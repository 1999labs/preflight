/**
 * Test harness and checks.
 *
 * Each check is verified twice: once against a well-behaved mock (must pass)
 * and once against a mock carrying the specific defect it is supposed to catch
 * (must flag). A check that cannot fail is not a check.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { startMock, type Defect, type MockOptions } from './mock-server.js';
import { classifyBlocked, HttpClient, parseRetryDelay } from '../src/http.js';
import { createRedactor } from '../src/redact.js';
import { listChecks, runCheck, type CheckContext, type CheckDef } from '../src/registry.js';
import { orderedChecks, resolveChecks } from '../src/checks/index.js';
import { buildReport, summarize, writeReport } from '../src/report.js';
import type { CheckResult, GlobalOptions, ProviderConfig } from '../src/types.js';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (err) {
    failed += 1;
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  FAIL ${name}\n         ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
}

const BASE_OPTIONS: GlobalOptions = {
  runs: 3,
  timeoutMs: 15_000,
  vision: false,
  compare: false,
  codeExec: false,
  verbose: false,
  contextSafety: 0.9,
  latencyConcurrency: 1,
  timeouts: {},
};

async function runCheckAgainst(
  name: string,
  mock: MockOptions = {},
  globalOverrides: Partial<GlobalOptions> = {},
  providerOverrides: Partial<ProviderConfig> = {},
): Promise<CheckResult> {
  const mockServer = await startMock(mock);
  try {
    const def = listChecks().find((c) => c.name === name);
    assert(def, `no check named ${name}`);
    const result = await runCheck(def, makeContext(mockServer.url, globalOverrides, providerOverrides));
    return result;
  } finally {
    await mockServer.close();
  }
}

function makeContext(
  baseUrl: string,
  globalOverrides: Partial<GlobalOptions> = {},
  providerOverrides: Partial<ProviderConfig> = {},
  facts: Record<string, unknown> = {},
): CheckContext {
  const provider: ProviderConfig = {
    id: 'mock',
    name: 'mock',
    baseUrl,
    model: 'mock-model-1',
    ...providerOverrides,
  };
  const opts: GlobalOptions = { ...BASE_OPTIONS, ...globalOverrides };
  const redactor = createRedactor([process.env['MOCK_KEY'] ?? 'test-secret-key-abcdef123456']);
  return {
    provider,
    http: new HttpClient(
      provider,
      process.env['MOCK_KEY'] ?? 'test-secret-key-abcdef123456',
      redactor,
      opts.timeoutMs,
      { maxAttempts: 1, ...(opts.retryDelayMs !== undefined ? { delayMs: opts.retryDelayMs } : {}) },
    ),
    redactor,
    opts,
    facts,
    log: () => {},
    timeoutFor: (check, fallback) => opts.timeouts[check] ?? opts.timeoutMs ?? fallback,
    body: (extra) => ({ ...(provider.extraBody ?? {}), ...(extra ?? {}) }),
  };
}

async function main(): Promise<void> {
  process.stdout.write('\nprovider-check tests\n\n');

  process.stdout.write('\ncontext_probe\n');
  await test('the ladder is sized to reach the claimed window', async () => {
    // A ladder that stops short of the claim can only ever report "verified to
    // the cap" — it cannot contradict the claim, so it is not a check. For a 1M
    // claim the rungs move up so the top one *is* the claim.
    const { planContextLadder } = await import('../src/checks/context-probe.js');

    const oneM = planContextLadder(1_000_000, 4);
    assertEqual(oneM.length, 4, 'the rung count is the request budget');
    assertEqual(oneM[oneM.length - 1], 1_000_000, 'the top rung must be the claim');
    for (let i = 1; i < oneM.length; i += 1) {
      assert(oneM[i]! > oneM[i - 1]!, `rungs must ascend: ${oneM.join(',')}`);
    }

    // At or below the old 128k ceiling the default ladder is reused unchanged,
    // so existing reports stay comparable.
    assertEqual(planContextLadder(128_000, 4).join(','), '8000,32000,64000,128000');
    // A small claim shrinks the ladder rather than sending a 1M request to an
    // 8k model.
    assert(planContextLadder(8_192, 4).at(-1)! <= 8_192, 'never probe above the claim');
    // No claim advertised: fall back to the default rather than guessing.
    assertEqual(planContextLadder(null, 4).join(','), '8000,32000,64000,128000');
    // A claim beyond the ceiling is clamped, and the clamp is what makes the
    // verdict hedge rather than claim the whole window.
    const { MAX_LADDER_TOP } = await import('../src/checks/context-probe.js');
    const huge = planContextLadder(4_000_000, 4);
    assertEqual(
      huge.at(-1)!,
      MAX_LADDER_TOP,
      'an out-of-reach claim must clamp to the ceiling, not try to send 4M tokens',
    );
    assert(huge.at(-1)! < 4_000_000, 'and the top rung must be below the claim, so the note hedges');
  });

  await test('reaches the claimed window instead of stopping at the old 128k cap', async () => {
    // A 256k claim: the old fixed ladder topped out at 128k and could only ever
    // report "verified to the cap". This one is reachable by the mock, so it
    // exercises the real HTTP path rather than just the planner.
    const server = await startMock({
      models: [{ id: 'mock-model-1', context_length: 256_000 }],
      maxBodyBytes: 4 * 1024 * 1024,
    });
    try {
      const def = listChecks().find((c) => c.name === 'context_probe')!;
      const ctx = makeContext(server.url, { timeoutMs: 240_000 }, {}, {});
      (ctx.facts as Record<string, unknown>)['claimedContextLength'] = 256_000;
      const r = await runCheck(def, ctx);
      assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
      assertEqual(r.metrics['max_ok_tokens'], 256_000, 'should reach the claimed window');
      assertEqual(r.metrics['claim_fully_probed'], true, 'the claim should be fully probed');
      assertEqual(r.metrics['probes_run'], 4, 'reaching the claim still costs the same 4 requests');
      assert(!r.note.includes('not probed'), `the claim was probed, so do not hedge: ${r.note}`);
    } finally {
      await server.close();
    }
  });

  await test('fails when a probe AT the claimed size is rejected', async () => {
    // The endpoint's own tokenizer counts ~18% higher than our estimate, so a
    // prompt sized to the claim can come in over the wire limit. That is still
    // a contradiction of the claim and must not be reported as a pass.
    // The 32k rung is scaled by the 0.9 safety factor to ~120k chars, so a
    // 110k ceiling rejects the claim-sized rung while letting 8k and 16k
    // (≈30k and ≈60k chars) through.
    const server = await startMock({
      models: [{ id: 'mock-model-1', context_length: 32_000 }],
      maxBodyBytes: 4 * 1024 * 1024,
      maxPromptChars: 110_000,
    });
    try {
      const def = listChecks().find((c) => c.name === 'context_probe')!;
      const ctx = makeContext(server.url, { contextLadder: [8_000, 16_000, 32_000] }, {}, {});
      (ctx.facts as Record<string, unknown>)['claimedContextLength'] = 32_000;
      const r = await runCheck(def, ctx);
      assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
      assert(
        r.note.includes('the catalog claims') || r.note.includes('was rejected'),
        `note should say the claim was contradicted: ${r.note}`,
      );
    } finally {
      await server.close();
    }
  });

  await test('an empty message with reasoning is a served response, not a rejection', async () => {
    // North Mini answered a 16k probe with HTTP 200 and an empty content field,
    // having spent the output budget on thinking. The old check called that a
    // context failure and reported a working 256k model as broken.
    const server = await startMock({
      models: [{ id: 'mock-model-1', context_length: 256_000 }],
      reasoningOnly: true,
      maxBodyBytes: 4 * 1024 * 1024,
    });
    try {
      const def = listChecks().find((c) => c.name === 'context_probe')!;
      const ctx = makeContext(server.url, { timeoutMs: 240_000 }, {}, {});
      (ctx.facts as Record<string, unknown>)['claimedContextLength'] = 256_000;
      const r = await runCheck(def, ctx);
      assertEqual(r.status, 'pass', `an all-reasoning response is still a response: ${r.note}`);
      assert(
        !r.note.includes('was rejected'),
        `the check must not call a 200 a rejection: ${r.note}`,
      );
      assert(r.metrics['max_ok_tokens']! > 0, 'the probe should count as having succeeded');
    } finally {
      await server.close();
    }
  });

  await test('an explicit --context-ladder overrides the planned one', async () => {
    const server = await startMock({ models: [{ id: 'mock-model-1', context_length: 1_000_000 }] });
    try {
      const def = listChecks().find((c) => c.name === 'context_probe')!;
      const ctx = makeContext(server.url, { contextLadder: [8_000, 16_000] }, {}, {});
      (ctx.facts as Record<string, unknown>)['claimedContextLength'] = 1_000_000;
      const r = await runCheck(def, ctx);
      assertEqual(r.metrics['ladder'], '8000,16000', 'the explicit ladder should be used verbatim');
      assertEqual(r.metrics['claim_fully_probed'], false, 'and it does not reach the claim');
      assertEqual(r.metrics['probes_run'], 2, 'two rungs means two requests to budget');
      assert(
        r.note.includes('not probed') || r.note.includes('probe cap'),
        `a ladder that stops short of the claim must not read as confirming it: ${r.note}`,
      );
    } finally {
      await server.close();
    }
  });

  await test('fails when a probe inside the claimed window is rejected', async () => {
    const tight = await startMock({
      models: [{ id: 'mock-model-1', context_length: 1_000_000 }],
      maxPromptChars: 60_000,
    });
    try {
      const def = listChecks().find((c) => c.name === 'context_probe')!;
      // An explicit ladder, so the expected failing rung is pinned by the test
      // rather than by whatever the planner picks for a 1M claim.
      const ctx = makeContext(
        tight.url,
        { contextLadder: [8_000, 32_000, 64_000] },
        {},
        {},
      );
      (ctx.facts as Record<string, unknown>)['claimedContextLength'] = 1_000_000;
      const r = await runCheck(def, ctx);
      assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
      assertEqual(r.metrics['first_failure_tokens'], 32000, 'should record the rung that failed');
      assertEqual(r.metrics['probes_run'], 2, 'should stop at the failure, not run the rest');
      assert(r.note.includes('would overflow'), `note should explain the routing impact: ${r.note}`);
    } finally {
      await tight.close();
    }
  });

  await test('stops at the first failure instead of burning the ladder', async () => {
    const tight = await startMock({ models: [{ id: 'mock-model-1', context_length: 16_384 }] });
    try {
      const def = listChecks().find((c) => c.name === 'context_probe')!;
      const ctx = makeContext(tight.url, {}, {}, {});
      (ctx.facts as Record<string, unknown>)['claimedContextLength'] = 16_384;
      const r = await runCheck(def, ctx);
      assert(r.metrics['probes_run']! <= 2, `should stop early, ran ${String(r.metrics['probes_run'])} probes`);
    } finally {
      await tight.close();
    }
  });

  await test('still measures a floor, with a warn, when no context_length is advertised', async () => {
    const r = await runCheckAgainst('context_probe', {}, {}, {});
    assertEqual(r.status, 'warn', `status was ${r.status}: ${r.note}`);
    assert(r.metrics['max_ok_tokens']! > 0, 'the measured floor should still be reported');
    assert(r.note.includes('no context_length'), 'the note should say there is no claim to compare against');
  });

  process.stdout.write('\nvision\n');
  await test('passes when the model correctly reports no text', async () => {
    const r = await runCheckAgainst('vision', {}, { vision: true });
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assert(r.metrics['image_bytes']! > 0, 'the generated image should be non-trivial');
  });

  await test('fails when the model hallucinates text into a textless image', async () => {
    const r = await runCheckAgainst('vision', { defects: ['vision-hallucinate'] }, { vision: true });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('did not process the image'), `note should say the image was not processed: ${r.note}`);
  });

  await test('fails when image input is rejected', async () => {
    const r = await runCheckAgainst('vision', { defects: ['vision-rejects-image'] }, { vision: true });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assertEqual(r.response?.status, 400, 'the rejection should be captured');
  });

  await test('the generated image is a well-formed PNG', async () => {
    const r = await runCheckAgainst('vision', {}, { vision: true });
    const url = (r.request?.body as { messages: Array<{ content: Array<{ image_url: { url: string } }> }> })
      .messages[0]!.content[1]!.image_url.url;
    const png = Buffer.from(url.split(',')[1]!, 'base64');
    assertEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
    assertEqual(png.readUInt32BE(16), 96, 'image width');
    assertEqual(png.readUInt32BE(20), 96, 'image height');
    assert(png.includes(Buffer.from('IEND')), 'missing IEND chunk');
  });

  process.stdout.write('\nstructured_outputs\n');
  await test('skips when the catalog does not advertise structured_outputs', async () => {
    const r = await runCheckAgainst('structured_outputs');
    assertEqual(r.status, 'skip', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('catalog'), 'skip reason should name the catalog: ' + r.note);
  });

  await test('passes when the output conforms to the schema', async () => {
    const def = listChecks().find((c) => c.name === 'structured_outputs')!;
    const server = await startMock({ supportedParameters: ['structured_outputs', 'max_tokens'] });
    try {
      const ctx = makeContext(server.url, {}, {}, {});
      (ctx.facts as Record<string, unknown>)['supportedParameters'] = ['structured_outputs', 'max_tokens'];
      const r = await runCheck(def, ctx);
      assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
      assertEqual(r.metrics['schema_violations'], 0, 'the object should conform');
    } finally {
      await server.close();
    }
  });

  await test('fails when the endpoint ignores the schema', async () => {
    const def = listChecks().find((c) => c.name === 'structured_outputs')!;
    const server = await startMock({
      defects: ['structured-ignores-schema'],
      supportedParameters: ['structured_outputs'],
    });
    try {
      const ctx = makeContext(server.url, {}, {}, {});
      (ctx.facts as Record<string, unknown>)['supportedParameters'] = ['structured_outputs'];
      const r = await runCheck(def, ctx);
      assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
      assert(r.metrics['schema_violations']! > 0, 'violations should be counted');
    } finally {
      await server.close();
    }
  });

  process.stdout.write('\ndata_policy (--zdr)\n');
  await test('passes and names the provider that served the ZDR request', async () => {
    const r = await runCheckAgainst('data_policy', {}, { dataPolicy: true });
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['served_by'], 'MockZDRProvider', 'the serving provider should be recorded');
    const f = (r.findings ?? []).find((x) => x.id === 'zdr_path_available');
    assert(f, 'expected a zdr_path_available finding');
    assert(
      String(f.evidence?.['served_by']).includes('MockZDRProvider'),
      'the finding should name which endpoint served the request',
    );
    assert(f.inference.includes('next request may not be'), 'the affirmative must stay weak');
  });

  await test('fails, not warns, when no ZDR path exists', async () => {
    const r = await runCheckAgainst('data_policy', { defects: ['no-zdr'] }, { dataPolicy: true });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    const ids = (r.findings ?? []).map((f) => f.id);
    assert(ids.includes('no_zdr_path'), `expected a no_zdr_path finding, got ${ids.join(',')}`);
  });

  process.stdout.write('\njson_mode catalog attribution\n');
  await test('blames the catalog, not the endpoint, when response_format is unlisted', async () => {
    const r = await runCheckAgainst('json_mode', { defects: ['no-json-mode'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['catalog_advertises_response_format'], null, 'the catalog is silent by default');
    assert(r.note.includes('catalog says nothing either way'), `note should be explicit: ${r.note}`);
  });

  process.stdout.write('\nmodality_claims (three-way)\n');

  async function modalityCheck(facts: Record<string, unknown>): Promise<CheckResult> {
    const server = await startMock({});
    try {
      const def = listChecks().find((c) => c.name === 'modality_claims')!;
      const ctx = makeContext(server.url, {}, {}, {});
      Object.assign(ctx.facts as Record<string, unknown>, facts);
      return await runCheck(def, ctx);
    } finally {
      await server.close();
    }
  }

  await test('flags a description claiming image input the catalog does not list', async () => {
    const r = await modalityCheck({
      catalogDescription: 'A fast model with native multimodal input support.',
      catalogModality: 'text->text',
      catalogInputModalities: ['text'],
    });
    const f = (r.findings ?? []).find((x) => x.id === 'modality_claim_vs_list');
    assert(f, `expected modality_claim_vs_list, got ${(r.findings ?? []).map((x) => x.id).join(',')}`);
    assert(f.observed.includes('multimodal'), 'the observation should quote the description');
    assert(f.observed.includes('text->text'), 'the observation should quote the listed modality');
    assert(f.inference.includes('contradicting itself'), 'the inference should name the contradiction');
  });

  await test('flags a catalog that lists image input but measures fail', async () => {
    // The one that bites: the endpoint accepts the request and does not look.
    const r = await modalityCheck({
      catalogDescription: 'A model with vision-language support.',
      catalogModality: 'text+image+video->text',
      catalogInputModalities: ['text', 'image', 'video'],
      visionVerdict: 'fail',
    });
    const f = (r.findings ?? []).find((x) => x.id === 'modality_list_vs_measured');
    assert(f, `expected modality_list_vs_measured, got ${(r.findings ?? []).map((x) => x.id).join(',')}`);
    assert(f.observed.includes('measured fail'), `observation should carry the measurement: ${f.observed}`);
    // Description and catalog agree, so only the measurement dissents.
    assertEqual(r.metrics['agreement'], 'catalog-vs-measured', 'only the measurement is out of step here');
    assert(f.inference.includes('does not look'), 'a measured fail is evidence the image is not being looked at');
  });

  await test('reports agreement when description, catalog and measurement line up', async () => {
    const r = await modalityCheck({
      catalogDescription: 'A model with native multimodal input support.',
      catalogModality: 'text+image+video->text',
      catalogInputModalities: ['text', 'image', 'video'],
      visionVerdict: 'pass',
    });
    assertEqual((r.findings ?? []).length, 0, 'no findings when everything agrees');
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['agreement'], 'catalog-and-measurement-agree', 'agreement should be recorded');
    assert(r.note.includes('not measured') === false, 'a measured pass should not say "not measured"');
  });

  await test('says not measured when vision was not run', async () => {
    const r = await modalityCheck({
      catalogDescription: 'A model with native multimodal input support.',
      catalogModality: 'text+image+video->text',
      catalogInputModalities: ['text', 'image', 'video'],
    });
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['measured'], 'not measured', 'the absence of a measurement should be explicit');
    assert(r.note.includes('not measured'), `the note should say it was not measured: ${r.note}`);
  });

  await test('an inconclusive measurement is not reported as a failure', async () => {
    // Absence of evidence is not evidence of absence.
    const r = await modalityCheck({
      catalogDescription: 'A model with vision-language support.',
      catalogModality: 'text+image+video->text',
      catalogInputModalities: ['text', 'image', 'video'],
      visionVerdict: 'inconclusive',
    });
    const f = (r.findings ?? []).find((x) => x.id === 'modality_list_vs_measured');
    assert(f, 'expected the finding to be raised');
    assert(f.inference.includes('absence of evidence'), `inference must not overstate: ${f.inference}`);
    assert(!f.inference.includes('does not look'), 'an inconclusive reply is not proof the image was ignored');
  });

  await test('flags image support present in the catalog but absent from the prose', async () => {
    const r = await modalityCheck({
      catalogDescription: 'A fast small model for everyday tasks.',
      catalogModality: 'text+image->text',
      catalogInputModalities: ['text', 'image'],
    });
    const f = (r.findings ?? []).find((x) => x.id === 'modality_understated_in_prose');
    assert(f, `expected modality_understated_in_prose, got ${(r.findings ?? []).map((x) => x.id).join(',')}`);
  });

  await test('costs zero requests and never blocks a text-only model', async () => {
    const def = listChecks().find((c) => c.name === 'modality_claims')!;
    assertEqual(def.requests, 0, 'the reconciliation must be free');
    const r = await modalityCheck({
      catalogDescription: 'A sparse mixture-of-experts model with 30B total parameters.',
      catalogModality: 'text->text',
      catalogInputModalities: ['text'],
    });
    assertEqual((r.findings ?? []).length, 0, 'a text-only model with no image claim should be quiet');
  });

  process.stdout.write('\nblocked (availability, not defect)\n');
  await test('a 429 retries once, then the transport reports it as blocked', async () => {
    const server = await startMock({ defects: ['always-429'] });
    try {
      const def = listChecks().find((c) => c.name === 'chat_basic')!;
      assertEqual(def.retry, true, 'chat_basic should opt in to one availability retry');
      const ctx = makeContext(server.url, { retryDelayMs: 1 });
      // The runner applies the per-check policy; do the same here.
      ctx.http.setMaxAttempts(2);
      const r = await runCheck(def, ctx);
      assertEqual(r.response?.status, 429, 'the 429 should be captured');
      assertEqual(r.response?.attempts, 2, 'exactly one retry should have been made');
    } finally {
      await server.close();
    }
  });

  await test('only 429 and 503 count as availability failures', async () => {
    for (const s of [429, 503]) assertEqual(classifyBlocked(s, ''), true, `${s} should be blocked`);
    for (const s of [400, 401, 404, 413, 422, 200]) {
      assertEqual(classifyBlocked(s, ''), false, `${s} is a verdict, not an outage`);
    }
  });

  await test('the retry delay honours the endpoint hint', async () => {
    assertEqual(parseRetryDelay({ headers: { 'retry-after': '3' } }), 3000, 'seconds should convert to ms');
    assertEqual(parseRetryDelay({ headers: { 'Retry-After': '7' } }), 7000, 'header lookup is case-insensitive');
    assertEqual(parseRetryDelay({ text: '{"retry_after": 2}' }), 2000, 'a body hint should be honoured');
    assertEqual(parseRetryDelay({ text: '{"error": {"message": "nope"}}' }), undefined, 'no hint means undefined');
  });

  await test('a measuring check opts out of the retry', async () => {
    const latency = listChecks().find((c) => c.name === 'latency')!;
    const quality = listChecks().find((c) => c.name === 'quality_smoke')!;
    const errors = listChecks().find((c) => c.name === 'error_handling')!;
    assert(!latency.retry, 'latency must not retry: it would hide the first failure in the measurement');
    assert(!quality.retry, 'quality_smoke must not retry: it would paper over unavailability across 10 prompts');
    assert(!errors.retry, 'error_handling must not retry: it is testing the exact status codes');
  });

  await test('the runner rewrites a 429 fail into blocked', async () => {
    const server = await startMock({ defects: ['always-429'] });
    try {
      const { runProvider } = await import('../src/runner.js');
      const provider: ProviderConfig = { id: 'm', name: 'm', baseUrl: server.url, model: 'mock-model-1' };
      const defs = listChecks().filter((c) => c.name === 'chat_basic' || c.name === 'streaming');
      const run = await runProvider(
        provider,
        'k',
        { ...BASE_OPTIONS, retryDelayMs: 1 },
        defs,
        () => {},
      );
      for (const r of run.results) {
        assertEqual(r.status, 'blocked', `${r.check} was ${r.status}: ${r.note}`);
        assert(r.note.includes('never reached'), `the note should say it was never reached: ${r.note}`);
        assert(r.response?.body !== undefined, 'the raw error body must be retained');
        assertEqual(r.metrics['attempts'], 2, 'the attempt count should be recorded');
      }
      assertEqual(run.summary.fail, 0, 'an outage must not be counted as a failure');
      assertEqual(run.summary.blocked, 2, 'both checks should be blocked');
      assertEqual(run.summary.status, 'blocked', 'the run should be blocked, not failed');
    } finally {
      await server.close();
    }
  });

  await test('a measuring check does not retry, so the failure stays visible', async () => {
    // A retry inside latency would report the timing of the second attempt and
    // hide the first failure, which is the whole measurement.
    const server = await startMock({ rateLimitEvery: 1 });
    try {
      const { runProvider } = await import('../src/runner.js');
      const provider: ProviderConfig = { id: 'm', name: 'm', baseUrl: server.url, model: 'mock-model-1' };
      const defs = listChecks().filter((c) => c.name === 'latency');
      const run = await runProvider(provider, 'k', { ...BASE_OPTIONS, runs: 2, retryDelayMs: 1 }, defs, () => {});
      const latency = run.results[0]!;
      assert(['fail', 'blocked'].includes(latency.status), `status was ${latency.status}: ${latency.note}`);
      const runs = (latency.details as { runs: Array<{ error?: string }> }).runs;
      assertEqual(runs.length, 2, 'both runs should be recorded, not silently retried');
    } finally {
      await server.close();
    }
  });

  process.stdout.write('\ndry-run cost model\n');
  await test('the worst case only doubles the checks that opt in to the retry', async () => {
    // A blanket n*2 said a saturated pool costs 68 for a 34-request plan, which
    // made day 1 look like it busted the 50/day cap and forced a gating
    // decision. But latency, quality_smoke and error_handling never retry, so
    // the real all-429 cost is well under the cap.
    const { planDryRun } = await import('../src/dry-run.js');
    const provider: ProviderConfig = {
      id: 'p', name: 'p', baseUrl: 'http://127.0.0.1:9/v1', model: 'm',
    };
    const plan = planDryRun(
      [provider],
      listChecks(),
      [],
      { ...BASE_OPTIONS, vision: true, dataPolicy: true, runs: 5 },
      50,
      new Map(),
    );
    const target = plan.targets[0]!;
    const rowFor = (n: string) => target.rows.find((r) => r.check === n)!;

    for (const n of ['latency', 'quality_smoke', 'error_handling']) {
      const row = rowFor(n);
      assertEqual(row.worstCase, row.requests, `${n} does not retry, so its worst case is its base cost`);
    }
    assertEqual(rowFor('chat_basic').worstCase, 2, 'chat_basic retries once, so it doubles');
    assertEqual(rowFor('modality_claims').worstCase, 0, 'a zero-request check cannot cost anything when blocked');

    assert(plan.worstCase < plan.total * 2, `worst case ${plan.worstCase} should be under a blanket doubling of ${plan.total * 2}`);
    assert(plan.worstCaseFits, `worst case ${plan.worstCase} should fit the cap of ${plan.cap}`);
  });

  await test('the dry-run says so when a fully blocked run would bust the cap', async () => {
    // The gate/no-gate decision depends on this being reported honestly in both
    // directions, not just the reassuring one.
    const { planDryRun, renderDryRun } = await import('../src/dry-run.js');
    const provider: ProviderConfig = {
      id: 'p', name: 'p', baseUrl: 'http://127.0.0.1:9/v1', model: 'm',
    };
    const plan = planDryRun(
      [provider],
      listChecks(),
      [],
      { ...BASE_OPTIONS, vision: true, dataPolicy: true, runs: 5 },
      // Above the base cost, below the all-429 cost: the one case where the
      // plan fits but a saturated pool would still overspend.
      34,
      new Map(),
    );
    assert(plan.fitsInOneDay, `a ${plan.total}-request plan should fit a cap of 34`);
    assert(!plan.worstCaseFits, `a ${plan.worstCase}-request worst case should bust a cap of 34`);
    const text = renderDryRun(plan);
    assert(text.includes('BUSTS THE CAP'), `expected a bust verdict: ${text}`);
  });

  process.stdout.write('\nreport size\n');
  await test('a multi-megabyte request body does not blow up the report', async () => {
    // error_handling sends a ~2 MB oversized probe and then keeps the wire pair
    // for reproduction. Captured verbatim, that one check was 4.2 MB of a
    // 4.35 MB report - the findings were unreadable inside their own file.
    const { clipCapturedBody } = await import('../src/http.js');

    const small = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    assertEqual(clipCapturedBody(small), small, 'a body under the cap must be untouched');

    const huge = { model: 'm', messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] };
    const clipped = clipCapturedBody(huge) as { truncated: boolean; original_bytes: number; keys: string[] };
    assert(clipped.truncated === true, 'an oversized body should be marked truncated');
    assert(clipped.original_bytes > 2 * 1024 * 1024, 'the real size should be recorded');
    assert(clipped.keys.includes('messages'), 'the shape should stay discoverable');
    assert(
      Buffer.byteLength(JSON.stringify(clipped), 'utf8') < 1024,
      'the replacement should be tiny, not merely smaller',
    );

    // The real end-to-end version: the check still passes, and the artifact it
    // writes is a readable size.
    const server = await startMock({});
    try {
      const dir = mkdtempSync(join(tmpdir(), 'pc-test-'));
      const out = join(dir, 'report.json');
      const run = await runProviderForTest(server.url, 'k', { error_handling: 'warn' });
      writeReport(out, buildReport([run], {}, 1), createRedactor(['k']));
      const bytes = readFileSync(out, 'utf8').length;
      assert(bytes < 200_000, `report should stay small, was ${bytes} bytes`);
    } finally {
      await server.close();
    }
  });

  await test('blocked and fail produce different exit codes', async () => {
    const server = await startMock({ defects: ['always-429'] });
    try {
      const dir = mkdtempSync(join(tmpdir(), 'pc-test-'));
      const out = join(dir, 'report.json');
      const run = (extra: string[]) =>
        new Promise<{ code: number; stdout: string }>((res) => {
          execFile(
            process.execPath,
            [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'cli.ts'),
              '--base-url', server.url, '--model', 'mock-model-1', '--key', 'test-secret-key-abcdef123456',
              '--only', 'chat_basic', '--out', out, ...extra],
            { cwd: ROOT },
            (err, stdout) => res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout }),
          );
        });

      const blockedRun = await run([]);
      assertEqual(blockedRun.code, 3, 'blocked-only should exit 3');
      assert(blockedRun.stdout.includes('BLOCKED'), `expected BLOCKED in output: ${blockedRun.stdout}`);

      const healthy = await startMock({});
      try {
        const okRun = await new Promise<{ code: number }>((res) => {
          execFile(
            process.execPath,
            [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'cli.ts'),
              '--base-url', healthy.url, '--model', 'mock-model-1', '--key', 'test-secret-key-abcdef123456',
              '--only', 'chat_basic'],
            { cwd: ROOT },
            (err) => res({ code: err ? ((err as { code?: number }).code ?? 1) : 0 }),
          );
        });
        assertEqual(okRun.code, 0, 'a healthy provider should still exit 0');
      } finally {
        await healthy.close();
      }
    } finally {
      await server.close();
    }
  });

  process.stdout.write('\nregistry\n');
  await test('every registered check appears in ORDERED_CHECKS', async () => {
    const all = orderedChecks(listChecks());
    assertEqual(all.length, listChecks().length, 'registry and ordered list differ in length');
  });

  await test('resolveChecks rejects unknown names with a helpful message', async () => {
    let message = '';
    try {
      resolveChecks(listChecks(), ['nope']);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert(message.includes('nope'), 'error should name the unknown check');
    assert(message.includes('models_endpoint'), 'error should list the known checks');
  });

  await test('duplicate check names are rejected', async () => {
    const { defineCheck } = await import('../src/registry.js');
    let threw = false;
    try {
      defineCheck({ name: 'models_endpoint', title: 'x', description: 'x', defaultTimeoutMs: 1, run: async () => {
        throw new Error('unused');
      } });
    } catch {
      threw = true;
    }
    assert(threw, 'registering a duplicate name should throw');
  });

  process.stdout.write('\nmodels_endpoint\n');
  await test('passes against a well-formed catalog', async () => {
    const r = await runCheckAgainst('models_endpoint');
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['context_length'], 8192, 'context length not extracted');
    assertEqual(r.metrics['model_listed'], true, 'model should be listed');
    assert(r.note.includes('8,192') || r.note.includes('8192'), 'note should mention the context length');
  });

  await test('warns when the catalog omits context_length', async () => {
    const r = await runCheckAgainst('models_endpoint', { defects: ['no-context-length'] });
    assertEqual(r.status, 'warn', `status was ${r.status}: ${r.note}`);
  });

  await test('fails when the requested model is absent from a multi-model catalog', async () => {
    const r = await runCheckAgainst(
      'models_endpoint',
      { models: [{ id: 'other-a', context_length: 4096 }, { id: 'other-b', context_length: 4096 }] },
      {},
      { model: 'not-listed' },
    );
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
  });

  await test('warns rather than fails when a single-model endpoint ignores the id', async () => {
    // Self-hosted single-model servers (llama.cpp, vLLM) routinely ignore the
    // model field, so this must not block a launch.
    const r = await runCheckAgainst('models_endpoint', {}, {}, { model: 'not-listed' });
    assertEqual(r.status, 'warn', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('verify routing'), `note should advise verifying routing: ${r.note}`);
  });

  await test('fails when /models 404s', async () => {
    const r = await runCheckAgainst('models_endpoint', { defects: ['models-404'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assertEqual(r.response?.status, 404, 'response status not captured');
  });

  await test('fails when the endpoint returns HTML instead of JSON', async () => {
    const r = await runCheckAgainst('models_endpoint', { defects: ['html-500'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
  });

  await test('fails (does not throw) when the host is unreachable', async () => {
    const r = await runCheckAgainst('models_endpoint', {}, {}, { baseUrl: 'http://127.0.0.1:9/v1' });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
  });

  await test('fails when the API key is rejected for catalog reads', async () => {
    const r = await runCheckAgainst(
      'models_endpoint',
      {},
      {},
      { apiKeyHeader: 'X-Api-Key', apiKeyPrefix: '' },
    );
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assertEqual(r.response?.status, 401, 'the 401 should be captured for debugging');
    assert(r.note.includes('key is rejected'), `note should name the auth problem: ${r.note}`);
  });

  process.stdout.write('\nchat_basic\n');
  await test('passes against a valid completion with usage', async () => {
    const r = await runCheckAgainst('chat_basic');
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['usage_present'], true, 'usage should be detected');
    assert(r.metrics['completion_tokens']! > 0, 'completion tokens should be reported');
  });

  await test('warns when the response omits usage', async () => {
    const r = await runCheckAgainst('chat_basic', { defects: ['no-usage'] });
    assertEqual(r.status, 'warn', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('usage'), 'note should mention usage');
  });

  await test('warns when the echoed model differs from the requested one', async () => {
    const r = await runCheckAgainst('chat_basic', { defects: ['wrong-model-echo'] });
    assertEqual(r.status, 'warn', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('some-other-model'), 'note should name the mismatched model');
  });

  await test('fails when a trivial prompt returns 500', async () => {
    const r = await runCheckAgainst('chat_basic', { defects: ['html-500'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assertEqual(r.response?.status, 500, 'should capture the 500 status');
  });

  process.stdout.write('\nstreaming\n');
  await test('passes on a well-formed SSE stream', async () => {
    const r = await runCheckAgainst('streaming');
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['done_sentinel'], true, '[DONE] should be detected');
    assertEqual(r.metrics['finish_reason'], 'stop', 'finish_reason should be detected');
    assert(r.metrics['ttft_first_token_ms'] !== null, 'TTFT should be measured');
  });

  await test('fails when the final token is dropped from the stream', async () => {
    const r = await runCheckAgainst('streaming', { defects: ['drop-last-token'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('strict prefix'), `note should name the prefix signature: ${r.note}`);
    assertEqual(r.metrics['tail_match'], 'prefix', 'tail comparison should report a prefix');
  });

  await test('does not judge the tail when the stream stopped at max_tokens', async () => {
    const r = await runCheckAgainst('streaming', { defects: ['truncate-stream', 'drop-last-token'] });
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['finish_reason'], 'length', 'finish_reason should be length');
    assertEqual(
      r.metrics['tail_match'],
      'truncated-by-max-tokens',
      'tail comparison should be suppressed when the stream is truncated by design',
    );
  });

  await test('warns rather than fails when two calls merely diverge', async () => {
    const r = await runCheckAgainst('streaming', { defects: ['nondeterministic'] });
    assertEqual(r.status, 'warn', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['tail_match'], 'diverged', 'should be classified as divergence');
    assert(r.note.includes('sampling'), `note should attribute it to sampling: ${r.note}`);
  });

  await test('passes when streamed and non-streamed lengths are close', async () => {
    const r = await runCheckAgainst('streaming');
    assert(
      ['identical', 'equivalent-length'].includes(String(r.metrics['tail_match'])),
      `unexpected tail_match: ${String(r.metrics['tail_match'])}`,
    );
    assert((r.metrics['tail_length_delta_pct'] as number) <= 15, 'lengths should be within tolerance');
  });

  await test('retries without a seed when the endpoint rejects it', async () => {
    const r = await runCheckAgainst('streaming', { rejectSeed: true });
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['seed_supported'], false, 'seed rejection should be recorded');
  });

  await test('does not claim the seed is honoured when the catalog omits it', async () => {
    // A gateway can accept a seed field and ignore it. models_endpoint has
    // already read supported_parameters, so the streaming check must not
    // present the two calls as pinned.
    const server = await startMock({});
    try {
      const def = listChecks().find((c) => c.name === 'streaming')!;
      const ctx = makeContext(server.url, {}, {}, {
        supportedParameters: ['max_tokens', 'temperature', 'tools', 'top_p'],
      });
      const r = await runCheck(def, ctx);
      assertEqual(r.metrics['seed_advertised'], false, 'seed should be seen as unadvertised');
      assertEqual(r.metrics['seed_supported'], false, 'the seed must not be claimed as honoured');
    } finally {
      await server.close();
    }
  });

  await test('does not put the whole model catalog in the report', async () => {
    const server = await startMock({
      models: Array.from({ length: 300 }, (_, i) => ({ id: `model-${i}`, context_length: 4096 })),
    });
    try {
      const def = listChecks().find((c) => c.name === 'models_endpoint')!;
      const ctx = makeContext(server.url, {}, { model: 'model-7' });
      const r = await runCheck(def, ctx);
      const facts = ctx.facts as Record<string, unknown>;
      assert(facts['modelsPayload'] === undefined, 'the raw catalog must not be stashed in facts');
      assertEqual(facts['modelListed'], true, 'the model should still be resolved');
      assertEqual(facts['claimedContextLength'], 4096, 'metadata should still be extracted');
    } finally {
      await server.close();
    }
  });

  await test('sends seed 42, temperature 0 and max_tokens 800', async () => {
    const r = await runCheckAgainst('streaming');
    const body = r.request?.body as { seed?: number; temperature?: number; max_tokens?: number };
    assertEqual(body.seed, 42, 'the streaming call should be seeded');
    assertEqual(body.temperature, 0, 'temperature should be 0');
    assertEqual(body.max_tokens, 800, 'max_tokens should leave room for reasoning');
  });

  await test('warns when the [DONE] sentinel is missing', async () => {
    const r = await runCheckAgainst('streaming', { defects: ['no-done'] });
    assertEqual(r.status, 'warn', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('[DONE]'), 'note should mention the missing sentinel');
  });

  await test('fails when no frame carries finish_reason', async () => {
    const r = await runCheckAgainst('streaming', { defects: ['no-finish-reason'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('finish_reason'), 'note should mention finish_reason');
  });

  await test('fails when streaming is not implemented at all', async () => {
    const r = await runCheckAgainst('streaming', { defects: ['no-done', 'no-finish-reason'] });
    assert(['fail'].includes(r.status), `status was ${r.status}: ${r.note}`);
  });

  process.stdout.write('\ntool_calling\n');
  await test('passes when the nested schema survives a round trip', async () => {
    const r = await runCheckAgainst('tool_calling');
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['tool_name'], 'record_deployment', 'tool name should be captured');
    assertEqual(r.metrics['nested_limits_present'], true, 'the nested object should survive');
    assertEqual(r.metrics['shape_mismatches'], 0, 'no shape mismatches expected');
    assertEqual(r.metrics['false_positive'], false, 'no tool call expected for a factual question');
  });

  await test('fails when the model ignores the tools array', async () => {
    const r = await runCheckAgainst('tool_calling', { defects: ['no-tools'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('did not call the tool'), `unexpected note: ${r.note}`);
  });

  await test('fails when the nested object is flattened away', async () => {
    const r = await runCheckAgainst('tool_calling', { defects: ['flat-tool-args'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('nested schema was flattened'), `note should name the flattening: ${r.note}`);
  });

  await test('fails when arguments are not valid JSON', async () => {
    const r = await runCheckAgainst('tool_calling', { defects: ['unparseable-tool-args'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('not valid JSON'), `note should mention invalid JSON: ${r.note}`);
  });

  await test('fails on a tool called for a plain question', async () => {
    const r = await runCheckAgainst('tool_calling', { defects: ['false-positive-tool'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('plain factual question'), `unexpected note: ${r.note}`);
  });

  await test('raises a finding for the legacy function_call shape', async () => {
    const r = await runCheckAgainst('tool_calling', { defects: ['legacy-function-call'] });
    assert(['pass', 'warn'].includes(r.status), `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['shape'], 'function_call', 'shape should be detected');
    const ids = (r.findings ?? []).map((f) => f.id);
    assert(ids.includes('legacy_function_call'), `expected a legacy_function_call finding, got ${ids.join(',')}`);
  });

  process.stdout.write('\njson_mode\n');
  await test('passes when the output parses as an object', async () => {
    const r = await runCheckAgainst('json_mode');
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['parsed_kind'], 'object', 'should parse as an object');
  });

  await test('fails when response_format is rejected', async () => {
    const r = await runCheckAgainst('json_mode', { defects: ['no-json-mode'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('rejected'), `note should say it was rejected: ${r.note}`);
  });

  await test('fails when the parameter is accepted but the output is prose', async () => {
    const r = await runCheckAgainst('json_mode', { defects: ['prose-in-json-mode'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('not valid JSON'), `note should say the output is not JSON: ${r.note}`);
  });

  process.stdout.write('\nerror_handling\n');
  await test('passes when all three probes return sensible codes', async () => {
    const r = await runCheckAgainst('error_handling', { maxPromptChars: 100_000 });
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['server_errors'], 0, 'no 5xx expected');
    assertEqual(r.metrics['html_error_bodies'], 0, 'no HTML expected');
  });

  await test('fails when a malformed request produces a 500', async () => {
    const r = await runCheckAgainst('error_handling', { defects: ['error-500'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assert(r.metrics['server_errors']! > 0, 'the 5xx should be counted');
    assert(r.note.includes('retry loop'), `note should explain the retry-loop risk: ${r.note}`);
  });

  await test('warns and keeps the wire pair when an oversized request is accepted', async () => {
    const r = await runCheckAgainst('error_handling', { defects: ['accept-oversized'] });
    assertEqual(r.status, 'warn', `status was ${r.status}: ${r.note}`);
    assert(r.response, 'the surprising probe must keep its wire pair for debugging');
    const ids = (r.findings ?? []).map((f) => f.id);
    assert(
      ids.includes('invalid_request_accepted'),
      `expected an invalid_request_accepted finding, got ${ids.join(',')}`,
    );
  });

  await test('fails when an error comes back as an HTML page', async () => {
    const r = await runCheckAgainst('error_handling', { defects: ['html-error-body'] });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assert(r.metrics['html_error_bodies']! > 0, 'the HTML body should be counted');
  });

  process.stdout.write('\ngolden prompts\n');
  await test('the golden file holds the ten required categories', async () => {
    const { readFileSync } = await import('node:fs');
    const golden = JSON.parse(readFileSync('prompts/golden.json', 'utf8')) as {
      prompts: Array<{ category: string; expect?: unknown; code?: unknown; tool?: unknown }>;
    };
    const cats = golden.prompts.map((p) => p.category);
    assertEqual(golden.prompts.length, 10, 'ten prompts expected');
    for (const expected of [
      'arithmetic', 'arithmetic', 'code', 'code', 'factual', 'factual',
      'instruction_following', 'instruction_following', 'tool_call', 'refusal',
    ]) {
      assert(cats.includes(expected), `missing category ${expected}`);
    }
    assertEqual(golden.prompts.filter((p) => p.code).length, 2, 'two code tasks expected');
    assertEqual(golden.prompts.filter((p) => p.tool).length, 1, 'one tool prompt expected');
  });

  await test('no golden prompt depends on a contested fact', async () => {
    // A prompt whose answer is genuinely ambiguous produces model-dependent
    // failures that say nothing about the provider.
    const { readFileSync } = await import('node:fs');
    const golden = JSON.parse(readFileSync('prompts/golden.json', 'utf8')) as {
      prompts: Array<{ id: string; messages: Array<{ content: string }> }>;
    };
    for (const p of golden.prompts) {
      assert(
        !/primary color/i.test(p.messages[0]?.content ?? ''),
        `${p.id} depends on which colours count as primary, which is ambiguous`,
      );
    }
  });

  process.stdout.write('\nquality_smoke\n');
  await test('scores every golden prompt and attributes failures', async () => {
    const r = await runCheckAgainst('quality_smoke');
    assertEqual(r.metrics['total'], 10, 'the golden file should hold 10 prompts');
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['score'], 10, `missed: ${String(r.metrics['failed_ids'])}`);
    const outcomes = (r.details as { outcomes: Array<{ id: string; passed: boolean }> }).outcomes;
    assertEqual(outcomes.length, 10, 'every prompt should have an outcome');
  });

  await test('scores code tasks structurally without executing them', async () => {
    const r = await runCheckAgainst('quality_smoke');
    assertEqual(r.metrics['code_exec_enabled'], false, 'code execution must be off by default');
    const outcomes = (r.details as { outcomes: Array<{ id: string; scored: string }> }).outcomes;
    const code = outcomes.find((o) => o.id === 'code-1');
    assert(code?.scored.includes('not executed'), `code task should be marked unexecuted: ${code?.scored}`);
  });

  await test('fails a code task whose output is prose rather than code', async () => {
    const r = await runCheckAgainst('quality_smoke', { defects: ['code-not-js'] });
    assert(r.status === 'fail' || r.status === 'warn', `status was ${r.status}: ${r.note}`);
    const outcomes = (r.details as { outcomes: Array<{ id: string; passed: boolean }> }).outcomes;
    assertEqual(outcomes.find((o) => o.id === 'code-1')?.passed, false, 'code-1 should have failed');
  });

  await test('catches a fabricated answer to a refusal prompt', async () => {
    const r = await runCheckAgainst('quality_smoke', { defects: ['fabricate-password'] });
    const outcomes = (r.details as { outcomes: Array<{ id: string; passed: boolean }> }).outcomes;
    assertEqual(
      outcomes.find((o) => o.id === 'refuse-1')?.passed,
      false,
      'a fabricated password must score as a failure',
    );
  });

  await test('runs the assertion suite when --code-exec is on', async () => {
    const r = await runCheckAgainst('quality_smoke', {}, { codeExec: true });
    const outcomes = (r.details as { outcomes: Array<{ id: string; scored: string }> }).outcomes;
    const code = outcomes.find((o) => o.id === 'code-1');
    assert(
      code?.scored.includes('assertion suite') || code?.scored.includes('parseable'),
      `code task should be executed or reported: ${code?.scored}`,
    );
  });

  // These go through runProvider, not runCheck: the 429 -> blocked rewrite is
  // applied centrally in the runner, so a test that calls the check directly
  // would see the pre-rewrite `fail` and wrongly conclude the fix is broken.
  await test('a fully rate-limited run is blocked, not a 0/10 failure', async () => {
    // Nemotron against a saturated pool scored 0/10 and reported FAIL, which
    // reads as "this model is unusable" when the truth is "we never got to ask".
    const server = await startMock({ defects: ['always-429'] });
    try {
      const { runProvider } = await import('../src/runner.js');
      const def = listChecks().find((c) => c.name === 'quality_smoke')!;
      const run = await runProvider(
        { id: 'm', name: 'm', baseUrl: server.url, model: 'mock-model-1' },
        'k',
        { ...BASE_OPTIONS, retryDelayMs: 1 },
        [def],
        () => {},
      );
      const r = run.results[0]!;
      assertEqual(r.status, 'blocked', `a 429 run must be blocked, was ${r.status}: ${r.note}`);
      assert(r.note.includes('never reached'), `the note should say we never reached it: ${r.note}`);
      assertEqual(r.metrics['unavailable_count'], 10, 'every prompt should be marked unavailable');
      assertEqual(r.metrics['score'], 0, 'the raw score is still reported as a floor');
    } finally {
      await server.close();
    }
  });

  await test('a partly rate-limited run warns and calls the score a floor', async () => {
    // Mixed availability: some prompts answered, some not. Not a clean pass, and
    // not a clean fail either, so it warns and says the score is a floor.
    const server = await startMock({ rateLimitEvery: 2 });
    try {
      const def = listChecks().find((c) => c.name === 'quality_smoke')!;
      const r = await runCheck(def, makeContext(server.url, { retryDelayMs: 1 }));
      assert(
        r.status === 'warn' || r.status === 'fail',
        `mixed availability should not be a clean pass, was ${r.status}`,
      );
      if (r.status === 'warn') {
        assert(r.note.includes('floor'), `the note should call the score a floor: ${r.note}`);
        assert(
          (r.metrics['unavailable_count'] as number) > 0,
          'the unavailable prompts should be counted',
        );
      }
    } finally {
      await server.close();
    }
  });

  process.stdout.write('\nfindings\n');
  await test('prompt-token overhead is reported as a finding, not a failure', async () => {
    const r = await runCheckAgainst('chat_basic', { promptTokenInflation: 150 });
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    const f = (r.findings ?? []).find((x) => x.id === 'prompt_token_overhead');
    assert(f, `expected a prompt_token_overhead finding, got ${(r.findings ?? []).map((x) => x.id).join(',')}`);
    assert(f.observed.includes('prompt_tokens'), 'the observation should quote the number');
    assert(f.inference.includes('system prompt'), 'the inference should state the reading');
    assert(f.observed !== f.inference, 'the observed fact and the inference must be distinguishable');
  });

  process.stdout.write('\nlatency\n');
  await test('reports TTFT and tokens/sec percentiles', async () => {
    const r = await runCheckAgainst('latency', { tokenDelayMs: 5, ttftDelayMs: 20 }, { runs: 4 });
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['runs_ok'], 4, 'all runs should succeed');
    assert(typeof r.metrics['ttft_p50_ms'] === 'number', 'TTFT p50 should be a number');
    assert(typeof r.metrics['tps_p50'] === 'number', 'tokens/sec p50 should be a number');
    const runs = (r.details as { runs: unknown[] }).runs;
    assertEqual(runs.length, 4, 'raw per-run timings should be retained');
  });

  await test('warns when some runs fail', async () => {
    const r = await runCheckAgainst('latency', { rateLimitEvery: 2 }, { runs: 4 });
    assertEqual(r.status, 'warn', `status was ${r.status}: ${r.note}`);
    assert(r.metrics['runs_failed']! > 0, 'failed runs should be counted');
  });

  await test('publishes no throughput figure when the decode window is too short', async () => {
    // A sub-10ms decode window is jitter, not throughput. Reporting a number
    // here would put a confidently wrong figure in a launch doc.
    const r = await runCheckAgainst('latency', {}, { runs: 2 });
    assertEqual(r.metrics['tps_p50'], null, 'throughput should be suppressed, not guessed');
    assert(r.metrics['throughput_unmeasurable']! > 0, 'suppressed runs should be counted');
  });

  await test('a partial latency failure still carries a wire pair', async () => {
    const r = await runCheckAgainst('latency', { rateLimitEvery: 2 }, { runs: 4 });
    assert(r.request, 'no request captured for a partial failure');
    assert(r.response, 'no response captured for a partial failure');
    assertEqual(r.response?.status, 429, 'should capture the rate-limit response');
  });

  await test('reports reasoning tokens separately from visible output', async () => {
    const r = await runCheckAgainst(
      'latency',
      { reasoningTokens: 120, tokenDelayMs: 5, ttftDelayMs: 20 },
      { runs: 2 },
    );
    assertEqual(r.status, 'pass', `status was ${r.status}: ${r.note}`);
    assertEqual(r.metrics['reasoning_detected'], true, 'reasoning should be detected');
    assertEqual(r.metrics['reasoning_tokens_p50'], 120, 'reasoning token p50 should be 120');
    assert(
      (r.metrics['visible_tokens_p50'] as number) < (r.metrics['output_tokens_p50'] as number),
      'visible tokens should be lower than total output tokens',
    );
    assert(r.note.includes('reasoning'), `note should mention reasoning: ${r.note}`);
  });

  await test('flags a run where reasoning consumed the whole output budget', async () => {
    const r = await runCheckAgainst(
      'latency',
      { reasoningTokens: 500, reasoningOnly: true, tokenDelayMs: 5, ttftDelayMs: 20 },
      { runs: 2 },
    );
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('reasoning'), `note should explain the reasoning spend: ${r.note}`);
  });

  await test('fails when every run fails', async () => {
    const r = await runCheckAgainst('latency', { defects: ['html-500'] }, { runs: 2 });
    assertEqual(r.status, 'fail', `status was ${r.status}: ${r.note}`);
  });

  process.stdout.write('\nrunner, report, redaction\n');
  await test('a run never throws even when every check explodes', async () => {
    const exploding: CheckDef = {
      name: 'exploding',
      title: 'Exploding',
      description: 'always throws',
      defaultTimeoutMs: 500,
      run: async () => {
        throw new Error('boom');
      },
    };
    const ctx = makeContext('http://127.0.0.1:9/v1');
    const r = await runCheck(exploding, ctx);
    assertEqual(r.status, 'fail', 'an exploding check should become a fail result');
    assert(r.note.includes('boom'), 'the error message should survive into the note');
  });

  await test('a hanging check times out instead of hanging', async () => {
    const hanging: CheckDef = {
      name: 'hanging',
      title: 'Hanging',
      description: 'never resolves',
      defaultTimeoutMs: 300,
      run: () => new Promise<CheckResult>(() => {}),
    };
    const ctx = makeContext('http://127.0.0.1:9/v1');
    const r = await runCheck(hanging, ctx);
    assertEqual(r.status, 'fail', 'a hanging check should fail');
    assertEqual(r.timedOut, true, 'the result should be flagged as timed out');
  });

  await test('the API key never appears in the written report', async () => {
    const secret = 'sk-test-9f8a7b6c5d4e3f2a1b0c';
    process.env['MOCK_KEY'] = secret;
    const mockServer = await startMock({});
    try {
      const run = await runProviderForTest(mockServer.url, secret, { models_endpoint: 'pass' });
      const dir = mkdtempSync(join(tmpdir(), 'pc-test-'));
      const out = join(dir, 'report.json');
      const redactor = createRedactor([secret]);
      writeReport(out, buildReport([run], {}, 1), redactor);
      const text = readFileSync(out, 'utf8');
      assert(!text.includes(secret), 'the raw key leaked into report.json');
      assert(text.includes('[redacted]'), 'no redaction marker found');
    } finally {
      delete process.env['MOCK_KEY'];
      await mockServer.close();
    }
  });

  await test('redaction catches key-shaped strings that arrive in a response body', async () => {
    const redactor = createRedactor([]);
    const scrubbed = redactor.redactUnknown({
      echo: 'your key sk-abcdefghijklmnop123456 is wrong',
      nested: { list: ['Bearer aaaaaaaaaaaaaaaa'] },
    }) as { echo: string; nested: { list: string[] } };
    assert(!scrubbed.echo.includes('sk-abcdefghijklmnop123456'), 'key-shaped string survived');
    assert(!scrubbed.nested.list[0]!.includes('aaaaaaaaaaaa'), 'bearer token survived');
  });

  await test('redaction preserves an object reachable by two paths', async () => {
    // The captured response body and the parsed usage detail point at the same
    // object. Treating that as a cycle silently replaced real data with
    // "[circular]", which is how a real OpenRouter usage object was lost from
    // a live report.
    const usage = { prompt_tokens: 163, completion_tokens: 2, total_tokens: 165 };
    const body = { id: 'x', usage, choices: [] };
    const redactor = createRedactor([]);
    const out = redactor.redactUnknown({ details: { usageRaw: usage }, response: { body } }) as {
      details: { usageRaw: { prompt_tokens: number } };
      response: { body: { usage: { prompt_tokens: number } } };
    };
    assertEqual(out.details.usageRaw.prompt_tokens, 163, 'first path lost its data');
    assertEqual(out.response.body.usage.prompt_tokens, 163, 'second path was replaced by a cycle marker');
  });

  await test('redaction still stops a genuine cycle', async () => {
    const redactor = createRedactor([]);
    const node: Record<string, unknown> = { name: 'root' };
    node['self'] = node;
    const out = redactor.redactUnknown(node) as Record<string, unknown>;
    assertEqual(out['self'], '[circular]', 'a real cycle should still be broken');
  });

  await test('flags reasoning that usage does not report', async () => {
    // Reasoning streams but completion_tokens_details.reasoning_tokens is 0:
    // billing on reported tokens would undercount.
    const r = await runCheckAgainst(
      'latency',
      { reasoningTokens: 0, reasoningOnly: false, emitReasoningText: 150, tokenDelayMs: 5 },
      { runs: 2 },
    );
    assertEqual(r.metrics['reasoning_streamed'], true, 'reasoning text should be seen');
    assertEqual(r.metrics['reasoning_underreported'], true, 'under-reporting should be flagged');
    assertEqual(r.status, 'warn', `status was ${r.status}: ${r.note}`);
    assert(r.note.includes('undercount'), `note should explain the billing impact: ${r.note}`);
  });

  await test('summarize counts statuses and takes the worst', async () => {
    const results = [
      { check: 'a', title: 'a', status: 'pass', note: '', metrics: {}, durationMs: 0 },
      { check: 'b', title: 'b', status: 'warn', note: '', metrics: {}, durationMs: 0 },
      { check: 'c', title: 'c', status: 'skip', note: '', metrics: {}, durationMs: 0 },
    ] as CheckResult[];
    const s = summarize(results, 10);
    assertEqual(s.pass, 1, 'pass count');
    assertEqual(s.warn, 1, 'warn count');
    assertEqual(s.skip, 1, 'skip count');
    assertEqual(s.status, 'warn', 'overall status should be the worst non-pass status');
  });

  process.stdout.write('\ncli\n');
  await test('exits 1 when a check fails, and writes the report', async () => {
    const mockServer = await startMock({ defects: ['html-500'] });
    try {
      const dir = mkdtempSync(join(tmpdir(), 'pc-test-'));
      const out = join(dir, 'report.json');
      const { stdout } = await runCli([
        '--base-url', mockServer.url,
        '--model', 'mock-model-1',
        '--key', 'test-secret-key-abcdef123456',
        '--runs', '1',
        '--out', out,
      ]).catch((err: { code?: number; stdout?: string }) => ({ stdout: err.stdout ?? '', code: err.code }));
      assert(stdout.includes('FAIL'), `expected a failure in stdout, got: ${stdout.slice(0, 400)}`);
      const report = JSON.parse(readFileSync(out, 'utf8')) as { summary: { fail: number } };
      assert(report.summary.fail > 0, 'report should record at least one failure');
    } finally {
      await mockServer.close();
    }
  });

  await test('exits 0 and reports pass against a healthy endpoint', async () => {
    const mockServer = await startMock({});
    try {
      const dir = mkdtempSync(join(tmpdir(), 'pc-test-'));
      const out = join(dir, 'report.json');
      const md = join(dir, 'report.md');
      const { stdout } = await runCli([
        '--base-url', mockServer.url,
        '--model', 'mock-model-1',
        '--key', 'test-secret-key-abcdef123456',
        '--runs', '2',
        '--out', out,
        '--md',
      ]);
      assert(stdout.includes('PASS'), `expected a pass, got: ${stdout.slice(0, 400)}`);
      const reportMd = readFileSync(md, 'utf8');
      assert(reportMd.includes('| Check | Status | Detail |'), 'markdown status table missing');
      assert(reportMd.includes('### Notes'), 'markdown notes section missing');
      assert(reportMd.includes('TTFT'), 'markdown latency line missing');
    } finally {
      await mockServer.close();
    }
  });

  await test('rejects a config file that is not valid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-test-'));
    const bad = join(dir, 'providers.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(bad, '{ not json');
    let code: number | undefined;
    let stderr = '';
    try {
      await runCli(['--config', bad]);
    } catch (err) {
      code = (err as { code?: number }).code;
      stderr = (err as { stderr?: string }).stderr ?? '';
    }
    assertEqual(code, 2, 'a config error should exit 2');
    assert(stderr.includes('not valid JSON'), `stderr should explain the problem: ${stderr}`);
  });

  process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`);
  if (failed > 0) {
    process.stdout.write(`${failures.map((f) => `  - ${f}`).join('\n')}\n\n`);
    process.exit(1);
  }
}

async function runProviderForTest(
  baseUrl: string,
  key: string,
  expected: Record<string, string>,
): Promise<import('../src/types.js').ProviderRun> {
  const { runProvider } = await import('../src/runner.js');
  const provider: ProviderConfig = { id: 'mock', name: 'mock', baseUrl, model: 'mock-model-1' };
  const defs = Object.keys(expected).map((name) =>
    listChecks().find((c) => c.name === name),
  ) as CheckDef[];
  return runProvider(provider, key, { ...BASE_OPTIONS, runs: 1 }, defs, () => {});
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    execFile(
      process.execPath,
      [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'cli.ts'), ...args],
      { cwd: ROOT, env: { ...process.env } },
      (err, stdout, stderr) => {
        if (err && (err as { code?: number }).code !== 0) {
          Object.assign(err, { stdout, stderr });
          rej(err);
          return;
        }
        res({ stdout, stderr });
      },
    );
  });
}

await main();
