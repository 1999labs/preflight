#!/usr/bin/env node
/**
 * provider-check CLI.
 *
 * Exit codes:
 *   0  every check passed (warn is not a failure)
 *   1  at least one check failed
 *   2  usage or configuration error
 *   3  nothing failed, but at least one check was blocked - the provider could
 *      not be reached, so the result is inconclusive rather than clean
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';

import { loadConfigFile, providerFromFlags, resolveKey, ConfigError, type ConfigFile } from './config.js';
import { compareWithOpenRouter, type CompareEntry } from './compare.js';
import { listChecks, type CheckDef } from './registry.js';
import { orderedChecks, PLANNED_CHECKS, resolveChecks } from './checks/index.js';
import { planDryRun, renderDryRun } from './dry-run.js';
import { renderMarkdown } from './markdown.js';
import { buildReport, summarize, writeReport, TOOL_VERSION } from './report.js';
import { runProvider } from './runner.js';
import { createRedactor } from './redact.js';
import type { GlobalOptions, ProviderConfig, ProviderRun } from './types.js';

interface CliOptions {
  baseUrl?: string;
  model?: string;
  name?: string;
  id?: string[];
  key?: string;
  runs?: string;
  out?: string;
  md?: boolean;
  config?: string;
  vision?: boolean;
  zdr?: boolean;
  compare?: boolean;
  dryRun?: boolean;
  dailyCap?: string;
  retryDelay?: string;
  only?: string;
  skip?: string;
  timeout?: string;
  checkTimeout?: string[];
  latencyConcurrency?: string;
  contextSafety?: string;
  contextLadder?: string;
  contextProbes?: string;
  codeExec?: boolean;
  verbose?: boolean;
  listChecks?: boolean;
  quiet?: boolean;
}

const program = new Command();

program
  .name('provider-check')
  .description(
    'Launch-QA readiness check for OpenAI-compatible LLM endpoints. Produces a per-check ' +
      'report and a non-zero exit code when something would break in production.',
  )
  .version(TOOL_VERSION)
  .option('--base-url <url>', 'endpoint base URL, e.g. https://api.example.com/v1')
  .option('--model <id>', 'model id to test')
  .option('--name <name>', 'human-readable provider name (default: the model id)')
  .option('--id <id>', 'with --config, run only these provider ids (repeatable)', collect, [])
  .option('--key <key>', 'API key (prefer an env var via providers.json "keyEnv")')
  .option('--runs <n>', 'latency runs (default: 20, or defaults.runs in the config)')
  .option('--out <path>', 'write the JSON report here')
  .option('--md', 'also write a markdown card per provider')
  .option('--config <path>', 'providers.json with several providers to run in one pass')
  .option('--vision', 'include the vision check (sends a small base64 image)')
  .option('--retry-delay <ms>', 'override the delay before retrying a 429/503', '0')
  .option('--zdr', 'include the zero-data-retention probe (1 request per target)')
  .option('--compare', 'diff claimed metadata against the OpenRouter model catalog')
  .option('--dry-run', 'print the planned request count per target and exit; makes no network calls')
  .option('--daily-cap <n>', 'requests per day to plan against in --dry-run', '50')
  .option('--only <checks>', 'comma-separated list of checks to run')
  .option('--skip <checks>', 'comma-separated list of checks to skip')
  .option('--timeout <ms>', 'default per-check timeout in ms', '60000')
  .option('--check-timeout <name=ms>', 'override one check timeout (repeatable)', collect, [])
  .option('--latency-concurrency <n>', 'parallel latency runs (default: 1)', '1')
  .option('--context-safety <n>', 'filler scaling factor for the context probe (0-1)', '0.9')
  .option(
    '--context-ladder <rungs>',
    'context probe rungs, comma-separated, e.g. 8k,32k,128k,1M (default: sized to the claimed window)',
  )
  .option(
    '--context-probes <n>',
    'how many rungs to probe when sizing the ladder to the claim (default: 4)',
  )
  .option('--code-exec', 'allow quality_smoke to execute model-written code tests (off by default)')
  .option('--verbose', 'log per-check detail while running')
  .option('--quiet', 'suppress progress output')
  .option('--list-checks', 'print the registered checks and exit')
  .showHelpAfterError();

program.parse(process.argv);
const opts = program.opts<CliOptions>();

// --- list-checks ------------------------------------------------------------
if (opts.listChecks) {
  const all = orderedChecks(listChecks());
  const width = Math.max(...all.map((c) => c.name.length));
  for (const c of all) {
    process.stdout.write(`${c.name.padEnd(width)}  ${c.defaultTimeoutMs / 1000}s  ${c.description}\n`);
  }
  process.exit(0);
}

// --- argument parsing -------------------------------------------------------
function intArg(value: string, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new InvalidArgumentError(`${name} must be an integer between ${min} and ${max}, got "${value}"`);
  }
  return n;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Parse a rung list like `8k,32k,1M` into token counts.
 *
 * Suffixes matter here: a 1,000,000-token rung is unreadable written out in full
 * and easy to fat-finger, and the whole point of the flag is that it is used
 * next to a claim printed as "1,000,000".
 */
function parseLadder(value: string): number[] {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new InvalidArgumentError('--context-ladder needs at least one rung, e.g. 8k,32k,128k');
  }
  const rungs = parts.map((p) => {
    const m = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(p);
    if (!m) {
      throw new InvalidArgumentError(
        `--context-ladder rung "${p}" is not a token count; use forms like 8192, 128k or 1M`,
      );
    }
    const mult = m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2]?.toLowerCase() === 'k' ? 1_000 : 1;
    const n = Math.round(Number(m[1]) * mult);
    if (n < 1_000) {
      throw new InvalidArgumentError(`--context-ladder rung "${p}" is below the 1,000-token floor`);
    }
    return n;
  });
  if (new Set(rungs).size !== rungs.length) {
    throw new InvalidArgumentError(`--context-ladder has duplicate rungs: ${value}`);
  }
  return [...rungs].sort((a, b) => a - b);
}

let global: GlobalOptions;
let defs: CheckDef[];
let providers: ProviderConfig[];

try {
  const timeouts: Record<string, number> = {};
  for (const pair of opts.checkTimeout ?? []) {
    const [name, ms] = pair.split('=');
    if (!name || !ms) throw new ConfigError(`--check-timeout expects name=ms, got "${pair}"`);
    timeouts[name.trim()] = intArg(ms, 'timeout', 100, 3_600_000);
  }

  global = {
    runs: 0, // resolved after the config file is read
    timeoutMs: intArg(opts.timeout ?? '60000', '--timeout', 1000, 3_600_000),
    vision: Boolean(opts.vision),
    dataPolicy: Boolean(opts.zdr),
    compare: Boolean(opts.compare),
    codeExec: Boolean(opts.codeExec),
    verbose: Boolean(opts.verbose),
    contextSafety: Number(opts.contextSafety ?? '0.9'),
    latencyConcurrency: intArg(opts.latencyConcurrency ?? '1', '--latency-concurrency', 1, 32),
    only: opts.only ? opts.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    skip: opts.skip ? opts.skip.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    timeouts,
    retryDelayMs: opts.retryDelay === '0' ? undefined : intArg(opts.retryDelay ?? '0', '--retry-delay', 0, 60_000) || undefined,
  };

  if (!(global.contextSafety > 0 && global.contextSafety <= 1)) {
    throw new ConfigError('--context-safety must be greater than 0 and at most 1');
  }

  if (opts.contextLadder) {
    global.contextLadder = parseLadder(opts.contextLadder);
  } else if (opts.contextProbes !== undefined) {
    // Without an explicit ladder, the rung count still shapes the ladder that
    // gets planned around the claim, so it is worth parsing on its own.
    const n = intArg(opts.contextProbes, '--context-probes', 1, 16);
    global.contextProbes = n;
  }

  defs = resolveChecks(listChecks(), global.only, global.skip);

  let defaults: ConfigFile['defaults'] = {};
  if (opts.config) {
    const cfg = loadConfigFile(opts.config);
    providers = cfg.providers;
    defaults = cfg.defaults ?? {};
    // Precedence: --runs > providers.json defaults.runs > 20.
    global.runs = opts.runs !== undefined
      ? intArg(opts.runs, '--runs', 1, 1000)
      : defaults.runs !== undefined
        ? intArg(String(defaults.runs), 'defaults.runs', 1, 1000)
        : 20;

    // --id narrows a multi-provider config to specific targets, so a shared
    // quota can be spent one target at a time across several days.
    const wanted = (opts.id ?? []).map((s: string) => s.trim()).filter(Boolean);
    if (wanted.length > 0) {
      const known = providers.map((p) => p.id);
      const unknown = wanted.filter((id: string) => !known.includes(id));
      if (unknown.length > 0) {
        throw new ConfigError(
          `--id matched no provider: ${unknown.join(', ')}. Available: ${known.join(', ')}`,
        );
      }
      providers = providers.filter((p) => wanted.includes(p.id));
    }
  } else if (opts.baseUrl || opts.model) {
    providers = [providerFromFlags({ baseUrl: opts.baseUrl, model: opts.model, name: opts.name })];
    global.runs = opts.runs !== undefined ? intArg(opts.runs, '--runs', 1, 1000) : 20;
  } else {
    throw new ConfigError('nothing to check: pass --base-url and --model, or --config providers.json');
  }
} catch (err) {
  process.stderr.write(`provider-check: ${err instanceof Error ? err.message : String(err)}\n`);
  program.outputHelp();
  process.exit(2);
}

// --- run --------------------------------------------------------------------
const quiet = Boolean(opts.quiet);
const log = (line: string) => {
  if (!quiet) process.stdout.write(`${line}\n`);
};

/** Every key known up front, so a key echoed in one provider's response is
 *  still scrubbed if it shows up inside another provider's section. */
const keyResults = providers.map((p) => resolveKey(p, opts.key));
const globalRedactor = createRedactor(keyResults.map((r) => r.key));

// --- dry run: cost the plan, spend nothing -------------------------------
if (opts.dryRun) {
  const cap = intArg(opts.dailyCap ?? '50', '--daily-cap', 1, 100_000);
  const keyErrors = new Map<string, string>();
  keyResults.forEach((r, i) => {
    const p = providers[i]!;
    if (r.error) keyErrors.set(p.id, r.error);
  });
  const plan = planDryRun(providers, defs, PLANNED_CHECKS, global, cap, keyErrors);
  process.stdout.write(`${renderDryRun(plan)}\n`);
  process.exit(plan.fitsInOneDay ? 0 : 1);
}

const runs: ProviderRun[] = [];
const compares: Array<{ providerId: string; entry: CompareEntry }> = [];
const startedAll = performance.now();

for (let i = 0; i < providers.length; i += 1) {
  const provider = providers[i]!;
  const keyResult = keyResults[i]!;

  if (!quiet) {
    log('');
    log(`▸ ${provider.name}  (${provider.baseUrl} · ${provider.model})`);
    if (keyResult.source === 'none') log('  (no API key resolved)');
  }

  if (keyResult.error) {
    const now = new Date().toISOString();
    const result = {
      check: 'config',
      title: 'Configuration',
      status: 'fail' as const,
      note: keyResult.error,
      metrics: {},
      durationMs: 0,
    };
    runs.push({
      provider: { ...provider, key: provider.key ? '[redacted]' : undefined },
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      results: [result],
      summary: summarize([result], 0),
      facts: {},
      error: keyResult.error,
    });
    log(`  ✗ config              FAIL        ${keyResult.error}`);
    continue;
  }

  const run = await runProvider(provider, keyResult.key, global, defs, log);
  runs.push(run);

  if (global.compare) {
    compares.push({
      providerId: provider.id,
      entry: await compareWithOpenRouter(provider.model, run.facts, log),
    });
  }
}

const durationMs = Math.round(performance.now() - startedAll);

const reportOptions: Record<string, unknown> = {
  runs: global.runs,
  timeoutMs: global.timeoutMs,
  vision: global.vision,
  compare: global.compare,
  latencyConcurrency: global.latencyConcurrency,
  contextSafety: global.contextSafety,
  codeExec: global.codeExec,
  checks: defs.map((d) => d.name),
  keySource: [...new Set(keyResults.map((r) => r.source))],
};

const report = buildReport(
  runs,
  reportOptions,
  durationMs,
  compares.length > 0 ? compares : undefined,
);

// --- output -----------------------------------------------------------------
const written: string[] = [];
if (opts.out) {
  written.push(writeReport(opts.out, report, globalRedactor));
}
if (opts.md) {
  const mdPath = opts.out ? replaceExtension(opts.out, '.md') : 'provider-check.md';
  const abs = resolve(mdPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, renderMarkdown(globalRedactor.redactUnknown(report) as typeof report), 'utf8');
  written.push(abs);
}

if (!quiet) {
  log('');
  for (const run of runs) {
    const s = run.summary;
    log(
      `${provider_status_icon(s.status)} ${run.provider.name.padEnd(28)} ` +
        `${s.pass} pass  ${s.warn} warn  ${s.fail} fail  ${s.blocked} blocked  ${s.skip} skip  (${s.durationMs}ms)`,
    );
    for (const r of run.results) {
      if (r.status === 'warn' || r.status === 'fail' || r.status === 'blocked') {
        log(`    ${r.status.toUpperCase().padEnd(7)} ${r.check}: ${r.note}`);
      }
    }
  }
  if (written.length > 0) {
    log('');
    for (const path of written) log(`wrote ${path}`);
  }
}

// Blocked is non-zero but distinct: CI should be able to tell "this provider is
// broken" from "we could not test it this time".
process.exit(report.summary.fail > 0 ? 1 : report.summary.blocked > 0 ? 3 : 0);

function provider_status_icon(status: string): string {
  if (status === 'pass') return '✓';
  if (status === 'fail') return '✗';
  if (status === 'blocked') return '▨';
  return '!';
}

function replaceExtension(path: string, ext: string): string {
  return path.replace(/\.[^./\\]+$/, '') + ext;
}
