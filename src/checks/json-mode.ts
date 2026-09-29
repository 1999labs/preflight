/**
 * Check 5 - json_mode
 *
 * `response_format: {type: "json_object"}` is how a router keeps structured
 * output out of the prose channel. The failure modes are worth separating:
 *
 *  - the parameter is rejected outright. The catalog usually advertises
 *    `response_format`, so a 400 here means the advertised surface and the
 *    real one disagree - a `fail`, not a warning.
 *  - the parameter is accepted but ignored, and the model wraps its answer in
 *    prose. This is the dangerous one: it parses at the request level and
 *    fails at the parse level, downstream and far from the cause.
 *  - valid JSON, but not an object - an array or a bare number, which breaks
 *    callers that index fields directly.
 *
 * The prompt deliberately contains the word "json", because OpenAI-family
 * endpoints reject the parameter otherwise, and that rejection would be a
 * property of the prompt rather than the provider.
 */

import { defineCheck, type CheckContext } from '../registry.js';
import { asMetric, fail, isRecord, pass, transportFail, warn, type ResultInit } from './_helpers.js';
import type { CheckResult, Metrics } from '../types.js';

const MAX_TOKENS = 800;

const PROMPT =
  'Return a JSON object describing a deploy. It must have exactly two keys: ' +
  '"service" (a string) and "replicas" (a number). Output only the JSON object, no prose, no code fences.';

export default defineCheck({
  name: 'json_mode',
  title: 'JSON mode',
  description: 'response_format json_object returns output that parses as a JSON object.',
  requests: 1,
  retry: true,
  defaultTimeoutMs: 60_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'json_mode';
    const title = 'JSON mode';

    const http = await ctx.http.request({
      method: 'POST',
      path: '/chat/completions',
      body: ctx.body({
        model: ctx.provider.model,
        messages: [{ role: 'user', content: PROMPT }],
        response_format: { type: 'json_object' },
        max_tokens: MAX_TOKENS,
        temperature: 0,
      }),
    });

    if (http.status === 0) return transportFail(name, title, http, 'json-mode request');

    if (!http.ok) {
      const mentionsFormat = /response_format|json|not support/i.test(http.text);
      // The catalog is the arbiter here. If it does not list response_format,
      // then a rejection is the documented behaviour and saying "unsupported"
      // would blame the endpoint for a gap in OpenRouter's own metadata. If it
      // does list it, a rejection is a contract violation and a fail.
      const advertised = ctx.facts.supportedParameters?.includes('response_format') ?? null;
      let note: string;
      if (!mentionsFormat) {
        note = `a json_object request returned HTTP ${http.status}`;
      } else if (advertised === false) {
        note =
          `response_format json_object was rejected with HTTP ${http.status}, and the catalog does not list ` +
          'response_format among this model\'s supported parameters — so this is a gap in the catalog, not a defect ' +
          'in the endpoint, and a router should not route structured-output traffic here';
      } else if (advertised === true) {
        note =
          `response_format json_object was rejected with HTTP ${http.status} even though the catalog advertises it, ` +
          'so the advertised surface and the real one disagree';
      } else {
        note = `response_format json_object was rejected with HTTP ${http.status}; the catalog says nothing either way`;
      }
      return fail(name, title, note, {
        metrics: { http_status: http.status, catalog_advertises_response_format: advertised },
        request: http.request,
        response: http.response,
        durationMs: http.durationMs,
      });
    }

    const body = http.json;
    if (!isRecord(body)) {
      return fail(name, title, 'the response body is not a JSON object', {
        metrics: { http_status: http.status },
        request: http.request,
        response: http.response,
        durationMs: http.durationMs,
      });
    }

    const content = readContent(body);
    const metrics: Metrics = {
      http_status: http.status,
      duration_ms: http.durationMs,
      content_chars: content.length,
      finish_reason: asMetric(firstChoice(body)['finish_reason']),
    };

    const init: ResultInit = {
      metrics,
      request: http.request,
      response: http.response,
      durationMs: http.durationMs,
      details: { content: content.slice(0, 500) },
    };

    if (content.trim() === '') {
      return fail(name, title, 'the response carried no content to parse', init);
    }

    // Strip code fences: some providers honour the mode but still wrap the
    // result, which is a separate, lesser problem worth distinguishing.
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content.trim());
    const candidate = fenced?.[1] ?? content;

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      Object.assign(metrics, { fenced: Boolean(fenced) });
      return fail(
        name,
        title,
        `response_format was accepted but the output is not valid JSON (${
          err instanceof Error ? err.message : String(err)
        }); a structured-output caller would fail here`,
        { ...init, details: { content: content.slice(0, 500), head: content.slice(0, 120) } },
      );
    }

    if (!isRecord(parsed)) {
      Object.assign(metrics, { parsed_kind: Array.isArray(parsed) ? 'array' : typeof parsed, fenced: Boolean(fenced) });
      return warn(
        name,
        title,
        `the output parsed as valid JSON but is ${Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`}, not an object`,
        init,
      );
    }

    const keys = Object.keys(parsed);
    Object.assign(metrics, {
      parsed_kind: 'object',
      top_level_keys: keys.join(','),
      fenced: Boolean(fenced),
    });

    if (keys.length === 0) {
      return fail(name, title, 'the output parsed as an empty JSON object', init);
    }

    // A fence means the mode was honoured but the formatting was not.
    if (fenced) {
      return warn(
        name,
        title,
        `the output is valid JSON but arrived wrapped in a \`\`\` code fence, so a strict parser would need to strip it first (top-level keys: ${keys.join(', ')})`,
        init,
      );
    }

    ctx.facts.jsonModeSupported = true;
    return pass(
      name,
      title,
      `output parsed as a JSON object with keys [${keys.slice(0, 6).join(', ')}]`,
      init,
    );
  },
});

function firstChoice(body: Record<string, unknown>): Record<string, unknown> {
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return {};
  const first = choices[0];
  return isRecord(first) ? first : {};
}

function readContent(body: Record<string, unknown>): string {
  const message = firstChoice(body)['message'];
  if (!isRecord(message)) return '';
  if (typeof message['content'] === 'string') return message['content'];
  if (Array.isArray(message['content'])) {
    return message['content']
      .map((p) => (isRecord(p) && typeof p['text'] === 'string' ? p['text'] : typeof p === 'string' ? p : ''))
      .join('');
  }
  return '';
}
