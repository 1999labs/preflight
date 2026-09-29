/**
 * Check 1 - models_endpoint
 *
 * A router's first question is not "does it work" but "is the thing I asked
 * for actually there". Many providers accept a request for a model that was
 * never served and quietly route to a default, or list a model with a stale
 * id. /models is also where the only machine-readable claims about context
 * length and pricing exist, and those claims are what we hold the provider to
 * later in context_probe and --compare.
 */

import { defineCheck, type CheckContext } from '../registry.js';
import { fail, isRecord, pass, skipped, transportFail, warn, type ResultInit } from './_helpers.js';
import type { CheckResult, Metrics } from '../types.js';

const CONTEXT_KEYS = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_input_tokens',
  'max_model_len',
  'max_sequence_length',
];

export default defineCheck({
  name: 'models_endpoint',
  title: 'Models endpoint',
  description: 'GET /models returns JSON and lists the model under test with usable metadata.',
  requests: 1,
  retry: true,
  defaultTimeoutMs: 15_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'models_endpoint';
    const title = 'Models endpoint';
    const http = await ctx.http.request({ method: 'GET', path: '/models' });

    if (http.status === 0) return transportFail(name, title, http, 'GET /models');
    if (http.status === 404) {
      return fail(name, title, 'GET /models returned 404; endpoint exposes no model catalog', {
        metrics: { http_status: 404 },
        request: http.request,
        response: http.response,
        durationMs: http.durationMs,
      });
    }
    if (http.status === 401 || http.status === 403) {
      return fail(name, title, `GET /models returned ${http.status}; the API key is rejected for catalog reads`, {
        metrics: { http_status: http.status },
        request: http.request,
        response: http.response,
        durationMs: http.durationMs,
      });
    }
    if (!http.ok) {
      return fail(name, title, `GET /models returned HTTP ${http.status} (expected 200)`, {
        metrics: { http_status: http.status },
        request: http.request,
        response: http.response,
        durationMs: http.durationMs,
      });
    }
    if (!/json/i.test(http.contentType)) {
      return fail(name, title, `GET /models returned content-type "${http.contentType || 'none'}", not JSON`, {
        metrics: { http_status: http.status, content_type: http.contentType || null },
        request: http.request,
        response: http.response,
        durationMs: http.durationMs,
      });
    }
    if (http.json === undefined) {
      return fail(name, title, 'GET /models returned a JSON content-type but the body did not parse', {
        metrics: { http_status: http.status, bytes: http.bytes },
        request: http.request,
        response: http.response,
        durationMs: http.durationMs,
      });
    }

    const entries = extractEntries(http.json);
    if (entries === undefined) {      return warn(
        name,
        title,
        'GET /models returned JSON but not a recognizable model list (expected a "data" array)',
        {
          metrics: { http_status: http.status, models_listed: 0, top_level_keys: topKeys(http.json).join(',') },
          details: { body_shape: describeShape(http.json) },
          request: http.request,
          response: http.response,
          durationMs: http.durationMs,
        },
      );
    }

    // Deliberately NOT stashing the raw catalog: on a large gateway that is
    // hundreds of kilobytes of models we have already extracted everything we
    // need from, and it buries the actual findings in report.json.
    const advertised = entries.map((e) => String(e['id'] ?? '')).filter(Boolean);
    ctx.facts.advertisedModels = advertised;

    const wanted = ctx.provider.model;
    const exact = entries.find((e) => e['id'] === wanted);
    const ci = entries.find((e) => String(e['id'] ?? '').toLowerCase() === wanted.toLowerCase());
    // OpenRouter-style ids are "vendor/model"; providers often list the bare
    // name, so accept either direction.
    const bare = wanted.includes('/') ? wanted.slice(wanted.indexOf('/') + 1) : wanted;
    const namespaced = entries.find((e) => {
      const id = String(e['id'] ?? '');
      return id === bare || (id.includes('/') && id.slice(id.indexOf('/') + 1) === bare);
    });
    const match = exact ?? ci ?? namespaced;

    const metrics: Metrics = {
      http_status: http.status,
      models_listed: entries.length,
      model_listed: Boolean(match),
      model_id: match ? String(match['id']) : null,
      context_length: null,
      duration_ms: http.durationMs,
    };

    const init: ResultInit = {
      metrics,
      details: { sample_ids: advertised.slice(0, 12) },
      request: http.request,
      response: http.response,
      durationMs: http.durationMs,
    };

    if (!match) {
      // A single-model endpoint is common and fine, but the id still must not
      // silently disagree with what we asked for.
      if (entries.length === 1) {
        const only = String(entries[0]?.['id'] ?? '(none)');
        ctx.facts.modelListed = false;
        return warn(
          name,
          title,
          `model "${wanted}" is not listed; endpoint advertises a single model "${only}" - verify routing`,
          init,
        );
      }
      ctx.facts.modelListed = false;
      return fail(
        name,
        title,
        `model "${wanted}" is absent from /models (${entries.length} models listed)`,
        init,
      );
    }

    ctx.facts.modelListed = true;
    if (!exact && match !== exact) {
      // Keep looking honest: we matched loosely, say so.
      init.metrics = { ...metrics, matched_loosely: true };
    }

    const contextLength = readContextLength(match);
    init.metrics = {
      ...(init.metrics as Metrics),
      context_length: contextLength ?? null,
    };
    if (contextLength !== undefined) ctx.facts.claimedContextLength = contextLength;

    const pricing = readPricing(match);
    if (pricing) ctx.facts.claimedPricing = { ...pricing };
    init.metrics = { ...(init.metrics as Metrics), ...pricingToMetrics(pricing) };

    // The three-way claim lives here: what the description claims, what the
    // architecture block lists, and - measured later by the vision check -
    // what the endpoint actually does.
    const architecture = isRecord(match['architecture']) ? match['architecture'] : undefined;
    const modality = typeof architecture?.['modality'] === 'string' ? architecture['modality'] : undefined;
    const inputs = Array.isArray(architecture?.['input_modalities'])
      ? (architecture['input_modalities'] as unknown[]).map(String)
      : undefined;
    const description = typeof match['description'] === 'string' ? match['description'] : undefined;
    ctx.facts.catalogModality = modality;
    ctx.facts.catalogInputModalities = inputs;
    ctx.facts.catalogDescription = description;
    if (modality) {
      init.metrics = {
        ...(init.metrics as Metrics),
        modality,
        input_modalities: inputs?.join(',') ?? null,
      };
    }

    const params = readSupportedParameters(match);
    if (params) {
      ctx.facts.supportedParameters = params;
      init.metrics = { ...(init.metrics as Metrics), supported_parameters: params.join(',') };
    }

    const ownedBy = typeof match['owned_by'] === 'string' ? match['owned_by'] : undefined;
    if (ownedBy) init.metrics = { ...(init.metrics as Metrics), owned_by: ownedBy };

    if (contextLength === undefined) {
      return warn(
        name,
        title,
        `model "${String(match['id'])}" is listed but no context_length is advertised - context_probe will be the only source of truth`,
        init,
      );
    }

    return pass(
      name,
      title,
      `model "${String(match['id'])}" listed among ${entries.length}, claiming ${contextLength.toLocaleString()} context tokens`,
      init,
    );
  },
});

/** Returns the list of model objects, or undefined if the shape is unknown. */
function extractEntries(body: unknown): Array<Record<string, unknown>> | undefined {
  if (Array.isArray(body)) return body.filter(isRecord);
  if (!isRecord(body)) return undefined;
  for (const key of ['data', 'models', 'results', 'items']) {
    const value = body[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  // Some gateways return { "<id>": {...} }.
  const values = Object.values(body);
  if (values.length > 0 && values.every(isRecord)) return values as Array<Record<string, unknown>>;
  return undefined;
}

function readContextLength(entry: Record<string, unknown>): number | undefined {
  for (const key of CONTEXT_KEYS) {
    const v = entry[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  // Some catalogs nest capabilities: { capabilities: { context_length } }.
  for (const nestedKey of ['capabilities', 'limits', 'meta', 'top_provider']) {
    const nested = entry[nestedKey];
    if (isRecord(nested)) {
      const v = readContextLength(nested);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

interface Pricing {
  promptPerToken?: number;
  completionPerToken?: number;
  currency?: string;
}

function readPricing(entry: Record<string, unknown>): Pricing | undefined {
  const raw = entry['pricing'] ?? entry['cost'] ?? entry['price'];
  if (!isRecord(raw)) return undefined;
  const out: Pricing = {};
  const prompt = firstNumber(raw, ['prompt', 'input', 'input_cost_per_token', 'prompt_per_token']);
  const completion = firstNumber(raw, ['completion', 'output', 'output_cost_per_token', 'completion_per_token']);
  // Heuristic: values below 0.01 are per-token; anything larger is quoted per
  // million tokens, which is how the big catalogs display it.
  if (prompt !== undefined) out.promptPerToken = prompt < 0.01 ? prompt : prompt / 1_000_000;
  if (completion !== undefined) out.completionPerToken = completion < 0.01 ? completion : completion / 1_000_000;
  if (typeof raw['currency'] === 'string') out.currency = raw['currency'];
  return out.promptPerToken !== undefined || out.completionPerToken !== undefined ? out : undefined;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = source[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function pricingToMetrics(pricing: Pricing | undefined): Metrics {
  if (!pricing) return {};
  return {
    price_prompt_per_1m_usd: pricing.promptPerToken !== undefined ? round6(pricing.promptPerToken * 1e6) : null,
    price_completion_per_1m_usd:
      pricing.completionPerToken !== undefined ? round6(pricing.completionPerToken * 1e6) : null,
  };
}

function readSupportedParameters(entry: Record<string, unknown>): string[] | undefined {
  const v = entry['supported_parameters'] ?? entry['supportedParameters'];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return undefined;
}

function topKeys(body: unknown): string[] {
  return isRecord(body) ? Object.keys(body).slice(0, 8) : [];
}

function describeShape(body: unknown): string {
  if (Array.isArray(body)) return 'array';
  if (!isRecord(body)) return typeof body;
  return Object.fromEntries(
    Object.entries(body)
      .slice(0, 8)
      .map(([k, v]) => [k, Array.isArray(v) ? `array(${v.length})` : typeof v]),
  ) as unknown as string;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
