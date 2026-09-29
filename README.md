# preflight

[![CI](https://github.com/1999labs/preflight/actions/workflows/ci.yml/badge.svg)](https://github.com/1999labs/preflight/actions/workflows/ci.yml)

Launch-QA readiness checks for OpenAI-compatible LLM endpoints.

> **Status:** thirteen checks, all implemented, each verified twice against a
> local mock server: once healthy, once carrying the specific defect it is meant
> to catch. Nine check runs against real OpenRouter endpoints are recorded in
> [`FINDINGS.md`](FINDINGS.md), along with sixteen bugs the tool found in itself
> while making them.

**If you read one thing, read [`FINDINGS.md`](FINDINGS.md).** It is the part
that is not boilerplate: sixteen bugs this tool found in *itself* while being
run against real endpoints, three of which produced a confident wrong answer
rather than an error. Bug #14 is the one worth your time: the context probe
reported "1,000,000 tokens confirmed" for a request the provider had just
rejected with HTTP 400, because the verdict compared with `<` where it needed
`<=`. A tool that reports success for the failure it exists to catch is worse
than no tool, because it gets trusted. The rest of this README is
documentation; that file is the argument.

This is the tool you run **before** onboarding a new provider into a router. It
answers a narrow question: if I send production traffic to this endpoint
tomorrow, what will break? Every check returns `pass` / `warn` / `fail` with
numbers, and the process exits non-zero if anything fails, so it can sit in CI
as a gate on a provider-onboarding PR.

The [`blocked`](#four-statuses-not-three) status is the part that is easy to
miss and hard to retrofit: it means the endpoint was never reached, so nothing
was learned. A tool that reports a saturated free tier as a broken provider
tells a reader to reject something that works.

## Install

Requires Node 20+. The only runtime dependency is `commander`.

```bash
git clone https://github.com/1999labs/preflight.git
cd preflight
npm install
npm run build
node dist/cli.js --list-checks
```

`dist/` is gitignored, so a fresh clone has no prebuilt output and `npm install`
is required. For a quick look without building, `npx tsx src/cli.ts --list-checks`
runs the CLI straight from source.

**There is no `npx preflight` yet.** npm publishing is not wired up, so the
examples below assume either a local build or `npx tsx`.

Copy `providers.example.json` to `providers.json` and edit it; see
[Usage](#usage).


## Usage

```bash
# one provider
preflight --base-url https://api.example.com/v1 \
               --model some-model \
               --key $KEY \
               --runs 20 \
               --out report.json \
               --md

# several providers in one pass
preflight --config providers.json --out report.json --md

# just the checks you care about
preflight --base-url https://api.example.com/v1 --model m \
  --key $KEY --only streaming,latency --runs 50
```

### Options

| Flag | Default | Notes |
| --- | --- | --- |
| `--base-url <url>` | none | Endpoint root, including `/v1`. |
| `--model <id>` | none | Model id to exercise. |
| `--key <key>` | env | Prefer `keyEnv` in `providers.json` over passing keys on the command line. |
| `--config <path>` | none | `providers.json`; runs every entry. |
| `--id <id>` | none | With `--config`, run only these provider ids. Repeatable. |
| `--dry-run` | none | Print the planned request count per target and exit. **Makes no network calls.** Exits non-zero if the plan exceeds `--daily-cap`. |
| `--daily-cap <n>` | `50` | Requests/day to plan against in `--dry-run`. |
| `--zdr` | off | Include the zero-data-retention probe (1 request per target). |
| `--runs <n>` | `20` | Latency runs. |
| `--out <path>` | none | Where to write `report.json`. |
| `--md` | off | Also write a markdown card per provider, next to `--out`. |
| `--vision` | off | Enables the vision check. |
| `--compare` | off | Diff claimed metadata against the OpenRouter catalog. |
| `--only <a,b>` / `--skip <a,b>` | none | Filter the check list. |
| `--timeout <ms>` | `60000` | Default per-check timeout. |
| `--context-safety <n>` | `0.9` | Filler scaling factor for the context probe. |
| `--context-probes <n>` | `4` | How many rungs to probe when the ladder is sized to the claim. |
| `--context-ladder <rungs>` | none | Explicit rungs, e.g. `8k,32k,128k,1M`. Overrides the planned ladder. |
| `--check-timeout <name=ms>` | none | Per-check override; repeatable. |
| `--latency-concurrency <n>` | `1` | Parallel latency runs. Keep at 1 for rate-limited providers. |
| `--code-exec` | off | Lets `quality_smoke` execute model-written code. Off by default; see below. |
| `--verbose` | off | Per-check detail while running. |
| `--list-checks` | none | Print the registered checks and exit. |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No check failed. `warn` does not fail the build. |
| `1` | At least one check **failed**: reached the provider, something is wrong with it. |
| `2` | Usage or configuration error (bad flags, unreadable `providers.json`). |
| `3` | Nothing failed, but something was **blocked**, so the result is inconclusive rather than clean. |

### Four statuses, not three

| Status | Meaning |
| --- | --- |
| `pass` / `warn` | A verdict, and it is fine. |
| `fail` | A verdict: the endpoint was reached and something is wrong with it. |
| `skip` | Chosen not to run (`vision` without `--vision`, `structured_outputs` unadvertised). |
| `blocked` | **No verdict at all.** The endpoint was never reached. |

A `fail` whose HTTP status is **429 or 503** is rewritten to `blocked`. This is
applied centrally in the runner rather than inside each check, because a check
that forgets it turns an outage into a rejection of a healthy provider, the
exact failure this tool exists to prevent. The first Qwen run reported three
FAILs for a model nobody had actually talked to.

429/503 is retried once before a check is marked blocked, honouring a
`Retry-After` header or a `retry_after` field when present. **Retry is
per-check and opt-in**: on for "does this work at all" checks, and off for
`latency`, `quality_smoke` and `error_handling`, because retrying inside a
measurement reports the second attempt and hides the first failure.

Budget accordingly: a target that 429s every call costs **double**. `--dry-run`
prints both numbers.

### providers.json

```json
{
  "defaults": { "timeoutMs": 60000, "runs": 20 },
  "providers": [
    {
      "id": "acme-gateway",
      "name": "Acme LLM Gateway",
      "baseUrl": "https://api.acme.example/v1",
      "model": "acme-large-70b",
      "keyEnv": "ACME_API_KEY",
      "extraBody": { "user": "preflight/0.1" },
      "timeouts": { "latency": 180000 },
      "notes": "Rate limited to 60 rpm, so latency runs stay sequential."
    },
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "openai/gpt-4o-mini",
      "keyEnv": "OPENROUTER_API_KEY"
    }
  ]
}
```

Keys resolve in this order: `--key` flag → the provider's `key` field (which may
be written as `"$MY_VAR"` to keep secrets out of the file) → `keyEnv` →
`PROVIDER_CHECK_KEY` / `OPENAI_API_KEY`. A missing key is reported as a `fail`
for that provider only; the rest of the report still runs.

See `providers.example.json` for a fuller example, including a non-Bearer auth
header.

## Example run

### Against a real endpoint

`preflight` against OpenRouter, `--zdr --vision --compare --runs 5`:

```
▸ OpenRouter — stealth/space-bunny-alpha  (https://openrouter.ai/api/v1 · stealth/space-bunny-alpha)
  ✓ models_endpoint    PASS     537ms  model "stealth/space-bunny-alpha" listed among 460, claiming 1,000,000 context tokens
  ✓ chat_basic         PASS     903ms  valid completion in 900.9ms, 163+2 tokens reported
  ✓ streaming          PASS    3250ms  6 frames, finish_reason="stop", [DONE] present, streamed text matches the non-streamed answer exactly (TTFT 1518.6ms)
  ✓ tool_calling       PASS    2759ms  tool call parsed into the nested schema correctly, and no tool was called for a plain question
  ✓ json_mode          PASS    2427ms  output parsed as a JSON object with keys [service, replicas]
  ! error_handling     WARN    7056ms  1 probe(s) returned an unrecognised but non-5xx status (oversized_request=200 …); confirm your retry logic handles these
  ✗ context_probe      FAIL   12217ms  the catalog claims 1,000,000 tokens, but a prompt of that size was rejected (HTTP 400)
  ! latency            WARN   14229ms  the model streams a reasoning phase (193 chars at p50) but usage reports 0 reasoning tokens, so token-based billing and budgeting will undercount
  ✓ quality_smoke      PASS   18722ms  10/10 golden prompts scored as expected
  · structured_outputs SKIP       1ms  not run: the catalog does not list structured_outputs for this model, so there is no contract to test
  ✓ vision             PASS    2249ms  the model correctly reported that the image contains no text
  ✓ modality_claims    PASS       2ms  description, catalog and measurement agree that this model accepts images
  ✓ data_policy        PASS    1841ms  a provider.data_collection:"deny" request succeeded, so at least one endpoint for this model offers a no-training path
```

**That one WARN is the most interesting line on the card.** The model advertises
a 1,000,000-token window, and the probe sent a prompt scaled *below* that claim
(an estimated 899,979 tokens), expecting it to pass. It came back HTTP 400:

> This endpoint's maximum context length is 1000000 tokens. However, you
> requested about 1062081 tokens.

We under-sent and were still rejected, because the endpoint's tokenizer counts
our filler roughly 18% higher than our estimate does. The endpoint's own stated
ceiling matches the catalog, so nothing here shows the window being smaller than
advertised. What it shows is that we could not generate a valid 1M probe, so the
claim is **unverified rather than refuted**, and the number a router should trust
is the one that was *measured* (250,000). A card that reported `PASS` here, or
that reported a "broken context window", would have been wrong in opposite
directions.

**On the `context_probe` line specifically:** the run above predates a fix. That
run printed `PASS` with the note "matching the claimed 1,000,000" for the same
probe that had just been rejected. The cause was an off-by-one in the verdict
logic: a failure *at* the claim was compared with `<` where it needed `<=`. The
line shown is what the current version reports. It is bug #14 in
[`FINDINGS.md`](FINDINGS.md), and it is a useful illustration of why the checks
are verified against mocks that can fail: a `pass` for the exact failure the
check exists to catch is worse than no check, because it gets trusted.

### Against the local mock

`npx tsx test/demo.ts` runs the real CLI against a mock gateway, so everything
below is generated output rather than a hand-written fiction. The second
provider is the mock deliberately carrying the dropped-last-token bug, an
unadvertised context length, and a 429:

```
▸ Mock Gateway (healthy)  (http://127.0.0.1:60275/v1 · mock-model-1)
  ✓ models_endpoint    PASS      48ms  model "mock-model-1" listed among 1, claiming 8,192 context tokens
  ✓ chat_basic         PASS       6ms  valid completion in 5.63ms, 9+1 tokens reported
  ✓ streaming          PASS     106ms  22 frames, finish_reason="stop", [DONE] present, tail intact (TTFT 14.28ms)
  ✓ latency            PASS    3366ms  TTFT p50 17.2ms / p95 19.08ms, 255.02 tok/s p50 over 4 runs

▸ Mock Gateway (defective)  (http://127.0.0.1:60276/v1 · mock-model-1)
  ! models_endpoint    WARN       5ms  model "mock-model-1" is listed but no context_length is advertised
  ✓ chat_basic         PASS       5ms  valid completion in 4.31ms, 9+1 tokens reported
  ✗ streaming          FAIL      79ms  the stream dropped the tail of the answer (67 chars streamed vs 70 non-streamed, ended "… 14, 15, 16, 17, 18, 19,")
  ! latency            WARN    2006ms  3/4 runs succeeded; 1 failed (HTTP 429 x1) - check for rate limiting
```

### `report.md`

```markdown
## Mock Gateway (defective) — FAIL

- **Endpoint:** `http://127.0.0.1:60276/v1`
- **Model:** `mock-model-1`
- **Duration:** 2.1s
- **Latency:** TTFT p50 10.20 / p95 12.22 ms · output 334.83 tok/s p50 / 342.03 p95 (3/4 runs ok)

| Check | Status | Detail |
| --- | --- | --- |
| `models_endpoint` | ⚠️ WARN | model is listed but no context_length is advertised |
| `chat_basic` | ✅ PASS | valid completion in 4.31ms, 9+1 tokens reported |
| `streaming` | ❌ FAIL | the stream dropped the tail of the answer (67 chars streamed vs 70 non-streamed) |
| `latency` | ⚠️ WARN | 3/4 runs succeeded; 1 failed (HTTP 429 x1) - check for rate limiting |

### Notes

- **Streaming (SSE)** (FAIL): the stream dropped the tail of the answer (67 chars
  streamed vs 70 non-streamed, ended "… 14, 15, 16, 17, 18, 19,") _(Blocking.)_
- **Latency and throughput** (WARN): 3/4 runs succeeded; 1 failed (HTTP 429 x1) _(Worth knowing.)_
```

### `report.json`

Trimmed; the real file carries the full request/response pair for every
non-passing check.

```json
{
  "tool": "preflight",
  "version": "0.1.0",
  "generatedAt": "2026-09-29T03:06:06.410Z",
  "durationMs": 5612,
  "targets": [
    { "id": "broken", "name": "Mock Gateway (defective)", "baseUrl": "http://127.0.0.1:60276/v1", "model": "mock-model-1" }
  ],
  "options": { "runs": 4, "timeoutMs": 60000, "checks": ["models_endpoint", "chat_basic", "streaming", "latency"] },
  "runs": [
    {
      "provider": { "id": "broken", "name": "Mock Gateway (defective)", "baseUrl": "http://127.0.0.1:60276/v1", "model": "mock-model-1" },
      "startedAt": "2026-09-29T03:06:02.8Z",
      "durationMs": 2094,
      "results": [
        {
          "check": "streaming",
          "title": "Streaming (SSE)",
          "status": "fail",
          "note": "the stream dropped the tail of the answer (67 chars streamed vs 70 non-streamed, ended \"… 14, 15, 16, 17, 18, 19,\")",
          "metrics": {
            "frames": 24, "data_frames": 23, "done_sentinel": true,
            "finish_reason": "stop", "tail_match": "prefix",
            "ttft_first_token_ms": 9.42, "nonstream_text_chars": 70, "nonstream_finish_reason": "stop"
          },
          "request": { "method": "POST", "url": ".../chat/completions", "headers": { "authorization": "[redacted]" }, "body": { "stream": true } },
          "response": { "status": 200, "contentType": "text/event-stream" },
          "durationMs": 79.11
        }
      ],
      "summary": { "pass": 1, "warn": 2, "fail": 1, "skip": 0, "total": 4, "status": "fail", "durationMs": 2094 },
      "facts": { "modelListed": true, "streamSupported": true }
    }
  ],
  "summary": { "providers": 2, "pass": 5, "warn": 2, "fail": 1, "skip": 0, "status": "fail" }
}
```

## What each check catches, and why a router cares

A router's job is to promise a request will come back correct, within a latency
budget, at a price it quoted. Each check below exists because of a specific way
that promise breaks.

These are numbered in **execution order**, the same order `--list-checks`
prints, rather than in the order they were written. It is not a ranking:
`models_endpoint` is first only because it discovers the claimed context
length and supported parameters that the checks after it depend on, and
`modality_claims` is late only because it reconciles the catalog against a
`vision` measurement.

### 1. `models_endpoint`: *is the model real, and what does it claim?*

`GET /models` must return JSON and list the model under test. Records
`context_length`, pricing and supported parameters when advertised.

*Why a router cares:* some gateways accept any model id and silently route to a
default, so your "70B" request is answered by something else. The advertised
context length is also the only machine-readable claim available for the
`context_probe` and `--compare` checks to hold the provider to. A missing
context length is a `warn`, not a `fail`: plenty of correct endpoints publish
only `{id, object, owned_by}`, and the probe will find out empirically.

A single-model endpoint that lists *one* model under a different name is also a
`warn` rather than a `fail`, because self-hosted servers routinely ignore the
model field entirely and failing them would be wrong.

### 2. `chat_basic`: *is the floor solid?*

One short prompt, and then the response is inspected for a well-formed
`chat.completion`: a `choices[].message` with content, an `id`, and `usage`.

*Why a router cares:*

- **No `usage` block** means no token counts, so you cannot bill, enforce a
  token budget, or attribute spend to a tenant. Many self-hosted servers do
  this, and it surfaces as a billing incident rather than an outage.
- **A mismatched `model` echo** means the provider served something other than
  what you asked for, which invalidates every other measurement in the report.
- **A missing `id`** means responses cannot be correlated with your own logs.

All three are `warn`: the endpoint works, but something downstream will be
wrong. A missing `choices` array or empty content is a `fail`.

### 3. `streaming`: *does the SSE contract hold?*

Streams a deterministic prompt and requires parseable SSE frames, a final frame
carrying `finish_reason`, and a `[DONE]` sentinel. It then runs the *same* prompt
non-streamed and compares the two answers.

Determinism is what makes the comparison meaningful, so the request pins
`temperature: 0` and, **when the model's catalog entry advertises `seed`, a
`seed`** as well. The streamed and non-streamed calls are made with identical
bodies, so any difference is transport, not sampling. When the catalog does *not*
advertise `seed`, the report says so rather than implying a guarantee that isn't
there. An endpoint that accepts `seed` and silently ignores it is a finding of
its own.

The two answers are then classified:

| Comparison | Verdict | Means |
| --- | --- | --- |
| Streamed text is a **strict prefix** of the non-streamed text | `fail` | The tail was dropped. This is the bug the check exists for. |
| Lengths within **15%** | `pass` | Close enough to be the same answer. |
| Lengths outside 15%, and not a prefix | `warn` | Divergence without a dropped-tail signature, most likely sampling, not a transport fault. A transport bug does not usually produce a *longer* stream. |
| Stream ended at `max_tokens` | not judged | A truncated-by-budget stream is a correct response to a truncated budget, not a defect. |

*Why a router cares:*

- **No `finish_reason`** means a truncated generation is indistinguishable from
  a complete one. That is exactly the information you need to decide whether to
  retry, and without it every truncated response looks like a successful one.
- **No `[DONE]` sentinel** leaves clients that wait for one hanging until
  timeout. `warn`, because the stream is otherwise usable.
- **A dropped last token** is the bug this check exists for. It is common,
  invisible in single-shot testing, and silently corrupts every streamed answer
  in production, a truncated word at the end of each response. It is only
  detectable by comparing against non-streamed ground truth, which is what this
  does.
- **The `warn` case is load-bearing.** Without a prefix test, a length
  difference reads as "the model is inconsistent" and gets tuned away as
  sampling noise. The prefix signature is what separates a real transport fault
  from an honest "these two calls drew different tokens."

### 4. `tool_calling`: *are the arguments executable?*

Sends a tool whose schema nests an object inside an object, then verifies the
returned `arguments` string parses into that nested shape. Then sends a prompt
that should **not** call a tool and verifies it doesn't.

*Why a router cares:*

- **A flattened nested object** is the common failure. Implementations that copy
  top-level keys pass every shallow schema test and break on the first real one.
  The `limits: {cpu, memory}` object is what catches it.
- **Arguments that don't parse** fail in the caller's process, not the provider's.
  The provider returns 200 and looks healthy.
- **A false positive is worse than a false negative.** A model that calls a tool
  for "what is the capital of France" hands the caller a fabricated result with
  the same confidence as a real one, and nothing downstream can tell them apart.

The legacy `function_call` shape is accepted but raises a finding, because a
client written against `tool_calls` sees no call at all.

### 5. `json_mode`: *is structured output actually structured?*

Sends `response_format: {type: "json_object"}` and requires the output to parse
as an object. The prompt contains the word "json", since OpenAI-family
endpoints reject the parameter otherwise and that rejection would be a property
of the prompt rather than the provider.

*Why a router cares:* the dangerous case is a provider that **accepts
`response_format` and ignores it**. Nothing fails at request time; the output
arrives wrapped in prose and the break surfaces downstream, far from the cause.
A rejection is a `fail` rather than a warning, because the catalog normally
advertises `response_format`. If the advertised surface and the real one
disagree, that is a launch blocker. Valid JSON in a code fence is a `warn`: the
mode was honoured, the formatting was not, and a strict parser needs to strip it.

### 6. `error_handling`: *can a retry loop tell a fault from a mistake?*

Three probes that any endpoint must survive: a malformed body, an unknown model
id, and a ~2 MB oversized request. Each must return a sensible status and a
JSON error body.

*Why a router cares:*

- **A `500` means the provider cannot distinguish "you sent garbage" from "I am
  broken."** A retry loop written against that contract retries indefinitely
  against a fault that will never clear, burning the budget you were trying to
  protect.
- **An HTML error page** breaks every SDK that parses the error as JSON, turning
  a clean 413 into an unhandled parse exception.
- **A 2xx to an invalid request** is the finding this catches most often. It
  means the edge does not validate, so a client bug becomes a full inference and
  a real bill rather than a fast rejection.

`429` is explicitly accepted for the oversized probe: a free-tier account is a
rate limiter before it is a server, and treating that as a defect would make the
check useless on exactly the endpoints that need it.

### 7. `context_probe`: *is the advertised context window real?*

Filler prompts up a ladder sized to the advertised `context_length`, stopping at
the first failure. The ladder *reaches the claim* when the budget allows: a
1M claim gets rungs of 125k / 250k / 500k / 1M rather than stopping at 128k,
so a `pass` on a 1M model means 1M was actually exercised. Override with
`--context-ladder`, or set the rung count with `--context-probes`.

*Why a router cares:* the advertised window is the only machine-readable claim a
provider makes about itself, and a router sizing context budgets on it will
overflow the real one. Two subtleties the check is careful about:

- **Passing the top rung proves the claim only if the rung reaches it.** The
  ladder tops out at `MAX_LADDER_TOP` (1M), so a claim beyond that is clamped
  and the verdict is "verified to the probe cap", not "confirmed". The report
  carries `claim_fully_probed` so a reader can tell which they got, and the
  note says so in words.
- **Token counts are estimates.** Filler is scaled by `--context-safety`
  (default 0.9) so estimator error does not manufacture a failure. A false fail
  is visible and explainable; a false pass silently misroutes traffic.
- **A rejected probe is not automatically a refuted claim.** When the endpoint
  reports how *it* counted the request, the two are compared. If we estimated
  below the claim, the provider counted above it, and the provider's own stated
  ceiling agrees with the catalog, then the likely cause is that our filler
  inflates under their tokenizer, not that the window is smaller. That is
  reported as a `warn` with a `context_probe_tokenizer_disagreement` finding
  and a `tokenizer_ratio` metric, and the note says "unverified, not as
  refuted". Only a provider whose stated ceiling is *below* the catalog claim
  produces a `fail`.

  This distinction is the difference between a measurement and an accusation.
  A real endpoint answered with *"maximum context length is 1000000 tokens.
  However, you requested about 1062081 tokens"* after we sent an estimated
  899,979, and calling that a broken context window would have blamed the
  provider for our arithmetic.

It never probes above what the provider claims, and it stops early on failure
so a model with an 8k window costs 1 request, not 4.

### 8. `latency`: *is it fast enough to route to?*

N runs (default 20) of a fixed prompt capped at 200 output tokens, streamed, so
TTFT and decode rate are measured separately. Reports p50 and p95 for both,
plus raw per-run timings.

*Why a router cares:* the two numbers drive different routing decisions. Slow
TTFT with good throughput feels broken in a chat UI even though the model is
fast; fast TTFT with poor throughput looks great until the answer is long.
A router needs both to place a provider in a tier.

One warm-up run is discarded, because cold-start cost is not what steady-state
traffic sees. Partial failures are a `warn` and the first failing request/response
pair is kept in the report, because intermittent `429`s are a rate-limit
finding rather than a defect. `latency` makes no judgement about whether the
numbers are *good*, but that threshold belongs to your product, not this tool.

**Reasoning models are handled explicitly.** For a model that thinks before it
answers, `completion_tokens` conflates reasoning with visible output, and TTFT
includes the entire thinking phase. Both are reported separately:

| Metric | Meaning |
| --- | --- |
| `ttft_p50_ms` | Time to the first **visible** token, so it includes any thinking phase. |
| `tps_p50` | Throughput over *all* generated tokens, reasoning included. |
| `visible_tps_p50` | Throughput over visible tokens only. |
| `reasoning_tokens_p50` | Reasoning tokens per run, when the provider reports them. |
| `visible_tokens_p50` | `completion_tokens` minus reasoning tokens. |

Reasoning text is read from `delta.reasoning_content` and
`delta.reasoning`, and counts from `completion_tokens_details.reasoning_tokens`,
`output_tokens_details.reasoning_tokens` or a top-level `reasoning_tokens`
providers disagree about all of these. If a run spends its entire output budget
thinking and emits nothing visible, that is reported as a failure with that
explicit reason, not as an empty response.

`throughput_unmeasurable` counts runs whose post-TTFT decode window was under
10ms. No tokens/sec figure is published for those, because a number derived
from a window shorter than the jitter around it is noise, and a confidently
wrong number in a launch doc is worse than a blank one.

### 9. `quality_smoke`: *which capability broke?*

Ten fixed prompts from `prompts/golden.json`: 2 arithmetic, 2 short code tasks,
2 factual, 2 instruction-following with a format constraint, 1 tool call, 1 that
should be refused. Scored per-prompt and reported as x/10 with a per-category
breakdown.

*Why a router cares:* the point is attribution, not the absolute number. 6/10
with arithmetic at 0/2 and facts at 2/2 is a completely different provider from
6/10 with the reverse, and they belong in different routing tiers.

Code tasks are scored **structurally by default**: the output must parse as
JavaScript and declare the required function, which catches prose answers and
truncated snippets without executing anything the model produced. `--code-exec`
additionally runs a real assertion suite in a sandboxed child process with a hard
timeout. It is off by default because executing model output is not something to
do implicitly in CI.

Refusal is scored on declining **and** not fabricating: a model that invents a
plausible password fails, because a confident wrong answer is worse than a
refusal.

> **A golden suite measures the test as well as the model.** The first live run
> scored 9/10, and the miss was a defect in our prompt, not the model: it asked
> for "three primary colors" and only accepted RED/BLUE/YELLOW, while the model
> answered RED,GREEN,BLUE, all four format constraints satisfied. Additive and
> subtractive primaries is a genuinely contested question, so that prompt would
> have been a permanent false positive teaching you to ignore the score. A test
> now asserts no golden prompt depends on a contested fact.

### 10. `structured_outputs`: *is the schema actually enforced?*

A sibling of `json_mode`, asking for more. `json_mode` only guarantees valid
JSON; `structured_outputs` asks the provider to enforce a schema, which is what
lets an extraction pipeline index fields instead of validating and retrying.

Providers frequently ship one parameter without the other, so this check
**self-skips unless the model's catalog entry advertises `structured_outputs`**.
Running it otherwise would report a catalog gap as an endpoint defect. The
inverse also now holds: when `json_mode` is rejected and the catalog does not
list `response_format`, the note says the catalog is the thing being judged, not
the endpoint.

### 11. `vision`: *does the model actually look?*

Gated behind `--vision`. Sends an image generated in code (a solid field with a
border, so the ground truth is exact and there is no asset to fetch) and asks
whether it contains any written text.

*Why a router cares:* a model that is not really multimodal will return a
confident description of something else, and nothing in the response tells the
caller the difference. The question is deliberately one a text-only model cannot
fake: a model that never looked describes the image or hedges, a model that
looked says "no".

### 12. `modality_claims`: *do the catalog and the model agree?*

Zero requests. It reads facts the other checks already established rather than
sending anything of its own, and it runs after `vision` for that reason.

Three sources can disagree about whether a model accepts images:

1. what the model page **describes**: marketing prose,
2. what the catalog **lists**: `architecture.modality`,
3. what the endpoint actually **does**: measured by the `vision` check.

Only the third is evidence. The first two are the same publisher's claims about
the same publisher, which makes them correlated rather than corroborating: a
catalog can be confidently and consistently wrong, and when it is, the router is
the thing that finds out.

*Why a router cares:* the asymmetry is what matters. "Lists image, measures
fail" is far worse than "lists text, measures nothing": the first sends real
images to an endpoint that will describe something else in their place, and the
caller has no way to tell. The reverse, a description promising vision the
catalog never mentions, wastes onboarding time rather than corrupting output, so
the check reports the disagreement rather than resolving it: resolving it needs
an image, which is `vision`'s job and is opt-in.

It returns `skip` when the catalog carries neither a description nor an
architecture block, because there is then nothing to compare against.

Two details about its verdicts, both deliberate:

- **A disagreement is a `pass`, not a `fail` or a `warn`.** The endpoint did what
  it did; what disagrees is the publisher's own metadata about it. The check
  raises a *finding* naming which source is at odds with which, and leaves the
  weighing to the reader, a check that turned inconsistent metadata into a red
  status would be reporting a marketing problem as a production outage.
- **"Not measured" is reported as such, in the note.** With `--vision` unset it
  passes with "description and catalog agree; not measured, because `--vision`
  was not run" rather than claiming agreement it did not establish. When
  `vision` *did* run and the reply was neither yes nor no, that is surfaced as
  `inconclusive` and explicitly not treated as a `fail`, absence of evidence
  and evidence of absence are different claims.

One limit worth stating: the claim patterns are deliberately narrow to avoid
false hits, so a model whose prose implies vision without using any of the
recognised phrasing is *not* flagged. A missed claim is quieter than an invented
one, and an invented finding is the more expensive error.


### 13. `data_policy`: *is there a no-training route?*

Opt-in via `--zdr`, one request.

OpenRouter publishes **no data-policy field**: not in the catalog, not on the
per-model endpoints endpoint. What it does expose is a request-side control:

> `provider.data_collection: "deny"`, described as *"use only providers which do
> not collect user data. If no available model provider meets the requirement,
> your request will return an error."*

So the question is answerable by behaviour rather than by scraping a model page.
One cheap request pinned to `deny`:

- **success**, meaning at least one endpoint offers a no-training path. The finding
  names the provider that actually served the request, because "a ZDR path
  exists" is close to useless without knowing which one you got.
- **that specific error**, meaning *no* endpoint for the model qualifies. Every request
  routed there may be stored and used for training. This **fails rather than
  warns**, because it is a routing constraint rather than a quality issue.

The asymmetry is deliberate: the affirmative is weak, it describes one request
that happened to be routed well, and the next may not be, while the negative is
strong.

*Why a router cares:* if there is no ZDR path, anything routed to that model may
be trained on. That is a compliance decision, and it cannot be made from a
catalog field that does not exist.

## Findings vs notes

A `Note` is a verdict: something passed, warned or failed. A **finding** is an
observation that is neither, a number that came off the wire, plus our reading
of it. Findings get their own section in the markdown card because a status table
forces a binary reading, and these deserve to be read as evidence.

Every finding keeps the two separate:

```markdown
**Prompt token overhead** `prompt_token_overhead` _(chat_basic)_

- **Observed:** prompt_tokens: 163 for a 4-word user message we estimated at ~14 tokens
- **We read that as:** the endpoint is counting tokens we did not send, which is
  consistent with a server-side system prompt being prepended
- _Evidence:_ `prompt_tokens=163`, `estimated_sent_tokens=14`, `cached_tokens=149`
```

"prompt_tokens: 163 for a 4-word message; 149 cached" is a fact.
"The provider injects a hidden system prompt" is our inference, and a reader who
disagrees can still act on the first line.

`FINDINGS.md` documents the five findings found against a real endpoint, each
with a **why a router cares** line.

## Design notes

**A check never throws.** Timeouts, DNS failures, HTML error pages, malformed
JSON and outright crashes are all `CheckResult` values with a status. Running
this against a half-broken provider is the normal case.

**Every check has a timeout.** The registry enforces it, so a hung endpoint
produces a `fail` with `timedOut: true` rather than a hung CI job.

**Keys are redacted twice**, at capture time, so a raw key never enters the
report object, and again as a sweep over the serialized JSON, to catch keys that
arrive inside a response body the tool doesn't control. `Authorization`-style
headers and key-shaped strings (`sk-…`, bearer tokens) are masked even when the
tool was never given the secret. `npm test` asserts a live key cannot reach
disk.

**Checks share discoveries through a facts bag.** `models_endpoint` runs first
and records the claimed context length; `context_probe` and `--compare` read it.
Adding a check is a new file in `src/checks/`, an import in
`src/checks/index.ts`, and a name in `ORDERED_CHECKS`. The test suite fails if a
check is registered but not listed.

**Token counts are estimated**, not tokenized: a blend of the chars/4 and
words×1.33 heuristics, rounded up. Shipping a tokenizer dependency to count
tokens in a pre-flight probe is the wrong trade. Where it matters, the
`context_probe` bias is deliberate: a false *fail* ("can't do 32k") is visible
and explainable, while a false *pass* silently misroutes traffic. Every
estimate is reported in the metrics so a reader can judge it.

**`--code-exec` is off by default.** `quality_smoke` includes short code tasks
with a runnable test. By default it scores them on syntax validity and required
structure only; with `--code-exec` it will execute model-written code in a
sandboxed child process with a timeout. Never enable that against untrusted
output in CI.

## Development

```bash
npm run typecheck
npm test          # 103 tests against a local mock server; nothing leaves the machine
npm run build
```

`npm test` runs every check twice: once against a well-behaved mock that must
pass, and once against a mock carrying the specific defect the check is supposed
to catch, which must be flagged. A check that cannot fail is not a check. It
also covers the no-throw guarantee, the timeout guard, key redaction, and the
CLI exit codes.

To regenerate the example output above against the mock:

```bash
npx tsx test/demo.ts
```

## Check coverage

This table is the registry's own list, in execution order. `models_endpoint`
runs first because it discovers the claimed context length and supported
parameters that `context_probe` and `--compare` then hold the provider to;
`modality_claims` runs after `vision` because it reconciles what the catalog
claimed against what the measurement found.

| # | Check | Requests | Status |
| --- | --- | ---: | --- |
| 1 | `models_endpoint` | 1 | implemented |
| 2 | `chat_basic` | 1 | implemented |
| 3 | `streaming` | 3 | implemented |
| 4 | `tool_calling` | 2 | implemented |
| 5 | `json_mode` | 1 | implemented |
| 6 | `error_handling` | 3 | implemented |
| 7 | `context_probe` | 4 | implemented; ladder sized to the claimed window, and distinguishes a refuted claim from an unverifiable one |
| 8 | `latency` | runs + 1 | implemented; one discarded warm-up, then `--runs` |
| 9 | `quality_smoke` | 10 | implemented, `prompts/golden.json` |
| 10 | `structured_outputs` | 1 | implemented; self-skips when the catalog does not advertise it |
| 11 | `vision` | 1 | implemented, opt-in via `--vision` |
| 12 | `modality_claims` | 0 | implemented; reconciles description, catalog and measurement |
| 13 | `data_policy` | 1 | implemented, opt-in via `--zdr` |
| none | `--compare` | 0 | implemented; diffs claimed metadata against the OpenRouter catalog |

Request counts are the base cost, and the whole plan is costable before
spending any of it, see [`--dry-run`](#usage).

`modality_claims`, `structured_outputs` and `data_policy` can all legitimately
return `skip`, and that is the correct answer rather than a gap: a check that
reports a missing catalog entry as an endpoint defect would be inventing a
finding.

