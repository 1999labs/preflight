/**
 * Per-provider execution: build the context, run the selected checks in
 * order, and assemble a ProviderRun.
 */

import { HttpClient } from './http.js';
import { createRedactor, type Redactor } from './redact.js';
import { runCheck, type CheckContext, type CheckDef } from './registry.js';
import { summarize } from './report.js';
import type { CheckResult, DiscoveredFacts, GlobalOptions, ProviderConfig, ProviderRun } from './types.js';

export interface RunOptions {
  global: GlobalOptions;
  log: (line: string) => void;
  /** Seconds since process start, used for the status line. */
}

export function buildRedactor(provider: ProviderConfig, key: string | undefined): Redactor {
  return createRedactor([key, provider.key]);
}

export async function runProvider(
  provider: ProviderConfig,
  key: string | undefined,
  opts: GlobalOptions,
  defs: CheckDef[],
  log: (line: string) => void,
): Promise<ProviderRun> {
  const redactor = buildRedactor(provider, key);
  // One shared client; per-request attempt caps come from the check definition.
  const http = new HttpClient(provider, key, redactor, opts.timeoutMs, {
    maxAttempts: 1,
    ...(opts.retryDelayMs !== undefined ? { delayMs: opts.retryDelayMs } : {}),
  });
  const facts: DiscoveredFacts = {};
  const started = Date.now();
  const t0 = performance.now();

  const ctx: CheckContext = {
    provider,
    http,
    redactor,
    opts,
    facts,
    log: (message, detail) => {
      if (opts.verbose) log(`      · ${message}${detail ? `: ${detail}` : ''}`);
    },
    timeoutFor(check, fallback) {
      return provider.timeouts?.[check] ?? opts.timeouts[check] ?? opts.timeoutMs ?? fallback;
    },
    body(extra) {
      return { ...(provider.extraBody ?? {}), ...(extra ?? {}) };
    },
  };

  const results: CheckResult[] = [];
  for (const def of defs) {
    const gate = gateFor(def, opts);
    if (gate) {
      results.push({
        check: def.name,
        title: def.title,
        status: 'skip',
        note: gate,
        metrics: {},
        durationMs: 0,
      });
      log(`  - ${def.name.padEnd(18)} skip`);
      continue;
    }

    // "Does it work" checks tolerate one transient 429; measuring checks do not.
    const attempts = def.retry ? 2 : 1;
    ctx.http.setMaxAttempts(attempts);

    const t = performance.now();
    const result = normaliseAvailability(await runCheck(def, ctx));
    const wall = Math.round(performance.now() - t);
    results.push(result);
    log(`  ${glyph(result.status)} ${def.name.padEnd(18)} ${result.status.toUpperCase().padEnd(5)} ${String(wall).padStart(6)}ms  ${result.note}`);
  }

  const durationMs = Math.round(performance.now() - t0);
  return {
    provider: redactProvider(provider, redactor),
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs,
    results,
    summary: summarize(results, durationMs),
    facts,
  };
}

/** Why a check is not running, or null when it is. */
function gateFor(def: CheckDef, opts: GlobalOptions): string | null {
  if (def.requiresVision && !opts.vision) return 'not run: requires the --vision flag';
  if (def.requiresDataPolicy && !opts.dataPolicy) return 'not run: requires the --zdr flag';
  return null;
}

/**
 * A `fail` whose HTTP status is 429 or 503 is not a verdict, it is an absence of
 * one. Applied centrally rather than inside each check, because a check that
 * forgets this turns an outage into a rejection of a healthy provider — and
 * the whole point of the tool is to not do that.
 */
function normaliseAvailability(result: CheckResult): CheckResult {
  if (result.status !== 'fail') return result;

  const status = result.response?.status;
  if (status !== 429 && status !== 503) return result;

  const attempts = result.response?.attempts ?? (Number(result.metrics['attempts'] ?? 1) || 1);
  const retried = attempts > 1 || result.metrics['retried'] === true;
  const reason =
    status === 429
      ? `rate limited (HTTP 429) after ${attempts} attempt${attempts === 1 ? '' : 's'}: the endpoint was never reached, so nothing was learned about it`
      : `unavailable (HTTP 503) after ${attempts} attempt${attempts === 1 ? '' : 's'}: the endpoint was never reached, so nothing was learned about it`;

  return {
    ...result,
    status: 'blocked',
    note: `could not be tested — ${reason}`,
    metrics: {
      ...result.metrics,
      blocked: true,
      blocked_status: status,
      attempts,
      retried,
    },
  };
}

function redactProvider(provider: ProviderConfig, redactor: Redactor): ProviderConfig {
  const copy = { ...provider };
  if (copy.key) copy.key = '[redacted]';
  if (copy.headers) copy.headers = redactor.redactHeaders(copy.headers);
  return copy;
}

function glyph(status: string): string {
  switch (status) {
    case 'pass':
      return '✓';
    case 'warn':
      return '!';
    case 'fail':
      return '✗';
    default:
      return '·';
  }
}
