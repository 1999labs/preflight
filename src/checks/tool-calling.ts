/**
 * Check 4 - tool_calling
 *
 * Tool calling is the feature a router is most often onboarded *for*, and the
 * one with the most ways to be subtly broken. A provider can accept a `tools`
 * array, return HTTP 200, and still produce arguments that a client cannot
 * execute - a JSON string instead of an object, a flat object where the schema
 * said nested, or a stringified value where a number was declared. All of
 * those look fine in a smoke test and blow up in the caller's process.
 *
 * The schema deliberately nests an object inside an object, because shallow
 * schemas pass on implementations that only ever copy top-level keys.
 *
 * The negative prompt matters just as much: a model that calls a tool when it
 * should not is worse than one that never calls one, because the caller cannot
 * tell a confident fabrication from a real result.
 */

import { defineCheck, type CheckContext } from '../registry.js';
import { asMetric, fail, finding, isRecord, pass, transportFail, warn, type ResultInit } from './_helpers.js';
import type { CheckResult, Finding, Metrics } from '../types.js';

const MAX_TOKENS = 800;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'record_deployment',
      description: 'Record a deployment of a service to a cluster.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service name' },
          replicas: { type: 'integer', description: 'Number of replicas' },
          limits: {
            type: 'object',
            properties: {
              cpu: { type: 'string' },
              memory: { type: 'string' },
            },
            required: ['cpu', 'memory'],
          },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['service', 'replicas', 'limits', 'tags'],
      },
    },
  },
];

const SHOULD_CALL = [
  {
    role: 'user' as const,
    content:
      'Deploy the checkout-api service with 3 replicas. Give it a cpu limit of 500m and a memory limit of 512Mi. ' +
      'Tag it canary and eu-west. Use the record_deployment tool.',
  },
];

const SHOULD_NOT_CALL = [
  {
    role: 'user' as const,
    content: 'What is the capital of France? Answer with the city name only.',
  },
];

/** What a correct nested parse must contain. */
const EXPECTED = {
  service: 'checkout-api',
  replicas: 3,
  limits: { cpu: '500m', memory: '512Mi' },
  tags: ['canary', 'eu-west'],
};

export default defineCheck({
  name: 'tool_calling',
  title: 'Tool calling',
  description: 'A nested-object tool schema yields parseable arguments, and no false positives.',
  requests: 2,
  retry: true,
  defaultTimeoutMs: 90_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'tool_calling';
    const title = 'Tool calling';

    // --- positive: should call the tool -------------------------------------
    const pos = await ctx.http.request({
      method: 'POST',
      path: '/chat/completions',
      body: ctx.body({
        model: ctx.provider.model,
        messages: SHOULD_CALL,
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: MAX_TOKENS,
        temperature: 0,
      }),
    });

    if (pos.status === 0) return transportFail(name, title, pos, 'tool-calling request');
    if (!pos.ok) {
      return fail(
        name,
        title,
        `a request with a tools array returned HTTP ${pos.status}; tool calling appears unsupported`,
        {
          metrics: { http_status: pos.status },
          request: pos.request,
          response: pos.response,
          durationMs: pos.durationMs,
        },
      );
    }

    const body = pos.json;
    if (!isRecord(body)) {
      return fail(name, title, 'the tool-calling response body is not a JSON object', {
        metrics: { http_status: pos.status },
        request: pos.request,
        response: pos.response,
        durationMs: pos.durationMs,
      });
    }

    const call = extractToolCall(body);
    const metrics: Metrics = {
      http_status: pos.status,
      duration_ms: pos.durationMs,
      tool_called: Boolean(call),
      tool_name: call?.name ?? null,
      shape: call ? shapeUsedBy(body) : null,
      finish_reason: asMetric(firstChoice(body)['finish_reason']),
    };

    const init: ResultInit = {
      metrics,
      request: pos.request,
      response: pos.response,
      durationMs: pos.durationMs,
    };

    if (!call) {
      return fail(
        name,
        title,
        'the model did not call the tool despite an explicit instruction naming it, so function-calling cannot be relied on',
        {
          ...init,
          details: { content: readText(body) },
        },
      );
    }

    if (metrics['shape'] === 'function_call') {
      init.findings = [
        ...(init.findings ?? []),
        finding(
          'tool_calling',
          'legacy_function_call',
          'Legacy function_call shape',
          'the tool call arrived in choices[0].function_call rather than choices[0].tool_calls',
          'this predates the parallel-tool-calling schema; a client written against tool_calls will see no call at all',
        ),
      ];
    }

    // Arguments must be a JSON *string* that parses into the nested shape.
    if (call.arguments === undefined) {
      return fail(name, title, `tool call "${call.name}" carried no arguments field`, init);
    }
    if (typeof call.arguments !== 'string') {
      return fail(
        name,
        title,
        `tool call arguments arrived as ${typeof call.arguments}, not a JSON string; strict clients will reject this`,
        { ...init, details: { arguments: call.arguments } },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments);
    } catch (err) {
      return fail(
        name,
        title,
        `tool call arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { ...init, details: { arguments: call.arguments.slice(0, 500) } },
      );
    }

    if (!isRecord(parsed)) {
      return fail(
        name,
        title,
        `tool call arguments parsed to ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object`,
        { ...init, details: { arguments: parsed } },
      );
    }

    const mismatches = verifyShape(parsed);
    Object.assign(metrics, {
      argument_keys: Object.keys(parsed).join(','),
      nested_limits_present: isRecord(parsed['limits']),
      shape_mismatches: mismatches.length,
    });
    init.details = { arguments: parsed, mismatches };

    if (mismatches.length > 0) {
      return fail(
        name,
        title,
        `tool call arguments do not match the nested schema: ${mismatches.join('; ')}`,
        init,
      );
    }

    ctx.facts.toolCallingSupported = true;

    // --- negative: should not call the tool --------------------------------
    const neg = await ctx.http.request({
      method: 'POST',
      path: '/chat/completions',
      body: ctx.body({
        model: ctx.provider.model,
        messages: SHOULD_NOT_CALL,
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: MAX_TOKENS,
        temperature: 0,
      }),
    });

    if (neg.status === 0) {
      return warn(
        name,
        title,
        'the tool call was correct, but the no-false-positive probe could not be completed',
        { ...init, request: neg.request, response: neg.response, durationMs: pos.durationMs + neg.durationMs },
      );
    }

    if (!neg.ok) {
      return fail(
        name,
        title,
        `the no-false-positive probe returned HTTP ${neg.status} with tools present, so ordinary chat is not unaffected by tool definitions`,
        { ...init, request: neg.request, response: neg.response },
      );
    }

    const falsePositive = extractToolCall(neg.json);
    Object.assign(metrics, {
      false_positive: Boolean(falsePositive),
      negative_content: readText(neg.json).slice(0, 120),
    });

    if (falsePositive) {
      return fail(
        name,
        title,
        `the model called ${falsePositive.name ?? 'a tool'} for a plain factual question; a caller cannot distinguish a fabricated result from a real one`,
        { ...init, request: neg.request, response: neg.response },
      );
    }

    const findings: Finding[] = init.findings ?? [];
    return pass(
      name,
      title,
      `tool call parsed into the nested schema correctly, and no tool was called for a plain question`,
      { ...init, findings, details: { ...(init.details as object), negative_answer: readText(neg.json).slice(0, 200) } },
    );
  },
});

interface ExtractedCall {
  name?: string;
  arguments?: unknown;
}

/** Accepts both the modern tool_calls shape and the legacy function_call. */
/**
 * Accepts both the modern tool_calls shape and the legacy function_call.
 *
 * Reads from `choices[0].message` first, because that is where OpenAI puts
 * them, then falls back to the choice itself for gateways that flatten the
 * message away. Getting this level wrong fails every conformant provider.
 */
function extractToolCall(body: unknown): ExtractedCall | null {
  if (!isRecord(body)) return null;
  const choice = firstChoice(body);
  const message = isRecord(choice['message']) ? choice['message'] : {};

  for (const container of [message, choice]) {
    const toolCalls = container['tool_calls'];
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const first = toolCalls[0];
      if (!isRecord(first)) continue;
      const fn = isRecord(first['function']) ? first['function'] : undefined;
      return {
        name:
          typeof fn?.['name'] === 'string'
            ? fn['name']
            : typeof first['name'] === 'string'
              ? first['name']
              : undefined,
        arguments: fn?.['arguments'] ?? first['arguments'],
      };
    }
  }

  for (const container of [message, choice]) {
    const legacy = container['function_call'];
    if (isRecord(legacy)) {
      return {
        name: typeof legacy['name'] === 'string' ? legacy['name'] : undefined,
        arguments: legacy['arguments'],
      };
    }
  }
  return null;
}

/** Which of the two container shapes actually carried the call. */
function shapeUsedBy(body: Record<string, unknown>): string {
  const choice = firstChoice(body);
  const message = isRecord(choice['message']) ? choice['message'] : {};
  for (const container of [message, choice]) {
    if (Array.isArray(container['tool_calls'])) return 'tool_calls';
  }
  return 'function_call';
}

function firstChoice(body: Record<string, unknown>): Record<string, unknown> {
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return {};
  const first = choices[0];
  return isRecord(first) ? first : {};
}

function readText(body: unknown): string {
  const choice = firstChoice(body as Record<string, unknown>);
  const message = choice['message'];
  if (isRecord(message) && typeof message['content'] === 'string') return message['content'];
  return '';
}

/** Confirms the nested object survived, not just the top-level keys. */
function verifyShape(args: Record<string, unknown>): string[] {
  const problems: string[] = [];

  if (typeof args['service'] !== 'string' || !args['service'].includes('checkout')) {
    problems.push(`service is ${JSON.stringify(args['service'])}, expected "checkout-api"`);
  }
  if (args['replicas'] !== EXPECTED.replicas) {
    problems.push(`replicas is ${JSON.stringify(args['replicas'])}, expected the number ${EXPECTED.replicas}`);
  }

  const limits = args['limits'];
  if (!isRecord(limits)) {
    problems.push('limits is missing or is not an object - nested schema was flattened or dropped');
  } else {
    if (typeof limits['cpu'] !== 'string' || !limits['cpu'].includes('500')) {
      problems.push(`limits.cpu is ${JSON.stringify(limits['cpu'])}, expected "500m"`);
    }
    if (typeof limits['memory'] !== 'string' || !String(limits['memory']).includes('512')) {
      problems.push(`limits.memory is ${JSON.stringify(limits['memory'])}, expected "512Mi"`);
    }
  }

  const tags = args['tags'];
  if (!Array.isArray(tags)) {
    problems.push('tags is missing or is not an array');
  } else {
    const tagStrings = tags.filter((t): t is string => typeof t === 'string');
    for (const expected of EXPECTED.tags) {
      if (!tagStrings.some((t) => t.toLowerCase().includes(expected))) {
        problems.push(`tags is missing "${expected}"`);
      }
    }
  }

  return problems;
}
