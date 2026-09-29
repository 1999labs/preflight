/**
 * Check 8 - latency
 *
 * A fixed ~200-token generation, repeated N times, streamed, so we can measure
 * TTFT and decode throughput separately. That separation is the point: a
 * provider with slow time-to-first-token feels broken in a chat UI even when
 * its decode rate is excellent, and the converse is just as true. A router
 * needs both to place a provider in a routing tier.
 *
 * The prompt is deterministic and set to hit the 200-token cap on purpose, so
 * every run does comparable work regardless of how the model likes to stop.
 * One warm-up run is discarded because first-call costs (model load, cold
 * connection pool) are not what a steady-state router experiences.
 */

import { defineCheck, type CheckContext } from '../registry.js';
import { fail, finding, pass, readStreamFrame, warn, type ResultInit } from './_helpers.js';
import { percentile, round } from '../http.js';
import { estimateTokens } from '../tokens.js';
import type { CheckResult, Finding, Metrics, WireRequest, WireResponse } from '../types.js';

const PROMPT = 'List the numbers 1 to 100, separated by commas, on one line. No other text.';
const MAX_TOKENS = 200;

/**
 * Shortest decode window from which a tokens/sec figure is meaningful. Below
 * this the window is dominated by scheduling jitter, so we publish nothing
 * rather than a confidently wrong number.
 */
const MIN_DECODE_WINDOW_MS = 10;

interface Run {
  index: number;
  status: number;
  ttftMs?: number;
  firstEventMs?: number;
  totalMs: number;
  outputTokens?: number;
  /** completion_tokens minus reasoning_tokens: what the user actually sees. */
  visibleTokens?: number;
  reasoningTokens?: number;
  reasoningChars?: number;
  decodeMs?: number;
  decodeWindowBasis?: 'post-ttft' | 'e2e' | 'too-short';
  tokensPerSec?: number;
  visibleTokensPerSec?: number;
  finishReason?: string;
  error?: string;
  request?: WireRequest;
  response?: WireResponse;
}

export default defineCheck({
  name: 'latency',
  title: 'Latency and throughput',
  description: 'N streamed runs of a fixed 200-token prompt; reports TTFT and output tokens/sec at p50/p95.',
  // One discarded warm-up plus the measured runs.
  requests: (opts) => opts.runs + 1,
  defaultTimeoutMs: 180_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'latency';
    const title = 'Latency and throughput';
    const runs = Math.max(1, ctx.opts.runs);
    const concurrency = Math.max(1, ctx.opts.latencyConcurrency);
    const budget = ctx.timeoutFor('latency', 180_000);
    // Leave headroom for the warm-up run and the trailing report.
    const deadline = performance.now() + budget - 1_000;

    const results: Run[] = [];
    let aborted = false;

    const measure = async (index: number): Promise<void> => {
      if (aborted) return;
      const sse = await ctx.http.stream({
        method: 'POST',
        path: '/chat/completions',
        body: ctx.body({
          model: ctx.provider.model,
          messages: [{ role: 'user', content: PROMPT }],
          max_tokens: MAX_TOKENS,
          temperature: 0,
          stream: true,
        }),
        timeoutMs: Math.max(5_000, Math.floor(budget / (runs + 2))),
      });

      const run: Run = { index, status: sse.status, totalMs: sse.durationMs };

      if (sse.status === 0 || !sse.ok) {
        run.error = sse.timedOut ? 'timeout' : sse.error ?? `HTTP ${sse.status}`;
        // Keep the wire pair from the first bad run so a partial failure is
        // reproducible from the report alone.
        run.request = sse.request;
        run.response = sse.response;
        results.push(run);
        return;
      }

      let text = '';
      let reasoningText = '';
      let usageTokens: number | undefined;
      let reasoningTokens: number | undefined;
      let finishReason: string | undefined;
      for (const ev of sse.events) {
        if (ev.data.trim() === '[DONE]') continue;
        const info = readStreamFrame(ev.data);
        text += info.content;
        reasoningText += info.reasoning;
        if (info.completionTokens !== undefined) usageTokens = info.completionTokens;
        if (info.reasoningTokens !== undefined) reasoningTokens = info.reasoningTokens;
        if (info.finishReason !== undefined) finishReason = info.finishReason;
      }

      // Reasoning models often report usage only in the final frame, and some
      // report nothing at all; fall back to estimating visible text and
      // measuring the reasoning text that did stream.
      const tokens = usageTokens ?? (text ? estimateTokens(text) : undefined);
      const ttft = sse.timeToFirstTokenMs ?? sse.timeToFirstEventMs;
      run.ttftMs = ttft;
      run.firstEventMs = sse.timeToFirstEventMs;
      run.outputTokens = tokens;
      run.reasoningTokens = reasoningTokens;
      run.reasoningChars = reasoningText.length;
      run.finishReason = finishReason;

      if (tokens !== undefined && reasoningTokens !== undefined) {
        run.visibleTokens = Math.max(0, tokens - reasoningTokens);
      } else if (usageTokens === undefined && text) {
        run.visibleTokens = estimateTokens(text);
      }

      if (tokens !== undefined && tokens > 0) {
        // The decode window is everything after the first token. If TTFT was
        // never observed (or lands at/after the end of the stream) there is no
        // window to divide by, and clamping to 1ms yields absurd throughput
        // numbers, so fall back to the full duration.
        const decodeMs = ttft === undefined || ttft >= sse.durationMs
          ? Math.max(1, sse.durationMs)
          : Math.max(1, sse.durationMs - ttft);
        run.decodeMs = decodeMs;
        if (ttft === undefined || ttft >= sse.durationMs) run.decodeWindowBasis = 'e2e';
        // Below this the window is shorter than the scheduling jitter around
        // it, and any number derived from it is noise. Report nothing rather
        // than a confident wrong figure in a launch doc.
        if (decodeMs >= MIN_DECODE_WINDOW_MS) {
          run.tokensPerSec = round((tokens / decodeMs) * 1000);
          if (run.visibleTokens !== undefined && run.visibleTokens > 0) {
            run.visibleTokensPerSec = round((run.visibleTokens / decodeMs) * 1000);
          }
        } else {
          run.decodeWindowBasis = 'too-short';
        }
      }

      // A reasoning model can spend the entire output budget thinking and emit
      // no visible content. That is a real finding, not a broken check, so it
      // gets reported rather than failed.
      if (tokens !== undefined && text.trim() === '' && (reasoningTokens ?? 0) > 0) {
        run.error = `all ${tokens} output tokens were spent on reasoning; no visible content was produced`;
      } else if (tokens === undefined) {
        run.error = 'no token counts in response and no content to estimate from';
        run.request = sse.request;
        run.response = sse.response;
      }
      results.push(run);
    };

    ctx.log('latency', `1 warm-up + ${runs} measured runs at concurrency ${concurrency}`);

    try {
      await measure(-1); // warm-up, discarded
    } catch (err) {
      return fail(name, title, `warm-up run crashed: ${err instanceof Error ? err.message : String(err)}`, {
        durationMs: 0,
      });
    }

    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, runs) }, async () => {
        while (next < runs && !aborted && performance.now() < deadline) {
          const index = next++;
          await measure(index);
        }
      }),
    );

    if (performance.now() >= deadline && next < runs) {
      aborted = true;
      ctx.log('latency', `stopped after ${next}/${runs} runs - check timeout reached`);
    }

    const ok = results.filter((r) => r.index >= 0 && !r.error);
    const failed = results.filter((r) => r.index >= 0 && r.error);
    const ttfts = ok.map((r) => r.ttftMs).filter((v): v is number => typeof v === 'number');
    const rates = ok.map((r) => r.tokensPerSec).filter((v): v is number => typeof v === 'number');
    const totals = ok.map((r) => r.totalMs);
    const tokenCounts = ok.map((r) => r.outputTokens).filter((v): v is number => typeof v === 'number');

    const attempted = results.filter((r) => r.index >= 0).length;
    const successRate = attempted > 0 ? ok.length / attempted : 0;

    const reasoningCounts = ok.map((r) => r.reasoningTokens).filter((v): v is number => typeof v === 'number');
    const reasoningCharCounts = ok.map((r) => r.reasoningChars ?? 0);
    const visibleCounts = ok.map((r) => r.visibleTokens).filter((v): v is number => typeof v === 'number');
    const visibleRates = ok.map((r) => r.visibleTokensPerSec).filter((v): v is number => typeof v === 'number');
    const reasoningStreamed = reasoningCharCounts.some((c) => c > 0);
    const reasoningReported = reasoningCounts.some((n) => n > 0);
    const reasoningPresent = reasoningReported || reasoningStreamed;
    // The provider streamed a thinking phase but billed zero reasoning tokens.
    // Token accounting that ignores it is a billing error, not a rounding
    // detail, and only the two sources disagreeing can reveal it.
    const reasoningUnderreported = reasoningStreamed && !reasoningReported;

    const metrics: Metrics = {
      runs_requested: runs,
      runs_completed: attempted,
      runs_ok: ok.length,
      runs_failed: failed.length,
      success_rate: round(successRate),
      ttft_p50_ms: ttfts.length ? percentile(ttfts, 50) : null,
      ttft_p95_ms: ttfts.length ? percentile(ttfts, 95) : null,
      ttft_min_ms: ttfts.length ? round(Math.min(...ttfts)) : null,
      tps_p50: rates.length ? percentile(rates, 50) : null,
      tps_p95: rates.length ? percentile(rates, 95) : null,
      tps_min: rates.length ? round(Math.min(...rates)) : null,
      e2e_p50_ms: totals.length ? percentile(totals, 50) : null,
      e2e_p95_ms: totals.length ? percentile(totals, 95) : null,
      output_tokens_p50: tokenCounts.length ? percentile(tokenCounts, 50) : null,
      reasoning_detected: reasoningPresent,
      reasoning_streamed: reasoningStreamed,
      reasoning_reported_tokens: reasoningCounts.length > 0,
      reasoning_underreported: reasoningUnderreported,
      reasoning_tokens_p50: reasoningCounts.length ? percentile(reasoningCounts, 50) : null,
      reasoning_tokens_total: reasoningCounts.length ? reasoningCounts.reduce((a, b) => a + b, 0) : null,
      reasoning_chars_p50: reasoningStreamed ? percentile(reasoningCharCounts, 50) : null,
      visible_tokens_p50: visibleCounts.length ? percentile(visibleCounts, 50) : null,
      visible_tps_p50: visibleRates.length ? percentile(visibleRates, 50) : null,
      throughput_unmeasurable: ok.filter((r) => r.decodeWindowBasis === 'too-short').length,
      token_source: ok.some((r) => r.outputTokens !== undefined && r.finishReason !== undefined) ? 'usage+estimate' : 'mixed',
      concurrency,
    };

    const init: ResultInit = {
      metrics,
      details: {
        prompt: PROMPT,
        max_tokens: MAX_TOKENS,
        reasoning_detected: reasoningPresent,
        runs: results
          .filter((r) => r.index >= 0)
          .sort((a, b) => a.index - b.index),
      },
      durationMs: round(ok.length + failed.length > 0 ? totals.reduce((a, b) => a + b, 0) : 0),
    };

    if (attempted === 0) {
      const first = results.at(-1);
      return fail(
        name,
        title,
        `no run completed; first attempt: ${first?.error ?? 'unknown error'}`,
        { ...init, request: first?.request, response: first?.response },
      );
    }

    if (ok.length === 0) {
      const first = failed[0];
      return fail(
        name,
        title,
        `all ${attempted} runs failed (${describeFailures(failed)})`,
        { ...init, request: first?.request, response: first?.response },
      );
    }

    if (failed.length > 0) {
      const firstFailure = failed[0]!;
      return warn(
        name,
        title,
        `${ok.length}/${attempted} runs succeeded; ${failed.length} failed (${describeFailures(failed)}) - check for rate limiting`,
        { ...init, request: firstFailure.request, response: firstFailure.response },
      );
    }

    if (reasoningUnderreported) {
      const chars = metrics['reasoning_chars_p50'];
      const p50 = percentile(ok.map((r) => r.reasoningChars ?? 0), 50);
      init.findings = [
        ...(init.findings ?? []),
        finding(
          'latency',
          'reasoning_underreported',
          'Reasoning under-reported in usage',
          `every run streamed reasoning_content (${Math.min(...ok.map((r) => r.reasoningChars ?? 0))}-` +
            `${Math.max(...ok.map((r) => r.reasoningChars ?? 0))} characters, p50 ${p50}) while usage ` +
            'reported completion_tokens_details.reasoning_tokens: 0 in all of them',
          'the provider generates reasoning but bills it as zero tokens, so per-request token budgets and cost projections will undercount; the reasoning is also absent from the reported output_tokens, so throughput is measured over visible text only',
          {
            reasoning_chars_p50: p50,
            reasoning_tokens_reported: 0,
            runs: ok.length,
            ttft_p50_ms: (metrics['ttft_p50_ms'] ?? null) as number | null,
          },
        ),
      ];
      return warn(
        name,
        title,
        `the model streams a reasoning phase (${fmtNum(chars)} chars at p50) but usage reports 0 reasoning tokens, so token-based billing and budgeting will undercount; TTFT p50 ${fmtNum(metrics['ttft_p50_ms'])}ms includes that thinking phase`,
        { ...init, request: undefined, response: undefined },
      );
    }

    const reasoningSuffix = reasoningPresent
      ? `, ${fmtNum(metrics['reasoning_tokens_p50'])} of ${fmtNum(metrics['output_tokens_p50'])} output tokens were reasoning`
      : '';

    return pass(
      name,
      title,
      `TTFT p50 ${fmtNum(metrics['ttft_p50_ms'])}ms / p95 ${fmtNum(metrics['ttft_p95_ms'])}ms, ${fmtNum(metrics['tps_p50'])} tok/s p50 over ${attempted} runs${reasoningSuffix}`,
      init,
    );
  },
});

function fmtNum(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'n/a';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function describeFailures(failed: Run[]): string {
  const counts = new Map<string, number>();
  for (const f of failed) {
    const key = f.error ?? `HTTP ${f.status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, v]) => `${k} x${v}`).join(', ');
}
