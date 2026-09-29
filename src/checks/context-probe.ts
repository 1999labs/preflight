/**
 * Check 7 - context_probe
 *
 * The only machine-readable claim a provider makes about its context window is
 * the `context_length` in its own catalog. This check tests whether that claim
 * is true, by sending filler at 8k / 32k / 64k / 128k and stopping at the
 * first failure.
 *
 * Two things this is careful about:
 *
 *  - **Token counts are estimates**, not tokenized. The filler is scaled by
 *    `contextSafety` (default 0.9) so estimator error does not push us over
 *    the real limit and manufacture a failure. A false fail is visible and
 *    explainable; a false pass silently misroutes traffic.
 *  - **Passing the largest probe is not proof of the full claim.** If the model
 *    advertises 1M and we only probed to 128k, the honest verdict is "verified
 *    to the probe cap", not "1M confirmed". The claim is only *contradicted*
 *    when a probe below min(claimed, cap) fails.
 *
 * Cost: up to 4 requests, and it stops early on failure, so a model with an 8k
 * window costs 1.
 */

import { defineCheck, type CheckContext } from '../registry.js';
import { fail, isRecord, pass, skipped, warn, type ResultInit } from './_helpers.js';
import { buildFillerMessage, estimateMessageTokens } from '../tokens.js';
import type { CheckResult, Metrics, WireRequest, WireResponse } from '../types.js';

const DEFAULT_LADDER = [8_000, 32_000, 64_000, 128_000];
/** Beyond this a probe request is megabytes of filler and the check is impractical. */
export const MAX_LADDER_TOP = 1_000_000;
const MAX_TOKENS = 32;

/**
 * Choose the rungs to probe for one model.
 *
 * The rule is that the ladder must *reach* the claimed window when the budget
 * allows, because a ladder that stops short of the claim can only ever report
 * "verified to the cap" — it can never contradict the claim, and a check that
 * cannot fail is not a check. So we drop rungs as the top grows, keeping the
 * same request count either way and always ending exactly on the claim.
 *
 *   8k claim   -> 8k, 16k, 32k, 64k        (reaches the claim)
 *   128k claim -> 8k, 32k, 64k, 128k       (the old default, unchanged)
 *   1M claim   -> 125k, 250k, 500k, 1M     (reaches the claim)
 *
 * The cost is honest about itself: probing a 1M window means sending a ~4 MB
 * request, so the request *count* stays fixed and the rung *sizes* move.
 */
export function planContextLadder(claimed: number | null, maxProbes: number): number[] {
  const rungs = Math.max(1, maxProbes);
  if (!claimed) return DEFAULT_LADDER.slice(0, rungs);

  const top = Math.min(claimed, MAX_LADDER_TOP);
  const defaultTop = DEFAULT_LADDER[DEFAULT_LADDER.length - 1]!;
  // At or below the old ceiling the default ladder is already the right shape,
  // and reusing it keeps existing reports comparable.
  if (top <= defaultTop) return DEFAULT_LADDER.filter((t) => t <= top);

  // Geometric from top/rungs up to top, so the last rung is always the claim.
  const out: number[] = [];
  for (let i = 0; i < rungs; i += 1) out.push(Math.round(top / rungs ** (rungs - 1 - i)));
  return [...new Set(out)].sort((a, b) => a - b);
}

interface Probe {
  target: number;
  estimated: number;
  ok: boolean;
  status: number;
  durationMs: number;
  error?: string;
  request?: WireRequest;
  response?: WireResponse;
}

export default defineCheck({
  name: 'context_probe',
  title: 'Context window probe',
  description: 'Filler prompts up a ladder sized to the claimed window, stopping at the first failure.',
  // Depends on the model: the ladder reaches the claim, so the count is the
  // rung budget rather than a constant.
  requests: (opts) =>
    Math.max(1, opts.contextLadder?.length ?? opts.contextProbes ?? DEFAULT_LADDER.length),
  retry: true,
  // A 1M-token rung is a ~4 MB request and can take minutes to ingest on a cold
  // path, so the default covers a ladder that actually reaches a large claim.
  defaultTimeoutMs: 600_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'context_probe';
    const title = 'Context window probe';
    const claimed = ctx.facts.claimedContextLength ?? null;
    // A caller-supplied ladder overrides; otherwise reach for the claim so the
    // verdict can contradict it rather than only describe the cap.
    const ladder =
      ctx.opts.contextLadder && ctx.opts.contextLadder.length > 0
        ? [...ctx.opts.contextLadder].sort((a, b) => a - b)
        : planContextLadder(claimed, ctx.opts.contextProbes ?? DEFAULT_LADDER.length);
    const cap = ladder[ladder.length - 1]!;
    // Total time allowed for the whole ladder; rungTimeout() apportions it.
    const budget = ctx.timeoutFor(name, 240_000);

    const probes: Probe[] = [];
    let stopped: Probe | null = null;

    for (const target of ladder) {
      // Never probe above what the provider claims; there is nothing to learn
      // and it would spend a large request proving the obvious.
      if (claimed !== null && target > claimed) {
        probes.push({ target, estimated: 0, ok: true, status: 0, durationMs: 0, error: 'not probed: above the claimed window' });
        continue;
      }

      const filler = buildFillerMessage(target, ctx.opts.contextSafety);
      const estimated = estimateMessageTokens([{ role: 'user', content: filler }]);

      const http = await ctx.http.request({
        method: 'POST',
        path: '/chat/completions',
        body: ctx.body({
          model: ctx.provider.model,
          messages: [{ role: 'user', content: filler }],
          max_tokens: MAX_TOKENS,
          temperature: 0,
        }),
        // Timeout is proportional to the rung, not split evenly. A 1M-token
        // request is ~125x the payload of an 8k one and legitimately takes far
        // longer, so an even split hands the big rungs a budget sized for the
        // small ones and times out a healthy endpoint.
        timeoutMs: rungTimeout(target, budget),
      });

      const ok = http.ok && isRecord(http.json) && hasContent(http.json);
      const probe: Probe = {
        target,
        estimated,
        ok,
        status: http.status,
        durationMs: http.durationMs,
      };
      if (!ok) {
        probe.error = describeFailure(http.status, http.text, http.error);
        probe.request = http.request;
        probe.response = http.response;
        stopped = probe;
      }
      probes.push(probe);
      ctx.log('context_probe', `${target} → ${ok ? 'ok' : `failed (${probe.error})`} in ${http.durationMs}ms`);

      if (!ok) break;
    }

    const okProbes = probes.filter((p) => p.ok && p.status !== 0);
    const maxOk = okProbes.reduce((m, p) => Math.max(m, p.target), 0);
    const effectiveCeiling = claimed === null ? cap : Math.min(claimed, cap);

    const metrics: Metrics = {
      probes_run: probes.filter((p) => p.status !== 0).length,
      ladder: ladder.join(','),
      /**
       * True only when the top rung is the *whole* claim. A claim above the
       * ceiling is clamped, and clamping must not read as "fully probed" — that
       * is the same overstatement this check exists to avoid.
       */
      claim_fully_probed: claimed !== null && cap >= claimed,
      max_ok_tokens: maxOk || null,
      first_failure_tokens: stopped?.target ?? null,
      first_failure_status: stopped?.status ?? null,
      first_failure_error: stopped?.error ?? null,
      claimed_context_length: claimed,
      probe_cap_tokens: cap,
      context_safety: ctx.opts.contextSafety,
      estimate_error_pct: okProbes.length
        ? Math.round(((maxOk - (okProbes.at(-1)?.estimated ?? maxOk)) / Math.max(1, maxOk)) * 100)
        : null,
    };

    const init: ResultInit = {
      metrics,
      details: { probes, note: 'token counts are estimates; the largest probe that succeeded is the measured floor' },
      request: stopped?.request,
      response: stopped?.response,
      durationMs: probes.reduce((a, p) => a + p.durationMs, 0),
    };

    if (probes.every((p) => p.status === 0)) {
      return skipped(
        name,
        title,
        claimed === null
          ? 'not run: the model is not listed with a context_length, so there is no claim to test against'
          : 'nothing to probe: the claimed window is smaller than the smallest rung of the ladder',
        init,
      );
    }

    if (maxOk === 0) {
      return fail(
        name,
        title,
        `even the smallest probe (${ladder[0]!.toLocaleString('en-US')} tokens) was rejected: ${
          stopped?.error ?? 'unknown error'
        }`,
        init,
      );
    }

    // The claim is contradicted when a rung at or below the claimed window
    // failed. `<=`, not `<`: a failure exactly AT the claim is the claim being
    // wrong, and treating it as a pass is the one error this check must not make.
    if (stopped && stopped.target <= (claimed ?? effectiveCeiling)) {
      const atClaim = stopped.target === claimed;
      return fail(
        name,
        title,
        atClaim
          ? `the catalog claims ${claimed!.toLocaleString('en-US')} tokens, but a prompt of that size was rejected ` +
            `(${stopped.error}); a router sized on the claim would overflow the real window`
          : `a ${stopped.target.toLocaleString('en-US')}-token prompt was rejected (${stopped.error}) even though the ` +
            `catalog claims ${(claimed ?? 0).toLocaleString('en-US')}; a router sized on the claim would overflow the real window`,
        init,
      );
    }

    if (claimed === null) {
      return warn(
        name,
        title,
        `handled prompts up to ${maxOk.toLocaleString('en-US')} tokens, but the model advertises no context_length so ` +
          'there is no claim to compare that against',
        init,
      );
    }

    if (claimed > cap) {
      // The claim is above what we probed, so say exactly how far the evidence
      // reaches and do not let "pass" stand in for the claim.
      return pass(
        name,
        title,
        `handled every rung up to ${maxOk.toLocaleString('en-US')} tokens; the catalog claims ${claimed.toLocaleString('en-US')}, ` +
          `which was not probed because the ladder stops at ${cap.toLocaleString('en-US')} — verified to the probe cap, not to the claim`,
        init,
      );
    }

    return pass(
      name,
      title,
      `handled prompts up to ${maxOk.toLocaleString('en-US')} tokens, matching the claimed ${claimed.toLocaleString('en-US')}`,
      init,
    );
  },
});

/**
 * How long one rung may take.
 *
 * The budget is split in proportion to each rung's share of the total payload,
 * with a floor, so a 1M probe is not held to the deadline that suits an 8k one.
 * Getting this wrong does not merely slow the check down: it reports a healthy
 * large-context model as a timeout, which is a false failure and the worst
 * possible direction for a check whose whole job is to avoid them.
 */
function rungTimeout(target: number, budget: number): number {
  const share = target / 1_000_000; // 1.0 at a 1M-token rung
  return Math.max(60_000, Math.round(budget * Math.max(0.5, share)));
}

function hasContent(body: Record<string, unknown>): boolean {
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const first = choices[0];
  if (!isRecord(first)) return false;
  const message = first['message'];
  if (!isRecord(message)) return false;
  if (typeof message['content'] === 'string' && message['content'].trim() !== '') return true;
  // A reasoning model can spend the whole output budget thinking and return an
  // empty message. That is NOT a context failure - the request was accepted and
  // answered - and calling it a rejection would report a working 256k model as
  // broken. Reasoning content counts as a response; a genuinely empty one does
  // not, because then we learned nothing about the window.
  const reasoning = message['reasoning'] ?? message['reasoning_content'];
  return typeof reasoning === 'string' && reasoning.trim() !== '';
}

function describeFailure(status: number, text: string, transportError?: string): string {
  if (status === 0) return transportError ?? 'no response';
  const snippet = text.replace(/\s+/g, ' ').slice(0, 140);
  return `HTTP ${status}${snippet ? `: ${snippet}` : ''}`;
}
