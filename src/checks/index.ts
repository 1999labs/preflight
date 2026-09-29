/**
 * The check list.
 *
 * Order is deliberate and sequential, not alphabetical: models_endpoint runs
 * first because it discovers the claimed context length and supported
 * parameters that context_probe and --compare then hold the provider to.
 *
 * Adding a check: create the file, import it here, append its name to
 * ORDERED_CHECKS. The self-check in `npm test` fails if you forget the last
 * step.
 */

import type { CheckDef, PlannedCheck } from '../registry.js';

import './models-endpoint.js';
import './chat-basic.js';
import './streaming.js';
import './tool-calling.js';
import './json-mode.js';
import './error-handling.js';
import './quality-smoke.js';
import './latency.js';
import './data-policy.js';
import './context-probe.js';
import './vision.js';
import './structured-outputs.js';
import './modality-claims.js';

/**
 * Execution order. Sequential, and not alphabetical: models_endpoint first
 * because it discovers the claims the other checks hold the provider to;
 * quality_smoke last because it is the most expensive and the least
 * structural, so it should not run if something basic is already broken.
 */
/**
 * Planned but not yet implemented, with the quota they will consume. Reported
 * by --dry-run so a schedule can be costed against what the tool will actually
 * be able to do, not just what exists today.
 */
export const PLANNED_CHECKS: PlannedCheck[] = [];

export const ORDERED_CHECKS: string[] = [
  'models_endpoint',
  'chat_basic',
  'streaming',
  'tool_calling',
  'json_mode',
  'error_handling',
  'context_probe',
  'latency',
  'quality_smoke',
  'structured_outputs',
  'vision',
  // After vision: this check is the reconciliation of what the catalog
  // claimed against what vision measured.
  'modality_claims',
  'data_policy',
];

let cache: CheckDef[] | null = null;

/** The ordered check list, validated against the registry. */
export function orderedChecks(registry: CheckDef[]): CheckDef[] {
  if (cache) return cache;
  const byName = new Map(registry.map((c) => [c.name, c]));

  const missing = ORDERED_CHECKS.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    throw new Error(`ORDERED_CHECKS names "${missing.join('", "')}" but no such check is registered`);
  }
  const unregistered = registry.map((c) => c.name).filter((n) => !ORDERED_CHECKS.includes(n));
  if (unregistered.length > 0) {
    throw new Error(`checks registered but missing from ORDERED_CHECKS: ${unregistered.join(', ')}`);
  }

  cache = ORDERED_CHECKS.map((n) => byName.get(n)!);
  return cache;
}

/**
 * Planned-but-unimplemented names are accepted by --only/--skip so a schedule
 * can be expressed and costed before the check exists. At run time they are
 * simply not in the registry, so they contribute nothing; --dry-run is where
 * they show up, marked NOT IMPLEMENTED.
 */
export function resolveChecks(
  registry: CheckDef[],
  only?: string[],
  skip?: string[],
): CheckDef[] {
  const all = orderedChecks(registry);
  let selected = all;
  if (only && only.length > 0) {
    const known = new Set([...all.map((c) => c.name), ...PLANNED_CHECKS.map((p) => p.name)]);
    const unknown = only.filter((n) => !known.has(n));
    if (unknown.length > 0) {
      throw new Error(
        `unknown check(s): ${unknown.join(', ')}. Known checks: ${[...known].join(', ')}`,
      );
    }
    selected = all.filter((c) => only.includes(c.name));
  }
  if (skip && skip.length > 0) selected = selected.filter((c) => !skip.includes(c.name));
  return selected;
}
