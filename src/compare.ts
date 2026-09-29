/**
 * --compare: diff the provider's self-reported metadata against the
 * OpenRouter catalog.
 *
 * Rationale: a provider's own /models endpoint is marketing copy. OpenRouter's
 * catalog is a second, independent claim. When the two disagree, a router
 * cannot know which is right, and the safe assumption is the smaller context
 * window and the intersection of supported parameters. This check makes that
 * disagreement visible instead of leaving it to be discovered in production.
 */

import { round } from './http.js';
import type { DiscoveredFacts } from './types.js';

const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const TIMEOUT_MS = 15_000;

export interface CompareEntry {
  matched: boolean;
  matchType: 'exact' | 'base_name' | 'substring' | 'none';
  openrouterId: string | null;
  openrouterUrl: string | null;
  context: {
    openrouter: number | null;
    providerClaim: number | null;
    probeMax: number | null;
    /** True when every available source agrees. */
    agrees: boolean | null;
    note: string;
  };
  parameters: {
    openrouter: string[];
    providerClaim: string[] | null;
    /** OpenRouter advertises it, the provider's catalog does not. */
    advertisedButUnclaimed: string[];
    /** The provider's catalog claims it, OpenRouter does not list it. */
    claimedButUnlisted: string[];
  };
  pricing: {
    openrouter: Record<string, string> | null;
    provider: Record<string, number | string> | null;
  };
  note: string;
}

export async function compareWithOpenRouter(
  model: string,
  facts: DiscoveredFacts,
  log: (message: string) => void,
): Promise<CompareEntry> {
  const base = emptyEntry(model);

  let catalog: { data?: unknown };
  try {
    const res = await fetch(CATALOG_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      base.note = `could not fetch the OpenRouter catalog (HTTP ${res.status}); comparison skipped`;
      return base;
    }
    catalog = (await res.json()) as { data?: unknown };
  } catch (err) {
    base.note = `could not fetch the OpenRouter catalog: ${err instanceof Error ? err.message : String(err)}`;
    return base;
  }

  const entries = Array.isArray(catalog.data) ? (catalog.data as Array<Record<string, unknown>>) : [];
  if (entries.length === 0) {
    base.note = 'the OpenRouter catalog returned no models';
    return base;
  }

  const { entry, type } = findMatch(entries, model);
  if (!entry) {
    base.note = `"${model}" is not listed on OpenRouter, so there is nothing to diff against`;
    return base;
  }

  const orId = String(entry['id'] ?? '');
  const orContext = typeof entry['context_length'] === 'number' ? entry['context_length'] : null;
  const orParams = Array.isArray(entry['supported_parameters'])
    ? (entry['supported_parameters'] as unknown[]).map(String)
    : [];
  const orPricing = isRecord(entry['pricing']) ? (entry['pricing'] as Record<string, string>) : null;
  const providerClaim = facts.claimedContextLength ?? null;
  const probeMax = facts.maxInputTokensSucceeded ?? null;

  const sources = [orContext, providerClaim, probeMax].filter((v): v is number => typeof v === 'number');
  const distinct = new Set(sources);
  // One source cannot disagree with itself, and saying it does would imply a
  // conflict that does not exist.
  const agrees = sources.length > 1 ? distinct.size === 1 : null;

  let contextNote: string;
  if (sources.length === 0) {
    contextNote = 'no context length is published by any source';
  } else if (sources.length === 1) {
    contextNote =
      `only one source publishes a context length (${sources[0]!.toLocaleString('en-US')} tokens); ` +
      'context_probe will provide the independent measurement';
  } else if (agrees) {
    contextNote = `all sources agree on ${sources[0]!.toLocaleString('en-US')} tokens`;
  } else {
    const low = Math.min(...sources);
    contextNote =
      `sources disagree (${sources.map((s) => s.toLocaleString('en-US')).join(' vs ')}); ` +
      `plan for the smaller value, ${low.toLocaleString('en-US')}`;
  }

  const providerParams = facts.supportedParameters ?? null;
  const advertisedButUnclaimed = providerParams
    ? orParams.filter((p) => !providerParams.includes(p))
    : [];
  const claimedButUnlisted = providerParams ? providerParams.filter((p) => !orParams.includes(p)) : [];

  log(`compare: matched ${orId} (${type})`);

  return {
    matched: true,
    matchType: type,
    openrouterId: orId,
    openrouterUrl: typeof entry['canonical_slug'] === 'string'
      ? `https://openrouter.ai/${String(entry['canonical_slug']).split('/')[0]}/${orId.split('/').at(-1)}`
      : null,
    context: { openrouter: orContext, providerClaim, probeMax, agrees, note: contextNote },
    parameters: {
      openrouter: orParams,
      providerClaim: providerParams,
      advertisedButUnclaimed,
      claimedButUnlisted,
    },
    pricing: { openrouter: orPricing, provider: facts.claimedPricing ?? null },
    note:
      type === 'exact'
        ? 'model id matches OpenRouter exactly'
        : `matched on ${type === 'base_name' ? 'model name without the vendor prefix' : 'a substring of the id'}; confirm this is the same weights`,
  };
}

function findMatch(
  entries: Array<Record<string, unknown>>,
  model: string,
): { entry?: Record<string, unknown>; type: CompareEntry['matchType'] } {
  const wanted = model.toLowerCase();
  const byId = (id: string) => id.toLowerCase();
  const base = wanted.includes('/') ? wanted.slice(wanted.indexOf('/') + 1) : wanted;

  const exact = entries.find((e) => byId(String(e['id'] ?? '')) === wanted);
  if (exact) return { entry: exact, type: 'exact' };

  const baseMatch = entries.find((e) => {
    const id = byId(String(e['id'] ?? ''));
    return id === base || (id.includes('/') && id.slice(id.indexOf('/') + 1) === base);
  });
  if (baseMatch) return { entry: baseMatch, type: 'base_name' };

  const sub = entries.find((e) => byId(String(e['id'] ?? '')).includes(base) || base.includes(byId(String(e['id'] ?? ''))));
  if (sub) return { entry: sub, type: 'substring' };

  return { type: 'none' };
}

function emptyEntry(model: string): CompareEntry {
  return {
    matched: false,
    matchType: 'none',
    openrouterId: null,
    openrouterUrl: null,
    context: { openrouter: null, providerClaim: null, probeMax: null, agrees: null, note: '' },
    parameters: { openrouter: [], providerClaim: null, advertisedButUnclaimed: [], claimedButUnlisted: [] },
    pricing: { openrouter: null, provider: null },
    note: '',
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export { round };
