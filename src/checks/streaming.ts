/**
 * Check 3 - streaming
 *
 * Streaming is where provider bugs concentrate, because it is the only path
 * with framing, ordering and termination semantics. A router that proxies SSE
 * needs three guarantees:
 *
 *  1. chunks are parseable SSE data frames,
 *  2. a final chunk carries finish_reason, so a truncated generation is
 *     distinguishable from a completed one (this is how you decide whether to
 *     retry),
 *  3. a [DONE] sentinel, so the client knows when to close - some proxies
 *     hang forever waiting for one that never comes.
 *
 * We also diff the streamed text against a non-streamed call of the same
 * prompt. A classic provider bug is emitting every token except the last one;
 * that only shows up if you compare against ground truth, and it silently
 * corrupts every streamed answer in production.
 *
 * That comparison has to be done carefully. Two calls to a sampled model are
 * not guaranteed to be byte-identical even at temperature 0, so a naive
 * character diff produces false "dropped tail" failures - the check would cry
 * wolf often enough that nobody would trust it. So both calls are pinned with
 * temperature 0 and a seed (dropped and retried if the endpoint rejects it),
 * and the verdict is decided in stages: a strict prefix is the dropped-chunk
 * signature and fails; anything else is judged on length, and a divergence is
 * reported as sampling variance rather than a bug.
 */

import { defineCheck, type CheckContext } from '../registry.js';
import { fail, finding, isRecord, pass, sseTransportFail, warn, type ResultInit } from './_helpers.js';
import type { HttpResult, SseResult } from '../http.js';
import type { CheckResult, Metrics } from '../types.js';

const PROMPT = 'Count from 1 to 20, separated by commas, on a single line. No other text.';
const MAX_TOKENS = 800;
const SEED = 42;

/** Streamed and non-streamed lengths within this ratio count as equivalent. */
const LENGTH_TOLERANCE = 0.15;

export default defineCheck({
  name: 'streaming',
  title: 'Streaming (SSE)',
  description: 'stream=true yields SSE chunks, a finish_reason, a [DONE] sentinel, and no dropped tail.',
  // stream + the non-streamed ground truth, plus a retry if the endpoint
  // rejects the seed.
  requests: 3,
  retry: true,
  defaultTimeoutMs: 60_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'streaming';
    const title = 'Streaming (SSE)';

    const body: Record<string, unknown> = {
      model: ctx.provider.model,
      messages: [{ role: 'user', content: PROMPT }],
      max_tokens: MAX_TOKENS,
      temperature: 0,
      stream: true,
    };

    const seeded = await streamWithSeed(ctx, body);
    const sse = seeded.response;
    let seedSupported = seeded.seedSupported;

    if (sse.status === 0) return sseTransportFail(name, title, sse, 'streaming request');
    if (!sse.ok) {
      return fail(
        name,
        title,
        `streaming request returned HTTP ${sse.status}; a router cannot fall back without a status contract`,
        {
          metrics: { http_status: sse.status, content_type: sse.contentType || null },
          request: sse.request,
          response: sse.response,
          durationMs: sse.durationMs,
        },
      );
    }
    if (!/text\/event-stream/i.test(sse.contentType)) {
      return fail(
        name,
        title,
        `stream=true was answered with content-type "${sse.contentType || 'none'}" - streaming is not actually implemented`,
        {
          metrics: { http_status: sse.status, content_type: sse.contentType || null },
          request: sse.request,
          response: sse.response,
          durationMs: sse.durationMs,
        },
      );
    }
    if (sse.events.length === 0) {
      return fail(name, title, 'SSE response contained no data frames', {
        metrics: { http_status: sse.status, frames: 0 },
        request: sse.request,
        response: sse.response,
        durationMs: sse.durationMs,
      });
    }

    // --- frame-level parsing -------------------------------------------------
    const doneIndex = sse.events.findIndex((e) => e.data.trim() === '[DONE]');
    const dataFrames = sse.events.filter((e) => e.data.trim() !== '[DONE]');

    const badFrames: string[] = [];
    let finishReasons: string[] = [];
    let text = '';
    let sawRole = false;
    for (const frame of dataFrames) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.data);
      } catch {
        badFrames.push(frame.data.slice(0, 120));
        continue;
      }
      if (!isRecord(parsed)) {
        badFrames.push(frame.data.slice(0, 120));
        continue;
      }
      const choices = parsed['choices'];
      if (!Array.isArray(choices)) continue;
      for (const c of choices) {
        if (!isRecord(c)) continue;
        const fr = c['finish_reason'];
        if (typeof fr === 'string' && fr.length > 0) finishReasons.push(fr);
        const delta = isRecord(c['delta']) ? c['delta'] : undefined;
        if (delta?.['role'] !== undefined) sawRole = true;
        const piece = delta?.['content'] ?? c['text'];
        if (typeof piece === 'string') text += piece;
        else if (Array.isArray(piece)) {
          for (const part of piece) {
            const p = isRecord(part) ? part['text'] : part;
            if (typeof p === 'string') text += p;
          }
        }
      }
    }

    const finishReason = finishReasons.at(-1);
    const lastFrame = dataFrames.at(-1);

    const metrics: Metrics = {
      http_status: sse.status,
      frames: sse.events.length,
      data_frames: dataFrames.length,
      invalid_json_frames: badFrames.length,
      finish_reason: finishReason ?? null,
      finish_reason_frames: finishReasons.length,
      done_sentinel: doneIndex !== -1,
      done_sentinel_position: doneIndex === -1 ? null : doneIndex + 1,
      ttft_first_event_ms: sse.timeToFirstEventMs ?? null,
      ttft_first_token_ms: sse.timeToFirstTokenMs ?? null,
      total_ms: sse.durationMs,
      text_chars: text.length,
      role_delta_seen: sawRole,
      last_frame_has_finish_reason: finishReasons.length > 0,
    };

    const init: ResultInit = {
      metrics,
      details: {
        text: text.slice(0, 600),
        invalid_frames_sample: badFrames.slice(0, 3),
        last_frame: lastFrame?.data.slice(0, 300) ?? null,
        max_tokens: MAX_TOKENS,
        seed: SEED,
      },
      request: sse.request,
      response: sse.response,
      durationMs: sse.durationMs,
    };

    // Stage (a): the stream's own contract has to hold before any comparison is
    // meaningful.
    const frameProblems: string[] = [];
    if (badFrames.length > 0) {
      frameProblems.push(`${badFrames.length} SSE frame(s) were not valid JSON`);
    }
    if (text.trim() === '') {
      return fail(
        name,
        title,
        'the stream produced no text content; frames arrived but no delta.content was ever set',
        init,
      );
    }
    if (finishReason === undefined) {
      frameProblems.push(
        'no frame carried finish_reason, so a truncated generation is indistinguishable from a complete one',
      );
      return fail(
        name,
        title,
        `${frameProblems.join('; ')} - tail integrity was not judged because the stream never declared a finish_reason`,
        init,
      );
    }

    // --- tail loss vs a non-streamed ground truth ---------------------------
    // Seeded identically to the streaming call, so any difference is either a
    // transport bug or ordinary sampling variance.
    const reference = await postWithSeed(ctx, {
      model: ctx.provider.model,
      messages: [{ role: 'user', content: PROMPT }],
      max_tokens: MAX_TOKENS,
      temperature: 0,
    });
    if (!reference.seedSupported) seedSupported = false;

    // A gateway can accept a seed it does not honour. models_endpoint has
    // already read the advertised parameter list, so an absent `seed` means the
    // two calls were pinned no more tightly than temperature 0 - which is
    // exactly the condition under which divergence is expected.
    const seedAdvertised = ctx.facts.supportedParameters?.includes('seed') ?? null;
    if (seedAdvertised === false) seedSupported = false;

    if (!reference.response.ok || !isRecord(reference.response.json)) {
      // Without ground truth we still know the stream itself was well-formed;
      // report the stream's own verdict and say the tail was not checked.
      Object.assign(metrics, { seed_supported: seedSupported, seed_advertised: null });
      return finish(
        warn(
          name,
          title,
          `stream was well-formed but the non-streamed ground-truth call failed (${reference.response.status || 'no response'}), so a dropped tail would not be detected`,
          init,
        ),
      );
    }

    const refText = readText(reference.response.json) ?? '';
    const refFinish = readFinish(reference.response.json);
    Object.assign(metrics, {
      seed_supported: seedSupported,
      seed_advertised: seedAdvertised,
      nonstream_text_chars: refText.length,
      nonstream_finish_reason: refFinish ?? null,
    });

    // Staged verdict, in the order that avoids false accusations.
    const verdict = judgeTail({ streamed: text, reference: refText, finishReason });

    Object.assign(metrics, {
      tail_match: verdict.kind,
      tail_length_delta_pct: verdict.deltaPct === null ? null : Math.round(verdict.deltaPct * 100),
    });

    // A finding, not a warning: the endpoint accepted a determinism control it
    // does not advertise, so anyone reading the report would otherwise assume
    // the two calls were pinned.
    if (seedAdvertised === false) {
      init.findings = [
        ...(init.findings ?? []),
        finding(
          'streaming',
          'seed_accepted_but_unsupported',
          'Seed accepted but not advertised',
          `the request carried seed=${SEED} and the endpoint accepted it (no 400), but the model's ` +
          `advertised supported_parameters are [${(ctx.facts.supportedParameters ?? []).join(', ')}], which do not include seed`,
          'the endpoint accepts and silently ignores the seed, so the streamed and non-streamed calls were pinned by temperature 0 alone - divergence between them is expected and is not evidence of a transport bug',
          { seed_requested: SEED, advertised_parameters: (ctx.facts.supportedParameters ?? []).join(',') },
        ),
      ];
    }

    if (verdict.status === 'fail') {
      return finish(fail(name, title, verdict.note, init), frameProblems);
    }
    if (verdict.status === 'warn') {
      // Say *why* the two calls could differ, so the warn is actionable
      // rather than just a number that missed a threshold.
      const unseeded = seedAdvertised === false
        ? ' (this model does not advertise seed support, so the two calls were only pinned by temperature 0)'
        : '';
      return finish(warn(name, title, `${verdict.note}${unseeded}`, init), frameProblems);
    }

    if (doneIndex === -1) {
      return finish(
        warn(
          name,
          title,
          `streamed ${dataFrames.length} frames and finished cleanly, but no [DONE] sentinel - clients that wait for it will hang until timeout`,
          init,
        ),
        frameProblems,
      );
    }

    ctx.facts.streamSupported = true;
    return finish(
      pass(
        name,
        title,
        `${dataFrames.length} frames, finish_reason="${finishReason}", [DONE] present, ${verdict.note} (TTFT ${sse.timeToFirstTokenMs ?? '?'}ms)`,
        init,
      ),
      frameProblems,
    );
  },
});

/**
 * Decide whether the stream lost its tail.
 *
 * Returns status null when the evidence cannot support a judgement, which
 * happens whenever the model stopped because it hit max_tokens: both calls are
 * then truncated by design and any difference says nothing about the transport.
 */
function judgeTail(input: {
  streamed: string;
  reference: string;
  finishReason?: string;
}): { status: 'pass' | 'warn' | 'fail'; kind: TailKind; note: string; deltaPct: number | null } {
  const streamed = input.streamed.trimEnd();
  const reference = input.reference.trimEnd();

  if (input.finishReason === 'length') {
    return {
      status: 'pass',
      kind: 'truncated-by-max-tokens',
      note: 'both calls stopped at max_tokens, so tail loss was not judged',
      deltaPct: null,
    };
  }

  if (streamed === reference) {
    return { status: 'pass', kind: 'identical', note: 'streamed text matches the non-streamed answer exactly', deltaPct: 0 };
  }

  // The dropped-chunk signature: everything the stream emitted is there, and
  // the non-streamed answer continues past it.
  if (reference.length > streamed.length && reference.startsWith(streamed)) {
    return {
      status: 'fail',
      kind: 'prefix',
      note:
        `the stream is a strict prefix of the non-streamed answer ` +
        `(${streamed.length} chars vs ${reference.length}), which is the signature of a dropped final chunk`,
      deltaPct: pct(streamed.length, reference.length),
    };
  }

  const deltaPct = pct(streamed.length, reference.length);
  if (deltaPct !== null && deltaPct <= LENGTH_TOLERANCE) {
    return {
      status: 'pass',
      kind: 'equivalent-length',
      note: `streamed and non-streamed lengths agree within ${Math.round(deltaPct * 100)}%`,
      deltaPct,
    };
  }

  return {
    status: 'warn',
    kind: 'diverged',
    note:
      `streamed and non-streamed responses diverge (${streamed.length} vs ${reference.length} chars` +
      `${deltaPct === null ? '' : `, ${Math.round(deltaPct * 100)}%`}); likely sampling, not a dropped chunk`,
    deltaPct,
  };
}

type TailKind = 'identical' | 'prefix' | 'equivalent-length' | 'diverged' | 'truncated-by-max-tokens';

function pct(a: number, b: number): number | null {
  if (b === 0) return null;
  return Math.abs(a - b) / b;
}

/**
 * POST with a seed, retrying once without it if the endpoint rejects the
 * field. Some providers only support seed for a subset of models, and a bare
 * 400 must not be mistaken for that when the real problem is a bad key - so
 * the retry only fires when the error text actually names the parameter.
 */
async function postWithSeed(
  ctx: CheckContext,
  body: Record<string, unknown>,
): Promise<{ response: HttpResult; seedSupported: boolean }> {
  const withSeed = await ctx.http.request({
    method: 'POST',
    path: '/chat/completions',
    body: ctx.body({ ...body, seed: SEED }),
  });

  if (!rejectedSeed(withSeed)) return { response: withSeed, seedSupported: true };

  const without = await ctx.http.request({ method: 'POST', path: '/chat/completions', body: ctx.body(body) });
  return { response: without, seedSupported: false };
}

/** Streaming equivalent of postWithSeed, so both calls agree on the seed. */
async function streamWithSeed(
  ctx: CheckContext,
  body: Record<string, unknown>,
): Promise<{ response: SseResult; seedSupported: boolean }> {
  const withSeed = await ctx.http.stream({
    method: 'POST',
    path: '/chat/completions',
    body: ctx.body({ ...body, seed: SEED }),
  });

  if (!rejectedSeed(withSeed)) return { response: withSeed, seedSupported: true };

  ctx.log('streaming', 'endpoint rejected the seed parameter; retrying without it');
  const without = await ctx.http.stream({ method: 'POST', path: '/chat/completions', body: ctx.body(body) });
  return { response: without, seedSupported: false };
}

function rejectedSeed(res: { status: number; text?: string; response?: { body?: unknown } }): boolean {
  if (res.status !== 400 && res.status !== 422) return false;
  const text = res.text ?? (typeof res.response?.body === 'string' ? res.response.body : '');
  return /seed/i.test(text);
}

/** Fold frame-level problems into a result, downgrading pass to warn at worst. */
function finish(result: CheckResult, frameProblems: string[] = []): CheckResult {
  if (frameProblems.length === 0) return result;
  const note = `${result.note}${result.note ? '; ' : ''}${frameProblems.join('; ')}`;
  const status = result.status === 'pass' ? 'warn' : result.status;
  return { ...result, status, note };
}

function readText(body: Record<string, unknown>): string | undefined {
  const choices = body['choices'];
  if (!Array.isArray(choices) || !isRecord(choices[0])) return undefined;
  const msg = choices[0]['message'];
  if (!isRecord(msg)) return undefined;
  const content = msg['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (isRecord(p) && typeof p['text'] === 'string' ? p['text'] : typeof p === 'string' ? p : ''))
      .join('');
  }
  return undefined;
}

function readFinish(body: Record<string, unknown>): string | undefined {
  const choices = body['choices'];
  if (!Array.isArray(choices) || !isRecord(choices[0])) return undefined;
  const fr = choices[0]['finish_reason'];
  return typeof fr === 'string' ? fr : undefined;
}

interface TailComparison {
  kind: 'identical' | 'prefix' | 'diverged' | 'longer';
  dropped: boolean;
  detail: string;
}

function compareTail(streamed: string, reference: string): TailComparison {
  const a = streamed.trimEnd();
  const b = reference.trimEnd();
  if (a === b) return { kind: 'identical', dropped: false, detail: 'streamed text is identical to non-streamed' };
  if (b.startsWith(a)) {
    const missing = b.length - a.length;
    return {
      kind: 'prefix',
      dropped: true,
      detail: `stream is a prefix of the non-streamed answer, missing ${missing} trailing char(s)`,
    };
  }
  if (a.startsWith(b) || a.length > b.length) {
    return {
      kind: 'longer',
      dropped: false,
      detail: `stream produced ${a.length} chars vs ${b.length} non-streamed (longer, not a dropped tail)`,
    };
  }
  return {
    kind: 'diverged',
    dropped: true,
    detail: 'streamed text diverges from the non-streamed answer before the end - order or content is not stable',
  };
}

function lastChars(s: string): string {
  const t = s.trimEnd();
  return t.length <= 24 ? t : `…${t.slice(-24)}`;
}
