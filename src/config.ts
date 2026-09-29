/**
 * Configuration: providers.json, CLI flag merging, and key resolution.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProviderConfig } from './types.js';

export interface ConfigFile {
  defaults?: {
    timeoutMs?: number;
    runs?: number;
    latencyConcurrency?: number;
    contextSafety?: number;
  };
  providers: ProviderConfig[];
}

export class ConfigError extends Error {}

export function loadConfigFile(path: string): ConfigFile {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `could not read config ${abs}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config ${abs} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const cfg = parsed as ConfigFile;
  if (!cfg || !Array.isArray(cfg.providers) || cfg.providers.length === 0) {
    throw new ConfigError(`config ${abs} must contain a non-empty "providers" array`);
  }
  cfg.providers.forEach((p, i) => validateProvider(p, `${abs} providers[${i}]`));
  return cfg;
}

export function validateProvider(p: Partial<ProviderConfig>, where: string): asserts p is ProviderConfig {
  for (const field of ['id', 'name', 'baseUrl', 'model'] as const) {
    const value = p[field];
    if (typeof value !== 'string' || value === '') {
      throw new ConfigError(`${where}: missing required string field "${field}"`);
    }
  }
  try {
    // eslint-disable-next-line no-new
    new URL(p.baseUrl as string);
  } catch {
    throw new ConfigError(`${where}: baseUrl "${p.baseUrl}" is not a valid URL`);
  }
}

export interface ResolveKeyResult {
  key?: string;
  source: string;
  error?: string;
}

/**
 * Key resolution order: provider.key (discouraged, usually ${ENV} syntax)
 * -> provider.keyEnv -> PROVIDER_CHECK_KEY / OPENAI_API_KEY.
 */
export function resolveKey(provider: ProviderConfig, override?: string): ResolveKeyResult {
  if (override) return { key: override, source: '--key flag' };

  if (provider.key) {
    // Allow {"key": "$MY_VAR"} so a config file can stay secret-free.
    const fromEnv = provider.key.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
    if (fromEnv) {
      const value = process.env[fromEnv[1]!];
      if (value) return { key: value, source: `$${fromEnv[1]}` };
      return { source: 'none', error: `provider "${provider.id}": env var ${fromEnv[1]} is not set` };
    }
    return { key: provider.key, source: 'providers.json "key" field' };
  }

  if (provider.keyEnv) {
    const value = process.env[provider.keyEnv];
    if (value) return { key: value, source: `$${provider.keyEnv}` };
    return { source: 'none', error: `provider "${provider.id}": env var ${provider.keyEnv} is not set` };
  }

  const fallback = process.env['PROVIDER_CHECK_KEY'] ?? process.env['OPENAI_API_KEY'];
  if (fallback) return { key: fallback, source: '$PROVIDER_CHECK_KEY' };

  return { source: 'none' };
}

export function providerFromFlags(opts: {
  baseUrl?: string;
  model?: string;
  name?: string;
  id?: string;
}): ProviderConfig {
  if (!opts.baseUrl) throw new ConfigError('--base-url is required (or use --config providers.json)');
  if (!opts.model) throw new ConfigError('--model is required (or use --config providers.json)');
  const provider: ProviderConfig = {
    id: opts.id ?? slug(opts.baseUrl),
    name: opts.name ?? opts.model,
    baseUrl: opts.baseUrl,
    model: opts.model,
  };
  validateProvider(provider, '--base-url/--model');
  return provider;
}

export function slug(s: string): string {
  return (
    s
      .replace(/^https?:\/\//, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'provider'
  );
}
