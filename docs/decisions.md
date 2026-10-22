# Decisions in spf

**Status:** the rails (config, client, policy, trace event, doctor checks)
plus the decision kinds listed under [Decisions](#decisions); `risk_tier`
(#104) is the first live kind. Each feature ticket under epic #102 adds one
kind and a subsection there.
Core ticket: #103. Renamed from `jev` to `decisions` in #150 (Part 1): see
[Migrating from `jev:`](#migrating-from-jev) if you have an existing config
or trace db.
Background: [`brainstorms/jev-in-the-factory.md`](brainstorms/jev-in-the-factory.md).

## What the decision layer is

The decision layer is a small, **model-agnostic** advisor to spf's
deterministic code. Code asks a typed question over a closed set of options,
and a decision model answers it, or the deterministic fallback does. *How*
a question gets answered is a **backend** (`decisions.backend`). There is one
today, `systemone`. Part 2 of #150 adds an embedding backend, so nothing
above the client seam may depend on which backend answered.

The `systemone` backend is a "System One" typed-decision model. That is
TypeSafe's Jev (reached through TypeSafe's own API or Cloudflare Workers AI)
or a local `nimble`/`tev1` served by Ollama. You give it unstructured context
(`state`) and a set of typed questions. It returns typed answers with
probabilities and a confidence, in roughly 70–500 ms, for about $0.04 per
million input tokens. Output tokens are free. It does not generate text. It
answers three question shapes:

| Shape | You give it | It returns |
|---|---|---|
| `choice` | a closed set of labeled options (≤255) | one option key, per-option probabilities, confidence |
| `score` | an ordered rubric of 2–10 level descriptions | a continuous score, per-level probabilities, confidence |
| `noul` | a yes/no statement | a probability that it is true (spf does not use this shape yet) |

spf uses `choice` and `score` as a fast, cheap advisor to the deterministic
code. It never replaces that code. Confidence thresholds are **not portable**
between backends or models: re-check `threshold` (in shadow mode first)
whenever you change `systemone.provider` or `systemone.model`.

## Invariants

spf's rule is *"deterministic TypeScript owns the graph: agent proposes,
code disposes."* The decision layer follows the same rule.
`src/core/decisions.ts` enforces all of the following in one place, so
individual features cannot weaken them:

1. **Off by default.** With no `decisions:` block, or with `enabled: false`,
   there is no client, no network call, and no trace event. Every decision is
   the deterministic fallback, so runs behave exactly as they did before this
   feature existed.
2. **Closed sets only.** Code builds the option set: an enum, or an
   operator-declared menu. The decision model's answer is used only if it is
   literally one of those options. It never names a chain, step, gate, model,
   or command that code did not offer it.
3. **Every decision has a deterministic fallback.** The fallback is used
   when the layer is disabled or the kind is `off`, in shadow mode, and when
   the API key is missing. It is also used on a timeout, an error, a malformed
   answer, an out-of-set answer, an answer outside the caller's `permitted`
   subset, or confidence below the threshold.
4. **Shadow vs act.** See [below](#shadow-vs-act).
5. **Every decision is recorded.** Whenever the layer is enabled for a kind,
   each decision (shadow or act, success or failure) is written as one trace
   event. A replay or `spf estimate` reuses the recorded decision instead of
   calling the model again.
6. **Gates only get stricter.** The decision model may add a rejection or
   stop a loop early. It may never approve past a gate, remove a gate, raise
   a retry ceiling, or spend beyond an operator-configured ceiling. None of
   those moves may appear in any option set, and `permitted` lets a caller
   narrow the set at run time (for example, "escalate only while under
   budget").
7. **Pure modules stay pure.** Resolve a decision once in an impure place,
   such as `startRun`, a loop body, or a watch hook. Then pass the resulting
   `Decision` into pure code (such as `core/tiering.ts`) as data.

## Configuration

```yaml
decisions:
  enabled: false            # default. false = total no-op
  backend: systemone        # how a question is answered (the only backend today)
  mode: shadow              # shadow | act — the default for every kind
  threshold: 0.7            # min confidence for an answer to act (0–1)
  timeout_ms: 2000          # per call; a timeout falls back — raise this for provider: ollama (see below)
  systemone:                # the `systemone` backend's transport settings
    provider: typesafe      # typesafe | cloudflare (Workers AI / AI Gateway) | ollama (local)
    model: jev-latest       # or a pinned version, e.g. jev-1.13 — typesafe only (cloudflare.model / ollama.model take over)
    api_key_env: TYPESAFE_API_KEY   # names the env var; never the key itself
    base_url: ""            # "" = https://api.typesafe.ai/v1 (POST …/systemone)
    cloudflare:             # used only with provider: cloudflare
      account_id_env: CLOUDFLARE_ACCOUNT_ID
      api_token_env: CLOUDFLARE_API_TOKEN   # needs the Workers AI > Read permission
      gateway: ""           # AI Gateway id; "" = call Workers AI directly
      model: typesafe/jev   # Cloudflare's catalog id (not jev-latest)
    ollama:                 # used only with provider: ollama
      base_url: http://localhost:11434/v1   # a local Ollama >= 0.35; no credentials — blank/whitespace is rejected (never falls back to the TypeSafe cloud default)
      model: nimble         # or tev1 / tev1:0.8b
  kinds:                    # per-kind overrides + feature settings
    risk_tier:              # (example — kinds are added by feature tickets)
      mode: act             # off | shadow | act
      threshold: 0.8
      timeout_ms: 500
      max_risk: standard    # a feature-specific key, validated by that feature
```

- **Merge across config layers.** Top-level keys merge key by key, so an
  override that only sets `enabled: true` keeps the base's threshold and
  timeout. `systemone` merges key by key one level down (an override that
  only sets `provider: ollama` keeps the base's `model` and `api_key_env`).
  `systemone.cloudflare`, `systemone.ollama` and `kinds` are each replaced as
  a whole object, like `tiering.roles` and `sandbox.cloudflare`.
- **`enabled: false` always wins.** It overrides every per-kind `mode`.
- **`spf doctor`.** When the layer is disabled, doctor shows nothing about it
  (apart from the [legacy `jev:` warning](#migrating-from-jev), which shows
  whenever a `jev:` block is present). When it is enabled, doctor shows:
  - the resolved settings (check `decisions`), as info;
  - a **warning** (`decisions api key`) if the provider's credential env vars
    are unset (every decision would fall back with `no_api_key`), which does
    not fail doctor — not shown at all for `provider: ollama`, which has no
    credentials;
  - a **failure** for a `base_url` that is not http(s) (`provider: typesafe`
    or `provider: ollama` — checked as `decisions base_url` /
    `decisions.systemone.ollama.base_url` respectively);
  - a **warning** (`decisions base_url`) for a top-level `systemone.base_url`
    that is ignored because the provider is not `typesafe`;
  - a **warning** (`decisions timeout_ms`) for `provider: ollama` with
    `timeout_ms` under 5000;
  - a **warning** (`decisions kind "<kind>"`) for a `kinds` key that is not a
    registered kind (usually a typo);
  - a **failure** (`decisions kind "<kind>"`) for a known kind whose feature
    settings do not validate;
  - a **warning** (`decisions.loop`) for a misplaced `loop:` block, see
    [`loop_control`](#loop_control).

  Doctor never calls TypeSafe or Cloudflare, because a live probe there
  would spend tokens on every run. `provider: ollama` is the one exception:
  it is local and free, so doctor also makes two live, never-failing GETs
  (`decisions ollama version` for `/api/version`, which warns below `0.35.0`,
  and `decisions ollama model` for `/api/tags`, which warns if
  `decisions.systemone.ollama.model` was never `ollama pull`ed) — gated on
  `--no-probe` like every other live probe `spf doctor` runs.

## Migrating from `jev:`

Nothing breaks if you do nothing. A `jev:` block is **still accepted**: spf
rewrites it onto `decisions:` when it loads the config, so nothing downstream
sees `jev`. It is deprecated, and `spf doctor` warns about it
(`decisions config: jev: is deprecated; move it to decisions: ...`) without failing.
Move the keys, don't just rename the block: a `decisions:` block that still
carries the old flat keys (`provider`, `model`, `ollama`, a nested `decisions:`
map, ...) is a config error naming where each key moved, rather than having
them silently dropped.

| Before (`jev:`) | After (`decisions:`) |
|---|---|
| `jev.enabled`, `.mode`, `.threshold`, `.timeout_ms` | `decisions.enabled`, `.mode`, `.threshold`, `.timeout_ms` (unchanged) |
| *(implicit)* | `decisions.backend: systemone` |
| `jev.provider` | `decisions.systemone.provider` |
| `jev.model` | `decisions.systemone.model` |
| `jev.api_key_env` | `decisions.systemone.api_key_env` |
| `jev.base_url` | `decisions.systemone.base_url` |
| `jev.cloudflare.*` | `decisions.systemone.cloudflare.*` |
| `jev.ollama.*` | `decisions.systemone.ollama.*` |
| `jev.decisions.<kind>` | `decisions.kinds.<kind>` |

```yaml
# Before
jev:
  enabled: true
  mode: act
  provider: ollama
  timeout_ms: 5000
  ollama:
    model: nimble
  decisions:
    risk_tier: { mode: act, max_risk: standard }

# After
decisions:
  enabled: true
  mode: act
  timeout_ms: 5000
  systemone:
    provider: ollama
    ollama:
      model: nimble
  kinds:
    risk_tier: { mode: act, max_risk: standard }
```

- **Both blocks is an error.** One config file with both `jev:` and
  `decisions:` fails to load with a message naming both. Keep only
  `decisions:`. Across config *layers* (for example a repo override on top of
  a packaged base) the spellings can differ: each layer is rewritten first,
  then the layers merge, so a base `jev:` and an override `decisions:`
  combine like any two layers.
- **A non-mapping value is an error.** `jev: true`, `jev: "on"` and
  `jev: [...]` fail to load (so does `decisions: true`), instead of quietly
  turning the layer off. An empty `jev:` (YAML null) is an empty block.
- **Trace rows are never migrated.** Rows recorded before #150 stay in the
  local sqlite db and in D1 as they were written. Every *reader* accepts both
  spellings (see [the trace event](#the-trace-event)), so replay,
  `spf estimate --replay-risk` and the dashboard keep working on old runs.
  New rows are written under the new names only.
- **Renamed names that appear in output** (a script that greps for them
  needs both spellings during the transition):

  | Was | Now |
  |---|---|
  | event `jev_decision` | event `decision` |
  | payload `jev_choice` | payload `model_choice` (plus new `backend`, `provider`) |
  | event `jev_triage` (finding triage outcome) | event `decision_triage` |
  | `tiering` event payload `jev` (its `jev_choice` inside) | `risk_decision` (`model_choice` inside) |
  | `chain_edge` event `via: "jev"` | `via: "decisions"` |
  | `spf estimate --json` `risk_source.jev` | `risk_source.decision` |
  | doctor checks `jev`, `jev api key`, `jev base_url`, `jev timeout_ms`, `jev.ollama.base_url`, `jev ollama version`, `jev ollama model`, `jev decision "<kind>"`, `jev.loop` | `decisions`, `decisions api key`, `decisions base_url`, `decisions timeout_ms`, `decisions.systemone.ollama.base_url`, `decisions ollama version`, `decisions ollama model`, `decisions kind "<kind>"`, `decisions.loop` |
  | `<data_dir>/watch/jev_events.jsonl` | `<data_dir>/watch/decision_events.jsonl` |
  | issue-tracker section `## Deprioritized by jev` | `## Deprioritized by the decision model` |

- **Renamed code** (for anyone building on the library): `core/jev.ts` is
  `core/decisions.ts`; `core/jev_kinds.ts` is `core/decision_kinds.ts`;
  `createJev`/`Jev` are `createDecider`/`Decider`; `run.jev` is
  `run.decider`; `JevClient`/`HttpJevClient` are `DecisionClient`/
  `HttpSystemOneClient`; `setJevClientFactory` is `setDecisionClientFactory`;
  `jevDoctorChecks` is `decisionsDoctorChecks`; `defineJevKind` is
  `defineDecisionKind`; `src/test/fake_jev.ts`'s `FakeJevClient` is
  `src/test/fake_decisions.ts`'s `FakeDecisionClient`.

## Shadow vs act

| | Model called? | Recorded? | What acts |
|---|---|---|---|
| disabled / kind `off` | no | no | fallback |
| `shadow` | yes | yes | **fallback** |
| `act` | yes | yes | the model's answer if it is in the set, permitted, and confident; otherwise the fallback |

Run a kind in `shadow` first. Its recorded decisions show how often the model
agreed with the heuristic, and whether act mode would have used its answer.
Compare that with the run's real outcome (accepted, blocked, cost) in the
trace db: [`spf decisions calibrate`](#calibrating-thresholds) does that join
for you and suggests a threshold. Flip a single kind to `act` with
`decisions.kinds.<kind>.mode: act` once the numbers support it.

## Calibrating thresholds

`threshold` is a global default (0.7) that is not portable between models
(see [What the decision layer is](#what-the-decision-layer-is)). Once a kind
has run in shadow for a while, `spf decisions calibrate` replaces the guess
with measured numbers from your own trace db:

```bash
spf decisions calibrate                          # every kind, human table
spf decisions calibrate --kind risk_tier --json  # one kind, machine-readable
spf decisions calibrate --target-precision 0.95 --min-samples 50 --since 2026-10-01
```

It is **read-only**. It never calls a model, never writes config, and never
writes a trace row. It reads the recorded decisions (the current `decision`
rows and the pre-#150 `jev_decision` rows alike), joins each one to an outcome
spf already recorded, and prints a **suggested** threshold. Changing
`decisions.kinds.<kind>.threshold` stays your edit.

Output is one block per **(kind, backend, provider, model)**. Legacy rows have
no backend or provider, so they form their own group (shown as `-`) and are
never merged with a modern row that happens to share a model name.

| Figure | Meaning |
|---|---|
| `n` | decisions recorded for the group (replayed rows are skipped: a replay is a re-judged copy, not a new sample) |
| `agree-with-fallback` | of the rows where the model gave a valid answer, how many equalled the deterministic fallback |
| `would_act` | of `n`, how many act mode would have used the model's answer (valid, confident, permitted) |
| `mode` | `shadow` or `act`. Shadow and act rows are **separate groups**: act rows are a biased sample (confident dissents acted and are excluded, low-confidence ones fell back and are kept), so the upper buckets would be almost all agreements. Calibrate from the `shadow` group |
| reliability table | five equal confidence buckets over 0-1: rows, mean confidence, precision and its 95% Wilson interval. Printed for all labelled rows, and again for dissents only |
| `dissents only` | the labelled rows where the model's answer differed from the fallback (n, precision, Wilson interval, reliability table). **These are the only rows act mode changes behaviour on**: an agreeing answer acts exactly like the fallback |
| `threshold in use` | the `threshold` most often recorded for the group, with the precision of the rows at or above it (all rows, and dissents only) |
| `suggested threshold` | the **lowest** threshold whose **dissent** tail (labelled dissenting rows at or above it) reaches `--target-precision` (default `0.9`), with at least half of `--min-samples` dissenting rows behind it, and that tail's Wilson interval. Agreements are never pooled in: they are scored right whenever the baseline did well, which would let them carry a tail over the target while every dissent in it is wrong. The threshold is rounded up to two decimals, so it never admits a row the measured tail did not. When no threshold qualifies (including when there are too few dissents), the report says so and shows the best it saw. **`act` groups never get a suggestion**: their confident dissents acted and are excluded, so the remaining dissent tail holds only rows below the threshold that acted; run the kind in shadow to calibrate it |

Below `--min-samples` (default `30`) **labelled** rows a group prints
`insufficient`: the counts are shown, but there is no table and no
suggestion. Read the interval, not just the point estimate: 30 rows that are
all right still only give a lower bound near 89%.

### What counts as an outcome

Outcome rules are built in code, per kind (`OUTCOME_RULES` in
`src/core/decision_calibration.ts`). Only things spf stores are used.

**The baseline-ran rule.** A row is labelled only when the deterministic
fallback is what acted (`choice === fallback`: every shadow row, and any act
row that fell back or agreed). The observed outcome is then the **baseline's**
outcome, and the model's answer is scored against it: agreeing with the
fallback is right if the baseline did well; dissenting is right if it did
badly. The dissent half is generous (the alternative might have failed too),
so treat precision for a dissenting model as an upper bound.

A row where the model's own answer acted (act mode, `choice !== fallback`) has
no observable counterfactual, so it is excluded and counted, not labelled.
**Calibrate on shadow data**; a kind you already flipped to `act` still
calibrates (as its own `mode=act` group), but only from its agreeing and
fallen-back rows, and the report flags that sample as biased. Rows with
`reason: not_permitted` (the answer was outside the caller's permitted set, so
it could never act at any threshold) are excluded.

| Kind | Observed outcome | Model is right when |
|---|---|---|
| `chain_router` | the run's session finished `success` or `fail` | it agreed and the run succeeded, or dissented and the run failed |
| `intake_readiness` | the `issue-<id>` build run finished `success` or `fail` | `build` and the run succeeded, or `refine`/`needs_human` and it failed |
| `loop_control` | after a failed round, did a later round of the same loop pass (a fix loop's suite `passed`, a revise loop's review `approved`)? | `continue` and the loop recovered, or `stop_blocked`/`escalate_tier` and it did not |
| `risk_tier` | the run was *clean* (success, no failed gate, no `fix_N`/`revise_N` round) or *troubled* | `high` and troubled, or `low` and clean. Only rows where the model's tier **differs from the fallback tier that ran** are scored, and a **downgrade** (a tier below the fallback's, e.g. `low` against `standard`/`high`) is scored only when the run was troubled (the downgrade was wrong); on a clean run it is excluded as ambiguous. `standard`, and any agreement with the fallback, are always ambiguous. The confound: the run executed on the fallback's tier, so a clean run on a stronger tier is partly that tier's doing; nothing measured whether the weaker tier would have stayed clean |
| `chain_edge` | none | no outcome signal: no stored result ties a branch choice to an outcome |
| `diff_risk` | none | no outcome signal: whether a diff really touched a risk is never recorded |
| `finding_triage` | none | no outcome signal: whether a finding was real is never recorded |
| `intake_feedback` | none | no outcome signal: what a human did after a feedback batch lives in the tracker, not the trace db |

A kind with no rule prints `no outcome signal` and its reason, with its
agree and `would_act` rates. The command never invents an outcome and never
asks a model to label one. A PR merge, a PR closing without a merge, and a human
relabelling an issue are **not** in the trace db today, so no rule can use
them; if spf starts recording them, add a rule.

Other rows are excluded and counted (`excluded: ...` in the table):

- **superseded**: a later decision of the same run, kind and key exists (an
  issue re-claim); only the latest is labelled, since the run's final status
  belongs to it.
- **unresolved**: the run has no finished session after the decision (still
  `running`, no session row, **killed**, or a status left over from an earlier
  run of the same `adw_id`), the loop has no later round to judge, or the
  outcome cannot be attributed to this decision: **a later run reused the
  `adw_id`** (a `:feedback` revision or a blocked-to-ready re-claim; `sessions`
  holds one row per `adw_id`, so its status is the *last* run's), or, for
  `loop_control`, a later decision in the same loop **acted** (act mode shaped
  whether the earlier round recovered). Later runs are counted from the `adw`
  process rows `session.ensure` writes, one per run. **Fan-out lane**
  (`watch.fanout.n > 1`): `chain_router` and `intake_readiness` are recorded
  under the fan-out base id (or `issue-<id>`) while the attempts run under their
  own ids, so those decisions have no session of their own and are always
  unresolved; those kinds stay `insufficient` there.

  **Kills (Ctrl-C, SIGTERM, `spf abort`) are never labelled.** spf never writes
  an `aborted` status: a killed run ends as session `fail`, which on its own
  looks like a quality failure (and would score, say, a shadow `loop_control`
  `stop_blocked` as right). So the signal handler (`src/core/session.ts`)
  writes a `run_killed` `log` event for every in-flight run **first**, in the
  same synchronous turn, before any otel/notify/D1 drain or the killed child's
  exit can let the phase's catch close the in-flight phase as an ordinary
  `fail`. It is an additive `log` row: session and phase statuses are unchanged
  for every other reader (dashboard, `spf watch`). Calibrate treats a run that
  carries the marker as unresolved, whatever its session status. A kill that
  lands before the marker can be written (`SIGKILL`, a crash, power loss) is
  caught by a fallback only when it leaves the evidence: a `fail` session with
  a phase that never closed. Runs recorded before the marker existed rely on
  that fallback alone.

  **Only the decision's own run counts.** An `adw_id` can be reused (a
  revision or re-claim), and a killed earlier run leaves its marker and open
  phase in the db forever. The kill check is therefore scoped to the run the
  decision belongs to, found from the `adw` process rows: for kinds recorded
  inside the run (`risk_tier`, `loop_control`) the latest run start at or before
  the decision; for kinds recorded before the claim (`chain_router`,
  `intake_readiness`) the earliest run start after it. A marker or an open phase
  from any other run of the same `adw_id` is ignored, so a later run that fails
  cleanly is labelled `bad` (and one that succeeds `good`) instead of being
  silently dropped; dropping only the failures would inflate precision and push
  suggested thresholds toward acting more. When the run cannot be located
  (no process rows, unknown timestamps) nothing is excluded, which can only
  make a row unresolved, never labelled.

  Two known limits. On a **D1**-backed trace db the marker is a network write
  raced against the same 750ms drain as `sessionFinish`, so it is best-effort:
  if it does not land and the phase was already closed, that run is labelled
  like an ordinary `fail`. The local backend's write is synchronous and always
  lands. And run windows compare wall-clock timestamps, so a db shared by
  several machines assumes their clocks agree.
- **ambiguous**: the rule cannot score this answer (`risk_tier` `standard`,
  agreement with the fallback tier, or a downgrade on a clean run).
- **not permitted**: `reason: not_permitted`; the answer could never act.
- **no confidence**: the model answered but reported none (it could never
  clear a threshold anyway).
- Rows with no valid model answer (timeouts, errors, out-of-set answers) count
  in `n` and `would_act` but cannot be scored.

### Caveats

Outcomes are proxies and samples are small, which is why the minimums and
intervals exist. A decision whose run was later revised or re-claimed under
the same `adw_id` is left unresolved rather than labelled with the later run's
result, and fan-out-lane `chain_router`/`intake_readiness` decisions cannot be
resolved today (see **unresolved** above). A run can fail for reasons no decision caused, so
`chain_router` and `intake_readiness` precision understates a good model.
`risk_tier` outcomes depend on the model that ran the work as well as the
risk it was given. Re-run after changing `systemone.provider` or
`systemone.model`, because the old model's rows describe the old model.

### For feature implementers

A new decision kind must appear in exactly one of `OUTCOME_RULES` or
`NO_OUTCOME_SIGNAL` (`src/core/decision_calibration.ts`); a test fails
otherwise. A rule is a pure function over a recorded row and the run's facts
(`RunFacts`, read by `core/decision_calibration_db.ts`) that says how the
baseline did. Use only data already in the trace db.

## The trace event

Every recorded decision is one `events` row with `type: "log"` and
`name: "decision"`. It is not a new event type, because that list is
closed and mirrored by the UI. The payload is the whole `Decision`:

| field | meaning |
|---|---|
| `kind`, `key` | which decision (`key` tells repeats in one run apart, e.g. `fix_2`) |
| `question` | `choice` or `score` |
| `options` | the closed set offered, in order |
| `choice` | **the effective choice**: what code acted on |
| `model_choice` | what the decision model answered, if it was in the set; else `null` |
| `backend`, `provider` | how it was answered: `decisions.backend` (`systemone`) and the transport behind it (`typesafe`, `cloudflare` or `ollama`). `null` on a row recorded before #150 |
| `confidence`, `score`, `probabilities` | as returned (confidence derived from probabilities if absent) |
| `fallback`, `used_fallback` | the deterministic answer, and whether it acted |
| `reason` | why the fallback acted, or `null` if the model's answer acted (see below) |
| `detail` | human-readable context (error text, confidence vs threshold) |
| `would_act` | act mode would have used the model's answer |
| `agrees` | `model_choice === fallback` |
| `latency_ms`, `model`, `usage` | call cost and speed (`model` is the concrete model id the backend reported) |
| `mode`, `threshold` | the policy in force |
| `input_sha256` | hash of state + instructions + options (the state itself is not stored). For offline analysis only: replay does not compare it. `""` when nothing was hashed |
| `replayed` | this decision reused an answer recorded in an earlier trace |

`reason` is the **first** check that disqualified the model's answer, in this
order: `disabled`, `kind_off`, `replay_missing`, `no_api_key`, `timeout`,
`error`, `invalid_response`, `invalid_choice`, `not_permitted`,
`low_confidence`, `shadow`. In shadow mode, `reason: "shadow"` therefore
means "valid and confident: act mode would have used this answer."

**Legacy rows.** Before #150 the event was named `jev_decision`, the answer
field was `jev_choice`, and there was no `backend` or `provider`. Those rows
are still read: every reader (replay through `findRecordedDecision`,
`listRecordedDecisions`, the dashboard's `SfDb.recordedDecisions`,
`spf estimate --replay-risk`) accepts both event names (`DECISION_EVENT_NAMES`)
and reads `jev_choice` as `model_choice` (`model_choice` wins when both are
present), so an old row replays to the same effective choice its modern twin
would. A new reader of any renamed event must accept both spellings too.
The same goes for the finding-triage outcome event (`decision_triage`, was
`jev_triage`; `FINDING_TRIAGE_EVENT_NAMES`). The other renamed persisted
keys (the `tiering` event's `risk_decision`, the `chain_edge` event's
`via: "decisions"`) are display-only today: nothing in this repo reads them
back, and rows recorded earlier keep the old spelling (`jev`, `via: "jev"`;
see the [table above](#migrating-from-jev)).

The event is never exported to OpenTelemetry, because `log` events are not
in otel's allowlist.

## For feature implementers

```ts
import { findRecordedDecision, parseDecisionExtras } from "../core/decisions.ts";
import { MY_KIND } from "../core/decision_kinds.ts";

const decision = await run.decider.decide({
  kind: MY_KIND.kind,          // registered in core/decision_kinds.ts
  key: "",                     // disambiguate repeats in one run
  options: [{ value: "low", description: "…" }, …],   // closed, code-built
  instructions: "…",           // the question
  state: issueBody,            // context; only its sha256 is recorded
  fallback: heuristicAnswer,   // what the code would have done anyway
  permitted: [...],            // optional run-time narrowing (monotone authority)
  phase_id: ph.phase_id,       // optional; PhaseHandle exposes the open phase's id
});
act(decision.choice);          // ALWAYS act on .choice, never .model_choice
```

- `run.decider` is already wired to the run's trace. For code that runs
  before a run exists (the watch lane), build one with
  `createDecider({ config: cfg.decisions, recorder: traceDecisionRecorder(tracer, adwId) })`.
- `decideBatch(state, items)` asks several questions over one shared state
  in **one** HTTP call, for example "triage each of these N findings".
- To replay, pass `replay: await findRecordedDecision(run.tracer.db, adwId, kind, key)`.
  The recorded **answer** is reused without calling the model, then judged again
  under today's policy and `permitted`. With an unchanged policy the
  effective choice is the recorded one. If the caller no longer permits the
  recorded choice, it is `not_permitted`. If the kind is now in shadow mode,
  the fallback acts. A recorded failure (timeout, error, and so on) replays
  as that same failure. `null` means replay mode with nothing recorded, so
  the fallback acts and the model is not called. A recording made for a
  different question (kind, key, question, options, or fallback changed) is
  `replay_missing`. `enabled: false` or a kind set to `off` beats any
  replay: the result is `disabled`/`kind_off` and nothing is recorded.
- Tests use `src/test/fake_decisions.ts`'s `FakeDecisionClient`, passed as
  `createDecider({ client })` or process-wide with `setDecisionClientFactory(() => fake)`.
  Always reset it with `setDecisionClientFactory(null)`.
- `decide()` throws only on programmer errors, such as an empty option set
  or a fallback that is not one of the options. It throws these even when
  the layer is disabled, so the call site's own unit test catches them.

### Rules for implementers

1. **`key` must be stable across runs.** Replay looks up the latest
   `(kind, key)` match. Use something that names the same logical question
   in every run, such as a finding fingerprint or `fix_<round>`. Never use
   an array index: once the list order changes, an index key replays the
   wrong item. (`decideBatch` question names `q0`, `q1`, ... are wire names
   only and are never used for replay.)
2. **Always compute the heuristic.** The fallback is computed on every
   call, in act mode too. It is the answer whenever the model's cannot act,
   and shadow analysis compares against it.
3. **Check run-time option sets before calling `decide()`.** When options
   come from run-time or operator data (a chain menu from `watch.chains`,
   one option per finding), call `isValidOptionSet(options, fallback, {permitted})`
   (or `optionSetProblem(...)` for the message) first. If the set is
   degenerate (empty, duplicated, or missing the fallback), skip `decide()`
   and use the heuristic directly. Letting `decide()` throw is only for
   statically built sets, where it fails the call site's unit test. A throw
   from operator data would crash a run that works with no `decisions:` block.
4. **`DecisionKindSpec.options` is display only.** Doctor shows it, and
   nothing checks it against the options a call site sends. Build the call
   site's options from the same constant as the spec so they cannot drift.
5. **`extras` and `parseDecisionExtras` are optional.** A kind with no
   feature settings omits `extras` and never calls `parseDecisionExtras`.
6. **Where to decide.** Inside a phase, pass that phase's
   `ph.phase_id` as `phase_id`. For run-scoped decisions (such as
   `startRun`), leave it `""`. The watch lane has no `Run`: build a `Decider`
   with `createDecider({ config: cfg.decisions, recorder: traceDecisionRecorder(tracer, adwId) })`
   once the lane has a tracer and an `adwId`. Before then, use
   `recorder: null`. That decision still acts, but it is not in any trace,
   so say so in your kind's docs.
7. **Mixing kinds in one `decideBatch` is allowed.** Each item is judged
   under its own kind's policy, and the call's deadline is the largest live
   `timeout_ms`. Keep a batch to one kind unless the items genuinely share
   one `state`.
8. **Each feature proves invariant 1 through its real call site.** Add a
   test showing that with no `decisions:` block the feature's result equals
   the heuristic and the trace has zero `decision` rows (and, ideally, that no
   client is constructed: register a throwing `setDecisionClientFactory`).
   Keeping existing tests unmodified is not enough, because it cannot cover
   new code paths.

## Decisions

Each feature ticket appends one subsection here with: the kind name, the
option set, the fallback (the existing heuristic), where it is resolved,
what acting on it can and cannot do, and any `decisions.kinds.<kind>`
settings it adds.

<!-- One "### `kind`" subsection per kind, ALPHABETICAL by kind. Insert yours in order; do not edit neighbors. -->

### `chain_edge`

Picks the next step at a branch point of a repo graph chain: a
`.spf/chains/*.yaml` step that declares more than one `next:` edge. Ticket
#109. Code: `src/chains/graph.ts`. How to author a graph chain:
[`authoring_chains.md`](../assets/skill/cookbooks/authoring_chains.md#declared-transitions-next).

- **Question and options.** A `choice` over that step's declared `next:`
  step ids, in the order the yaml lists them. The set is built from the
  yaml, so the kind declares no static `options`. The decision model cannot name a step
  the author did not list as an edge of that step.
- **Fallback.** The step's `default:` edge. If `default:` is omitted, the
  fallback is the linear next step, which the loader requires to be one of
  the edges. If the fallback's target has used up its `max_visits`, the
  first declared edge whose target has not becomes the fallback. This is
  exactly the path the chain takes with no `decisions:` block.
- **Where it is resolved.** In `walkGraph` (called by `steps.runSteps`)
  after the branch step finishes and before the next one starts, through
  `run.decider`. `phase_id` is `""` because the decision sits between phases.
  `key` is `<step id>#<visit>`, for example `triage#2` for the second time
  `triage` ran. It is stable across runs and never a list index. The state
  the decision model sees is the chain name, the request (clipped), the path so far,
  `accepted`/`reason`, the last envelope's status and summary, and the
  last quality or review result in brief.
- **`permitted`.** Only the edges whose target still has `max_visits` left.
  When only one edge is open, the decision model is not asked. When none is open, the walk
  stops and the run is not accepted.
- **What acting on it can do.** The decision model can take a different declared edge.
  That can run an extra check or review, loop back to a step for another
  bounded attempt, or end the chain early at a `next: []` step.
- **What it cannot do.** The loader rejects any graph in which that could
  weaken the chain (invariant 6):
  - every cycle must pass through a `max_visits` step, and `max_steps`
    caps total step executions;
  - no path may reach a `commit` without every gating step
    (`qualityCheck`, `fixLoop`, `reviseLoop`: a `Step` with `gate: true`)
    that the default path runs before it. A commit that only a model-picked
    edge reaches is held to the gates the default path runs before its
    first commit, or before its end if it never commits;
  - a commit that only a model-picked edge reaches must be `onlyIfAccepted`;
  - an `onlyIfAccepted` commit needs at least one gating step on every
    path to it.

  `spf fanout`, `watch.fanout` and `spf doctor` decide whether a graph
  chain commits from its default path (`chainHasCommitStep`). A commit
  that only the decision model can reach does not make a chain eligible for fan-out.

  At run time, `accepted` on a graph chain is the AND of each gating
  step's latest result. A passing check the decision model routes to therefore cannot
  overwrite an earlier failure.
- **Replay.** Every transition is a `chain_edge` log event, with
  `from`/`to`/`via`/`visit` and, at a branch point, `key`, `options`,
  `permitted` and `fallback`. `via` is `"decisions"` when the decision
  model's answer picked the edge (it was `"jev"` before #150; rows already
  recorded keep that value), `"fallback"` when the fallback did, and
  `"linear"`, `"declared"` or `"only_permitted"` when there was nothing to
  decide. Every walk also writes one `chain_path`
  event holding the whole path. That includes a walk that ends because a
  step threw, in which case `stopped` reads `threw: <message>`. To retrace
  a run without calling the decision model, pass
  `walkGraph(run, state, graph, { replay: (key) => findRecordedDecision(db, adwId, "chain_edge", key) })`.
  Replay is currently an API for tooling and tests only. `steps.runSteps`
  does not pass a replay, and no CLI command (`spf trace`, `spf estimate`,
  `spf watch`) re-drives a run from its recorded edges yet. Wiring a
  `--replay <adw_id>` through `runSteps` is follow-up work. If the yaml
  has changed since the recording so that a branch point's options differ,
  the recorded decision does not match and replays as `replay_missing`.
  The fallback edge then acts.
- **Extras.** None. Tune it with `decisions.kinds.chain_edge.{mode,threshold,timeout_ms}` only.


### `chain_router`

Picks which chain builds an issue that `spf watch` claims. Ticket #107.

```yaml
watch:
  chain: plan-build-test              # the default, and the fallback
  chains: [plan-build, build-review]  # the allowlist the router may pick from
decisions:
  enabled: true
  kinds:
    chain_router: { mode: shadow }    # or act / off; threshold, timeout_ms as usual; replay: true (default)
```

- **Kind:** `chain_router`, a `choice` question.
- **Options:** built by code at claim time, not static. The menu is
  `watch.chain` first, then each `watch.chains` entry in the order written,
  with duplicates removed. Each option's value is the chain name. Its
  description, which only the decision model sees, is the chain's `describe` line plus its
  derived `phases` string. The state the decision model reads is the issue's id, title and
  body (the body is cut to 4,000 characters), the default chain, and whether
  a commit chain is required. The trace records only a sha256 of that state.
- **Fallback:** `watch.chain`, the one chain `spf watch` ran before this
  feature existed. It is always on the menu, so you do not need to repeat it
  in `watch.chains`.
- **Where it is resolved:** in `core/watch.ts`, at claim time and before
  any worktree is created, through the `WatchDeps.routeChain` callback. That
  callback is built by `makeWatchChainRouter` in `cli/commands/watch.ts`
  over `core/chain_router.ts`. `key` is the issue id and `phase_id` is `""`,
  because no chain has started yet. The decision is written to the main
  repo's trace db under the claim's adw_id: `issue-<id>` for single
  dispatch, or the best-of-N base id (for example `issue-<id>`) that the
  attempt ids derive from. `spf phases issue-<id>` shows it. If the trace db
  cannot be opened, the claim never blocks, but an unrecorded decision never
  acts either: in `act` mode the decision model is asked in shadow for that claim (the log
  line shows its suggestion) and `watch.chain` runs; in `shadow` mode the
  decision is simply untraced. One log line says which. Plain `ready`
  claims are routed. A `feedback` revision never asks the decision model: it rebuilds with
  the chain recorded on the issue's marker (`WatchMarker.chain`, written
  only when a claim was routed away from `watch.chain`) while that chain is
  still in `watch.chains`, and otherwise runs `watch.chain`.
- **Replay:** a re-claim of the same issue (`blocked` back to `ready`, a
  daemon restart) looks up the latest recorded `chain_router` decision for
  that adw_id and issue id and passes it to `decide()` as `replay`: no decision-model
  call, the recorded answer re-judged under today's mode, threshold and
  menu. A row is reused only when the decision model actually answered (a recorded
  timeout or error is asked again, not pinned forever) and the menu and
  fallback are unchanged (edit `watch.chain`/`watch.chains` and the next
  claim asks live). A best-of-N base id bumped past a crashed attempt is a
  new adw_id, so it asks live too. Set `replay: false` to ask on every
  claim.
- **Best-of-N:** when `watch.fanout.n > 1`, chains with no commit step are
  removed from the menu in code before the decision model is asked, so the decision model never sees
  them. This uses the same `hasCommitStep` check as the startup refusal. A
  routed chain is checked again when each attempt dispatches.
- **Degenerate menus skip the decision model:** if the menu has fewer than two chains
  after filtering (for example the allowlist holds only non-commit chains
  under best-of-N), `decide()` is not called. The fallback runs and no
  trace row is written.
- **What acting can do:** swap which operator-allowlisted chain runs for
  this one issue. `core/watch.ts` re-checks the answer against `watch.chain`
  plus `watch.chains` before dispatching, so even a router that strayed off
  its menu cannot start any other registered chain. Only `act` mode is
  announced: spf posts one issue comment naming the chosen chain and why
  (routed, kept, or which fallback), and the PR body gets the same line. In
  `shadow` mode, and with the decision model off, nothing appears on the tracker; the decision model's
  suggestion is in the trace and the daemon log only. With routing
  configured, the `issue_claimed` notification is sent after routing, so
  its `chain` field names the chain that runs, and `--dry-run` says routing
  is enabled.
- **What acting cannot do:** name a chain outside the menu (that answer is
  `invalid_choice` and the fallback runs), pick a non-commit chain under
  best-of-N, or change anything inside a chain. Every chain's own gates,
  retry limits and budget ceilings run unchanged. Routing never changes
  `watch.chain_options`, the adw_id, the branch, or the worktree.
- **Validation:** every `watch.chains` name must resolve through
  `findChain`. This is checked at `spf watch` startup, not when the config
  is loaded (the chain registry is per repo and is built after config load,
  the same as for `watch.chain`): `spf watch` refuses to start, and
  `spf doctor` fails a `watch.chains` check. Doctor also runs the same suites and owners
  checks on each allowlisted chain as on `watch.chain`, and under best-of-N
  it warns which allowlisted chains will never be offered.
- **Extras:** `replay` (boolean, default `true`), described under
  **Replay** above. An invalid value stops `spf watch` at startup and fails
  `spf doctor`.


### `diff_risk`

Issue #152. After a run's diff exists and its suite and review have passed,
but before the signoff and the commit, the decision model is asked whether
the diff touches each of seven risk areas. A hit can only **add** a human
signoff requirement and a label. Code: `src/chains/diff_risk.ts` (the git
read, the decision call, the trace) and `src/core/diff_risk.ts` (the pure
floor, the clipped state, the action table).

- **Question:** seven `choice` questions, one per risk key, all asked in ONE
  `decideBatch` call over one shared state. The keys (`DIFF_RISK_KEYS` in
  `core/decision_kinds.ts`) are `auth`, `money`, `schema`, `data_loss`,
  `state`, `api_contract` and `secrets`. Each question is a short constant
  instruction that names its risk and points at `state.diff`, never restating
  the diff.
- **Options:** `touches | does_not_touch` (`DIFF_RISK_CHOICES`). The model
  never names an action.
- **Key:** the risk key itself (`auth`, `money`, ...): one decision per key
  per run.
- **Fallback, the deterministic floor:** a code-owned table decides each
  key's `fallback` with no model. It reads every changed path (tracked
  changes, deletions, and untracked files) and every **added** line of the
  whole diff:
  - paths: `migrations/**`, `db/migrate/**`, `*.sql`, `schema.prisma`
    (schema); `auth/**`, `oauth*`, `permissions*`, `rbac*`, `jwt*`
    (auth); `billing/**`, `payments/**`, `stripe*`, `invoices*` (money);
    `state/**`, `store(s)/**`, `cache/**`, `queue(s)/**` (state);
    `openapi*`, `*.proto`, `*.graphql`, `api/**`, `routes/**`
    (api_contract); `.env*`, `*.pem`, `*.key`, `credentials*.json`, `.npmrc`,
    `.envrc`, `.netrc`, `.pypirc`, `.aws/credentials`, `kubeconfig`,
    `.kube/config`, `*.tfvars` (secrets).
    A `.env.example`, `.env.sample`, `.env.template` or `.env.dist` is a
    committed template of key names, not a secret, and does not match.
  - added lines: private-key blocks, AWS/GitHub/Slack/Google/`sk-` key
    shapes, npm tokens, `user:password@host` URL userinfo, and
    `password|token|secret|api_key = "<12+ chars>"` assignments, quoted or
    unquoted (`KEY=value`, YAML `password: value`; a value that is a
    reference (`$VAR`, `{{ x }}`, `process.env...`) or a call is not a hit)
    (secrets); `DROP TABLE|COLUMN|...`, `TRUNCATE TABLE`, and
    `DELETE FROM x;` with no `WHERE` (data_loss).
  `state`, `api_contract` and money logic in an innocuous file are exactly
  what globs miss and what the model is for.
- **What acting on it does (act mode):** a key is flagged when the floor hit
  it **or** the model's acted answer is `touches`. Each flag adds the label
  `risk:<key>` (`DIFF_RISK_ACTIONS`) and sets `require_human_signoff`. The
  signoff requirement is `review.require_human_signoff || flagged`
  (`mergeSignoff`), passed to `decideSignoff` in `simple_sdlc`: attended, a
  human is asked as always and the prompt names the flagged risks;
  unattended, the existing fail-closed branch applies, so a flagged diff
  stops before `commit_build` and the error names the flags. **Read the
  next bullet before switching to act.** There is no
  action to turn signoff off, reduce review rounds, drop a gate, raise a
  retry ceiling or spend more.
- **Act mode under `spf watch`, `spf fanout` and `spf loop` blocks the
  run.** Every dispatch from those commands is unattended, so a flagged
  diff throws a typed `SignoffRequiredError` from the signoff phase before
  `commit_build`. What each command does with it:
  - `spf watch`: no PR is opened and the issue is blocked. The failure path
    still runs `preserveWork` like any failed run, so the unfinished tree is
    committed (`wip: ...`) and pushed to `<branch>-wip` on origin, **except**
    when the flags include `secrets` or the diff could not be read (the
    error's `withholdsWip`): then nothing is committed or pushed, the blocked
    comment says so, and the work is discarded with the worktree. A flagged
    `auth`, `schema`, `money`, ... diff is therefore pushed to the `-wip`
    branch for a human to look at, with no PR.
  - `spf loop`: the error is **terminal**. The loop records the attempt and
    stops (`reason: blocked`) instead of re-running; without that, a flagged
    diff would fail every iteration the same way and burn `--stuck-after`
    (default 3) whole chain runs, each re-planning and re-building. One chain
    run is spent, as it would have been with `diff_risk` off.
  - `spf fanout`: each attempt is an independent sibling already budgeted by
    `--n`, so a flagged attempt just fails (nothing re-runs) and its green,
    approved build is discarded.
  The floor is broad (any `api/**`, `routes/**`, `state*`, `store*`,
  `cache*` or `login*` path, a `.sql` file, a plan file named `auth-*.md`),
  so under act an unattended pipeline will block often. The error message
  names every cause: when `review.require_human_signoff` is already true in
  the config it says so and does not suggest that loosening `diff_risk`
  alone would unblock the run. Carrying the flags into the PR body or labels
  instead of failing the run is a follow-up (the code hosts have no PR-label
  call yet). Until then run `diff_risk` in `shadow` for unattended pipelines
  and use `act` only for attended `spf run`s, where a human answers the
  signoff prompt.
- **What it can never do:**
  - A model answer never removes a flag. A floor hit stays flagged when the
    model answers `does_not_touch`, errors, times out or is unsure. A
    property test checks this over every floor and every model answer.
  - It never turns `review.require_human_signoff` off, and never touches the
    reviewer's verdict, the fix and revise loops, or the suite.
  - In **shadow** mode nothing is applied: the decisions and one
    `decision_diff_risk` event are recorded, with `applied: false`, the
    flags the floor raised and `model_would_add`, the keys the model would
    have added on top in act mode. Use that to watch the hit rate before
    switching to act.
  - With no `decisions:` block, or `kinds.diff_risk.mode: off`, it is a
    total no-op: no phase, no diff read, no extras parse, no call, no row.
    The floor does **not** run on its own either, so an existing run never
    gains a signoff requirement it did not have. The floor acts only while
    the kind is on in act mode (including as the answer when the model
    fails).
- **Clipping:** the model reads a clipped copy of the diff, bounded by
  `max_diff_chars` as a **hard** limit on `state.diff`: file headers, clip
  marks and separators all count inside it. The files that fit share it
  fairly, so one huge file cannot push out the rest (small files stay
  whole); files the budget cannot show are not headed one by one but counted
  in a single trailing `(N more file(s) omitted)` line (and `state.diff_files_omitted`).
  `max_diff_chars: 0` sends an empty `diff` and the file list only. A clip is never silent: the
  state carries `diff_clipped: true` and a note the model reads, the
  outcome has `clipped: true`, and the `decision_diff_risk` event and a
  console line say so. The floor reads the **whole** diff, so a clip can
  hide a hunk from the model but never from the floor. The file list is
  capped at 100 paths (the rest are a count). Untracked files (new files stay
  untracked until `commit_build`) are scanned whole by the floor, up to 8
  MiB each and 64 MiB in total; the 16000-character clip applies only to
  what the model sees. A file past those caps is listed as `unscanned`
  (its path is still checked; the event, the console and the model's note
  say so). A line longer than 4000 characters is scanned in overlapping
  windows, not skipped. A binary file is listed by name only. Paths are read
  NUL-separated with `core.quotePath=false`, so non-ASCII filenames match
  the path rules.
- **Where:** a `diff_risk` phase (`code`, owner `decisions`) between the
  last review/retest and the `signoff` phase of `simple_sdlc`, run once, only
  when the suite is green and the review approved (otherwise nothing would
  commit). Chains other than `simple_sdlc` have no signoff step, so they do
  not use this kind yet.
- **Never fail-open, never fail the run:** the diff is read with a large
  buffer (retrying file by file when it is too big), and the path floor needs
  only the file lists, so it runs even when no diff text can be read. If git
  cannot be read at all (`unreadable`), or the phase itself throws, then in
  **act** mode the outcome requires human signoff with that reason, and in
  shadow nothing is applied; either way a `decision_diff_risk` event
  (`unreadable`, `unscanned`) and a console line record it, and the run
  itself still continues. A trace-write failure is warned about once and
  ignored.
- **Labels are recorded, not pushed.** `CodeHostProvider` has no PR-label
  call today, so the `risk:<key>` labels exist only in the outcome, the
  `decision_diff_risk` event, the console and the signoff prompt/log, not on
  a GitHub or Bitbucket PR.
  Persona selection (`add_panel_persona`) waits for #34.
- **Upgrading with `decisions:` already on:** the global `decisions.mode`
  default is `shadow`, so a config that enabled `decisions` for another kind
  gets `diff_risk` in shadow with no further setting: one more model call per
  `simple-sdlc` run, carrying the clipped diff to the configured backend. Set
  `decisions.kinds.diff_risk.mode: off` to opt out.
- **What leaves the machine:** when the kind is on (shadow included, since
  shadow still calls the model), the decision model's `state` carries the
  changed file paths and the clipped diff, which is the actual code. Secrets
  the floor recognises (private-key blocks, AWS/GitHub/Slack/Google/`sk-`
  keys, literal credential assignments) are replaced by `[redacted: <why>]`
  before clipping, and files whose path is a secrets rule (`.env*`, `*.pem`,
  `*.key`, ssh keys, `credentials*.json`, `.npmrc`, `.envrc`, `.netrc`, `.aws/credentials`, `*.tfvars`) are sent by name only
  (`state.withheld_files`). The floor still reads the unredacted text. The
  redaction covers only the shapes the floor knows; other proprietary code
  is sent as is. Set `max_diff_chars: 0` to send only the file list. A local
  `provider: ollama` keeps it on the machine.
- **Extras** (`decisions.kinds.diff_risk`):

  | key | default | meaning |
  |---|---|---|
  | `max_diff_chars` | `16000` | Hard bound on the characters of diff in the model's `state` (headers and clip marks included), shared across the files shown. Integer, 0 to 30000; 0 sends the file list only. The floor ignores it. |

  ```yaml
  decisions:
    enabled: true
    kinds:
      diff_risk:
        mode: shadow          # watch the hit rate first; act applies the flags
        timeout_ms: 10000     # one call carries seven questions over a diff
        max_diff_chars: 16000
  ```

  `spf decisions calibrate` gives no threshold for this kind: it has no
  outcome signal (see the table above). Before moving to act, set a per-kind
  `threshold` yourself from the shadow `decision_diff_risk` events: the rate
  of `model_would_add` and the recorded confidences of the model's `touches`
  answers. The global default threshold flags more than a risk gate should.

### `finding_triage`

Ticket #106. Before a rejected review's findings reach the fixing agent,
the decision model classifies each **unmet** finding (`met: false` in the reviewer's
`ReviewOutput`) so the fixer spends its round on what matters.

- **Question:** `choice`, one per unmet finding, all asked in ONE
  `decideBatch` call per round. The state is the request plus the review
  (summary, up to 25 `blocking` entries, and the unmet findings, each with
  an `id` = its fingerprint). Each question is a short pointer ("classify
  the finding whose id is ...") and never restates the finding. The state
  is clipped by progressively tighter limits until it fits a fixed
  character budget, so the whole request stays inside the decision model's ~32k-token
  budget even at the cap (`TRIAGE_REQUEST_CHAR_BUDGET` in
  `chains/finding_triage.ts`; a test pins the worst case). At most 50
  distinct findings are asked about per round; any beyond that keep the
  fallback.
- **Options:** `real | noise | style` (`FINDING_TRIAGE_CLASSES` in
  `core/decision_kinds.ts`; the call site builds its options from that tuple).
  `real` = a genuine unmet requirement or defect; `noise` = a false
  positive, already satisfied, out of scope, or unactionable; `style` = a
  cosmetic preference that does not decide whether the request is met.
- **Fallback:** `real` for every finding, which is today's behavior: the
  fixer is asked to close all of them.
- **Key:** `revise_<round>:<fingerprint>`, where the fingerprint is the
  first 16 hex chars of sha256 of the finding's normalized requirement text
  (case, whitespace, and evidence do not change it). Findings with the same
  requirement share one question.
- **Where:** inside the revise phase of `reviseLoop` (`chains/steps.ts`) and
  of the built-in `simple_sdlc` chain's review loop, so each decision's
  `phase_id` is that `revise_<round>` phase (`ph.phase_id`). The call site is live only; it
  does not pass `replay` yet, but the keys are stable, so a replay caller
  can look decisions up with `findRecordedDecision(db, adwId,
  "finding_triage", key)`.
- **What acting on it does (act mode, confident answer):** a `noise` or
  `style` finding is removed from the handoff's `findings`. Any `blocking`
  entry whose text is the same requirement (after case and whitespace
  normalization) goes with it. A blocker worded differently stays, because
  spf never guesses which free-text blocker a finding means. This only
  happens while at least one unmet finding is still `real` (see "never
  empties the ask" below). With the
  default `drop: none`, each demoted finding is listed again under a
  `## Deprioritized by the decision model` section appended to the envelope's
  `notes_for_next_agent`, so the fixer still sees it, ranked after the real
  work. When anything was demoted, one `log`/`decision_triage` event on the
  revise phase records what was kept, deprioritized, and dropped. (The
  event was `jev_triage` before #150; any reader of triage rows must accept
  both names, as `FINDING_TRIAGE_EVENT_NAMES` does.)
- **What it can never do:**
  - It never changes `approved`. The loop's verdict, `state.review`, and
    `state.accepted` all come from the reviewer's original envelope, and
    the reviewer rules on every requirement again next round. Triage shapes
    what the fixer is asked to fix. It cannot turn a rejection into an
    approval.
  - It never empties the ask. If every unmet finding comes back demoted,
    the handoff's `findings` and `blocking` are passed through unchanged,
    whatever `drop` says; the demotions only add the
    `## Deprioritized by the decision model` note. The `decision_triage` event records
    `all_demoted: true` (and `drop_suspended: true` when `drop` would have
    withheld some). So a rejected review always reaches the fixer with a
    non-empty structured to-do list, and every handoff still passes
    `gates.verdictConsistent` just as the reviewer's own envelope did.
  - The next review round is handed the builder's envelope, never the
    triaged handoff.
  - A failure writing the `decision_triage` event is warned about once on
    stderr and never fails the revise phase, the same as `decision`
    rows.
  - It never triages `met: true` findings or an approving review.
- **Shadow mode:** The decision model is called and every decision is recorded, but the
  fallback (`real`) acts, so the fixer receives the reviewer's envelope
  unchanged.
- **Not triaged:** `fixLoop`'s suite output. A `QualityResult` holds one
  verbatim output blob per check (whatever the linter or test runner
  printed), not a list of findings, and splitting arbitrary tool output per
  finding would mean parsing formats spf does not own. To get triage for an
  external reviewer, have a reviewer agent consult it and use `reviseLoop`
  (see `cookbooks/ocr_reviewer.md`).
- **Extras** (`decisions.kinds.finding_triage`):

  ```yaml
  decisions:
    enabled: true
    kinds:
      finding_triage:
        mode: act
        timeout_ms: 10000   # recommended: one call carries up to 50 questions
        drop: none          # none | noise | noise_and_style
  ```

  The ticket's `decisions.triage.drop` is spelled
  `decisions.kinds.finding_triage.drop` here, following the
  `decisions.kinds.<kind>` convention every kind uses. A top-level
  `decisions.triage:` key is not a setting: the config schema ignores unknown
  `decisions:` keys without a warning, so a setting placed there silently does
  nothing.

  **Timeout.** The global default `timeout_ms: 2000` is sized for one
  question. A triage batch asks up to 50 in one call, so give this kind its
  own `timeout_ms` (10000 is a reasonable start). A timeout is safe, since
  every finding falls back to `real`, but it turns triage off for that
  round.

  `drop` picks which demoted findings are withheld from the fixer entirely
  rather than deprioritized. `none` (default): every finding still reaches
  the fixer. `noise`: `noise` findings are withheld and `style` findings are
  deprioritized. `noise_and_style`: both are withheld. A withheld finding
  is never silent: its `decision` row and the `decision_triage` event both
  record it. An invalid value fails the run in `startRun` with
  `decisions.kinds.finding_triage: ...`, before the first phase and so
  before any agent spend (`startRun` parses the settings of every
  registered kind that is not `off`; `risk_tier` keeps its own narrower
  rule and is parsed only while tiering is on too). `spf doctor` reports
  it too.


### `intake_feedback`

Ticket #108. It classifies the new PR comments behind a `<prefix>:feedback`
label in the build lane's revision loop.

- **Options** (`choice`): `revise` | `question` | `approve` | `out_of_scope`.
- **Fallback**: `revise`. This is today's behavior: every `feedback` claim
  reruns the chain.
- **Resolved in** `core/watch.ts` `classifyFeedback`, called from
  `runIssueSingle`'s revision branch after `claimFeedback` claims the issue
  and the PR's comments are read. This happens before any worktree write.
  The adw_id is `issue-<id>`, which the revision run reuses,
  and `phase_id` is `""`. The key is `pr<n>:r<round>:<last comment id>`.
  The decision model reads the same comments `buildIssuePrompt` shows as "Corrections to
  address": the comments since the last push, or all comments when there is
  no watermark. The issue body is not included. If there are no such
  comments, the decision model is not called and the result is `revise`.
- **Acting on it**:
  - `revise` runs the revision exactly as before.
  - `question` posts an acknowledgement comment on the issue and does not
    run the chain.
  - `approve` and `out_of_scope` are logged only while the PR is open. On
    a closed PR they also post a one-line comment, because the issue lands
    on `blocked`, and a silent `blocked` would be a dead end.
  - Every choice except `revise` moves the issue back to `review` if the PR
    is open, or `blocked` if it is closed. It first records the answered
    key and choice on the marker (`WatchMarker.intake_feedback`). The PR,
    its branch, and every other marker field are not changed.
- **Human override**: when the human adds `feedback` again with no new PR
  comment, the key is the same as the recorded one. spf reads that as
  "revise anyway": it revises and does not call the decision model. With a new comment,
  the key changes, and the decision model classifies the new batch. So a wrong answer
  costs one relabel, and the issue never bounces between `feedback` and
  `review`.
- **What it cannot do**: skip a revision's gates, merge or approve a PR, or
  move anything to `done`. `approve` only means "no rerun". The PR still
  needs a human to merge it, and `finishReviews` still decides `done`. The
  worst a wrong answer can do is skip a revision a human asked for until
  the human adds the label again (see the override above). Turning the kind
  to `off` restores today's behavior.
- **Replay**: never replayed. In act mode each key is asked at most once:
  a non-`revise` answer is on the marker before anything else acts, and the
  next claim with that key is the override. A `revise` answer bumps the
  round, which changes the key. The recorded decision is for offline
  analysis only (`listRecordedDecisions`).
- **Default on**: none of the intake decisions needs its own opt-in.
  `decisions.enabled: true` turns this kind on at the global `decisions.mode`. If that
  mode is `act`, the kind acts on your tracker. To opt out, set
  `decisions.kinds.intake_feedback.mode: off`.
- **Extras**: none. Use `decisions.kinds.intake_feedback.mode` to turn it on
  or off independently of `intake_readiness`.


### `intake_readiness`

Ticket #108. It decides, before `spf watch` claims a `<prefix>:ready`
issue, whether to build it as written.

- **Options** (`choice`): `build` | `refine` | `needs_human`.
- **Fallback**: `build`. This is today's behavior.
- **Resolved in** `core/watch.ts` `routeReadiness`, called from
  `claimNewWork` after the frontier check and local lock, and before the
  tracker-side `claim()`. The adw_id is `issue-<id>`, `phase_id` is `""`,
  and the key is `""`. The decision model reads the issue's id, title, labels, and body
  (truncated).
- **`permitted`**:
  - `build` and `needs_human` are always permitted.
  - `refine` is permitted only while `watch.refine.enabled` is true, and
    only for an issue the refine lane did not create itself (no
    `spf-refine:` marker in the body). This prevents a loop.
- **Runs once per issue**: an issue that already has any watch marker is
  always `build`, and the decision model is not called. This covers an earlier routing, an
  earlier build, or a PR. Relabeling a routed issue `ready` therefore
  overrules the router.
- **Acting on it**:
  - `refine` moves the issue to `<prefix>:spec-ready` with an explanatory
    comment.
  - `needs_human` moves the issue to `<prefix>:blocked` with a needs-info
    comment, then sends an `issue_blocked` notification. This reuses the
    existing blocked state, so there is no new label.

  Only after that transition succeeds does the router write the marker
  (`WatchMarker.intake = {routed, at}`), so the marker only records routings
  that happened. A routed issue is never claimed and never uses the
  concurrency budget. A tracker error while routing skips the issue for
  that tick:
  - If the transition fails, the issue stays `ready` with no marker and no
    notification, and the next tick routes it again.
  - If the marker write fails after the transition, the issue stays routed
    but has no marker. A human's relabel to `ready` then routes it once
    more.
- **Per-tick cap**: routings that send an issue away (and routing errors)
  do not spend the concurrency budget. Instead, they are capped at
  `watch.concurrency` per tick, and the other issues wait for the next
  tick. A tick therefore makes at most 2 x `concurrency` readiness calls,
  each bounded by `timeout_ms`.
- **Replay**: never replayed. The router only asks about an issue with no
  marker. After an answer, an issue has no marker only if a tracker write
  failed. In that case a fresh answer about the issue as it is now is the
  right one. The recorded decision is for offline analysis only
  (`listRecordedDecisions`).
- **Several daemons**: the router runs before `claim()`'s compare-and-set,
  and the pid lock only protects one machine. So two daemons on different
  machines watching the same repo could both route one issue in the same
  tick. That means a duplicate comment and a duplicate decision-model call. This is
  accepted, because the watch lane does not support that setup anyway:
  `reconcileOrphans` treats every `working` issue that its own process is
  not running as an orphan.
- **What it cannot do**: skip a gate or push work forward. It can only send
  unclaimed work away from the build lane, to a human or to decomposition.
  `refine` is impossible while the refine lane is off. A mode of `off`
  skips the marker read too, so it adds no tracker call.
- **Default on**: `decisions.enabled: true` turns this kind on at the global
  `decisions.mode`, just like `intake_feedback`. There is no separate intake
  opt-in. To opt out, set `decisions.kinds.intake_readiness.mode: off`.
- **Extras**: none. Use `decisions.kinds.intake_readiness.mode` to toggle it.

**Tracing for both kinds**: `spf watch` has no `Run` before a claim. When
`decisions.enabled` is true and at least one intake kind is not `off`,
`cli/commands/watch.ts` `openWatchIntakeDecider` opens one Tracer for the
daemon's lifetime on the normal trace db. It records each decision under
the issue's adw_id. The JSONL copy goes to
`<data_dir>/watch/decision_events.jsonl`. Otherwise nothing is opened and
`WatchDeps.intakeDecider` is unset.


### `loop_control`

Ticket #105. After a failed round in `fixLoop` or `reviseLoop`
(`src/chains/steps.ts`), spf asks the decision model what the loop should do next.

- **Kind:** `loop_control`, a `choice` question.
- **Options:** `continue`, `escalate_tier`, `stop_blocked`. Both the
  kind spec and the call site build these from the single constant
  `LOOP_CONTROL_CHOICES`.
- **Fallback:** `continue`. This is the existing behavior: spend the next
  repair round on the same agent and the same model. Every fallback reason
  (disabled, shadow, timeout, error, low confidence, a choice outside the
  set or outside `permitted`) runs the loop you have today.
- **When spf asks:** only after a round fails and another repair round would
  otherwise run. It never asks after a passing round or on the final round,
  because the loop ends there anyway. A loop with `max: 3` makes at most two
  decisions.
- **Where it is resolved:** `src/chains/loop_control.ts`
  (`createLoopControl`), called from the loop body between the failed round
  and the repair phase.
  - The decision's `phase_id` is the failed round's phase (`test_2`,
    `verify_1`, `review_1`, ...).
  - Its `key` is `fix:<round phase>` or `revise:<round phase>`, for example
    `fix:test_1` or `revise:review_2`. A chain that runs the same loop again
    in one run (a repo chain listing `fixLoop` twice over one suite, or
    `reviseLoop` twice) numbers the later loops: `fix#2:test_1`,
    `revise#2:review_1`. Loops are counted in the order they start, so for a
    fixed chain the key stays stable across runs and never collides within
    one.
  - Replay: a replay or estimate driver puts a run's loops in replay mode
    with `setLoopControlReplay(run, resolver)`. The usual resolver is
    `recordedDecisionReplay(db, sourceAdwId)`, which looks up the recorded
    decision by that key. `decide()` re-judges the recorded answer under
    today's policy and today's `permitted`, so a recorded `escalate_tier`
    replays as `not_permitted` once `max_tier` is removed, and a loop with
    nothing recorded falls back (`replay_missing`, `continue`). Nothing in
    spf drives a replay yet; `spf estimate` does not run loops.
  - The `state` the decision model sees: the loop and round, `max_rounds` and the repair
    rounds left, the repairing agent and its current tier, whether escalation
    is available (and if not, why), the latest round's detail, and a short
    history of earlier rounds with the action taken after each. For
    `fixLoop`, the latest round's detail is the failures plus each failed
    check's command, exit code, and clipped output tail. For `reviseLoop`, it
    is the reviewer's summary, its `blocking` list, and its unmet findings.
  - The state is bounded so it stays inside the decision model's state budget: each list
    keeps its first 20 entries plus a "… and N more" line (with the full
    count alongside), every text field is clipped, the history keeps the
    last 6 rounds, and a state still over about 48,000 characters is cut
    down further (older history first, then the latest detail).
- **What acting on it can do:**
  - `stop_blocked` ends the loop immediately with no further repair round.
    The run is **not accepted**, and its reason reads
    `stopped after round N of M: ... (loop_control)`.
  - `escalate_tier` moves the repairing role (the fix `owner`, or the
    reviseLoop `builder`) up **one** rung of `tiering.tiers` for the rest of
    **this** loop. It goes through the same `effectiveAgent()` dispatch seam
    that tiering uses. Only the model changes. When the loop exits, the run's
    original routing is restored, even if a phase throws.
  - Escalating opens a fresh agent session for the repairing role. spf
    rejoins a session only on the model it was opened with, so the escalated
    rounds do not see the earlier rounds' conversation. They get the prompt
    and the failing round's verbatim output, which is what every repair
    round gets. When the loop exits, spf restores the role's
    `agent_map.json` entry, so later phases on the original model rejoin
    their original session.
  - A `loop_control` log event and a console line record every
    non-`continue` action. An escalation also records its `from_tier` and
    `to_tier`.
- **What acting on it cannot do:**
  - add a round. The configured `max` is a hard ceiling;
  - skip, weaken, or pass a gate. Every check and review phase runs as
    before, and a stop never turns a failure into acceptance;
  - retier the reviewer. When one agent is both the reviewer and the
    builder of a `reviseLoop`, escalation is refused for that loop, because
    tiering routes by agent name and moving the author would move the
    critic too. Only `continue` and `stop_blocked` can act there;
  - skip a rung;
  - escalate more than once per loop;
  - escalate above the operator's ceiling. `escalate_tier` is in
    `permitted` only when every one of these holds:
    - `max_tier` is set and names a declared rung;
    - tiering is enabled and routed this role this run;
    - the next rung up is at or below `max_tier`;
    - that rung is usable under the same backend and served-tag rule as
      `resolveTiering`;
    - the reviewer and the builder are different agents (`reviseLoop` only);
    - this loop has not already escalated.

    In every other case, the decision model's `escalate_tier` becomes `not_permitted`, and
    the loop continues. The same holds on replay.
- **Settings (`extras`):**

  ```yaml
  decisions:
    kinds:
      loop_control:
        mode: act           # common knobs as usual
        max_tier: strong    # the highest tiering.tiers rung escalation may reach
  ```

  `max_tier` is the operator spend ceiling. Ticket #105 called it
  `decisions.loop.max_tier`, but it lives under the kind's own `decisions.kinds`
  entry, as the core contract requires for every feature setting. A
  `decisions.loop:` block is dropped when the config is parsed, so it would leave
  escalation silently off; `spf doctor` warns (`decisions.loop`) when any config
  layer has one. When it is absent, which is the default,
  escalation is disabled and only `continue` and `stop_blocked` can act. A
  malformed value fails `spf doctor`. It also fails `startRun` whenever the
  kind is live. A `max_tier` that names no declared rung disables
  escalation, and the reason appears in the state the decision model sees.


### `risk_tier`

Classifies a run's risk for tiering (#104). Code: `src/core/risk_tier.ts`.

- **Kind:** `risk_tier`, a `choice` question.
- **Options:** `low | standard | high`, in ladder order, weakest first. The
  set is closed and built from `RISK_TIER_KIND.options`.
- **Fallback:** the existing `classifyRisk` heuristic in
  `src/core/tiering.ts`, which adds chain weight and prompt word count. It is
  computed on every call, act mode included.
- **Where it is resolved:** once per `startRun` call in
  `src/chains/steps.ts`, before any phase opens.
  - `phase_id` is `""` (run-scoped).
  - `key` is the chain name, so a joined session's second `startRun` under
    a different chain has its own key.
  - The `Decision` goes into the pure `resolveTiering` as data
    (`TierInput.riskDecision`). `resolveTiering` never calls the decision model.
  - The decision-model call runs concurrently with the ollama tag probe, so it adds at
    most `max(probe, timeout_ms)` to run start, not their sum.
  - **Resume:** a run that re-enters `startRun` under the same `adw_id` and
    chain (the watch lane's continue-refinement resume, the build lane's
    `spf:feedback` loop) replays that run's own latest `risk_tier` decision
    instead of asking the decision model again, so both halves of one run route from the
    same answer. The replay is judged again under today's policy and
    `max_risk`, and is recorded as another row with `replayed: true`. It is
    used only when the question is the same (same options and same
    heuristic fallback). A resumed prompt that lands in a different
    word-count bucket is a new question, so it is asked live and recorded.
- **When it is asked at all:** only when `decisions.enabled` is true, the kind's
  mode is not `off`, and `tiering.enabled` is true. Risk changes nothing but
  tiering's routing, so with tiering off no call is spent. If any of the
  three is false, no call is made, no `decision` row is written, the
  extras are not parsed, and the `tiering` event is unchanged.
- **Trace:** the full decision is its own `decision` row. The existing
  `tiering` log event also carries a compact `risk_decision` summary (the key
  was `jev` before #150, and its `model_choice` was `jev_choice`; old rows
  keep the old spelling): `choice`,
  `model_choice`, `confidence`, `fallback`, `used_fallback`, `reason`,
  `mode`, `would_act`, `replayed`, `kind` and `key`. `risk` in that event is
  the effective risk, and `signals` are still the heuristic's. A console
  note is printed only when the decision model's answer moved the risk off the heuristic's.
- **`spf estimate`** never calls the decision model. By default it uses the heuristic. With
  `--replay-risk <adw_id>`, it replays the decision that run recorded for
  this chain, judged again under today's policy, with no call and no row
  written. When `risk_tier` is live for the config, or a replay is asked
  for, the report says which source it used: `risk_source` in `--json` (its
  recorded `decision` was `risk_source.jev` before #150), and
  a `risk from` line in text. A replay only matches when today's heuristic
  gives the same fallback (same chain, and a prompt in the same word-count
  bucket). Otherwise the reason is `replay_missing` and the heuristic acts.
  A recording above today's `max_risk` replays as `not_permitted`. Invalid
  `risk_tier` extras with `--replay-risk` exit 1 with the
  `decisions.kinds.risk_tier: ...` config error. With no trace db under
  `--cwd`, the detail says there is nothing to replay.
- **What acting on it can do:** pick which rung of the operator's own
  `tiering.tiers` ladder each routed role starts from. This is the same
  one-step shift the heuristic makes.
- **What it cannot do:**
  - name a model, add a rung, or route a role that `tiering.roles` does not
    name
  - walk up past an unusable rung (the walk only goes down)
  - raise `max_run_tokens` or `max_run_cost`, which are enforced as before
  - act above `max_risk` (see below)
- **Shadow mode:** The decision model is asked and the answer is recorded, but the
  heuristic's risk routes the run.
- **What leaves the machine:** when the kind is live, the decision model's `state` carries
  the chain name, the heuristic's signals, and the head of the operator's
  prompt (up to `max_prompt_chars`, default 4000). Prompts often embed issue
  bodies and comment threads (the watch resume folds the whole thread in).
  Set `max_prompt_chars: 0` to send only the chain name and the signals.
- **Config validation:** `startRun` validates the extras only when the kind
  is live, which includes `tiering.enabled`. With tiering off the extras are
  never read, so an invalid `max_risk` does not fail a run (a feature that
  is off is a no-op). `spf doctor` validates them regardless, so it catches
  a latent typo before tiering is turned on.

Extras, under `decisions.kinds.risk_tier`:

| key | default | meaning |
|---|---|---|
| `max_risk` | `high` | The highest risk the decision model's answer may act on (the `permitted` ceiling). The heuristic's own answer is always permitted, so this caps escalation driven by the decision model and never lowers what the run would get without the decision model. |
| `max_prompt_chars` | `4000` | How much of the prompt, from the start, goes into the decision model's `state`. The rest is dropped and flagged `prompt_truncated`. `0` sends no prompt text. Integer, 0 to 200000. |

```yaml
decisions:
  enabled: true
  kinds:
    risk_tier: { mode: act, threshold: 0.8, max_risk: standard }
tiering:
  enabled: true
  # tiers / roles as usual
```

## System One providers

`decisions.backend: systemone` has three transports, chosen by
`decisions.systemone.provider`. All three take the same question body shape
and return the same answers, so nothing above the client can tell them
apart. Credentials, URL, and (for Ollama) a couple of extra wire limits
differ.

| | `provider: typesafe` (default) | `provider: cloudflare` | `provider: ollama` |
|---|---|---|---|
| Endpoint | `POST {systemone.base_url}/systemone` (default `https://api.typesafe.ai/v1/systemone`) | `POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/typesafe/jev`, or with `cloudflare.gateway` set, `POST https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/workers-ai/typesafe/jev` | `POST {systemone.ollama.base_url}/systemone` (default `http://localhost:11434/v1/systemone`) |
| Auth | `Bearer $TYPESAFE_API_KEY` (`systemone.api_key_env`) | `Bearer $CLOUDFLARE_API_TOKEN` (the same token spf's Cloudflare model provider and sandbox use) | none — a bare local Ollama has no auth of its own |
| Body | `{model, state, questions}` | `{state, questions}` (the model is in the URL) | `{model, state, questions}` (`model` is `systemone.ollama.model`, e.g. `nimble`, NOT `systemone.model`) |
| Response | `{model, answers, usage}` | the same, wrapped in `{result, success, errors}`; spf unwraps it, and `success: false` is an `error` | the same as TypeSafe |
| Extra limits | — | — | 64 KiB request body; 2–26 options per `choice`/`score` question (TypeSafe allows 255/2–10) |

### `provider: typesafe` (TypeSafe's Jev, the default)

```yaml
decisions:
  enabled: true
  systemone:
    provider: typesafe
    model: jev-latest              # or jev-preview, or a pinned version such as jev-1.13
    api_key_env: TYPESAFE_API_KEY  # the env var NAME; export the key itself in your shell or .env
    base_url: ""                   # "" = https://api.typesafe.ai/v1
```

The direct route to TypeSafe's API. `systemone.model` is a TypeSafe catalog
id (`jev-latest`, `jev-preview`) and applies to this provider only. With
`api_key_env` unset in the environment, every decision falls back with
`no_api_key`, and `spf doctor` warns (`decisions api key`).

### `provider: cloudflare` (Workers AI / AI Gateway)

```yaml
decisions:
  enabled: true
  systemone:
    provider: cloudflare
    cloudflare:
      account_id_env: CLOUDFLARE_ACCOUNT_ID
      api_token_env: CLOUDFLARE_API_TOKEN   # needs the Workers AI > Read permission
      gateway: ""                           # AI Gateway id; "" = Workers AI directly
      model: typesafe/jev                   # Cloudflare's catalog id — NOT systemone.model
```

Routing through AI Gateway (set `cloudflare.gateway`) gives you Cloudflare's
caching, rate limiting and request logs in front of the model. The
Cloudflare pricing page lists Jev at $0.042 per 1M input tokens, $0 output,
with zero data retention. The env-var names default to the ones spf's
Cloudflare model provider and sandbox backend already read, so one token
serves all three. `systemone.model` and `systemone.base_url` are ignored with
this provider (`spf doctor` warns if `base_url` is set).

### `provider: ollama` (local)

```yaml
decisions:
  enabled: true
  timeout_ms: 5000           # Ollama's first call after a model load can be slow; TypeSafe's 2000ms default is too tight
  systemone:
    provider: ollama
    ollama:
      base_url: http://localhost:11434/v1   # default
      model: nimble                          # 9B, default — tev1 and tev1:0.8b are also available
  kinds:
    risk_tier: { mode: act }
```

Requires **Ollama >= 0.35**, which is when it started serving the System
One API (`POST /v1/systemone`) — `spf doctor` checks this via `GET
/api/version` and warns below it. No API key, no streaming, local-only
(this is not available through Ollama Cloud). Options are capped at 2–26 per
question (`choice` and `score` both), stricter than TypeSafe's 255/2–10;
spf checks the actual serialized request against both that cap and a 64 KiB
body limit before ever calling `fetch` — Ollama rejects an over-budget
request rather than truncating it, so spf treats a violation as a
programmer/config error for that call (fallback acts, `reason: "error"`),
not a network failure.

Pull the model before using it: `ollama pull nimble`. `spf doctor` also
checks `GET /api/tags` and warns if `decisions.systemone.ollama.model` was
never pulled. Raise `decisions.timeout_ms` to at least 5000ms (`spf doctor`
warns below that) — the first call after Ollama loads a model can take
several seconds; every call after that is fast.

## Wire format and caveats

- The TypeSafe request body is `{model, state, questions}` and the response
  is `{model, answers, usage}`. No SDK is used; each client is a small
  wrapper over `fetch`.
- **Checked against the live TypeSafe API on 2026-09-25.** `model` is
  required. Valid ids are `jev-latest` and `jev-preview`
  (`GET https://api.typesafe.ai/v1/models` lists them), and a response names
  the concrete version it ran (e.g. `jev-1.13.0`). A `choice` answer carries
  `choice`, `confidence` and `probabilities`. A `score` answer carries
  `score` (continuous), `confidence`, a `legend` and `probabilities`, keyed
  by **0-based** level index. A `noul` answer carries only `noul` (0–1) and
  no confidence. Typical latency was 150–440 ms per call.
- The Cloudflare path is built from Cloudflare's model page and covered by
  tests with a fake `fetch`. It has not yet been checked against a live
  Workers AI response.
- The Ollama path (>= 0.35) serves the same `{model, state, questions}` ->
  `{model, answers, usage}` shape as TypeSafe at `/v1/systemone`, with the
  stricter wire limits noted above. Covered by tests with a fake `fetch`;
  not yet checked against a live Ollama server.
- Answers are still parsed defensively. Any answer spf does not recognize
  becomes `invalid_response` and the fallback acts.
- spf does not retry. The model's value is fast answers, and every failure
  already has a correct answer (the fallback). A `429`/`529` is recorded as
  `error` with the status in `detail`.
- State and questions share a budget of about 32,000 tokens per call. The
  model is documented as unreliable at counting, so ask one question per
  item and sum the answers in code.
