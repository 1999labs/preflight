/**
 * Check 9 - error_handling
 *
 * A router's retry and fallback logic is written against status codes, so
 * malformed input is a *contract test*, not a robustness test. Three probes
 * that any endpoint must survive:
 *
 *  - a malformed body, which should be the caller's fault (400),
 *  - an unknown model id, which is a routing miss (404 or 400),
 *  - an oversized request, which is a capacity problem (413, or 400/422 from
 *    a gateway that validates inline).
 *
 * The failure this exists to catch is a `500` or an HTML error page. Both mean
 * the provider cannot distinguish "you sent me garbage" from "I am broken",
 * which means a router's retry loop will retry indefinitely against a fault
 * that will never clear, and a client SDK that tries to parse the body as JSON
 * will throw instead of surfacing a useful error.
 *
 * `429` is accepted for the oversized probe: a free-tier account is a rate
 * limiter before it is a server, and treating that as a defect would make this
 * check useless on exactly the endpoints it is most needed for.
 */

import { defineCheck, type CheckContext } from '../registry.js';
import { fail, finding, isRecord, pass, warn, type ResultInit } from './_helpers.js';
import type { CheckResult, Finding, MetricValue, Metrics, WireRequest, WireResponse } from '../types.js';

/** ~2 MB: large enough to trip a body limit, small enough to send anywhere. */
const OVERSIZED_BODY_BYTES = 2 * 1024 * 1024;
const OVERSIZED_TIMEOUT_MS = 45_000;

interface ProbeResult {
  probe: string;
  status: number;
  request?: WireRequest;
  response?: WireResponse;
  durationMs: number;
  acceptable: boolean;
  problem: string | null;
  contentType: string;
  jsonBody: boolean;
  hasErrorField: boolean;
  errorMessage: string | null;
}

const ACCEPTABLE_CODES = new Set([400, 401, 403, 404, 405, 413, 415, 422, 429]);

export default defineCheck({
  name: 'error_handling',
  title: 'Error handling',
  description: 'Malformed, unknown-model and oversized requests get sensible codes and JSON error bodies.',
  requests: 3,
  defaultTimeoutMs: 120_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'error_handling';
    const title = 'Error handling';

    // 1. Malformed JSON body.
    const malformed = await ctx.http.request({
      method: 'POST',
      path: '/chat/completions',
      rawBody: '{"model": "broken", "messages": [',
      headers: { 'content-type': 'application/json' },
    });

    // 2. A model id that cannot exist.
    const unknownModel = await ctx.http.request({
      method: 'POST',
      path: '/chat/completions',
      body: ctx.body({
        model: 'preflight/definitely-not-a-real-model-9f3a2c',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
      }),
    });

    // 3. An oversized body.
    const oversized = await ctx.http.request({
      method: 'POST',
      path: '/chat/completions',
      body: ctx.body({
        model: ctx.provider.model,
        messages: [{ role: 'user', content: 'x'.repeat(OVERSIZED_BODY_BYTES) }],
        max_tokens: 16,
      }),
      timeoutMs: OVERSIZED_TIMEOUT_MS,
    });

    const probes: ProbeResult[] = [
      evaluate('malformed_body', malformed, new Set([400, 415, 422])),
      evaluate('unknown_model', unknownModel, new Set([400, 404, 422])),
      evaluate('oversized_request', oversized, new Set([400, 413, 422, 429])),
    ];

    const serverErrors = probes.filter((p) => p.status >= 500 || p.status === 0);
    const htmlBodies = probes.filter((p) => p.contentType && !/json/i.test(p.contentType) && p.status !== 0);
    const badCodes = probes.filter((p) => !p.acceptable && p.status !== 0);
    const missingErrorBody = probes.filter((p) => p.status !== 0 && p.status >= 400 && !p.jsonBody);

    const metrics: Metrics = {
      probes: probes.length,
      http_statuses: probes.map((p) => p.status).join(','),
      server_errors: serverErrors.length,
      html_error_bodies: htmlBodies.length,
      non_json_error_bodies: missingErrorBody.length,
      unexpected_codes: badCodes.length,
    };

    const init: ResultInit = {
      metrics,
      details: { probes },
      findings: buildFindings(probes),
      durationMs: probes.reduce((a, p) => a + p.durationMs, 0),
    };

    // A probe that behaved surprisingly should be reproducible from the
    // report alone, so attach the wire pair of whichever probe is at fault.
    const culprit =
      serverErrors[0] ??
      htmlBodies[0] ??
      badCodes[0] ??
      missingErrorBody[0] ??
      probes.find((p) => p.status === 200);
    const withWire = culprit ? { ...init, request: culprit.request, response: culprit.response } : init;

    if (serverErrors.length > 0) {
      return fail(
        name,
        title,
        `${serverErrors.length} of ${probes.length} probes returned a server error or no response (${describe(serverErrors)}); a router's retry loop would spin against a fault that cannot clear`,
        { ...init, request: malformed.request, response: malformed.response },
      );
    }

    if (htmlBodies.length > 0) {
      return fail(
        name,
        title,
        `${htmlBodies.length} probe(s) returned an HTML error body instead of JSON (${describe(htmlBodies)}); a client SDK parsing the error will throw rather than report the fault`,
        withWire,
      );
    }

    if (badCodes.length > 0) {
      return warn(
        name,
        title,
        `${badCodes.length} probe(s) returned an unrecognised but non-5xx status (${describe(badCodes)}); confirm your retry logic handles these`,
        withWire,
      );
    }

    if (missingErrorBody.length > 0) {
      return warn(
        name,
        title,
        `all statuses are sensible but ${missingErrorBody.length} error body/bodies were not JSON, so the failure reason is unavailable to a caller`,
        withWire,
      );
    }

    return pass(
      name,
      title,
      `all three probes returned ${probes.map((p) => p.status).join('/')} with JSON error bodies and no 5xx`,
      init,
    );
  },
});

function evaluate(
  probe: string,
  res: {
    status: number;
    contentType: string;
    json?: unknown;
    text: string;
    durationMs: number;
    error?: string;
    timedOut?: boolean;
    request?: WireRequest;
    response?: WireResponse;
  },
  ideal: Set<number>,
): ProbeResult {
  const jsonBody = res.json !== undefined;
  let hasErrorField = false;
  let errorMessage: string | null = null;

  if (isRecord(res.json)) {
    const err = res.json['error'];
    if (typeof err === 'string') {
      hasErrorField = true;
      errorMessage = err;
    } else if (isRecord(err)) {
      hasErrorField = true;
      errorMessage = typeof err['message'] === 'string' ? err['message'] : null;
    } else if (typeof res.json['message'] === 'string') {
      hasErrorField = true;
      errorMessage = res.json['message'];
    }
  }

  let acceptable = true;
  let problem: string | null = null;

  if (res.status === 0) {
    acceptable = false;
    problem = res.timedOut ? 'timed out with no response' : `no response (${res.error ?? 'transport error'})`;
  } else if (res.status >= 500) {
    acceptable = false;
    problem = `HTTP ${res.status} is a server error, not a client error`;
  } else if (!ACCEPTABLE_CODES.has(res.status)) {
    acceptable = false;
    problem = `HTTP ${res.status} is not a recognised error status`;
  } else if (!ideal.has(res.status)) {
    // Still acceptable, just not the textbook code for this probe.
    problem = null;
  }

  return {
    probe,
    status: res.status,
    ...(res.request ? { request: res.request } : {}),
    ...(res.response ? { response: res.response } : {}),
    durationMs: res.durationMs,
    acceptable,
    problem,
    contentType: res.contentType,
    jsonBody,
    hasErrorField,
    errorMessage,
  };
}

/**
 * A 2xx to a deliberately invalid request is not a pass. It means the edge
 * accepted input it should have rejected, so a caller bug surfaces as a real
 * inference and a real bill rather than a fast, cheap error.
 */
function buildFindings(probes: ProbeResult[]): Finding[] {
  const accepted = probes.filter((p) => p.status >= 200 && p.status < 300);
  if (accepted.length === 0) return [];
  return accepted.map((p) =>
    finding(
      'error_handling',
      'invalid_request_accepted',
      'Invalid request accepted',
      `the ${p.probe.replace(/_/g, ' ')} probe returned HTTP ${p.status} instead of an error status`,
      'the endpoint does not validate this at the edge, so a client bug becomes a full inference and a bill rather than a fast rejection; size and shape limits are enforced somewhere less visible, if at all',
      { probe: p.probe, http_status: p.status, duration_ms: p.durationMs },
    ),
  );
}

function describe(probes: ProbeResult[]): string {
  return probes.map((p) => `${p.probe}=${p.status}${p.problem ? ` (${p.problem})` : ''}`).join(', ');
}

export type { MetricValue };
