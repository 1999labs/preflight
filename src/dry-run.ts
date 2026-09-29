/**
 * --dry-run: cost a plan without spending any of it.
 *
 * On a shared free-tier quota, the expensive mistake is running the wrong
 * twelve requests. This prints, per target, which checks would run, how many
 * requests each costs, what the target would total, and how the whole batch
 * sits against the daily cap - then exits non-zero if the plan does not fit.
 *
 * Nothing here touches the network. That includes the catalog: a dry run that
 * fetched /models to be helpful would itself be a request.
 */

import { estimateRequests, type CheckDef, type PlannedCheck } from './registry.js';
import type { GlobalOptions, ProviderConfig, Status } from './types.js';

export interface PlannedTarget {
  provider: ProviderConfig;
  defs: CheckDef[];
  planned: PlannedCheck[];
  /** Checks skipped because an opt-in flag was not passed. */
  gatedOut: CheckDef[];
}

export interface DryRunRow {
  check: string;
  requests: number;
  /** Cost if every request in this check is 429/503. Equals `requests` for a
   *  check that does not opt in to the availability retry. */
  worstCase: number;
  note?: string;
  status: 'runs' | 'gated' | 'not-implemented' | 'filtered';
}

export interface DryRunTargetReport {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  rows: DryRunRow[];
  total: number;
  worstCase: number;
  keyResolved: boolean;
  keyError?: string;
}

export interface DryRunReport {
  targets: DryRunTargetReport[];
  total: number;
  /** Cost of the whole batch if every request is 429/503. */
  worstCase: number;
  cap: number;
  fitsInOneDay: boolean;
  /** True when even the all-429 worst case fits the cap. */
  worstCaseFits: boolean;
  perDay: Array<{ day: number; total: number; targets: string[] }>;
  notes: string[];
}

/** Highest requests any single check can spend, used to warn about retries. */
const SEED_RETRY_NOTE = 'may cost 1 more if the endpoint rejects seed';

export function planDryRun(
  providers: ProviderConfig[],
  defs: CheckDef[],
  planned: PlannedCheck[],
  opts: GlobalOptions,
  cap: number,
  keyErrors: Map<string, string>,
): DryRunReport {
  const targets: DryRunTargetReport[] = providers.map((provider) => {
    const rows: DryRunRow[] = [];
    let total = 0;
    let worst = 0;

    for (const def of defs) {
      const gated =
        (def.requiresVision && !opts.vision) || (def.requiresDataPolicy && !opts.dataPolicy);
      if (gated) {
        rows.push({
          check: def.name,
          requests: 0,
          worstCase: 0,
          status: 'gated',
          note: optInNote(def),
        });
        continue;
      }
      const n = estimateRequests(def, opts);
      // Only a check that opts in to the availability retry can double. The
      // measuring checks deliberately do not, so a blanket n*2 overstates the
      // real cost of an unavailable provider — and on a shared daily quota that
      // overstatement is what makes a plan look like it busts the cap.
      const rowWorst = def.retry ? n * 2 : n;
      rows.push({
        check: def.name,
        requests: n,
        worstCase: rowWorst,
        status: 'runs',
        note: worstCaseNote(def, n, rowWorst),
      });
      total += n;
      worst += rowWorst;
    }

    for (const p of planned) {
      if (opts.skip?.includes(p.name)) {
        rows.push({
          check: p.name,
          requests: 0,
          worstCase: 0,
          status: 'filtered',
          note: 'not implemented; excluded by --skip',
        });
        continue;
      }
      // --only narrows the plan; a planned check outside it is not budgeted.
      if (opts.only && opts.only.length > 0 && !opts.only.includes(p.name)) {
        rows.push({
          check: p.name,
          requests: 0,
          worstCase: 0,
          status: 'filtered',
          note: 'not implemented; outside --only',
        });
        continue;
      }
      // Gated opt-in checks only count when the gate is open.
      if (p.name === 'vision' && !opts.vision) {
        rows.push({
          check: p.name,
          requests: 0,
          worstCase: 0,
          status: 'gated',
          note: 'not implemented; gated behind --vision',
        });
        continue;
      }
      const n = typeof p.requests === 'function' ? p.requests(opts) : p.requests;
      rows.push({
        check: p.name,
        requests: n,
        worstCase: n,
        status: 'not-implemented',
        note: p.why,
      });
      total += n;
      worst += n;
    }

    const keyError = keyErrors.get(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      rows,
      total,
      worstCase: worst,
      keyResolved: !keyError,
      ...(keyError ? { keyError } : {}),
    };
  });

  const total = targets.reduce((a, t) => a + t.total, 0);
  const worstCase = targets.reduce((a, t) => a + t.worstCase, 0);
  const fitsInOneDay = total <= cap;
  const worstCaseFits = worstCase <= cap;

  // Greedy day packing, so an over-budget plan still shows when it would land.
  const perDay: DryRunReport['perDay'] = [];
  let day = 0;
  let used = 0;
  for (const t of targets) {
    if (used > 0 && used + t.total > cap) {
      day += 1;
      used = 0;
    }
    const bucket = (perDay[day] ??= { day: day + 1, total: 0, targets: [] });
    bucket.total += t.total;
    bucket.targets.push(t.id);
    used += t.total;
  }

  const notes: string[] = [];
  notes.push(
    `Worst case if the upstream pool is saturated: ${worstCase} requests. Only checks that opt in to the ` +
      'availability retry cost double — latency, quality_smoke and error_handling deliberately do not, ' +
      'because a retry inside a measurement reports the second attempt and hides the first failure.',
  );
  const missing = planned.filter((p) => defs.every((d) => d.name !== p.name));
  if (missing.length > 0 && targets.some((t) => t.rows.some((r) => r.status === 'not-implemented'))) {
    notes.push(
      `${missing.map((m) => m.name).join(', ')} ${missing.length === 1 ? 'is' : 'are'} budgeted here but not implemented yet: ` +
        'a real run would silently skip them, so the live cost will be lower than this table until they land.',
    );
  }
  notes.push('The catalog fetch behind --compare is unauthenticated and does not count against the model quota.');
  if (!fitsInOneDay) {
    notes.push(
      `Plan totals ${total} requests against a cap of ${cap}. It does not fit in one day; see the day packing below.`,
    );
  } else if (!worstCaseFits) {
    // The distinction that decides whether a saturated pool is dangerous: the
    // plan fits, but a provider that 429s throughout would overspend.
    notes.push(
      `The plan fits (${total} ≤ ${cap}), but a fully rate-limited run would cost ${worstCase}, which busts the cap. ` +
        'Gate on a 1-request probe first, or expect to spend the day over budget.',
    );
  } else {
    notes.push(
      `Even a fully rate-limited run stays within the cap (${worstCase} ≤ ${cap}), so a saturated upstream pool ` +
        'costs time but not quota overrun. No preflight gate is needed.',
    );
  }
  const unresolved = targets.filter((t) => t.keyError);
  if (unresolved.length > 0) {
    notes.push(`${unresolved.length} target(s) have no resolvable API key and would fail immediately without spending quota.`);
  }

  return { targets, total, worstCase, cap, fitsInOneDay, worstCaseFits, perDay, notes };
}

function optInNote(def: CheckDef): string {
  if (def.requiresVision) return 'not run: requires --vision';
  if (def.requiresDataPolicy) return 'not run: requires --data-policy';
  return 'not run: opt-in';
}

/** Why this row's worst case is (or is not) higher than its base cost. */
function worstCaseNote(def: CheckDef, n: number, worst: number): string {
  if (def.name === 'streaming') return SEED_RETRY_NOTE;
  if (worst > n) return `doubles to ${worst} if every attempt is 429/503`;
  // Saying "no retry" matters as much as saying "doubles": it is the reason the
  // real worst case is lower than a blanket doubling would suggest.
  return 'no availability retry, so a 429/503 costs the same as a pass';
}

export function renderDryRun(report: DryRunReport): string {
  const out: string[] = [];
  out.push('provider-check — DRY RUN (no network calls made)');
  out.push('');

  for (const t of report.targets) {
    out.push(`▸ ${t.name}`);
    out.push(`  ${t.baseUrl} · ${t.model}`);
    if (t.keyError) {
      out.push(`  ! ${t.keyError}`);
    }
    out.push('');
    out.push('    check                     requests  worst  status');
    out.push('    ------------------------  --------  -----  -------------------');
    for (const row of t.rows) {
      const label = row.check.padEnd(24);
      const req = String(row.requests).padStart(8);
      // Only show the worst case where it differs, so the common column does
      // not turn into noise.
      const worst =
        row.worstCase === row.requests ? '     ' : String(row.worstCase).padStart(5);
      out.push(`    ${label}  ${req}  ${worst}  ${label4(row.status)}`);
      if (row.note && row.status !== 'runs') {
        out.push(`    ${' '.repeat(24)}           ${row.note}`);
      }
    }
    out.push(`    ${''.padEnd(24)}  ${String(t.total).padStart(8)}  ${String(t.worstCase).padStart(5)}  TOTAL`);
    out.push('');
  }

  out.push('─'.repeat(60));
  const verdict: Status = report.fitsInOneDay ? 'pass' : 'fail';
  out.push(
    `TOTAL ${report.total} requests across ${report.targets.length} target(s) · daily cap ${report.cap} · ${verdict === 'pass' ? 'FITS IN ONE DAY' : 'DOES NOT FIT IN ONE DAY'}`,
  );
  const worstVerdict: Status = report.worstCaseFits ? 'pass' : 'fail';
  out.push(
    `WORST CASE ${report.worstCase} requests if every request is 429/503 · ${worstVerdict === 'pass' ? 'STAYS WITHIN THE CAP' : 'BUSTS THE CAP'}`,
  );
  out.push('');

  if (report.perDay.length > 1) {
    out.push('Suggested packing (greedy, in order):');
    for (const d of report.perDay) {
      out.push(`  day ${d.day}: ${d.total} requests — ${d.targets.join(', ')}`);
    }
    out.push('');
  }

  for (const note of report.notes) out.push(`note: ${note}`);
  out.push('');

  return out.join('\n');
}

function label4(status: DryRunRow['status']): string {
  switch (status) {
    case 'runs':
      return 'would run';
    case 'gated':
      return 'gated';
    case 'not-implemented':
      return 'NOT IMPLEMENTED';
    default:
      return 'filtered';
  }
}
