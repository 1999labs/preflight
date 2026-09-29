/**
 * Shared helpers for check implementations.
 *
 * These exist so each check file reads as: make a request, assert a shape,
 * return a result. No try/catch boilerplate, no throw discipline to remember.
 */

import type { HttpResult, SseResult } from '../http.js';
import type { CheckResult, Finding, Metrics, MetricValue, Status, WireRequest, WireResponse } from '../types.js';

export interface ResultInit {
  metrics?: Metrics;
  details?: unknown;
  /** Observations that are neither pass nor fail. */
  findings?: Finding[];
  request?: WireRequest;
  response?: WireResponse;
  durationMs?: number;
  error?: string;
  timedOut?: boolean;
}

/**
 * Build a finding, keeping the observation and the interpretation separate.
 *
 * `observed` must be checkable against the raw response. If it cannot be
 * quoted straight from the wire, it belongs in `inference` instead.
 */
export function finding(
  check: string,
  id: string,
  label: string,
  observed: string,
  inference: string,
  evidence?: Finding['evidence'],
): Finding {
  return evidence
    ? { id, label, observed, inference, check, evidence }
    : { id, label, observed, inference, check };
}

export function result(
  check: string,
  title: string,
  status: Status,
  note: string,
  init: ResultInit = {},
): CheckResult {
  const out: CheckResult = {
    check,
    title,
    status,
    note,
    metrics: init.metrics ?? {},
    durationMs: init.durationMs ?? 0,
  };
  if (init.details !== undefined) out.details = init.details;
  if (init.findings && init.findings.length > 0) out.findings = init.findings;
  if (init.request) out.request = init.request;
  if (init.response) out.response = init.response;
  if (init.error) out.error = init.error;
  if (init.timedOut) out.timedOut = true;
  return out;
}

export function pass(check: string, title: string, note: string, init: ResultInit = {}): CheckResult {
  return result(check, title, 'pass', note, init);
}

export function warn(check: string, title: string, note: string, init: ResultInit = {}): CheckResult {
  return result(check, title, 'warn', note, init);
}

export function fail(check: string, title: string, note: string, init: ResultInit = {}): CheckResult {
  return result(check, title, 'fail', note, init);
}

export function skipped(check: string, title: string, note: string, init: ResultInit = {}): CheckResult {
  return result(check, title, 'skip', note, init);
}

/** Turn a transport-level failure into a fail result with the wire pair. */
export function transportFail(
  check: string,
  title: string,
  http: HttpResult,
  what: string,
): CheckResult {
  return fail(
    check,
    title,
    http.timedOut
      ? `${what} timed out after ${http.durationMs}ms`
      : `${what} failed: ${http.error ?? 'no response'}`,
    {
      metrics: {
        http_status: http.status || null,
        duration_ms: http.durationMs,
        attempts: http.attempts,
        blocked: http.blocked,
      },
      request: http.request,
      response: http.response,
      durationMs: http.durationMs,
      error: http.error,
      timedOut: http.timedOut,
    },
  );
}

export function sseTransportFail(
  check: string,
  title: string,
  sse: SseResult,
  what: string,
): CheckResult {
  return fail(
    check,
    title,
    sse.timedOut
      ? `${what} timed out after ${sse.durationMs}ms`
      : `${what} failed: ${sse.error ?? 'no response'}`,
    {
      metrics: {
        http_status: sse.status || null,
        duration_ms: sse.durationMs,
        attempts: sse.attempts,
        blocked: sse.blocked,
      },
      request: sse.request,
      response: sse.response,
      durationMs: sse.durationMs,
      error: sse.error,
      timedOut: sse.timedOut,
    },
  );
}

/**
 * Read `usage` defensively. A router cares about the difference between
 * "missing usage" (you cannot bill or do rate math) and "usage present but
 * shaped wrong" (some vendors put prompt_tokens in a different field).
 */
export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  raw?: unknown;
}

export function readUsage(body: unknown): Usage {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const meta = isRecord(b['meta']) ? b['meta'] : undefined;
  const candidates = [b['usage'], b['usageMetadata'], b['token_usage'], b['tokenUsage'], meta?.['usage']];
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      const u = c as Record<string, unknown>;
      const prompt = num(u['prompt_tokens'] ?? u['input_tokens'] ?? u['promptTokens'] ?? u['inputTokens']);
      const completion = num(
        u['completion_tokens'] ?? u['output_tokens'] ?? u['completionTokens'] ?? u['outputTokens'],
      );
      const total = num(u['total_tokens'] ?? u['totalTokens']) ?? (prompt && completion ? prompt + completion : undefined);
      if (prompt !== undefined || completion !== undefined || total !== undefined) {
        return {
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: total,
          reasoningTokens: readReasoningTokens(u),
          raw: c,
        };
      }
    }
  }
  return {};
}

/**
 * Reasoning token counts, which sit in a different place on every vendor.
 *
 * For a reasoning model this is the difference between "the provider is fast"
 * and "the provider is fast once it stops thinking". OpenAI and OpenRouter put
 * it under completion_tokens_details; DeepSeek has used both that and a
 * top-level field; Anthropic-through-OpenRouter mirrors OpenAI's shape.
 */
export function readReasoningTokens(usage: Record<string, unknown>): number | undefined {
  const candidates: unknown[] = [
    usage['reasoning_tokens'],
    (isRecord(usage['completion_tokens_details']) ? usage['completion_tokens_details']['reasoning_tokens'] : undefined),
    (isRecord(usage['output_tokens_details']) ? usage['output_tokens_details']['reasoning_tokens'] : undefined),
    (isRecord(usage['completion_tokens_details']) ? usage['completion_tokens_details']['reasoning'] : undefined),
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return undefined;
}

/**
 * Reasoning text in a non-streamed response.
 *
 * OpenRouter puts a `reasoning` field on the assistant message, which is the
 * only place this provider exposes the thinking phase. Combined with the
 * streamed `reasoning_content`, it is a second independent witness to
 * reasoning having happened - which is what makes an under-report detectable.
 */
export function readMessageReasoning(body: unknown): string {
  if (!isRecord(body)) return '';
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!isRecord(first)) return '';
  const message = first['message'];
  if (!isRecord(message)) return '';
  for (const key of ['reasoning', 'reasoning_content', 'thinking']) {
    const value = message[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

export interface StreamFrameInfo {
  content: string;
  reasoning: string;
  finishReason?: string;
  completionTokens?: number;
  reasoningTokens?: number;
}

/**
 * Pull content, reasoning text, finish_reason and usage out of one SSE frame.
 *
 * Reasoning text arrives under delta.reasoning_content (DeepSeek) or
 * delta.reasoning (Anthropic-style gateways); providers that do not report
 * usage in-stream leave the token count to the estimator, but the reasoning
 * *text* is still measurable, which is how we explain a high TTFT.
 */
export function readStreamFrame(frame: string): StreamFrameInfo {
  const out: StreamFrameInfo = { content: '', reasoning: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return out;
  }
  if (!isRecord(parsed)) return out;

  const usage = parsed['usage'] ?? parsed['usageMetadata'];
  if (isRecord(usage)) {
    const completion = usage['completion_tokens'] ?? usage['output_tokens'] ?? usage['outputTokens'];
    if (typeof completion === 'number') out.completionTokens = completion;
    const reasoning = readReasoningTokens(usage);
    if (reasoning !== undefined) out.reasoningTokens = reasoning;
  }

  const choices = parsed['choices'];
  if (!Array.isArray(choices)) return out;
  for (const c of choices) {
    if (!isRecord(c)) continue;
    const fr = c['finish_reason'];
    if (typeof fr === 'string' && fr.length > 0) out.finishReason = fr;
    const delta = isRecord(c['delta']) ? c['delta'] : undefined;
    for (const piece of [delta?.['content'], c['text']]) {
      if (typeof piece === 'string') out.content += piece;
      else if (Array.isArray(piece)) {
        for (const part of piece) {
          const p = isRecord(part) ? part['text'] : part;
          if (typeof p === 'string') out.content += p;
        }
      }
    }
    for (const rk of [delta?.['reasoning_content'], delta?.['reasoning'], c['reasoning_content']]) {
      if (typeof rk === 'string') out.reasoning += rk;
    }
  }
  return out;
}

/** Pull the assistant text out of a chat/completions-shaped response. */
export function readMessageContent(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const choices = b['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as Record<string, unknown>;
  const msg = (first['message'] ?? first['delta']) as Record<string, unknown> | undefined;
  const content = msg?.['content'];
  if (typeof content === 'string') return content;
  // Some vendors return content as an array of parts.
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const p = part as Record<string, unknown>;
        return typeof p['text'] === 'string' ? p['text'] : '';
      })
      .join('');
  }
  if (typeof first['text'] === 'string') return first['text'];
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Coerce an arbitrary JSON value into something a Metrics cell can hold. */
export function asMetric(value: unknown): MetricValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}
