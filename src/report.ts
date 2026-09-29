/**
 * Report assembly and serialization.
 *
 * The report is the artifact; the console output is a courtesy. report.json
 * therefore carries everything needed to debug a failure without a rerun: the
 * full request/response pair for anything that is not a pass, per-run timings,
 * and the raw metric values rather than pre-rendered prose.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { scrub, type Redactor } from './redact.js';
import { worstStatus } from './registry.js';
import type {
  CheckResult,
  ProviderRun,
  Report,
  RunSummary,
  Status,
} from './types.js';

export const TOOL_NAME = 'preflight';
export const TOOL_VERSION = '0.1.0';

export function summarize(results: CheckResult[], durationMs: number): RunSummary {
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  return {
    pass: count('pass'),
    warn: count('warn'),
    fail: count('fail'),
    blocked: count('blocked'),
    skip: count('skip'),
    total: results.length,
    status: worstStatus(results.map((r) => r.status)),
    durationMs,
  };
}

export function buildReport(
  runs: ProviderRun[],
  options: Record<string, unknown>,
  durationMs: number,
  compare?: unknown,
): Report {
  const totals = runs.reduce(
    (acc, run) => {
      acc.pass += run.summary.pass;
      acc.warn += run.summary.warn;
      acc.fail += run.summary.fail;
      acc.blocked += run.summary.blocked;
      acc.skip += run.summary.skip;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0, blocked: 0, skip: 0 },
  );

  const report: Report = {
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    durationMs,
    targets: runs.map((run) => ({
      id: run.provider.id,
      name: run.provider.name,
      baseUrl: run.provider.baseUrl,
      model: run.provider.model,
    })),
    options,
    runs,
    summary: {
      providers: runs.length,
      ...totals,
      status: worstStatus(runs.map((r) => r.summary.status)),
    },
  };
  if (compare !== undefined) report.compare = compare;
  return report;
}

export function writeReport(path: string, report: Report, redactor: Redactor): string {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  // Final redaction sweep: anything a provider echoed back that happened to
  // look like a key gets scrubbed here.
  writeFileSync(abs, `${JSON.stringify(scrub(report, redactor), null, 2)}\n`, 'utf8');
  return abs;
}
