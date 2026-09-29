/**
 * Check 10 - quality_smoke
 *
 * Ten fixed prompts with known answers, scored individually. The point is not
 * an absolute quality number - it is attribution. A provider that drops from
 * 9/10 to 6/10 has a specific failure, and the per-prompt breakdown says which
 * capability broke: arithmetic, code, facts, format adherence, tool use, or
 * refusal.
 *
 * Code tasks are scored structurally by default: the output must parse as
 * JavaScript and declare the required function. That catches a model that
 * returns prose or a truncated snippet without executing anything the provider
 * produced. `--code-exec` additionally runs the model-written code against a
 * real assertion suite in a child process, and is off by default because
 * executing model output is not something to do implicitly in CI.
 *
 * Refusal is scored on declining *and* not fabricating: a model that invents a
 * plausible password is worse than one that says it cannot help.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineCheck, type CheckContext } from '../registry.js';
import { fail, isRecord, pass, warn, type ResultInit } from './_helpers.js';
import { matches, type MatchKind } from '../tokens.js';
import type { CheckResult, Metrics } from '../types.js';

const MAX_TOKENS = 800;
const GOLDEN_PATH = new URL('../../prompts/golden.json', import.meta.url);

interface GoldenPrompt {
  id: string;
  category: string;
  note?: string;
  messages: Array<{ role: string; content: string }>;
  expect?: { kind: MatchKind; value: string };
  code?: { required: string[]; test?: string };
  tool?: { name: string };
}

interface Golden {
  prompts: GoldenPrompt[];
}

interface Outcome {
  id: string;
  category: string;
  passed: boolean;
  scored: string;
  output: string;
  durationMs: number;
  error?: string;
  /** True when the prompt was never answered because the endpoint was unavailable. */
  unavailable?: boolean;
  /** The status that made it unavailable, so the verdict can cite it. */
  unavailableStatus?: number;
}

export default defineCheck({
  name: 'quality_smoke',
  title: 'Quality smoke test',
  description: 'Ten golden prompts scored individually; reports x/10 with per-prompt attribution.',
  requests: 10,
  defaultTimeoutMs: 240_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'quality_smoke';
    const title = 'Quality smoke test';

    let golden: Golden;
    try {
      const { readFileSync } = await import('node:fs');
      golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
    } catch (err) {
      return fail(
        name,
        title,
        `could not load prompts/golden.json: ${err instanceof Error ? err.message : String(err)}`,
        { durationMs: 0 },
      );
    }

    if (!Array.isArray(golden.prompts) || golden.prompts.length === 0) {
      return fail(name, title, 'prompts/golden.json contains no prompts', { durationMs: 0 });
    }

    const outcomes: Outcome[] = [];
    const startedAll = performance.now();

    for (const prompt of golden.prompts) {
      const http = await ctx.http.request({
        method: 'POST',
        path: '/chat/completions',
        body: ctx.body({
          model: ctx.provider.model,
          messages: prompt.messages,
          max_tokens: MAX_TOKENS,
          temperature: 0,
          ...(prompt.tool ? { tools: [toolFor(prompt.tool.name)], tool_choice: 'auto' } : {}),
        }),
      });

      if (http.status === 0 || !http.ok) {
        outcomes.push({
          id: prompt.id,
          category: prompt.category,
          passed: false,
          scored: 'request failed',
          output: '',
          durationMs: http.durationMs,
          error: http.status === 0 ? http.error ?? 'no response' : `HTTP ${http.status}`,
          // A 429/503 is availability, not a wrong answer. Marked so the verdict
          // can tell "the model got this wrong" from "we never got to ask".
          unavailable: http.blocked === true,
          ...(http.blocked ? { unavailableStatus: http.status } : {}),
        });
        continue;
      }

      const body = http.json;
      const output = readContent(body);
      const call = extractToolName(body);
      const verdict = scorePrompt(prompt, output, call, ctx.opts.codeExec);
      outcomes.push({
        id: prompt.id,
        category: prompt.category,
        passed: verdict.passed,
        scored: verdict.scored,
        output: output.slice(0, 300),
        durationMs: http.durationMs,
        ...(verdict.error ? { error: verdict.error } : {}),
      });
    }

    const total = outcomes.length;
    const score = outcomes.filter((o) => o.passed).length;
    const failed = outcomes.filter((o) => !o.passed);
    // Prompts we never got an answer for. A score of 0/10 because the pool was
    // saturated says nothing about the model, and reporting it as a fail is the
    // exact mistake the `blocked` status exists to prevent.
    const unavailable = failed.filter((o) => o.unavailable === true);
    const byCategory = groupByCategory(outcomes);

    const metrics: Metrics = {
      score,
      total,
      percent: total > 0 ? Math.round((score / total) * 100) : 0,
      failed_ids: failed.map((o) => o.id).join(','),
      unavailable_count: unavailable.length,
      categories: Object.entries(byCategory)
        .map(([k, v]) => `${k}=${v.pass}/${v.total}`)
        .join(' '),
      code_exec_enabled: ctx.opts.codeExec,
      duration_ms: Math.round(performance.now() - startedAll),
    };

    const init: ResultInit = {
      metrics,
      details: { outcomes, by_category: byCategory, golden: 'prompts/golden.json' },
      durationMs: Math.round(performance.now() - startedAll),
    };

    // Reported as a `fail` carrying the 429, because the runner rewrites any
    // 429/503 fail into `blocked` centrally. That is the one path guaranteed to
    // agree with every other check: "we never reached it" is decided in one
    // place, not re-implemented per check.
    if (unavailable.length > 0 && unavailable.length === failed.length) {
      return fail(
        name,
        title,
        `all ${total} golden prompts were rate limited (HTTP 429/503); the model was never reached, so its quality is unknown`,
        {
          ...init,
          response: { status: unavailable[0]!.unavailableStatus ?? 429 },
        },
      );
    }

    if (score === total) {
      return pass(name, title, `${score}/${total} golden prompts scored as expected`, init);
    }
    if (unavailable.length > 0) {
      return warn(
        name,
        title,
        `${score}/${total}, but ${unavailable.length} prompt(s) were rate limited rather than answered, so the score is a floor`,
        init,
      );
    }
    if (failed.length === 1) {
      return warn(
        name,
        title,
        `${score}/${total}; missed ${failed[0]!.id} (${failed[0]!.category}): ${failed[0]!.scored}`,
        init,
      );
    }
    return fail(
      name,
      title,
      `${score}/${total}; missed ${failed.map((o) => `${o.id}`).join(', ')} - see per-prompt attribution in the report`,
      init,
    );
  },
});

function scorePrompt(
  prompt: GoldenPrompt,
  output: string,
  toolName: string | undefined,
  codeExec: boolean,
): { passed: boolean; scored: string; error?: string } {
  if (prompt.code) {
    return scoreCode(prompt, output, codeExec);
  }

  if (prompt.tool) {
    if (!toolName) {
      return { passed: false, scored: 'no tool call was returned' };
    }
    if (toolName !== prompt.tool.name) {
      return { passed: false, scored: `called "${toolName}" instead of "${prompt.tool.name}"` };
    }
    return { passed: true, scored: `called ${toolName}` };
  }

  if (!prompt.expect) {
    return { passed: true, scored: 'no assertion defined' };
  }

  const passed = matches(prompt.expect.kind, prompt.expect.value, output);
  if (passed) return { passed: true, scored: `matched ${prompt.expect.kind}` };

  if (prompt.expect.kind === 'not_contains') {
    return { passed: false, scored: `output contained the forbidden string "${prompt.expect.value}"` };
  }
  return { passed: false, scored: `did not match ${prompt.expect.kind} ${truncate(prompt.expect.value)}` };
}

/**
 * Structural by default. With --code-exec, additionally runs the model-written
 * code against the golden assertion suite in a child process with a hard
 * timeout, so a function that parses but returns the wrong answer is caught.
 */
function scoreCode(
  prompt: GoldenPrompt,
  output: string,
  codeExec: boolean,
): { passed: boolean; scored: string; error?: string } {
  const code = extractFencedCode(output) ?? output;

  const missing = (prompt.code?.required ?? []).filter((name) => !new RegExp(`\\b${name}\\b`).test(code));
  if (missing.length > 0) {
    return { passed: false, scored: `output does not define ${missing.join(', ')}` };
  }

  // Parse-only validation: catches prose answers and truncated snippets
  // without running anything the model produced.
  const parsed = parseJavaScript(code);
  if (!parsed.ok) {
    return { passed: false, scored: `output is not parseable JavaScript: ${parsed.error}` };
  }

  if (!codeExec || !prompt.code?.test) {
    return { passed: true, scored: 'defines the required function and parses as JavaScript (not executed)' };
  }

  const executed = runCodeTest(code, prompt.code.test);
  if (executed.ok) {
    return { passed: true, scored: 'the golden assertion suite passed' };
  }
  return { passed: false, scored: `the golden assertion suite failed: ${executed.error}`, error: executed.error };
}

/**
 * Executes model-generated code. Opt-in via --code-exec, run in a throwaway
 * directory in a child process with a hard timeout, and never inherits
 * anything from this process beyond node itself.
 */
function runCodeTest(code: string, test: string): { ok: boolean; error?: string } {
  let dir: string;
  let file: string;
  try {
    dir = mkdtempSync(join(tmpdir(), 'preflight-code-'));
    file = join(dir, 'candidate.js');
    writeFileSync(
      file,
      `const CODE = ${JSON.stringify(code)};\ntry {\n${test}\nconsole.log('PASS');\n} catch (e) { console.error('FAIL: ' + e.message); process.exit(1); }\n`,
      'utf8',
    );
  } catch (err) {
    return { ok: false, error: `could not stage the test: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const result = spawnSync(process.execPath, ['--disable-proto=throw', file], {
      cwd: dir,
      timeout: 5_000,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '' },
    });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 200) };
    }
    return { ok: true };
  } finally {
    try {
      rmSync(dir!, { recursive: true, force: true });
    } catch {
      /* best effort: the OS reaps temp dirs */
    }
  }
}

/** Strip markdown fences and any leading prose around a code block. */
function extractFencedCode(text: string): string | undefined {
  const match = /```(?:javascript|js|ts)?\s*\n([\s\S]*?)```/i.exec(text);
  return match?.[1];
}

/**
 * Parse-only validation via the Function constructor, which parses without
 * executing the body.
 */
function parseJavaScript(code: string): { ok: boolean; error?: string } {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 120) : String(err) };
  }
}

function groupByCategory(outcomes: Outcome[]): Record<string, { pass: number; total: number }> {
  const out: Record<string, { pass: number; total: number }> = {};
  for (const o of outcomes) {
    const bucket = (out[o.category] ??= { pass: 0, total: 0 });
    bucket.total += 1;
    if (o.passed) bucket.pass += 1;
  }
  return out;
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

function extractToolName(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!isRecord(first)) return undefined;
  // tool_calls live on the message, not the choice; some gateways flatten it.
  const message = isRecord(first['message']) ? first['message'] : {};

  for (const container of [message, first]) {
    const toolCalls = container['tool_calls'];
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const call = toolCalls[0];
      if (!isRecord(call)) continue;
      const fn = isRecord(call['function']) ? call['function'] : undefined;
      return typeof fn?.['name'] === 'string' ? fn['name'] : undefined;
    }
  }
  for (const container of [message, first]) {
    const legacy = container['function_call'];
    if (isRecord(legacy) && typeof legacy['name'] === 'string') return legacy['name'];
  }
  return undefined;
}

function toolFor(name: string): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name,
      description: 'Get the current weather for a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  };
}

function truncate(value: string): string {
  return value.length <= 40 ? value : `${value.slice(0, 40)}…`;
}
