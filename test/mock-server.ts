/**
 * A deliberately small OpenAI-compatible server used by `npm test`.
 *
 * It exists so the checks can be verified - including their failure paths -
 * without pointing preflight at anyone's production endpoint. Each defect
 * flag reproduces a real bug we have seen gateways ship.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type Defect =
  | 'none'
  | 'no-usage'
  | 'no-done'
  | 'no-finish-reason'
  | 'drop-last-token'
  | 'models-404'
  | 'no-context-length'
  | 'wrong-model-echo'
  | 'html-500'
  | 'slow'
  | 'truncate-stream'
  | 'nondeterministic'
  | 'no-tools'
  | 'flat-tool-args'
  | 'unparseable-tool-args'
  | 'false-positive-tool'
  | 'legacy-function-call'
  | 'no-json-mode'
  | 'prose-in-json-mode'
  | 'html-error-body'
  | 'error-500'
  | 'code-not-js'
  | 'fabricate-password'
  | 'accept-oversized'
  | 'context-tiny'
  | 'vision-hallucinate'
  | 'vision-rejects-image'
  | 'structured-rejects'
  | 'structured-ignores-schema'
  | 'no-zdr'
  | 'always-429';

export interface MockOptions {
  models?: Array<{ id: string; context_length?: number }>;
  /** Return 429 on every Nth chat request. */
  rateLimitEvery?: number;
  defects?: Defect[];
  /** Artificial per-token delay for the latency check. */
  tokenDelayMs?: number;
  ttftDelayMs?: number;
  /** Emit this many reasoning tokens before any visible content, as a reasoning model would. */
  reasoningTokens?: number;
  /** Reasoning model that spends its whole budget thinking and emits no visible text. */
  reasoningOnly?: boolean;
  /** Return 400 naming "seed" when the request carries a seed field. */
  rejectSeed?: boolean;
  /** Stream reasoning text while reporting reasoning_tokens: 0, as some providers do. */
  emitReasoningText?: number;
  /** Report this many extra prompt_tokens, simulating a hidden system prompt. */
  promptTokenInflation?: number;
  /** supported_parameters advertised by /models for this mock. */
  supportedParameters?: string[];
  /** Largest prompt the mock will accept, in characters. */
  maxPromptChars?: number;
  /**
   * Make context rejections report the provider's own token counts, as several
   * real providers do, and inflate them by `inflation` to simulate a tokenizer
   * that disagrees with our estimate. `max` is the ceiling the mock claims.
   */
  tokenCountsInError?: { max: number; inflation: number };
  /**
   * Body size limit in bytes; defaults to 3 MB. A 1M-token context probe is a
   * ~4.2 MB request and a 2M rung is ~8.5 MB, so tests that probe a large claim
   * must raise this — a 413 here is the mock's limit, not the model's.
   */
  maxBodyBytes?: number;
}

export interface MockHandle {
  url: string;
  close(): Promise<void>;
  requestCount: number;
}

const PROMPT_LEN = 60;

const DEFAULTS: MockOptions = {
  models: [{ id: 'mock-model-1', context_length: 8192 }],
};

export async function startMock(options: MockOptions = {}): Promise<MockHandle> {
  const opts = { ...DEFAULTS, ...options };
  const defects = new Set(opts.defects ?? []);
  const models = opts.models ?? DEFAULTS.models!;
  let requestCount = 0;
  let chatCount = 0;

  const server: Server = createServer((req, res) => {
    requestCount += 1;
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = await readBody(req);
    const auth = req.headers['authorization'];
    const key = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : '';

    if (!key) {
      return json(res, 401, { error: { message: 'missing bearer token', type: 'invalid_request_error' } });
    }

    if (defects.has('html-500')) {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('<html><body>502 Bad Gateway from an upstream proxy</body></html>');
      return;
    }

    if (url.pathname.endsWith('/models')) {
      if (defects.has('models-404')) return json(res, 404, { error: { message: 'no catalog' } });
      const listed = models.map((m) => ({
        id: m.id,
        object: 'model',
        owned_by: 'mock',
        ...(defects.has('no-context-length') || m.context_length === undefined
          ? {}
          : { context_length: m.context_length }),
        pricing: { prompt: '0.000002', completion: '0.000008' },
        ...(opts.supportedParameters ? { supported_parameters: opts.supportedParameters } : {}),
      }));
      return json(res, 200, { object: 'list', data: listed });
    }

    if (url.pathname.endsWith('/chat/completions')) {
      chatCount += 1;
      // The exact 429 shape OpenRouter returned for the Qwen run, so the
      // blocked path is tested against a real error body.
      if (defects.has('always-429')) {
        return json(res, 429, {
          error: {
            message: 'Provider returned error',
            code: 429,
            metadata: {
              raw: 'mock-model-1 is temporarily rate-limited upstream. Please retry shortly.',
              provider_name: 'ModelRun',
              is_byok: false,
              provider_error_code: '429',
              limit_source: 'upstream_provider_shared_pool',
              remedy_hint:
                'Retry shortly, add your own provider key, or route to another provider with provider routing.',
            },
          },
          user_id: 'user_test',
        });
      }
      if (opts.rateLimitEvery && chatCount % opts.rateLimitEvery === 0) {
        return json(res, 429, { error: { message: 'rate limit exceeded', type: 'rate_limit_error' } });
      }

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body || '{}') as Record<string, unknown>;
      } catch {
        // Defect switches must be reachable by the malformed-body probe, which
        // never reaches any handler below.
        if (defects.has('error-500')) return json(res, 500, { error: { message: 'internal error' } });
        if (defects.has('html-error-body')) {
          res.writeHead(502, { 'content-type': 'text/html' });
          res.end('<html><body>Bad Gateway</body></html>');
          return;
        }
        return json(res, 400, { error: { message: 'invalid JSON body' } });
      }
      const sizeCeiling = opts.maxBodyBytes ?? 3 * 1024 * 1024;
      if (body.length > sizeCeiling && !defects.has('accept-oversized')) {
        if (defects.has('error-500')) return json(res, 500, { error: { message: 'internal error' } });
        return json(res, 413, { error: { message: 'request body too large' } });
      }
      const model = String(parsed['model'] ?? 'unknown');
      if (!models.some((m) => m.id === model)) {
        if (defects.has('error-500')) return json(res, 500, { error: { message: 'internal error' } });
        if (defects.has('html-error-body')) {
          res.writeHead(502, { 'content-type': 'text/html' });
          res.end('<html><body>Bad Gateway</body></html>');
          return;
        }
        return json(res, 404, { error: { message: `model ${model} not found`, type: 'not_found_error' } });
      }

      // A context ceiling, so context_probe has something to discover.
      const rawPrompt = String(
        (Array.isArray(parsed['messages']) ? parsed['messages'] : [])
          .map((m) => (m && typeof (m as { content?: unknown }).content === 'string' ? (m as { content: string }).content : ''))
          .join(' '),
      );
      const ceiling = defects.has('context-tiny') ? 4_000 : opts.maxPromptChars;
      if (ceiling !== undefined && rawPrompt.length > ceiling) {
        // A provider that tells you what it counted is the only way to tell a
        // short window from a low estimate, so the defect that simulates one
        // reports both numbers the way real providers do.
        if (opts.tokenCountsInError) {
          const model_ = models.find((m) => m.id === model);
          const statedMax = opts.tokenCountsInError.max;
          const counted = Math.round((rawPrompt.length / 4) * opts.tokenCountsInError.inflation);
          return json(res, 400, {
            error: {
              message:
                `This endpoint's maximum context length is ${statedMax} tokens. ` +
                `However, you requested about ${counted.toLocaleString('en-US')} tokens ` +
                `(${Math.round((rawPrompt.length / 4) * opts.tokenCountsInError.inflation).toLocaleString('en-US')} of text).`,
              code: 'context_length_exceeded',
            },
            model: model_?.id,
          });
        }
        return json(res, 400, { error: { message: 'maximum context length exceeded', code: 'context_length_exceeded' } });
      }

      const messages = (parsed['messages'] ?? []) as Array<{ content?: string }>;

      const prompt = String(messages[messages.length - 1]?.content ?? '');
      let text = respondTo(prompt);
      if (defects.has('nondeterministic')) {
        // Same prompt, materially different answer length: the model sampled.
        const salt = (chatCount % 2) * 40;
        text = `${text} ${'extra sampled words '.repeat(Math.ceil(salt / 19))}`.trim();
      }
      if (opts.rejectSeed && parsed['seed'] !== undefined) {
        return json(res, 400, {
          error: { message: "Unsupported parameter: 'seed' is not supported by this model" },
        });
      }

      const stream = parsed['stream'] === true;

      if (stream) {
        return streamResponse(res, text, opts, defects);
      }

      const usage = defects.has('no-usage')
        ? {}
        : {
            prompt_tokens: Math.round(prompt.length / 4) + (opts.promptTokenInflation ?? 0),
            completion_tokens: Math.round(text.length / 4),
            total_tokens: Math.round((prompt.length + text.length) / 4) + (opts.promptTokenInflation ?? 0),
          };

      // --- tool calling, json mode, golden prompts --------------------------
      const tools = Array.isArray(parsed['tools']) ? (parsed['tools'] as Array<Record<string, unknown>>) : [];
      const toolName = tools.length > 0 ? String((tools[0] as { function?: { name?: string } }).function?.name ?? '') : '';
      const wantsTool = /deploy the checkout-api/i.test(prompt);
      const isGoldenTool = /weather in lisbon/i.test(prompt);
      const isArith1 = /how much change/i.test(prompt);
      const isArith2 = /20 percent of 35 percent/i.test(prompt);
      const isFact1 = /first crewed moon landing/i.test(prompt);
      const isFact2 = /chemical symbol for the element gold/i.test(prompt);
      const isFormat1 = /exactly three colors/i.test(prompt);
      const isFormat2 = /boiling point of water at sea level/i.test(prompt);
      const isRefusal = /admin password/i.test(prompt);
      const isCode = /isPalindrome|flattenOnce/.test(prompt);
      const responseFormatType = (parsed['response_format'] as { type?: string } | undefined)?.type;
      const isJsonMode = responseFormatType === 'json_object';

      const overCalls = defects.has('false-positive-tool') && !wantsTool && !isGoldenTool;
      if (tools.length > 0 && (wantsTool || isGoldenTool || overCalls)) {
        if (defects.has('no-tools')) {
          return json(res, 200, completionShape(model, chatCount, 'I cannot use tools.', usage, false));
        }
        const shouldCall = wantsTool || isGoldenTool || overCalls;
        if (!shouldCall) {
          return json(res, 200, completionShape(model, chatCount, 'Paris.', usage, false));
        }
        const goodArgs = {
          service: 'checkout-api',
          replicas: 3,
          limits: { cpu: '500m', memory: '512Mi' },
          tags: ['canary', 'eu-west'],
        };
        const args = defects.has('unparseable-tool-args')
          ? '{"service": "checkout-api", '
          : defects.has('flat-tool-args')
            ? '{"service":"checkout-api","replicas":3,"cpu":"500m","memory":"512Mi","tags":["canary","eu-west"]}'
            : JSON.stringify(goodArgs);
        const fn = { name: toolName || 'record_deployment', arguments: args };
        if (defects.has('legacy-function-call')) {
          return json(res, 200, {
            id: `chatcmpl-mock-${chatCount}`,
            object: 'chat.completion',
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: null, function_call: fn }, finish_reason: 'stop' }],
            usage,
          });
        }
        return json(res, 200, {
          id: `chatcmpl-mock-${chatCount}`,
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: fn }] }, finish_reason: 'tool_calls' }],
          usage,
        });
      }

      if (isJsonMode) {
        if (defects.has('no-json-mode')) {
          return json(res, 400, { error: { message: "Unsupported parameter: 'response_format' is not supported" } });
        }
        const content = defects.has('prose-in-json-mode')
          ? 'Sure! {"service": "api", "replicas": 2}'
          : '{"service": "api", "replicas": 2}';
        return json(res, 200, completionShape(model, chatCount, content, usage, false));
      }

      if (responseFormatType === 'json_schema') {
        if (defects.has('structured-rejects')) {
          return json(res, 400, { error: { message: "Unsupported parameter: 'json_schema'" } });
        }
        const content = defects.has('structured-ignores-schema')
          ? '{"service": "api", "replicas": "three", "extra": true}'
          : '{"service": "api", "replicas": 3, "healthy": true}';
        return json(res, 200, completionShape(model, chatCount, content, usage, false));
      }

      // --- vision -----------------------------------------------------------
      if (Array.isArray((messages[messages.length - 1] as { content?: unknown } | undefined)?.content)) {
        if (defects.has('vision-rejects-image')) {
          return json(res, 400, { error: { message: 'this model does not support image input' } });
        }
        const content = defects.has('vision-hallucinate') ? 'Yes, there is text.' : 'No';
        return json(res, 200, completionShape(model, chatCount, content, usage, false));
      }

      // --- zero-data-retention probe ----------------------------------------
      if (isRecord(parsed['provider']) && (parsed['provider'] as { data_collection?: string }).data_collection === 'deny') {
        if (defects.has('no-zdr')) {
          return json(res, 400, {
            error: { message: 'No available model provider meets the data_collection requirement' },
          });
        }
        return json(res, 200, {
          ...completionShape(model, chatCount, 'ok', usage, false),
          provider: 'MockZDRProvider',
        });
      }

      if (isArith1) return json(res, 200, completionShape(model, chatCount, '29', usage, false));
      if (isArith2) return json(res, 200, completionShape(model, chatCount, '350', usage, false));
      if (isFact1) return json(res, 200, completionShape(model, chatCount, '1969', usage, false));
      if (isFact2) return json(res, 200, completionShape(model, chatCount, 'Au', usage, false));
      if (isFormat1) return json(res, 200, completionShape(model, chatCount, 'RED, BLUE, YELLOW', usage, false));
      if (isFormat2) return json(res, 200, completionShape(model, chatCount, 'one hundred', usage, false));
      if (isRefusal) {
        const content = defects.has('fabricate-password')
          ? "Sure, the admin password is hunter2."
          : "I can't help with that; I have no access to credentials.";
        return json(res, 200, completionShape(model, chatCount, content, usage, false));
      }
      if (isCode) {
        const fnName = /isPalindrome/.test(prompt) ? 'isPalindrome' : 'flattenOnce';
        const body2 = /isPalindrome/.test(prompt)
          ? `function ${fnName}(s){const t=s.toLowerCase().replace(/[^a-z0-9]/g,'');return t===[...t].reverse().join('');}`
          : `function ${fnName}(arr){return arr.flat();}`;
        const content = defects.has('code-not-js')
          ? 'Sure! First, consider the requirements. Then define the behaviour you want.'
          : `\`\`\`javascript\n${body2}\n\`\`\``;
        return json(res, 200, completionShape(model, chatCount, content, usage, false));
      }

      return json(res, 200, {
        id: `chatcmpl-mock-${chatCount}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: defects.has('wrong-model-echo') ? 'some-other-model' : model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
        usage,
      });
    }

    return json(res, 404, { error: { message: `no route for ${url.pathname}` } });
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock server failed to bind');

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requestCount,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  } as MockHandle;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function completionShape(
  model: string,
  n: number,
  content: string,
  usage: unknown,
  _unused: boolean,
): Record<string, unknown> {
  return {
    id: `chatcmpl-mock-${n}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
  };
}

function respondTo(prompt: string): string {
  if (prompt.includes('Count from 1 to 20')) {
    return Array.from({ length: 20 }, (_, i) => i + 1).join(', ') + '.';
  }
  if (prompt.includes('List the numbers 1 to 100')) {
    return Array.from({ length: 140 }, (_, i) => i + 1).join(', ') + '.';
  }
  if (prompt.includes('exactly the word')) return 'ready';
  return 'ok';
}

async function streamResponse(
  res: ServerResponse,
  text: string,
  opts: MockOptions,
  defects: Set<Defect>,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const tokens = text.match(/\S+\s*/g) ?? [text];
  const emitted = defects.has('drop-last-token') ? tokens.slice(0, -1) : tokens;

  res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);

  if (opts.ttftDelayMs) await sleep(opts.ttftDelayMs);
  if (defects.has('slow')) await sleep(2000);

  // Reasoning models stream a thinking phase before any visible content.
  if (opts.reasoningTokens || opts.emitReasoningText) {
    const budget = opts.emitReasoningText ?? opts.reasoningTokens ?? 0;
    const declared = opts.emitReasoningText ? 0 : opts.reasoningTokens ?? 0;
    const thinking = 'weighing the options '.repeat(Math.ceil(budget / 4));
    for (const piece of thinking.match(/\S+\s*/g) ?? []) {
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }] })}\n\n`,
      );
      if (opts.tokenDelayMs) await sleep(opts.tokenDelayMs);
    }
  }

  for (const token of opts.reasoningOnly ? [] : emitted) {
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: token }, finish_reason: null }] })}\n\n`,
    );
    if (opts.tokenDelayMs) await sleep(opts.tokenDelayMs);
  }

  if (defects.has('truncate-stream')) {
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`,
    );
  } else if (!defects.has('no-finish-reason')) {
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    );
  }
  // Usage arrives on its own final frame, as OpenAI-compatible reasoning
  // providers do.
  if (!defects.has('no-usage') && (opts.reasoningTokens || opts.emitReasoningText)) {
    const declared = opts.emitReasoningText ? 0 : opts.reasoningTokens ?? 0;
    const completion = declared + Math.round(text.length / 4);
    res.write(
      `data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: Math.round(PROMPT_LEN / 4),
          completion_tokens: completion,
          total_tokens: Math.round(PROMPT_LEN / 4) + completion,
          completion_tokens_details: { reasoning_tokens: declared },
        },
      })}\n\n`,
    );
  }
  if (!defects.has('no-done')) {
    res.write('data: [DONE]\n\n');
  }
  res.end();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
