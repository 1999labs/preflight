/**
 * Redaction.
 *
 * API keys end up in reports, and reports get pasted into tickets. So
 * redaction happens at capture time (so a raw key never sits in the report
 * object) AND as a final sweep over the serialized JSON (to catch keys that
 * arrived inside a response body we didn't control).
 */

const SENSITIVE_HEADERS = new Set(
  [
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'x-goog-api-key',
    'openai-api-key',
    'anthropic-api-key',
    'cookie',
    'set-cookie',
    'x-session-token',
  ].map((h) => h.toLowerCase()),
);

/** Vendor-prefixed keys we recognise by shape, e.g. sk-..., hf_..., gsk_... */
const KEY_SHAPES: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(sk|hf|api|xai|gsk|AIza|nvapi|glpat|r8|sk-ant|gcp|hf_)[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /"(?:api[_-]?key|token|secret|password|authorization)"\s*:\s*"[^"]{8,}"/gi,
];

export const REDACTED = '[redacted]';

export interface Redactor {
  (input: string): string;
  redactHeaders(headers: Record<string, string | undefined>): Record<string, string>;
  redactUnknown(value: unknown): unknown;
}

export function createRedactor(secrets: Array<string | undefined>): Redactor {
  const literals = [...new Set(secrets.filter((s): s is string => Boolean(s && s.length >= 6)))]
    // Longest first so a prefix doesn't mask a longer real key.
    .sort((a, b) => b.length - a.length);

  const redactString = (input: string): string => {
    let out = input;
    for (const secret of literals) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    for (const shape of KEY_SHAPES) out = out.replace(shape, REDACTED);
    return out;
  };

  const redactHeaders = (headers: Record<string, string | undefined>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : redactString(v);
    }
    return out;
  };

  /**
   * `seen` is a stack of the current path, not a set of everything visited.
   * A value reachable by two different paths (the same `usage` object hanging
   * off both `details` and `response.body`) is a shared reference, not a
   * cycle, and redacting it as "[circular]" silently destroys real data.
   */
  const redactUnknown = (value: unknown, seen: Set<object> = new Set()): unknown => {
    if (typeof value === 'string') return redactString(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((v) => redactUnknown(v, seen));
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_HEADERS.has(k.toLowerCase()) && typeof v === 'string' && v.length > 0) {
          out[k] = REDACTED;
        } else {
          out[k] = redactUnknown(v, seen);
        }
      }
      return out;
    } finally {
      seen.delete(value);
    }
  };

  const fn = ((input: string) => redactString(input)) as Redactor;
  fn.redactHeaders = redactHeaders;
  fn.redactUnknown = redactUnknown;
  return fn;
}

/** Final safety net: sweep an already-built object before it is serialized. */
export function scrub<T>(value: T, redactor: Redactor): T {
  return redactor.redactUnknown(value) as T;
}
