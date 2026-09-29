/**
 * Shared types for preflight.
 *
 * A check NEVER throws. Every outcome - including timeouts, DNS failures and
 * malformed responses - is a CheckResult with a status. That is the whole
 * contract this tool is built on: running it against a half-broken provider is
 * the normal case, not the exception.
 */

/**
 * `blocked` is deliberately not `fail`.
 *
 * A `fail` is a verdict: the endpoint was reached and something is wrong with
 * it. A `blocked` is an absence of a verdict: the endpoint was never reached,
 * or was unreachable at that moment, so nothing was learned. Collapsing the two
 * is the specific failure mode this tool exists to prevent — a card reading
 * "3 FAIL" for a model nobody actually talked to tells a reader to reject a
 * provider on the strength of an outage.
 */
export type Status = 'pass' | 'warn' | 'fail' | 'skip' | 'blocked';

export type MetricValue = number | string | boolean | null;

export interface Metrics {
  [key: string]: MetricValue;
}

/** A captured request, always redacted before it leaves the process. */
export interface WireRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A captured response. `body` is parsed JSON when possible, else text. */
export interface WireResponse {
  status?: number;
  /** Requests made for this call, including any availability retry. */
  attempts?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
  contentType?: string;
  bytes?: number;
  durationMs?: number;
  error?: string;
}

/**
 * A finding is something a check observed that is neither a pass nor a fail.
 *
 * The distinction that matters: `observed` is what the wire actually said, and
 * `inference` is what we think it means. Keeping them in separate fields stops
 * a guess from being reported with the authority of a measurement - "the
 * provider injects a hidden system prompt" is our reading of "prompt_tokens:
 * 163 for a 4-word user message, 149 of them cached".
 */
export interface Finding {
  /** Stable identifier, e.g. `reasoning_underreported`. */
  id: string;
  /** Short human-readable title. */
  label: string;
  /** The fact, with numbers, exactly as observed. */
  observed: string;
  /** What we think it implies, labelled as inference. */
  inference: string;
  /** Which check surfaced it. */
  check: string;
  evidence?: Record<string, MetricValue>;
}

export interface CheckResult {
  check: string;
  title: string;
  status: Status;
  /** One line, plain English, written for a human reading a report. */
  note: string;
  metrics: Metrics;
  /** Optional structured detail; always JSON-safe. */
  details?: unknown;
  /** Observations that are neither pass nor fail. */
  findings?: Finding[];
  /** Populated for fail (and most warn) so the operator can reproduce. */
  request?: WireRequest;
  response?: WireResponse;
  durationMs: number;
  timedOut?: boolean;
  error?: string;
}

export interface ProviderConfig {
  /** Stable slug used in filenames and report keys. */
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** Preferred: name of the env var holding the key. */
  keyEnv?: string;
  /** Discouraged: literal key. Never echoed to output. */
  key?: string;
  /** Overrides for non-Bearer auth. */
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  headers?: Record<string, string>;
  /** Merged into every chat request body. */
  extraBody?: Record<string, unknown>;
  /** Per-check timeout override in ms. */
  timeouts?: Record<string, number>;
  notes?: string;
}

export interface GlobalOptions {
  runs: number;
  timeoutMs: number;
  vision: boolean;
  dataPolicy: boolean;
  compare: boolean;
  codeExec: boolean;
  verbose: boolean;
  contextSafety: number;
  latencyConcurrency: number;
  /**
   * Context probe rungs, ascending. Empty means the built-in default ladder.
   *
   * A function of the model, not a constant, because the honest ceiling for a
   * 128k model is very different from the honest ceiling for a 1M one — and a
   * fixed ladder either wastes requests on small models or under-tests large
   * ones. See `planContextLadder` in `checks/context-probe.ts`.
   */
  contextLadder?: number[];
  /** Rungs to plan when no explicit ladder is given (default 4). */
  contextProbes?: number;
  /** Only run these checks (in registry order). */
  only?: string[];
  /** Skip these checks. */
  skip?: string[];
  /** Per-check timeout overrides from the CLI. */
  timeouts: Record<string, number>;
  /** Overrides the endpoint's own retry hint. Undefined = honour the hint. */
  retryDelayMs?: number;
}

/**
 * Facts discovered by earlier checks, shared downstream.
 *
 * context_probe needs the claimed context_length from models_endpoint;
 * --compare needs what the probe actually found. Checks run sequentially in
 * registry order and communicate through this bag rather than through each
 * other directly.
 */
export interface DiscoveredFacts {
  modelListed?: boolean;
  claimedContextLength?: number;
  claimedPricing?: Record<string, number | string>;
  supportedParameters?: string[];
  advertisedModels?: string[];
  maxInputTokensSucceeded?: number;
  maxInputTokensFailed?: number;
  streamSupported?: boolean;
  toolCallingSupported?: boolean;
  jsonModeSupported?: boolean;
  visionSupported?: boolean;
  /** What the catalog description claims about image/video input. */
  catalogDescription?: string;
  /** What the catalog's architecture block lists, e.g. "text+image->text". */
  catalogModality?: string;
  catalogInputModalities?: string[];
  /** pass | fail | inconclusive, once vision has run. */
  visionVerdict?: string;
  zdrPathAvailable?: boolean;
  [key: string]: unknown;
}

export interface ProviderRun {
  provider: ProviderConfig;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  results: CheckResult[];
  summary: RunSummary;
  facts: DiscoveredFacts;
  error?: string;
}

export interface RunSummary {
  pass: number;
  warn: number;
  fail: number;
  /** Could not be tested; no verdict either way. */
  blocked: number;
  skip: number;
  total: number;
  status: Status;
  durationMs: number;
}

export interface Report {
  tool: string;
  version: string;
  generatedAt: string;
  durationMs: number;
  /** Redacted, for the operator. */
  targets: Array<{
    id: string;
    name: string;
    baseUrl: string;
    model: string;
  }>;
  options: Record<string, unknown>;
  runs: ProviderRun[];
  compare?: unknown;
  summary: {
    providers: number;
    pass: number;
    warn: number;
    fail: number;
    blocked: number;
    skip: number;
    status: Status;
  };
}
