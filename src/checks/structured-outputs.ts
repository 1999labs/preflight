/**
 * Check 12 - structured_outputs
 *
 * A sibling of json_mode, and a different contract.
 *
 * `json_mode` only asks for "valid JSON", which tells a caller nothing about
 * the shape. `structured_outputs` asks the provider to enforce a schema, and
 * that is the feature a router actually wants: an extraction pipeline can
 * index fields directly instead of validating and retrying.
 *
 * The two parameters are not interchangeable and providers frequently ship
 * one without the other. This check therefore only runs when the model
 * advertises `structured_outputs` in its catalog entry. Running it otherwise
 * would report a capability gap as if it were an endpoint defect — the same
 * distinction json_mode now draws in reverse.
 *
 * OpenRouter and OpenAI both spell the request as:
 *   response_format: { type: 'json_schema',
 *                      json_schema: { name, strict, schema } }
 */

import { defineCheck, type CheckContext } from '../registry.js';
import { fail, isRecord, pass, skipped, transportFail, warn, type ResultInit } from './_helpers.js';
import type { CheckResult, Metrics } from '../types.js';

const MAX_TOKENS = 800;

const SCHEMA = {
  type: 'object',
  properties: {
    service: { type: 'string' },
    replicas: { type: 'integer' },
    healthy: { type: 'boolean' },
  },
  required: ['service', 'replicas', 'healthy'],
  additionalProperties: false,
};

const PROMPT =
  'Report this deployment: the service is called checkout-api, it runs 3 replicas, and it is healthy. ' +
  'Return only the structured object.';

export default defineCheck({
  name: 'structured_outputs',
  title: 'Structured outputs',
  description: 'json_schema enforcement yields an object that conforms to the required schema.',
  requests: 1,
  retry: true,
  defaultTimeoutMs: 60_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'structured_outputs';
    const title = 'Structured outputs';

    const advertised = ctx.facts.supportedParameters?.includes('structured_outputs') ?? null;
    if (advertised !== true) {
      return skipped(
        name,
        title,
        'not run: the catalog does not list structured_outputs for this model, so there is no contract to test',
        { metrics: { catalog_advertises_structured_outputs: advertised } },
      );
    }

    const http = await ctx.http.request({
      method: 'POST',
      path: '/chat/completions',
      body: ctx.body({
        model: ctx.provider.model,
        messages: [{ role: 'user', content: PROMPT }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'deployment', strict: true, schema: SCHEMA },
        },
        max_tokens: MAX_TOKENS,
        temperature: 0,
      }),
    });

    if (http.status === 0) return transportFail(name, title, http, 'structured-outputs request');

    if (!http.ok) {
      return fail(
        name,
        title,
        `json_schema was rejected with HTTP ${http.status} even though the catalog advertises structured_outputs, ` +
          'so the advertised surface and the real one disagree',
        {
          metrics: { http_status: http.status, catalog_advertises_structured_outputs: true },
          request: http.request,
          response: http.response,
          durationMs: http.durationMs,
        },
      );
    }

    const content = readContent(http.json);
    const metrics: Metrics = {
      http_status: http.status,
      duration_ms: http.durationMs,
      catalog_advertises_structured_outputs: true,
      content_chars: content.length,
    };

    const init: ResultInit = {
      metrics,
      request: http.request,
      response: http.response,
      durationMs: http.durationMs,
      details: { content: content.slice(0, 400) },
    };

    if (content.trim() === '') {
      return fail(name, title, 'the response carried no content to validate against the schema', init);
    }

    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content.trim());
    const candidate = fenced?.[1] ?? content;

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      return fail(
        name,
        title,
        `structured_outputs was accepted but the output does not parse as JSON (${
          err instanceof Error ? err.message : String(err)
        }); schema enforcement is not happening`,
        { ...init, details: { content: content.slice(0, 400) } },
      );
    }

    if (!isRecord(parsed)) {
      return fail(
        name,
        title,
        `the output parsed as ${Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`}, not an object matching the schema`,
        init,
      );
    }

    const violations = validate(parsed);
    Object.assign(metrics, {
      top_level_keys: Object.keys(parsed).join(','),
      schema_violations: violations.length,
      fenced: Boolean(fenced),
    });
    init.details = { parsed, violations };

    if (violations.length > 0) {
      return fail(
        name,
        title,
        `the output parses but does not conform to the schema: ${violations.join('; ')} — with strict enforcement this shape should have been impossible to return`,
        init,
      );
    }

    ctx.facts.structuredOutputsSupported = true;
    return pass(
      name,
      title,
      `the output conformed to the required schema (${Object.keys(parsed).join(', ')})`,
      init,
    );
  },
});

/** Checks the properties strict mode claims to have enforced. */
function validate(value: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of SCHEMA.required) {
    if (!(key in value)) problems.push(`missing required key "${key}"`);
  }
  if (!problems.length) {
    if (typeof value['service'] !== 'string') problems.push(`service is ${typeof value['service']}, expected string`);
    if (typeof value['replicas'] !== 'number' || !Number.isInteger(value['replicas'])) {
      problems.push(`replicas is ${JSON.stringify(value['replicas'])}, expected integer`);
    }
    if (typeof value['healthy'] !== 'boolean') problems.push(`healthy is ${typeof value['healthy']}, expected boolean`);
  }
  for (const key of Object.keys(value)) {
    if (!(SCHEMA.required as string[]).includes(key)) {
      problems.push(`unexpected key "${key}" (the schema sets additionalProperties:false)`);
    }
  }
  return problems;
}

function readContent(body: unknown): string {
  if (!isRecord(body)) return '';
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!isRecord(first)) return '';
  const message = first['message'];
  if (!isRecord(message)) return '';
  if (typeof message['content'] === 'string') return message['content'];
  if (Array.isArray(message['content'])) {
    return message['content']
      .map((p) => (isRecord(p) && typeof p['text'] === 'string' ? p['text'] : typeof p === 'string' ? p : ''))
      .join('');
  }
  return '';
}
