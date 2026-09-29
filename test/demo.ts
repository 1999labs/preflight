/**
 * Demo harness: starts the mock server and runs the real CLI against it, so
 * the README example report is generated output rather than a hand-written
 * fiction. Run with: npx tsx test/demo.ts
 */

import { writeFileSync, mkdtempSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startMock } from './mock-server.js';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'pc-demo-'));

const healthy = await startMock({
  models: [{ id: 'mock-model-1', context_length: 8192 }],
  tokenDelayMs: 4,
  ttftDelayMs: 12,
});
const broken = await startMock({
  models: [{ id: 'mock-model-1' }],
  defects: ['drop-last-token', 'no-context-length'],
  ttftDelayMs: 8,
  tokenDelayMs: 3,
  rateLimitEvery: 5,
  promptTokenInflation: 149,
});

const configPath = join(dir, 'providers.json');
writeFileSync(
  configPath,
  JSON.stringify({
    providers: [
      { id: 'healthy', name: 'Mock Gateway (healthy)', baseUrl: healthy.url, model: 'mock-model-1', keyEnv: 'DEMO_KEY' },
      { id: 'broken', name: 'Mock Gateway (defective)', baseUrl: broken.url, model: 'mock-model-1', keyEnv: 'DEMO_KEY' },
    ],
  }),
);

try {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'cli.ts'),
      '--config', configPath, '--runs', '4', '--out', join(dir, 'report.json'), '--md',
      // The defective mock 429s on every fifth request. Without this the retry
      // honours the 20s default backoff, so a demo that should take seconds
      // sits in sleep for minutes. Tests pass retryDelayMs: 1 for the same reason.
      '--retry-delay', '1'],
    { cwd: ROOT, env: { ...process.env, DEMO_KEY: 'sk-demo-0123456789abcdefXYZ' } },
  ).catch((err) => ({ stdout: err.stdout ?? '' }));
  process.stdout.write(stdout);
  process.stdout.write(`\nartifacts: ${dir}\n`);
} finally {
  await healthy.close();
  await broken.close();
}
