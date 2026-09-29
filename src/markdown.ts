/**
 * Markdown output: one card per provider.
 *
 * Written to be pasted into a launch thread. The Notes section is the point -
 * it turns every warn/fail into a sentence an engineer can act on, so nobody
 * has to open report.json to find out what is wrong.
 */

import type { CheckResult, Finding, ProviderRun, Report, Status } from './types.js';

const ICON: Record<Status, string> = {
  pass: '✅',
  warn: '⚠️',
  fail: '❌',
  skip: '⏭️',
  blocked: '🚧',
};

const STATUS_LABEL: Record<Status, string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'SKIP',
  blocked: 'BLOCKED',
};

export function renderMarkdown(report: Report): string {
  const out: string[] = [];
  out.push(`# provider-check report`);
  out.push('');
  out.push(
    `**${report.summary.status.toUpperCase()}** — ${report.summary.providers} provider(s), ` +
      `${report.summary.pass} pass · ${report.summary.warn} warn · ${report.summary.fail} fail · ` +
      `${report.summary.blocked} blocked · ${report.summary.skip} skip ` +
      `(${formatDuration(report.durationMs)} total)`,
  );
  out.push('');
  out.push(`Generated ${report.generatedAt} · tool v${report.version}`);
  out.push('');

  for (const run of report.runs) {
    out.push(...renderRun(run));
  }

  if (report.compare !== undefined) {
    out.push('## Comparison vs OpenRouter catalog');
    out.push('');
    out.push('```json');
    out.push(JSON.stringify(report.compare, null, 2));
    out.push('```');
    out.push('');
  }

  return out.join('\n');
}

function renderRun(run: ProviderRun): string[] {
  const out: string[] = [];
  const { provider, summary } = run;

  out.push('---');
  out.push('');
  out.push(`## ${provider.name} — ${STATUS_LABEL[summary.status]}`);
  out.push('');
  out.push(`- **Endpoint:** \`${provider.baseUrl}\``);
  out.push(`- **Model:** \`${provider.model}\``);
  out.push(`- **Duration:** ${formatDuration(summary.durationMs)}`);

  const latency = run.results.find((r) => r.check === 'latency');
  if (latency && latency.status !== 'skip') {
    const m = latency.metrics;
    out.push(
      `- **Latency:** TTFT p50 ${fmt(m['ttft_p50_ms'])} / p95 ${fmt(m['ttft_p95_ms'])} ms · ` +
        `output ${fmt(m['tps_p50'])} tok/s p50 / ${fmt(m['tps_p95'])} p95 ` +
        `(${fmt(m['runs_ok'])}/${fmt(m['runs_requested'])} runs ok)`,
    );
  }

  const context = run.results.find((r) => r.check === 'context_probe');
  if (context) {
    const m = context.metrics;
    out.push(
      `- **Context:** largest working prompt ${fmt(m['max_ok_tokens'] ?? m['max_ok'])} tokens ` +
        `(claimed ${fmt(m['claimed_context_length'] ?? m['claimed'])})`,
    );
  }

  const quality = run.results.find((r) => r.check === 'quality_smoke');
  if (quality) {
    out.push(`- **Quality:** ${fmt(quality.metrics['score'])}/${fmt(quality.metrics['total'])} golden prompts`);
  }

  const models = run.results.find((r) => r.check === 'models_endpoint');
  if (models) {
    const priceIn = models.metrics['price_prompt_per_1m_usd'];
    const priceOut = models.metrics['price_completion_per_1m_usd'];
    if (priceIn !== undefined || priceOut !== undefined) {
      out.push(`- **Price:** $${fmt(priceIn)}/1M in · $${fmt(priceOut)}/1M out`);
    }
  }
  out.push('');

  // Status table
  out.push('| Check | Status | Detail |');
  out.push('| --- | --- | --- |');
  for (const r of run.results) {
    out.push(`| \`${r.check}\` | ${ICON[r.status]} ${STATUS_LABEL[r.status]} | ${escapeCell(r.note)} |`);
  }
  out.push('');

  // Findings: neither pass nor fail. Kept out of the table because a table
  // column forces a binary reading, and these are the observations that
  // deserve to be read as evidence rather than verdicts.
  const findings = run.results.flatMap((r) => r.findings ?? []);
  out.push('### Findings');
  out.push('');
  if (findings.length === 0) {
    out.push('No findings. The checks surfaced nothing beyond their pass/fail verdicts.');
  } else {
    for (const f of findings) {
      out.push(`**${f.label}** \`${f.id}\` _(${f.check})_`);
      out.push('');
      out.push(`- **Observed:** ${f.observed}`);
      out.push(`- **We read that as:** ${f.inference}`);
      if (f.evidence) {
        out.push(`- _Evidence:_ ${Object.entries(f.evidence)
          .map(([k, v]) => `\`${k}=${String(v)}\``)
          .join(', ')}`);
      }
      out.push('');
    }
  }

  const blocked = run.results.filter((r) => r.status === 'blocked');
  const notes = run.results.filter((r) => r.status === 'warn' || r.status === 'fail');

  if (blocked.length > 0) {
    out.push('### Blocked — not tested');
    out.push('');
    out.push(
      'These checks never reached the provider, so they say nothing about it. ' +
        'Do not read them as failures.',
    );
    out.push('');
    for (const r of blocked) {
      out.push(`- **${r.title}**: ${r.note}`);
      if (r.response?.body !== undefined) {
        out.push('');
        out.push('  ```json');
        out.push(`  ${JSON.stringify(r.response.body, null, 2).split('\n').join('\n  ')}`);
        out.push('  ```');
      }
    }
    out.push('');
  }

  out.push('### Notes');
  out.push('');
  if (notes.length === 0 && blocked.length === 0) {
    out.push('Nothing to flag. Every check passed.');
  } else {
    for (const r of notes) {
      const lead = r.status === 'fail' ? 'Blocking' : 'Worth knowing';
      out.push(`- **${r.title}** (${STATUS_LABEL[r.status]}): ${r.note} _(${lead}.)_`);
      if (r.timedOut) out.push(`  - Timed out; raise the timeout for \`${r.check}\` if this is a slow provider.`);
    }
    if (blocked.length > 0) {
      out.push(`- **${blocked.length} check(s) blocked**: see the section above. Nothing was learned about this provider.`);
    }
  }
  out.push('');

  if (provider.notes) {
    out.push(`_Config note: ${provider.notes}_`);
    out.push('');
  }

  return out;
}

function fmt(v: unknown): string {
  if (v === undefined || v === null || v === '') return 'n/a';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2).replace(/\.00$/, '');
  }
  return String(v);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Plain-text status line used by the console output. */
export function renderConsoleSummary(run: ProviderRun): string {
  const { summary } = run;
  return `${STATUS_LABEL[summary.status]}  ${summary.pass} pass  ${summary.warn} warn  ${summary.fail} fail  ${summary.skip} skip`;
}

export type { CheckResult, Finding };
