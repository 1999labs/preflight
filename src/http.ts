/**
 * HTTP layer: one place where every outbound request happens.
 *
 * Responsibilities: URL joining, auth, timeouts, redacted request/response
 * capture for the report, SSE parsing with per-event timestamps, and turning
 * every failure mode into a value instead of an exception.
 */

import type { Redactor } from './redact.js';
import type { ProviderConfig, WireRequest, WireResponse } from './types.js';

/** Bodies larger than this are truncated in the report. */
const MAX_CAPTURE_BYTES = Number(process.env['PROVIDER_CHECK_MAX_CAPTURE'] ?? 64 * 1024);

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

export function authHeaders(provider: ProviderConfig, key: string | undefined): Record<string, string> {
  const header = provider.apiKeyHeader ?? 'Authorization';
  const prefix = provider.apiKeyPrefix ?? 'Bearer ';
  const out: Record<string, string> = {};
  if (key) out[header] = `${prefix}${key}`;
  for (const [k, v] of Object.entries(provider.headers ?? {})) out[k] = v;
  return out;
}

export interface HttpResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  text: string;
  json?: unknown;
  contentType: string;
  bytes: number;
  durationMs: number;
  error?: string;
  timedOut: boolean;
  /**
   * True when the endpoint was reachable but refused to serve us: a 429 or 503
   * that survived the retry policy. Availability, not a defect.
   */
  blocked: boolean;
  /** Why it was considered blocked, in plain words. */
  blockedReason?: string;
  /** How many requests were made, including retries. */
  attempts: number;
  /** Delay honoured before the retry, in ms. */
  retriedAfterMs?: number;
  request: WireRequest;
  response: WireResponse;
}

/** Statuses that mean "come back later", not "you did it wrong". */
const UNAVAILABLE_STATUSES = new Set([429, 503]);

/** Upper bound on any retry delay we will honour, so CI cannot be stalled. */
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 20_000;

export interface RequestInitLite {
  method?: string;
  path: string;
  body?: unknown;
  /** Send a deliberately malformed body (string) to probe error handling. */
  rawBody?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Cap attempts for this call; defaults to the client policy. */
  maxAttempts?: number;
}

export interface RetryPolicy {
  /** 2 means one retry. 1 (the default) means never retry. */
  maxAttempts: number;
  /** Overrides any retry hint the endpoint supplies. Used by tests. */
  delayMs?: number;
}

export interface SseEvent {
  /** Milliseconds since the request was sent. */
  t: number;
  data: string;
}

export interface SseResult {
  ok: boolean;
  status: number;
  contentType: string;
  events: SseEvent[];
  /** Concatenated text of all data payloads, for `data: {"..."}` frames. */
  durationMs: number;
  timeToFirstEventMs?: number;
  timeToFirstTokenMs?: number;
  error?: string;
  timedOut: boolean;
  blocked: boolean;
  attempts: number;
  request: WireRequest;
  response: WireResponse;
}

export class HttpClient {
  constructor(
    private readonly provider: ProviderConfig,
    private readonly key: string | undefined,
    private readonly redactor: Redactor,
    private readonly defaultTimeoutMs: number,
    private readonly retry: RetryPolicy = { maxAttempts: 1 },
  ) {}

  /** Set per check by the runner; 2 enables one availability retry. */
  setMaxAttempts(n: number): void {
    this.retry.maxAttempts = n;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return { ...authHeaders(this.provider, this.key), ...(extra ?? {}) };
  }

  private captureRequest(url: string, method: string, headers: Record<string, string>, body: unknown): WireRequest {
    return {
      method,
      url,
      headers: this.redactor.redactHeaders(headers),
      // Request bodies are capped for the same reason responses are: a probe
      // like error_handling's oversized request is megabytes of filler, and
      // storing it verbatim turns the report into an unreadable blob that
      // buries the findings. Captured for reproduction, not for archiving.
      body: clipCapturedBody(this.redactor.redactUnknown(body)),
    };
  }

  private captureResponse(
    res: Response,
    text: string,
    contentType: string,
    durationMs: number,
    parsed: unknown,
  ): WireResponse {
    const bytes = Buffer.byteLength(text, 'utf8');
    const truncated = bytes > MAX_CAPTURE_BYTES;
    const clipped = truncated
      ? text.slice(0, MAX_CAPTURE_BYTES)
      : text;
    return {
      status: res.status,
      statusText: res.statusText,
      headers: this.redactor.redactHeaders(Object.fromEntries(res.headers.entries())),
      body: truncated ? `${clipped}\n…[truncated ${bytes - MAX_CAPTURE_BYTES} bytes]` : parsed ?? clipped,
      contentType,
      bytes,
      durationMs,
    };
  }

  async request(init: RequestInitLite): Promise<HttpResult> {
    const maxAttempts = init.maxAttempts ?? this.retry.maxAttempts;
    let attempt = 0;
    let retriedAfterMs: number | undefined;

    for (;;) {
      const result = await this.requestOnce(init);
      attempt += 1;
      result.attempts = attempt;
      if (result.response) result.response.attempts = attempt;
      if (retriedAfterMs !== undefined) result.retriedAfterMs = retriedAfterMs;

      if (!result.blocked || attempt >= maxAttempts) return result;

      const delay = this.retry.delayMs ?? parseRetryDelay(result) ?? DEFAULT_RETRY_DELAY_MS;
      const wait = Math.min(delay, MAX_RETRY_DELAY_MS);
      retriedAfterMs = wait;
      result.retriedAfterMs = wait;
      await sleep(wait);
    }
  }

  /** One attempt, with no retry logic. */
  private async requestOnce(init: RequestInitLite): Promise<HttpResult> {
    const method = init.method ?? 'POST';
    const url = joinUrl(this.provider.baseUrl, init.path);
    const headers = this.buildHeaders(init.headers);
    if (init.body !== undefined || init.rawBody !== undefined) {
      headers['content-type'] ??= 'application/json';
    }
    const wire = this.captureRequest(url, method, headers, init.body ?? init.rawBody);
    const timeoutMs = init.timeoutMs ?? this.defaultTimeoutMs;
    const ac = new AbortController();
    const onAbort = () => ac.abort(init.signal?.reason);
    init.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    const started = performance.now();

    let res: Response | undefined;
    let text = '';
    let error: string | undefined;
    let timedOut = false;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: init.rawBody !== undefined ? init.rawBody : init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ac.signal,
      });
      text = await res.text();
    } catch (err) {
      timedOut = ac.signal.aborted && !init.signal?.aborted;
      error = timedOut
        ? `request timed out after ${timeoutMs}ms`
        : describeError(err);
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
    }

    const durationMs = round(performance.now() - started);
    const contentType = res?.headers.get('content-type') ?? '';
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    const response: WireResponse = res
      ? this.captureResponse(res, text, contentType, durationMs, json)
      : { error, durationMs };

    return {
      ok: res ? res.ok : false,
      status: res?.status ?? 0,
      statusText: res?.statusText ?? '',
      headers: res ? Object.fromEntries(res.headers.entries()) : {},
      text,
      json,
      contentType,
      bytes: Buffer.byteLength(text, 'utf8'),
      durationMs,
      error,
      timedOut,
      blocked: classifyBlocked(res?.status ?? 0, text),
      attempts: 1,
      request: wire,
      response,
    };
  }

  /**
   * POST with stream:true and parse the SSE frames, timestamping each one.
   * Returns a value even when the server ignores stream and replies with a
   * single JSON object (a common failure mode worth reporting precisely).
   */
  async stream(init: RequestInitLite): Promise<SseResult> {
    const maxAttempts = init.maxAttempts ?? this.retry.maxAttempts;
    let attempt = 0;
    for (;;) {
      const result = await this.streamOnce(init);
      attempt += 1;
      result.attempts = attempt;
      if (result.response) result.response.attempts = attempt;
      if (!result.blocked || attempt >= maxAttempts) return result;
      const delay = this.retry.delayMs ?? parseRetryDelayStreaming(result) ?? DEFAULT_RETRY_DELAY_MS;
      await sleep(Math.min(delay, MAX_RETRY_DELAY_MS));
    }
  }

  private async streamOnce(init: RequestInitLite): Promise<SseResult> {
    const method = init.method ?? 'POST';
    const url = joinUrl(this.provider.baseUrl, init.path);
    const headers = this.buildHeaders({ accept: 'text/event-stream', ...(init.headers ?? {}) });
    if (init.body !== undefined) headers['content-type'] ??= 'application/json';
    const wire = this.captureRequest(url, method, headers, init.body);
    const timeoutMs = init.timeoutMs ?? this.defaultTimeoutMs;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    const started = performance.now();

    const events: SseEvent[] = [];
    let res: Response | undefined;
    let raw = '';
    let error: string | undefined;
    let timedOut = false;
    let firstEventAt: number | undefined;
    let firstTokenAt: number | undefined;
    let buffer = '';

    try {
      res = await fetch(url, {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ac.signal,
      });
      const ctype = res.headers.get('content-type') ?? '';
      if (!res.body || !/text\/event-stream/i.test(ctype)) {
        raw = await res.text();
      } else {
        const decoder = new TextDecoder();
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          const t = round(performance.now() - started);
          buffer += decoder.decode(chunk, { stream: true });
          let sep = findSeparator(buffer);
          while (sep) {
            const frame = buffer.slice(0, sep.index);
            buffer = buffer.slice(sep.index + sep.length);
            const data = frame
              .split(/\r?\n/)
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).replace(/^ /, ''))
              .join('\n');
            if (data) {
              events.push({ t, data });
              firstEventAt ??= t;
              if (firstTokenAt === undefined && sseHasContent(data)) firstTokenAt = t;
            }
            sep = findSeparator(buffer);
          }
        }
        if (buffer.trim() && /^data:/m.test(buffer)) {
          const data = buffer
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('\n');
          if (data) events.push({ t: round(performance.now() - started), data });
        }
      }
    } catch (err) {
      timedOut = ac.signal.aborted;
      error = timedOut ? `stream timed out after ${timeoutMs}ms` : describeError(err);
    } finally {
      clearTimeout(timer);
    }

    const durationMs = round(performance.now() - started);
    const contentType = res?.headers.get('content-type') ?? '';
    const response: WireResponse = res
      ? {
          status: res.status,
          statusText: res.statusText,
          headers: this.redactor.redactHeaders(Object.fromEntries(res.headers.entries())),
          body:
            events.length > 0
              ? `${events.length} SSE frames, last: ${events[events.length - 1]?.data?.slice(0, 400) ?? ''}`
              : raw.slice(0, MAX_CAPTURE_BYTES),
          contentType,
          bytes: Buffer.byteLength(raw || '', 'utf8') || events.length,
          durationMs,
        }
      : { error, durationMs };

    return {
      ok: res ? res.ok : false,
      status: res?.status ?? 0,
      contentType,
      events,
      durationMs,
      timeToFirstEventMs: firstEventAt,
      timeToFirstTokenMs: firstTokenAt,
      error,
      timedOut,
      blocked: classifyBlocked(res?.status ?? 0, raw),
      attempts: 1,
      request: wire,
      response,
    };
  }
}

/** A 429 or 503 is an availability problem, never a defect in the endpoint. */
export function classifyBlocked(status: number, body: string): boolean {
  return UNAVAILABLE_STATUSES.has(status);
}

/**
 * Cap a captured request body at MAX_CAPTURE_BYTES.
 *
 * A body under the cap is returned untouched, so ordinary requests keep their
 * exact structure. A body over it is replaced with a description carrying the
 * real size, because a truncated-but-valid-looking object is worse than an
 * honest placeholder: it reads like a complete request when it is not one, and
 * the long string fields are the entire reason it was too big.
 */
export function clipCapturedBody(body: unknown): unknown {
  if (body === undefined || body === null) return body;
  if (typeof body === 'string') return clipString(body);
  if (typeof body !== 'object') return body;

  const encoded = JSON.stringify(body);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') <= MAX_CAPTURE_BYTES) {
    return body;
  }
  return {
    truncated: true,
    original_bytes: Buffer.byteLength(encoded, 'utf8'),
    note: `request body exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit; re-run the check to reproduce it`,
    keys: Object.keys(body as Record<string, unknown>),
  };
}

function clipString(s: string): string {
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= MAX_CAPTURE_BYTES) return s;
  return `${s.slice(0, MAX_CAPTURE_BYTES)}\n…[truncated ${bytes - MAX_CAPTURE_BYTES} bytes]`;
}

/**
 * Honour whatever retry guidance the endpoint gave, so a provider saying
 * "retry in 3s" is not made to wait out the full default.
 */
export function parseRetryDelay(res: { headers?: Record<string, string>; text?: string }): number | undefined {
  const header = Object.entries(res.headers ?? {}).find(
    ([k]) => k.toLowerCase() === 'retry-after',
  )?.[1];
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  // Some gateways put the delay in the body, e.g. {"retry_after": 5}.
  const body = res.text ?? '';
  const match = /"(?:retry_?after|retry_?delay|retryAfter|retryDelay)"\s*:\s*(\d+(?:\.\d+)?)/i.exec(body);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) return value <= 10 ? value * 1000 : value;
  }
  return undefined;
}

/** Same as parseRetryDelay, but an SSE result keeps its headers on `response`. */
export function parseRetryDelayStreaming(res: SseResult): number | undefined {
  return parseRetryDelay({ headers: res.response?.headers, text: res.response?.body as string | undefined });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findSeparator(buf: string): { index: number; length: number } | null {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/** Does this SSE data frame carry model output (as opposed to role/metadata)? */
function sseHasContent(data: string): boolean {
  if (data === '[DONE]') return false;
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: unknown }; text?: unknown }>;
      delta?: { content?: unknown };
    };
    for (const c of parsed.choices ?? []) {
      if (typeof c.delta?.content === 'string' && c.delta.content.length > 0) return true;
      if (typeof c.text === 'string' && c.text.length > 0) return true;
    }
    if (typeof parsed.delta?.content === 'string' && parsed.delta.content.length > 0) return true;
    return false;
  } catch {
    return false;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return cause ? `${err.message} (${cause})` : err.message;
  }
  return String(err);
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Nearest-rank percentile; p in 0..100. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return round(sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!);
}

export function median(values: number[]): number {
  return percentile(values, 50);
}
