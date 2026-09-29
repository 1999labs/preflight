/**
 * Check 11 - data_policy (opt-in, --data-policy)
 *
 * OpenRouter's API does not publish a data-policy field, in the catalog or on
 * the per-model endpoints endpoint. The only thing it exposes is a
 * request-side control:
 *
 *   provider.data_collection: "deny"
 *     "use only providers which do not collect user data. If no available
 *      model provider meets the requirement, your request will return an error."
 *
 * Which makes the question answerable by behaviour rather than by scraping a
 * model page. Send one cheap request pinned to `deny`:
 *
 *  - success  -> at least one endpoint for this model offers a no-training
 *                path. The router can route sensitive traffic to it.
 *  - error    -> *no* endpoint for this model is ZDR, so every request through
 *                this model may be stored and used for training. That is the
 *                Poolside-style case, and it is a routing decision, not a
 *                preference.
 *
 * The asymmetry matters: the affirmative is weak (one clean endpoint among
 * several is not a guarantee about the one you get at 3am) and the negative is
 * strong. The finding says exactly which one was observed.
 *
 * Costs one request, so it is opt-in and budgeted separately.
 */

import { defineCheck, type CheckContext } from '../registry.js';
import { fail, finding, isRecord, pass, type ResultInit } from './_helpers.js';
import type { CheckResult, Finding, Metrics } from '../types.js';

export default defineCheck({
  name: 'data_policy',
  title: 'Data policy (ZDR path)',
  description: 'Probes provider.data_collection:"deny" to find out whether a no-training route exists.',
  requests: 1,
  requiresDataPolicy: true,
  retry: true,
  defaultTimeoutMs: 30_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'data_policy';
    const title = 'Data policy (ZDR path)';

    const http = await ctx.http.request({
      method: 'POST',
      path: '/chat/completions',
      body: ctx.body({
        model: ctx.provider.model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 16,
        temperature: 0,
        // Pin the request to providers that do not collect user data. If none
        // qualifies, OpenRouter errors instead of silently downgrading.
        provider: { data_collection: 'deny' },
      }),
    });

    // The endpoint may also be addressed through extraBody; merge in case the
    // operator pinned routing there instead.
    const observed: Metrics = {
      http_status: http.status,
      duration_ms: http.durationMs,
      deny_supported: null,
    };

    const init: ResultInit = {
      metrics: observed,
      request: http.request,
      response: http.response,
      durationMs: http.durationMs,
    };

    if (http.status === 0) {
      return fail(
        name,
        title,
        `the data-collection probe did not complete: ${http.error ?? 'no response'}; the data policy for this model is unknown`,
        init,
      );
    }

    if (http.ok) {
      // Name the endpoint that served it. "A ZDR path exists" is close to
      // useless on its own; the useful part is that you can see which
      // provider you were actually routed to, and check it is the one you
      // were relying on.
      const servedBy = readProviderName(http.json);
      Object.assign(observed, { deny_supported: true, served_by: servedBy ?? null });
      ctx.facts.zdrPathAvailable = true;
      ctx.facts.zdrProvider = servedBy;
      return pass(
        name,
        title,
        'a provider.data_collection:"deny" request succeeded, so at least one endpoint for this model offers a no-training path',
        {
          ...init,
          findings: [
            finding(
              'data_policy',
              'zdr_path_available',
              'A no-training path exists',
              'the same request answered 200 with provider.data_collection set to "deny"',
              'at least one upstream endpoint for this model does not retain user data, so sensitive traffic has somewhere safe to go - this is the weakest of the findings, because it describes one request that happened to be routed well, and the next request may not be',
              
              {
                http_status: http.status,
                duration_ms: http.durationMs,
                served_by: servedBy ?? 'not reported by the endpoint',
              },
            ),
          ],
        },
      );
    }

    const errorText = readErrorText(http.json) ?? http.text;
    const looksLikePolicyRefusal = /data_collection|no available model provider|does not collect|zero.data|zdr/i.test(
      errorText,
    );

    // A 400 that never mentions the parameter means the endpoint did not
    // understand it, which is a different (and worse) answer than "no ZDR".
    if (!looksLikePolicyRefusal) {
      Object.assign(observed, { deny_supported: false });
      return fail(
        name,
        title,
        `the data-collection probe returned HTTP ${http.status} without mentioning data_collection, so the endpoint did not act on the parameter and the data policy is unknown - do not assume this is a "no training" answer`,
        { ...init, details: { error: errorText.slice(0, 400) } },
      );
    }

    Object.assign(observed, { deny_supported: false });
    ctx.facts.zdrPathAvailable = false;

    const findings: Finding[] = [
      finding(
        'data_policy',
        'no_zdr_path',
        'No no-training path exists',
        `a request pinned to provider.data_collection:"deny" was rejected (HTTP ${http.status}: ` +
          `${errorText.slice(0, 160)}), meaning no endpoint for this model qualifies as zero-data-retention`,
        'every request routed to this model may be stored by its provider and used for training, so it is unsuitable for anything confidential unless that is acceptable in writing; the check fails rather than warns because this is a routing constraint, not a quality issue',
        { http_status: http.status, duration_ms: http.durationMs },
      ),
    ];

    return fail(
      name,
      title,
      `no ZDR endpoint is available for this model (data_collection:"deny" was rejected with HTTP ${http.status})`,
      { ...init, findings, details: { error: errorText.slice(0, 400) } },
    );
  },
});

/** OpenRouter echoes the serving provider on the response body. */
function readProviderName(body: unknown): string | null {
  if (!isRecord(body)) return null;
  for (const key of ['provider', 'provider_name']) {
    const v = body[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function readErrorText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const err = body['error'];
  if (typeof err === 'string') return err;
  if (isRecord(err) && typeof err['message'] === 'string') return err['message'];
  if (typeof body['message'] === 'string') return body['message'];
  return null;
}
