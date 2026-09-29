/**
 * Check registry.
 *
 * Adding a check = add one file in src/checks/ that calls defineCheck(), then
 * add its name to ORDERED_CHECKS in src/checks/index.ts. Nothing else changes:
 * the runner applies the timeout and the no-throw guarantee uniformly, and the
 * report, markdown and exit-code logic are all driven off the registry.
 */

import type { Redactor } from './redact.js';
import type { HttpClient } from './http.js';
import type {
  CheckResult,
  DiscoveredFacts,
  GlobalOptions,
  ProviderConfig,
  Status,
} from './types.js';

export interface CheckContext {
  provider: ProviderConfig;
  http: HttpClient;
  redactor: Redactor;
  opts: GlobalOptions;
  /** Shared between checks: one check's discovery feeds the next. */
  facts: DiscoveredFacts;
  log(message: string, detail?: string): void;
  /** Resolve an effective timeout: per-provider override > CLI > check default. */
  timeoutFor(check: string, fallbackMs: number): number;
  /** Base chat body with provider extraBody merged in. */
  body(extra?: Record<string, unknown>): Record<string, unknown>;
}

export interface CheckDef {
  name: string;
  title: string;
  description: string;
  defaultTimeoutMs: number;
  /**
   * Requests this check will issue, so `--dry-run` can budget a plan against a
   * quota before spending any of it. A function when the count depends on
   * options (latency scales with --runs).
   */
  requests: number | ((opts: GlobalOptions) => number);
  /**
   * Opt in to one availability retry (429/503) per request.
   *
   * Off by default, deliberately. A retry is right for a check whose question
   * is "does this work at all", and wrong for a check that is *measuring*
   * something: retrying inside `latency` would report the timing of the second
   * attempt and hide the first failure entirely, and retrying inside
   * `quality_smoke` would paper over unavailability across ten prompts.
   */
  retry?: boolean;
  /** Only runs when --vision is passed. */
  requiresVision?: boolean;
  /** Only runs when --data-policy is passed. */
  requiresDataPolicy?: boolean;
  run(ctx: CheckContext): Promise<CheckResult>;
}

export function estimateRequests(def: CheckDef, opts: GlobalOptions): number {
  return typeof def.requests === 'function' ? def.requests(opts) : def.requests;
}

/**
 * Checks that are planned but not yet implemented, with the budget they will
 * consume. `--dry-run` reports these so a plan can be costed honestly instead
 * of silently omitting the checks that are not there yet.
 */
export interface PlannedCheck {
  name: string;
  requests: number | ((opts: GlobalOptions) => number);
  why: string;
}

const registry = new Map<string, CheckDef>();

export function defineCheck(def: CheckDef): CheckDef {
  if (registry.has(def.name)) {
    throw new Error(`duplicate check name: ${def.name}`);
  }
  registry.set(def.name, def);
  return def;
}

export function getCheck(name: string): CheckDef | undefined {
  return registry.get(name);
}

export function listChecks(): CheckDef[] {
  return [...registry.values()];
}

/**
 * Execute one check. Guarantees:
 *  - never throws; a rejection becomes a fail result
 *  - always resolves within defaultTimeoutMs (plus a small grace period)
 *  - a hung check is reported as a fail with the partial note, not a hang
 */
export async function runCheck(def: CheckDef, ctx: CheckContext): Promise<CheckResult> {
  const timeoutMs = ctx.timeoutFor(def.name, def.defaultTimeoutMs);
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;

  try {
    const guard = new Promise<CheckResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          check: def.name,
          title: def.title,
          status: 'fail',
          note: `timed out after ${timeoutMs}ms without completing`,
          metrics: { timeout_ms: timeoutMs },
          durationMs: round(performance.now() - started),
          timedOut: true,
        });
      }, timeoutMs);
    });

    const result = await Promise.race([def.run(ctx), guard]);
    return { ...result, durationMs: round(result.durationMs || performance.now() - started) };
  } catch (err) {
    return {
      check: def.name,
      title: def.title,
      status: 'fail',
      note: `check crashed: ${describe(err)}`,
      metrics: {},
      durationMs: round(performance.now() - started),
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Worst status wins.
 *
 * Ordering is fail > blocked > warn > pass. A defect is the worst outcome; an
 * untested check is next, because "we do not know" is more dangerous to a
 * reader than "we know it is slightly off" — but neither is a pass.
 */
export function worstStatus(statuses: Status[]): Status {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('warn')) return 'warn';
  if (statuses.includes('pass')) return 'pass';
  return 'skip';
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
