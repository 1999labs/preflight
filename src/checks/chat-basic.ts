/**
 * Check 2 - chat_basic
 *
 * The floor. If a single short prompt cannot produce a well-formed
 * chat.completion, nothing downstream is worth measuring. Two things a router
 * specifically cares about beyond "did we get text":
 *
 *  - usage. Without prompt/completion token counts you cannot bill, cannot
 *    enforce a token budget, and cannot attribute spend to a tenant. Many
 *    self-hosted servers return completions with no usage block at all.
 *  - the echoed `model` field. If it disagrees with the id we asked for, the
 *    provider is silently serving something else, which invalidates every
 *    other measurement in this report.
 */

import { defineCheck, type CheckContext } from '../registry.js';
import { fail, finding, isRecord, pass, readMessageReasoning, readReasoningTokens, transportFail, warn, type ResultInit } from './_helpers.js';
import { estimateMessageTokens } from '../tokens.js';
import type { CheckResult, Finding, Metrics } from '../types.js';

const PROMPT = 'Reply with exactly the word: ready';

/**
 * Generous enough that a reasoning model still has budget left for visible
 * text after it has thought. At 16 tokens a reasoning model can legitimately
 * spend the whole allowance thinking and answer with nothing, which would look
 * identical to a broken endpoint.
 */
const MAX_TOKENS = 800;

export default defineCheck({
  name: 'chat_basic',
  title: 'Basic chat completion',
  description: 'POST /chat/completions returns a valid completion with usage fields.',
  requests: 1,
  retry: true,
  defaultTimeoutMs: 30_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'chat_basic';
    const title = 'Basic chat completion';

    const http = await ctx.http.request({
      method: 'POST',
      path: '/chat/completions',
      body: ctx.body({
        model: ctx.provider.model,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: MAX_TOKENS,
        temperature: 0,
      }),
    });

    if (http.status === 0) return transportFail(name, title, http, 'POST /chat/completions');
    if (!http.ok) {
      return fail(name, title, `POST /chat/completions returned HTTP ${http.status} for a trivial prompt`, {
        metrics: { http_status: http.status, duration_ms: http.durationMs },
        request: http.request,
        response: http.response,
        durationMs: http.durationMs,
      });
    }
    if (!/json/i.test(http.contentType)) {
      return fail(
        name,
        title,
        `response content-type is "${http.contentType || 'none'}", not JSON - a router cannot parse this`,
        {
          metrics: { http_status: http.status, content_type: http.contentType || null },
          request: http.request,
          response: http.response,
          durationMs: http.durationMs,
        },
      );
    }

    const body = http.json;
    if (!isRecord(body)) {
      return fail(name, title, 'response body is not a JSON object', {
        metrics: { http_status: http.status, bytes: http.bytes },
        request: http.request,
        response: http.response,
        durationMs: http.durationMs,
      });
    }

    const choices = body['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      return fail(name, title, 'response has no "choices" array - not a chat.completion shape', {
        metrics: { http_status: http.status, top_level_keys: Object.keys(body).slice(0, 8).join(',') },
        request: http.request,
        response: http.response,
        durationMs: http.durationMs,
      });
    }

    const first = isRecord(choices[0]) ? choices[0] : {};
    const message = isRecord(first['message']) ? first['message'] : undefined;
    if (!message) {
      return fail(name, title, 'first choice has no "message" object', {
        metrics: { http_status: http.status, choice_keys: Object.keys(first).join(',') },
        request: http.request,
        response: http.response,
        durationMs: http.durationMs,
      });
    }

    const content = message['content'];
    const contentText = typeof content === 'string' ? content : undefined;
    const refusal = typeof message['refusal'] === 'string' ? message['refusal'] : undefined;

    if ((contentText === undefined || contentText.trim() === '') && !refusal) {
      // Distinguish "the model thought and said nothing" from "the endpoint is
      // broken", because the fix is completely different.
      const usageRaw = isRecord(body['usage']) ? body['usage'] : undefined;
      const reasoning = usageRaw ? readReasoningTokens(usageRaw) : undefined;
      if (reasoning !== undefined && reasoning > 0) {
        return fail(
          name,
          title,
          `all ${reasoning} output tokens were spent on reasoning and no visible content was returned; raise max_tokens or accept that this model needs a larger budget`,
          {
            metrics: { http_status: http.status, reasoning_tokens: reasoning, visible_tokens: 0 },
            request: http.request,
            response: http.response,
            durationMs: http.durationMs,
          },
        );
      }
      return fail(name, title, 'assistant message is empty - the model returned no content', {
        metrics: { http_status: http.status, duration_ms: http.durationMs },
        request: http.request,
        response: http.response,
        durationMs: http.durationMs,
      });
    }

    const usage = readUsageFields(body);
    const echoedModel = typeof body['model'] === 'string' ? body['model'] : undefined;
    const finishReason = typeof first['finish_reason'] === 'string' ? first['finish_reason'] : undefined;
    const hasId = typeof body['id'] === 'string' && body['id'].length > 0;
    const objectType = typeof body['object'] === 'string' ? body['object'] : undefined;
    const reasoningText = readMessageReasoning(body);
    const sentTokens = estimateMessageTokens([{ role: 'user', content: PROMPT }]);
    const sentWords = PROMPT.split(/\s+/).filter(Boolean).length;

    const metrics: Metrics = {
      http_status: http.status,
      duration_ms: http.durationMs,
      response_id_present: hasId,
      object: objectType ?? null,
      echoed_model: echoedModel ?? null,
      model_echo_matches: echoedModel === undefined ? null : echoedModel === ctx.provider.model,
      finish_reason: finishReason ?? null,
      prompt_tokens: usage.promptTokens ?? null,
      completion_tokens: usage.completionTokens ?? null,
      total_tokens: usage.totalTokens ?? null,
      content_chars: (contentText ?? refusal ?? '').length,
      usage_present: usage.present,
      reasoning_tokens: usage.reasoningTokens ?? null,
    };

    const init: ResultInit = {
      metrics,
      details: { content: (contentText ?? refusal ?? '').slice(0, 500), usageRaw: usage.raw ?? null },
      findings: buildFindings({
        sentTokens,
        sentWords,
        promptTokens: usage.promptTokens,
        cachedTokens: readCachedTokens(body),
        reasoningChars: reasoningText.length,
        reasoningTokens: usage.reasoningTokens,
        latencyMs: http.durationMs,
      }),
      request: http.request,
      response: http.response,
      durationMs: http.durationMs,
    };

    const problems: string[] = [];

    if (!usage.present) {
      problems.push('no usage block, so tokens cannot be billed or budgeted');
    } else {
      if (usage.promptTokens === undefined) problems.push('usage is missing prompt/input token count');
      if (usage.completionTokens === undefined) problems.push('usage is missing completion/output token count');
    }

    if (echoedModel !== undefined && echoedModel !== ctx.provider.model) {
      problems.push(`response "model" is "${echoedModel}", not the requested "${ctx.provider.model}"`);
    }
    if (!hasId) problems.push('response has no "id" field, so responses cannot be correlated with logs');
    if (objectType !== undefined && objectType !== 'chat.completion') {
      problems.push(`"object" is "${objectType}" rather than "chat.completion"`);
    }
    if (finishReason === 'length') {
      problems.push('finish_reason is "length" - output was truncated before the model finished');
    }
    if (finishReason === 'content_filter') {
      problems.push('finish_reason is "content_filter" for a benign prompt, so filtering may be over-eager');
    }

    if (problems.length === 0) {
      return pass(
        name,
        title,
        `valid completion in ${http.durationMs}ms, ${usage.promptTokens ?? '?'}+${usage.completionTokens ?? '?'} tokens reported`,
        init,
      );
    }

    return warn(name, title, `completion is usable but ${problems.join('; ')}`, init);
  },
});

/**
 * Observations that are not pass/fail.
 *
 * Every `observed` string here is a number that came off the wire. The
 * interpretation lives in `inference` and is labelled as ours, because the
 * difference matters: the provider's own field says one thing, and what we
 * think it means is a separate claim that a reader is free to disagree with.
 */
function buildFindings(input: {
  sentTokens: number;
  sentWords: number;
  promptTokens?: number;
  cachedTokens?: number;
  reasoningChars: number;
  reasoningTokens?: number;
  latencyMs: number;
}): Finding[] {
  const out: Finding[] = [];

  // Hidden prompt overhead: a gateway can prepend a system prompt the caller
  // never sent, which changes both cost and latency for every request.
  if (
    input.promptTokens !== undefined &&
    input.promptTokens > input.sentTokens * 1.5 &&
    input.promptTokens - input.sentTokens >= 16
  ) {
    out.push(
      finding(
        'chat_basic',
        'prompt_token_overhead',
        'Prompt token overhead',
        `prompt_tokens: ${input.promptTokens} for a ${input.sentWords}-word user message we estimated at ` +
          `~${input.sentTokens} tokens` +
          (input.cachedTokens ? `, of which ${input.cachedTokens} are cached` : ''),
        'the endpoint is counting tokens we did not send, which is consistent with a server-side system prompt being prepended; budget and latency estimates built on the caller\'s own prompt will be low',
        {
          prompt_tokens: input.promptTokens,
          estimated_sent_tokens: input.sentTokens,
          cached_tokens: input.cachedTokens ?? null,
          overhead_tokens: input.promptTokens - input.sentTokens,
        },
      ),
    );
  }

  if (input.reasoningChars > 0 && (input.reasoningTokens ?? 0) === 0) {
    out.push(
      finding(
        'chat_basic',
        'reasoning_underreported',
        'Reasoning under-reported in usage',
        `message.reasoning contained ${input.reasoningChars} characters while usage reported ` +
          `completion_tokens_details.reasoning_tokens: ${input.reasoningTokens ?? 0}`,
        'the provider generated reasoning but does not count it, so token-based billing and per-request token budgets will undercount the work actually done',
        {
          reasoning_chars: input.reasoningChars,
          reasoning_tokens_reported: input.reasoningTokens ?? 0,
          completion_tokens: input.promptTokens ?? 0,
        },
      ),
    );
  }

  return out;
}

function readCachedTokens(body: Record<string, unknown>): number | undefined {
  const usage = body['usage'];
  if (!isRecord(usage)) return undefined;
  const details = usage['prompt_tokens_details'];
  if (!isRecord(details)) return undefined;
  const cached = details['cached_tokens'];
  return typeof cached === 'number' ? cached : undefined;
}

function readUsageFields(body: Record<string, unknown>): {
  present: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  raw?: unknown;
} {
  const candidates = [body['usage'], body['usageMetadata'], body['token_usage'], body['tokenUsage']];
  for (const c of candidates) {
    if (!isRecord(c)) continue;
    const pick = (...keys: string[]): number | undefined => {
      for (const k of keys) {
        const v = c[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
      }
      return undefined;
    };
    const promptTokens = pick('prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens');
    const completionTokens = pick('completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens');
    const totalTokens = pick('total_tokens', 'totalTokens');
    if (promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined) {
      return { present: true, promptTokens, completionTokens, totalTokens, raw: c };
    }
  }
  const present = candidates.some((c) => isRecord(c));
  return { present };
}
