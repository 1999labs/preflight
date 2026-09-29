# Findings

Observations the checks surfaced that are neither pass nor fail. Each is split
into what the wire **said** and what we think it **means**, because the second
is a claim a reader is free to disagree with.

---

## 1. Reasoning under-reported in usage

**Observed:** every latency run streamed `reasoning_content` (99–211 characters,
p50 158) while `usage.completion_tokens_details.reasoning_tokens` was `0` in all
of them. `message.reasoning` was `null` on a non-streamed call.

**We read that as:** the provider generates reasoning but does not count it.
Token-based billing and per-request token budgets will undercount the work
actually done, and reported `output_tokens` describes visible text only.

**Why a router cares:** this is the difference between knowing what a request
cost and estimating it. If a tenant's spend is computed from reported tokens,
a reasoning-heavy workload is systematically under-billed, and the error grows
with exactly the requests you most want to meter. It also means `max_tokens`
limits reasoning models in ways that are invisible in the response.

**Check:** `latency`, `chat_basic` · **Status:** warn · **id:** `reasoning_underreported`

---

## 2. Prompt token overhead

**Observed:** `prompt_tokens: 163` for a 4-word user message we estimated at ~14
tokens, of which `cached_tokens: 149`.

**We read that as:** the endpoint is counting tokens we did not send, consistent
with a server-side system prompt being prepended. Budget and latency estimates
built on the caller's own prompt will be low.

**Why a router cares:** the gap between what you send and what you are billed is
the per-request tax on every call, and it lands on latency too. A router that
sizes context budgets, or predicts cost from request size, is wrong by a
constant it never measured. It also means the provider reserves a large prefix
of your context window before your prompt starts.

**Check:** `chat_basic` · **Status:** finding (non-blocking) · **id:** `prompt_token_overhead`

---

## 3. Seed accepted but not advertised

**Observed:** the request carried `seed: 42` and the endpoint accepted it with no
error, but the model's advertised `supported_parameters` are `[include_reasoning,
max_tokens, reasoning, reasoning_effort, response_format, temperature,
tool_choice, tools, top_p]` — which do not include `seed`.

**We read that as:** the endpoint accepts and silently ignores the seed, so the
streamed and non-streamed calls were pinned by `temperature: 0` alone.
Divergence between them is expected and is not evidence of a transport bug.

**Why a router cares:** accepted-and-ignored is worse than rejected. A rejected
parameter fails loudly at integration; an ignored one produces responses that
look deterministic until they are not, which for a router means two identical
requests can be routed differently and there is no signal that it happened. Any
caching or deduplication keyed on request+seed is unsound against this endpoint.

**Check:** `streaming` · **Status:** finding (non-blocking) · **id:** `seed_accepted_but_unsupported`

---

## 4. Invalid request accepted

**Observed:** the `oversized_request` probe (~2 MB body) returned HTTP 200.
Malformed body returned 400 and an unknown model id returned 400, both with JSON
error bodies.

**We read that as:** the endpoint does not validate body size at the edge, so a
client bug becomes a full inference and a real bill rather than a fast
rejection. Size limits are enforced somewhere less visible, if at all.

**Why a router cares:** input validation is a cheap defence. A client that
accidentally sends a 50 MB prompt gets billed for it and waited on, rather than
getting an immediate 413. It also means the provider's own limits are not
knowable from the error contract, so capacity planning rests on guesswork.

**Check:** `error_handling` · **Status:** warn · **id:** `invalid_request_accepted`

---

## 5. Streaming divergence that is not a dropped chunk

**Observed:** streamed text was 69 characters against 50 for a non-streamed call
of the same seeded prompt — the stream was *longer*. Neither call hit
`max_tokens`; both returned `finish_reason: stop`.

**We read that as:** sampling variance, following from finding 3. Correctly
classified as `diverged` and warned rather than failed.

**Why a router cares:** a naive char-diff comparison of two calls reports this as
a dropped final chunk, which is the exact failure that check exists to catch. A
check that cries wolf gets ignored, and a real dropped token then ships. This is
the reason the comparison is staged rather than a diff.

**Check:** `streaming` · **Status:** warn · **id:** (metric `tail_match=diverged`)

---

## 6. The 429 shape `error_handling` should reward

**Observed:** `qwen/qwen3.8-27b:free` returned HTTP 429 for every request. The
body was:

```json
{
  "error": {
    "message": "Provider returned error",
    "code": 429,
    "metadata": {
      "raw": "qwen/qwen3.8-27b:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits",
      "provider_name": "ModelRun",
      "is_byok": false,
      "provider_error_code": "429",
      "limit_source": "upstream_provider_shared_pool",
      "remedy_hint": "Retry shortly, add your own provider key (https://openrouter.ai/settings/integrations), or route to another provider with provider routing: https://openrouter.ai/docs/features/provider-routing"
    }
  },
  "user_id": "user_3EJuPvRYuPw925DABzQftPLXO3O"
}
```

**We read that as:** the 429 is OpenRouter's *edge* describing an upstream
condition, not the upstream speaking for itself. The edge knows which provider
served it (`provider_name`), why it is limited (`limit_source`), and what a
client can do about it (`remedy_hint`). That is a materially better error
contract than a bare `429 Too Many Requests`, and it is the shape
`error_handling` exists to insist on.

**Why a router cares:** a client that can read `remedy_hint` can fall back by
itself — retry later, or route to a different provider — without a human in the
loop. `limit_source: upstream_provider_shared_pool` in particular tells a router
that the limit is *not* the caller's fault and will not clear by backing off
harder, which is the difference between a backoff strategy that works and one
that just delays the failure. The converse is worse than useless: a bare 429
reads as "you are being throttled", and a well-behaved client responds by
slowing down — precisely the wrong response to a saturated upstream pool.

---

## 7. A 429 is not a verdict — and this produced a bug

**Observed:** the first Qwen run reported `chat_basic FAIL`, `streaming FAIL`,
`latency FAIL` — three failures, exit 1, on a model that was never reached.

**We read that as:** the tool telling a reader to reject a provider on the
strength of an outage. That is the exact failure mode this project exists to
prevent, and the run that exposed it is the run I had just used to convince
myself the checks worked.

Four statuses now, and the fourth is the one that matters:

| Status | Meaning |
| --- | --- |
| `pass` / `warn` | A verdict, and it is fine. |
| `fail` | A verdict: reached the endpoint, something is wrong with it. |
| `skip` | Chosen not to run. |
| `blocked` | **No verdict at all.** The endpoint was never reached. |

`blocked` is applied centrally in the runner, not per check, because a check
that forgets it turns an outage into a rejection of a healthy provider. The
rule is narrow: a `fail` whose HTTP status is **429 or 503** becomes `blocked`.
A 400, 404 or 413 is a genuine verdict and stays a `fail`.

Ordering is `fail > blocked > warn > pass`, and the exit codes separate them:

| Exit | Meaning |
| --- | --- |
| `0` | No failures. |
| `1` | At least one check **failed**. |
| `2` | Usage or configuration error. |
| `3` | Nothing failed, but something was **blocked**. Inconclusive, not clean. |

A 429 or 503 is retried once before a check is marked blocked, honouring a
`Retry-After` header or a `retry_after` field in the body when present.

**Retry is per-check and opt-in, and that distinction was a bug too.** The first
implementation retried globally and broke the latency check in a way that would
have corrupted real numbers: a retry inside a latency run reports the timing of
the *second* attempt and hides the first failure entirely. So retry is now
declared per check — on for the "does this work at all" checks, and deliberately
off for `latency`, `quality_smoke` and `error_handling`, which are measuring
something or testing an exact status.

**Worst case for budgeting:** a target that 429s every call costs **at most
double, and usually less** — only the checks that opted in to the retry pay it.
For the day-1 Space Bunny plan that is 49 requests, not 68: `latency`,
`quality_smoke` and `error_handling` (19 requests) do not retry, so they cannot
double. `--dry-run` now prints base and worst-case separately and says which one
busts the cap, because a blanket doubling here is what made an affordable plan
look unrunnable.

---

## 8. The 128k probe would have hung — O(n²) filler

**Observed:** `buildFillerMessage` appended one word at a time and re-estimated
the whole buffer each time, so a 128k-token prompt was ~115,000 iterations over
a growing half-megabyte string. The test suite hung on it; the live probe would
have hung worse.

**We read that as:** a cost that only appears when you actually build the large
prompt. A 32k probe is fast enough to look fine.

| Target | Estimated tokens | Size | Build time |
| ---: | ---: | ---: | ---: |
| 8,000 | 7,194 | 33 KB | 2.3 ms |
| 32,000 | 28,778 | 133 KB | 10.0 ms |
| 64,000 | 57,526 | 265 KB | 27.9 ms |
| 128,000 | 115,114 | 531 KB | 75.1 ms |

Linear now: the words-per-token ratio is measured once, the word count is sized
up front, and the correction pass trims in chunks rather than per word. Every
estimate lands under its target at the 0.9 safety factor, which is the intended
direction — a false fail is visible and explainable, a false pass silently
misroutes traffic.

---


| # | Bug | Impact | Fix |
| --- | --- | --- | --- |
| 1 | Redaction replaced a *shared* object with `"[circular]"` | **Data loss** — the whole `usage` object was destroyed in `report.json`, because it is reachable via both `details.usageRaw` and `response.body` and the cycle check conflated "seen twice" with "is a cycle" | `seen` is a path stack, not a visit set |
| 2 | Reasoning under-reporting went unreported | Reported `reasoning_tokens: 0` as fact while holding streaming evidence that contradicted it | `reasoning_underreported` finding |
| 3 | `facts.modelsPayload` stored the whole catalog | **755 KB of a 1.6 MB report** — 460 model objects burying the findings | Not stored; only extracted fields kept |
| 4 | `seed_supported: true` implied the seed was honoured | Would let a reader trust a determinism guarantee that does not exist | `seed_supported` cross-checked against `supported_parameters` |
| 5 | `extractToolCall` read `choices[0].tool_calls` | **Would have false-failed every conformant provider** — `tool_calls` lives on `choices[0].message` | Reads `message` first, then the choice |
| 6 | `error_handling` dropped the wire pair on warn | A surprising probe was not reproducible from the report | Culprit probe's wire pair attached |
| 7 | `--compare` claimed "sources disagree" from one source | Implied a conflict that does not exist | Single source reported as single |

---

## Bugs found by running the tool

| # | Bug | Impact | Fix |
| --- | --- | --- | --- |
| 1 | Redaction replaced a *shared* object with `"[circular]"` | **Data loss** — the whole `usage` object was destroyed in `report.json`, because it is reachable via both `details.usageRaw` and `response.body` and the cycle check conflated "seen twice" with "is a cycle" | `seen` is a path stack, not a visit set |
| 2 | Reasoning under-reporting went unreported | Reported `reasoning_tokens: 0` as fact while holding streaming evidence that contradicted it | `reasoning_underreported` finding |
| 3 | `facts.modelsPayload` stored the whole catalog | **755 KB of a 1.6 MB report** — 460 model objects burying the findings | Not stored; only extracted fields kept |
| 4 | `seed_supported: true` implied the seed was honoured | Would let a reader trust a determinism guarantee that does not exist | `seed_supported` cross-checked against `supported_parameters` |
| 5 | `extractToolCall` read `choices[0].tool_calls` | **Would have false-failed every conformant provider** — `tool_calls` lives on `choices[0].message` | Reads `message` first, then the choice |
| 6 | `error_handling` dropped the wire pair on warn | A surprising probe was not reproducible from the report | Culprit probe's wire pair attached |
| 7 | `--compare` claimed "sources disagree" from one source | Implied a conflict that does not exist | Single source reported as single |
| 8 | 429s reported as `fail` | Rejected a provider on the strength of an outage | Fourth status, `blocked`; exit code 3 |
| 9 | Global retry policy | Would report the *second* attempt's latency and hide the first failure | Retry is per-check and opt-in |
| 10 | `buildFillerMessage` was O(n²) | Hung on the 128k probe | Linear; see the timing table above |
| 11 | `defaults.runs` silently ignored | Commander's default always won — **20 wasted requests per target** | Precedence: `--runs` > `defaults.runs` > 20 |
| 12 | `--dry-run` doubled *every* check for the worst case | **Reported 68 requests where the real cost is 49** — made day 1 look like it busted the 50/day cap and stalled the run on a gating decision that was not needed | Worst case is per-check, following the same opt-in retry flag |
| 13 | `captureRequest` never truncated the body | **4.2 MB of a 4.35 MB report** — the 2 MB oversized probe stored twice, burying every finding | `clipCapturedBody`, same 64 KB cap responses already had |
| 14 | A probe failing *at* the claimed size reported `pass` | **Reported "1M confirmed" for a 1M probe the endpoint had just rejected with HTTP 400** — a false pass on the exact failure the check exists to catch | Compare with `<=`, not `<`; dedicated test |
| 15 | An all-reasoning HTTP 200 read as a rejected context probe | **Reported a working 256k model as FAIL** — the probe succeeded and spent its output budget thinking, leaving `content` empty | `hasContent` accepts `reasoning`/`reasoning_content`; dedicated test |
| 16 | Transport failures inside `quality_smoke` were scored as wrong answers | **Nemotron reported 0/10 FAIL when all ten prompts were HTTP 429** — a saturated pool presented as an unusable model | Outcomes carry `unavailable`; an all-unavailable run becomes a 429 `fail` the runner rewrites to `blocked`; a partial one warns and calls the score a floor |

---

## 9. Day 1 live run — `stealth/space-bunny-alpha`

First full 13-check run against a real endpoint. **9 pass · 3 warn · 0 fail ·
1 skip**, 34 requests. Card: `reports/day1-space-bunny.md`.

The three warns all reproduce earlier findings on a second model, which is the
useful part: they are properties of this provider class, not of one endpoint.
The genuinely new result is the ZDR path below.

### 9a. Vision works, and the catalog was right

`vision` **passed** — the model correctly reported that a generated 96×96 solid
image contains no text, and did not hallucinate text into it. `modality_claims`
**passed**: description, catalog and measurement all agree the model accepts
images.

This settles a question the handoff flagged as easy to get wrong. The catalog
lists `stealth/space-bunny-alpha` as `text+image+video->text`, and that is
accurate. There is no claimed-vs-listed discrepancy here; the check that carries
weight is listed-vs-measured, and it came back clean.

**Note the limit of this result:** it proves *image* input. The catalog also
claims *video*, and nothing in the suite tests video. The claim is unverified.

**Check:** `vision`, `modality_claims` · **Status:** pass

### 9b. The 1M context claim is contradicted — and the first run missed it

**First run:** `context_probe` passed every rung to 128,000 tokens against a
1,000,000 claim, because the ladder stopped at 128k. The verdict was honest
("verified to the probe cap") but weak: nothing above 128k had been tested.

**Rerun, with the ladder sized to the claim** (125k / 250k / 500k / 1M):

| Rung | Our estimate | Result |
| ---: | ---: | --- |
| 15,625 | 14,017 | ok |
| 62,500 | 56,163 | ok |
| 250,000 | 224,948 | ok |
| 1,000,000 | 899,979 | **HTTP 400** |

The endpoint's own error: *"This endpoint's maximum context length is 1000000
tokens. However, you requested about 1062081 tokens."*

**We read that as:** the claim is *not* safely usable. We deliberately under-sent
— 899,979 estimated tokens, 10% below the claim — and the endpoint still
rejected it, because its tokenizer counts our filler ~18% higher than ours. So
the effective usable window is somewhere below 1M, and the gap is a tokenizer
disagreement rather than a hard limit we can see.

**Why a router cares:** a router sizing a context budget to "1,000,000" from
this catalog number would overflow the real window. The margin here is not
"1M minus a safety factor" — the provider's own counting is the dominant
uncertainty, and we have no tokenizer to measure it with. The honest number for
a router is **250,000 verified**, not 1M claimed.

**This also found a bug in the check itself.** The verdict logic compared the
failing rung with `<` against the claim, so a failure *at exactly* the claimed
size fell through to `pass` — it printed "handled prompts up to 1,000,000 tokens,
matching the claimed 1,000,000" for a run where the 1M probe had just been
rejected. Fixed to `<=`, with a dedicated test. A check that reports `pass` for
the failure it exists to catch is worse than no check, because it is trusted.

**Check:** `context_probe` · **Status:** fail (after the fix)

---

## 11. Day 2 — `cohere/north-mini-code:free`, and the seed question answered

**8 pass · 2 warn · 1 fail · 2 skip**, 33 requests. Card:
`reports/day2-north-mini.md`.

### 11a. `seed` is real here — the divergence is Space Bunny's, not OpenRouter's

This was the run with a question attached rather than just another card.

| | Space Bunny | North Mini |
| --- | --- | --- |
| `seed` in `supported_parameters` | no | **yes** |
| `tail_match` | `diverged` (38%) | **`identical` (0%)** |
| streamed vs non-streamed | 69 vs 50 chars | 69 vs 69 chars |

**We read that as:** the determinism difference is the *model*, not the
platform. North Mini advertises `seed`, honours it, and returns byte-identical
text across a streamed and non-streamed call. Space Bunny accepts `seed` and
ignores it, so its divergence was always going to happen.

**Why a router cares:** this is the actionable split. If you cache or dedupe on
request+seed, North Mini is safe and Space Bunny is not. And it confirms that
`seed_accepted_but_unsupported` is a real signal rather than noise — the same
tool, same day, two models, opposite verdicts, both correct.

### 11b. Two new findings

**All output spent on reasoning, 4 runs in 5.** `latency` WARN: every failed run
returned 200 output tokens with no visible content — the thinking phase consumed
the whole budget. The same `reasoning_underreported` pattern as Space Bunny,
here severe enough to break 80% of requests at `max_tokens: 200`. A client
setting a tight `max_tokens` on a reasoning model can get empty responses.

**9/10 on the golden suite**, missing `format-2` (instruction following). Worth
noting as a *model* difference rather than a defect: the tool attributed it to
one prompt, which is the behaviour the golden suite was designed for.

**Check:** `latency`, `quality_smoke` · **Status:** warn

### 11c. `error_handling` is clean here — a real contrast

All three probes returned 400/400/400 with JSON bodies and no 5xx. Space Bunny
accepted a 2 MB oversized request with 200. So the missing edge validation is
Space Bunny's, not a property of OpenRouter. This is what a contrast case is
for.

### 11d. The `context_probe` FAIL on this card is a tool bug, fixed

The card reads `FAIL: a 16,000-token prompt was rejected`. It was **HTTP 200**.
North Mini had spent its output budget on reasoning and returned an empty
`content` field, and `hasContent` treated that as a rejection — reporting a
working 256k model as broken. Fixed: reasoning content now counts as a response,
with a test. See bug #15.

The 256k claim is therefore **unverified, not contradicted** — the probe stopped
at 16k for the wrong reason. A rerun would settle it.

---

## 12. Day 3 — `nvidia/nemotron-3.5-lightning:free`, and the card that was mostly blocked

**3 pass · 0 warn · 2 fail · 6 blocked · 2 skip**, 33 requests. Card:
`reports/day3-nemotron.md`.

**This is the blocked path working as designed, and it is the first run where
it dominated.** Six of eight executed checks returned `blocked` with the reason
"rate limited (HTTP 429) after 2 attempts: the endpoint was never reached, so
nothing was learned about it." The upstream pool for this model was saturated.
`models_endpoint`, `modality_claims` and `data_policy` passed; everything that
needed a live completion was blocked.

**What it tells you:** the 1M context claim is **unverified** — the probe never
got past 429, so this is the second model where the Space Bunny tokenizer
question goes unanswered. Nemotron advertises `seed`, so its determinism case is
also still open. Neither is a negative result; both are "ask again when the pool
is healthy."

### 12a. The 0/10 was a tool bug, and the worst of the three

The card read:

```
FAIL quality_smoke: 0/10; missed arith-1, arith-2, code-1, code-2, fact-1, ...
```

Every one of those ten was `HTTP 429`. `quality_smoke` counted a request that
was never answered as a prompt the model got wrong, so a saturated pool read as
"this model scores zero" — the precise failure the `blocked` status was
introduced to prevent, arriving through the one check that scores many prompts
rather than one.

**Why this one matters more than bugs #14 and #15:** those were wrong about a
specific provider. This one invents a verdict about a model that was never
spoken to, and it did so on the run where the pool was least healthy. Fixed:
each outcome carries `unavailable`, an all-unavailable run returns a 429 `fail`
that the runner rewrites to `blocked`, and a partially-answered one warns and
calls the score a floor rather than a measurement. Two tests, one through
`runProvider` because the 429→blocked rewrite lives in the runner.

**General lesson:** a check that aggregates many sub-results has to keep
"unasked" separate from "answered badly", or it will launder an outage into a
quality score. `latency` already had to learn this for its own runs; the golden
suite had not.

### 12b. `data_policy` failed honestly

`FAIL` on a 404 that did not mention `data_collection`, with the note warning
not to read it as a "no training" answer. That is the check doing its job
correctly — it declined to guess. Worth contrasting with days 1 and 2, where the
ZDR probe returned 200 and `served_by` was reported. Three models, three
different answers, which is exactly why this is a probe and not a lookup.

**Card:** `reports/day3-nemotron.md`



### 9c. A no-training path exists — the weakest finding in the set

**Observed:** a request carrying `provider.data_collection: "deny"` returned
HTTP 200, and the response named `served_by: Stealth`.

**We read that as:** at least one upstream endpoint for this model does not
retain user data. Weaker than it looks: this describes *one request that
happened to route well*, and the next request may not. It is a sampled
observation, not a property of the model.

**Why a router cares:** this is the finding most likely to be over-read. "A ZDR
path exists" sounds like a guarantee; it is a single data point. Routing
sensitive traffic on it means one unlucky request leaks. If ZDR is a
requirement rather than a nice-to-have, it needs a repeated probe that reports
how *often* the deny path is honoured — the current check answers a different
question than the one a compliance reviewer asks.

**Check:** `data_policy` · **Status:** pass · **id:** `zdr_path_available`

### 9d. Findings 1, 3 and 4 reproduce on a second model

| Finding | Observed on Space Bunny |
| --- | --- |
| `reasoning_underreported` | every latency run streamed 103–172 chars of reasoning (p50 153) while `reasoning_tokens: 0`; TTFT p50 1522 ms includes the thinking phase |
| `prompt_token_overhead` | `prompt_tokens: 163` for a 6-word message estimated at ~15 tokens, 149 of them cached |
| `seed_accepted_but_unsupported` | `seed: 42` accepted with no 400, but `seed` is absent from `supported_parameters` |
| `invalid_request_accepted` | the ~2 MB oversized probe returned HTTP 200 |
| streaming divergence | 69 vs 50 chars — the stream was *longer*, correctly classified `diverged`, not a dropped tail |

`seed_accepted_but_unsupported` is the one to keep an eye on: it is
accepted-and-ignored, which is worse than rejected, because responses look
deterministic until they are not. North Mini and Nemotron both advertise
`seed`, so they are the contrast cases that will show whether this is
model-specific or an OpenRouter-wide pattern.

**Throughput for reference:** TTFT p50 1522 ms / p95 1836 ms, output 480 tok/s
p50, 5/5 runs clean, 10/10 golden prompts. Reasoning is always on, so TTFT
includes thinking and the tok/s figure covers visible text only.

---

## 10. The report buried its own findings — 4.2 MB of filler

**Observed:** the day-1 report was 4,355,602 bytes. `error_handling` accounted
for 4,203,092 of them. The ~2 MB oversized probe was stored **twice** — once as
`request` (2,097,484 B) and again inside `details.probes` (2,102,749 B).

**We read that as:** the same class of bug as #3, one layer over. The
oversized probe is *supposed* to be megabytes — that is how it trips a body
limit — and `error_handling` deliberately keeps the wire pair so a surprising
probe is reproducible. The defect was upstream of the check:
`captureResponse` capped bodies at 64 KB via `MAX_CAPTURE_BYTES`, while
`captureRequest` only redacted and never truncated. Nothing about the check was
wrong; the transport had an asymmetry in it.

**Why it matters anyway:** a report nobody can open is a report nobody reads.
The findings were all present and all correct, and they were 0.2% of the file.

**Fixed** in `src/http.ts`: request bodies now pass through `clipCapturedBody`
under the same 64 KB cap. Bodies under the cap are returned untouched, so
ordinary requests keep their exact structure. Bodies over it become
`{truncated, original_bytes, keys, note}` — an honest placeholder rather than a
half-object that reads like a complete request. One test covers both the unit
behaviour and the end-to-end artifact staying under 200 KB.

---


`format-1` asked for "exactly three primary colors" and scored only
RED/BLUE/YELLOW. The model answered `RED,GREEN,BLUE` — all four format
constraints satisfied, but the additive/subtractive primaries question is
genuinely contested. That was a **defective test**, not a model failure, and it
would have shown up as a permanent provider regression.

Reworded to "exactly three colors" with an open colour set, so only the format
constraint is scored. A test now asserts no golden prompt depends on a contested
fact.

**The general lesson:** a golden suite measures the model *and* the test. A
failure only means something if the prompt is unambiguous — otherwise you are
maintaining a permanent false positive and learning to ignore the score.
