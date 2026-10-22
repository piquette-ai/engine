# Changelog

This project doesn't otherwise keep a changelog file (releases are tagged
straight off `main` — see `scripts/tag-release.js`); this file starts with
the OTel SDK migration below because it's large enough, and cuts closely
enough to `observability.otel`'s existing invariants, to be worth a written
record independent of the commit log.

## Unreleased

### Fixed — protected-file enforcement was bypassed by committing

`permissions.snapshot()` fingerprints `git diff HEAD`, so an agent that COMMITTED an edit to a protected file moved HEAD and the change vanished from both snapshots (observed: a builder committed `scripts/sim-verify.sh`, listed in `defaults.protected_files`, and it went through).

- **`core/permissions.ts`**: `snapshot()` now records HEAD's sha; `enforce()` also diffs it against the new HEAD (`git diff --name-only --no-renames <start> HEAD`, a tree diff, so it works when HEAD was reset/amended/rewritten; renames count as delete + add). Those paths join the touched set and go through the same `permitted()` rules (file, glob and directory patterns, an agent's own `writes`). Paths already committed before the turn are not flagged; gitignored `data_dir` content never appears.
- Remedy for a committed breach: the path is restored to its start-sha content (or removed if it did not exist then) and recorded in ONE new revert commit. Not a reset/amend, so the agent's legitimate commits and any already-pushed history are preserved; the branch's net diff is clean. The phase still fails with `PermissionBreach`, as for uncommitted breaches. A path that was already dirty before the turn and then committed by the agent is reported as `COMMITTED-BY-AGENT` and left in HEAD (the operator's pre-turn content is not destroyed). All committed breaches are reverted in a single commit; if that commit fails (signing, mid-merge/rebase) the staged restore is undone so the repo stays consistent.
- Known limitation: if the agent switches HEAD to a different existing branch, the `start..HEAD` diff includes everything between the branches and the revert commit lands on that other branch.
- Known limitation: an unborn HEAD (repo with no commits) records no start sha, so a protected file in the very first commit is not caught.

### Fixed — SPF-opened PRs now link to their issue when tracker and code host are the same GitHub repo

briefs-finance/mobile PR #113 (issue #84, `github-projects` + `github`) carried no closing reference, so GitHub's `closedByPullRequestsReferences` was empty and the issue was never linked or auto-closed.

- **`core/watch.ts`**: the generated PR body gains `Closes #<n>` when `deps.closingRefs` is set — i.e. `watch.issue_provider` is `github`/`github-projects` AND `watch.code_host` is `github`. If the issue's repo (`watch.issue_repo || watch.repo`) differs from `watch.repo`, the qualified `Closes owner/repo#<n>` is used; ids that are not a GitHub number (`84`, `#84`, `owner/repo#84`) get no keyword. The line sits inside the `spliceGeneratedBody` region, so revision rounds and supersede flows replace it instead of duplicating it.
- Mismatched pairings (Jira + Bitbucket, GitHub issues + Bitbucket) are unchanged: no keyword, the issue id stays plain text.
- **`cli/commands/watch.ts`**: the factory computes `closingRefs` from config.

### Added — `spf decisions calibrate`: measured thresholds from recorded decisions (#151)

A read-only report that joins every recorded decision to an outcome spf already stores and answers, per **(kind, backend, provider, model)**: how often the model agreed with the fallback, how often act mode would have used its answer, how reliable its confidence was, and which threshold would have reached a target precision. It replaces the global `0.7` guess and hand-written SQL. See "Calibrating thresholds" in `docs/decisions.md`.

- **Command**: `spf decisions calibrate [--kind <kind>] [--target-precision 0.9] [--min-samples 30] [--since <iso-date>] [--json]`. It never calls a model, never writes config, and never writes a trace row. Output is a human table, or `--json`.
- **Per group**: `n`, agree-with-fallback rate, `would_act` rate, a five-bucket confidence reliability table (precision with a 95% Wilson interval), the precision at the threshold in use, and a suggested threshold (the lowest whose tail reaches the target with enough rows behind it, with its Wilson interval). Below `--min-samples` labelled rows a group prints `insufficient`. Shadow and act rows are separate groups (`mode=`).
- **The suggestion comes from dissents only.** Act mode only changes behaviour when the model confidently dissents, so the suggested threshold is derived from the dissent tail (`model_choice !== fallback`), which is also reported on its own (n, precision with a Wilson interval, reliability table). Agreements are never allowed to carry a tail over the target. `not_permitted` rows can never act and are excluded.
- **Both row shapes**: the current `decision` rows and the pre-#150 `jev_decision` rows (`jev_choice` read as `model_choice`) are read. Legacy rows have no backend or provider and form their own group.
- **Outcomes**: built in code per kind from data spf records: `chain_router` and `intake_readiness` score against the run's session status, `loop_control` against whether a later round of the same loop passed, `risk_tier` against whether the run was clean or troubled (failed gate, repair round, failure). A label is assigned only when the fallback acted (the model's own acted answer has no counterfactual). `chain_edge`, `finding_triage` and `intake_feedback` print `no outcome signal`: PR merge/close and human relabels are not in the trace db. `risk_tier` is scored only where the model's tier differs from the fallback tier that ran, and a downgrade on a clean run is ambiguous (the stronger tier ran). A kill (Ctrl-C / SIGTERM / `spf abort` all write session `fail`) is left unresolved: the signal handler now writes an additive `run_killed` `log` event synchronously before any drain or phase close (no session/phase status changes), and calibrate also falls back to a `fail` session with a phase that never closed. Only the decision's OWN run counts (found from the `adw` process rows), so a killed earlier run of a reused `adw_id` no longer censors a later run's clean failure. `act` groups get no suggested threshold. A decision is left unresolved when a later run reused its `adw_id` (a `:feedback` revision or a blocked-to-ready re-claim overwrites the session status; detected from the `adw` process rows) and, for `loop_control`, when a later decision in the same loop acted. Fan-out-lane `chain_router` and `intake_readiness` decisions have no session under their adw_id and stay unresolved. Replayed, superseded, unresolved, ambiguous, `not_permitted` and confidence-less rows are excluded and counted. An unknown `--kind` is refused with the list of known kinds.
- **Code**: `core/decision_calibration.ts` (pure), `core/decision_calibration_db.ts` (SELECT-only readers), `SfDb.allRecordedDecisions` / `SfDb.runFacts`, `cli/commands/decisions.ts`. A new decision kind must declare an outcome rule or a reason it has none (a test enforces this).

### Changed — the jev decision layer is now `decisions:` (#150)

Part 1 of #150 renames spf's `jev:` layer to a model-agnostic `decisions:` layer. The layer's behavior is unchanged (off by default, closed option sets, deterministic fallbacks, shadow/act); what changed is its names. Part 2 (an embedding backend) is separate. Operator docs moved from `docs/jev.md` to **`docs/decisions.md`**, which has a "Migrating from `jev:`" section.

- **Config**: `decisions: {enabled, mode, threshold, timeout_ms, backend: systemone, systemone: {provider, model, api_key_env, base_url, cloudflare, ollama}, kinds: {...}}`. `jev.provider/model/api_key_env/base_url/cloudflare/ollama` moved under `decisions.systemone.*`; `jev.decisions.<kind>` is `decisions.kinds.<kind>`; `enabled/mode/threshold/timeout_ms` keep their names. `systemone` merges key by key across config layers; `systemone.cloudflare`, `systemone.ollama` and `kinds` are whole-object replaces.
- **Back-compat**: a legacy `jev:` block is still accepted — it is rewritten onto `decisions:` per config layer at load time, so a base `jev:` and an override `decisions:` merge like any two layers — and `spf doctor` warns (`decisions config`: `jev: is deprecated; move it to decisions: ...`) without failing. Renaming the block in place is not enough: a `decisions:` block still carrying the old flat keys (`provider`, `model`, `api_key_env`, `base_url`, `cloudflare`, `ollama`, a nested `decisions:` map) is a config error naming where each key moved, never silently stripped (which would send an Ollama user's state to the hosted API and drop per-kind overrides). A single config layer carrying **both** `jev:` and `decisions:` is a config error naming both. A non-mapping `jev:` / `decisions:` value (`true`, `"on"`, a list) is a config error, not a silent disabled block; an empty `jev:` key is an empty block.
- **Trace (new rows)**: the decision event is `log`/`decision` (was `jev_decision`); its payload field `jev_choice` is `model_choice`, and rows gain `backend` (`systemone`) and `provider` (`typesafe | cloudflare | ollama`); `model` is the concrete model id. The finding-triage outcome event `jev_triage` is `decision_triage`.
- **Trace (old rows)**: nothing is migrated. Every reader (`findRecordedDecision`/`listRecordedDecisions` replay, the dashboard's `SfDb.recordedDecisions`, `spf estimate --replay-risk`) accepts both event names (`DECISION_EVENT_NAMES`) and reads `jev_choice` as `model_choice` (`model_choice` wins when both are present); a reader of triage rows accepts both `FINDING_TRIAGE_EVENT_NAMES`. Old `jev_decision` rows replay to the same effective choice as their modern twins.
- **Other renamed persisted / machine-readable contracts** (no legacy alias — nothing in this repo reads them back, and rows already recorded keep the old spelling): the `tiering` event payload's `jev` summary is `risk_decision` (its inner `jev_choice` is `model_choice`); a `chain_edge` event's `via: "jev"` is `via: "decisions"`; `spf estimate --json` `risk_source.jev` is `risk_source.decision`; the JSONL twin of watch-intake decisions is `<data_dir>/watch/decision_events.jsonl` (was `watch/jev_events.jsonl`); the finding-triage section appended to a fixer's notes reads `## Deprioritized by the decision model` (was `## Deprioritized by jev`); a `loop_control` stop reads "the decision model judged the loop blocked". The `spf estimate` text line reads `risk from  recorded decision` (was `recorded jev decision`).
- **`spf doctor` check names**: `jev` is `decisions`; `jev api key` is `decisions api key`; `jev base_url` is `decisions base_url`; `jev timeout_ms` is `decisions timeout_ms`; `jev.ollama.base_url` is `decisions.systemone.ollama.base_url`; `jev ollama version` / `jev ollama model` / `jev ollama reachability` are `decisions ollama version` / `decisions ollama model` / `decisions ollama reachability`; `jev decision "<kind>"` is `decisions kind "<kind>"`; `jev.loop` is `decisions.loop`.
- **Code**: `core/jev.ts` is `core/decisions.ts`, `core/jev_kinds.ts` is `core/decision_kinds.ts`, `createJev`/`Jev` are `createDecider`/`Decider`, `run.jev` is `run.decider`, `HttpJevClient` is `HttpSystemOneClient`, `setJevClientFactory` is `setDecisionClientFactory`, `WatchDeps.intakeJev` is `intakeDecider`, and `src/test/fake_jev.ts` is `fake_decisions.ts`.

### Fixed — `diffMatchesClaims` rejected every deleted file

A builder that deletes files must list them in `changed_files`, but the gate required each claimed path to exist on disk, so any deletion failed the build ("claimed changed file does not exist") — observed on briefs-finance/mobile#84, a refactor deleting a route group, which failed after a 63-minute build on all 9 deleted files.

- **`core/gates.ts`**: a claimed path absent on disk now passes iff git confirms it was a tracked file at the run's base (`git cat-file -t <base>:<path>` is `blob`), reported as `deleted (tracked at base <short sha>)`. The base is HEAD's merge-base with `origin/<watch.base_branch>` (else the local branch; default `main`). Never-tracked paths, directories, paths outside the repo and prose (with its "looks like a summary sentence" hint) still fail; with no git or no resolvable base the old behavior (fail) is kept.
- A builder's exact trailing ` (deleted|added|modified|renamed)` annotation is stripped before resolving and cross-checked (`(deleted)` on an existing file, `(added|modified)` on an absent one, fail). Any other parenthetical stays prose.

### Fixed — github-projects: a `<prefix>:refined` issue moved to Ready is claimed, not shadowed

Label-only states shadow the board Status in `deriveState()`, so a refine-lane leaf (`<prefix>:refined`) that a human promoted by moving its card to the Ready column was never claimed — and nothing was logged (observed: 954 silent ticks).

- **`core/issues/github_projects_provider.ts`**: `<prefix>:refined` + board Status mapped to `ready` now derives `ready` (the board wins for that one explicit-promotion pair); the stale `refined` label is removed best-effort on the board scan (one attempt per issue per process, never throws) and always on `claim()`. Every other label-only state (`spec-ready`, `refining`, `split-proposed`, `feedback`, ...) still shadows the board.
- A label-only state label that shadows a Status mapped to a DIFFERENT build-lane state now logs a one-time warning naming the issue, label and Status, so a silently-ignored card move can't recur.
- README and `assets/skill/references/config.md`: promoting a refined leaf on a github-projects board means moving the card to the Ready column.

### Fixed — `spf watch` loses finished work to a missing result line, a network blip, or any failure

Three production failure modes (v0.24.0, `issue_provider: github-projects`, `claude_code` through `ollama launch`), each fixed at its cause.

- **`core/agent_cc.ts`**: a `claude` turn that ends WITHOUT a stream-json `result` line (exit 0 or not — seen 5/5 failures since 2026-10-01, once after the builder had finished everything) is no longer fatal. `run()` now resumes the SAME session (`--resume <session_id>`, same model/cmd/env/flags, a prompt telling it to emit its final answer without redoing work) up to `NO_RESULT_RESUMES` (2, exported; override with `SPF_CLAUDE_NO_RESULT_RESUMES`) times before throwing. The spawn-and-collect half moved into a private `runOnce`. Not resumed: spawn failures, `is_error` results, and runs that streamed nothing (a launch problem a resume would only repeat). Failed attempts' assistant usage is added to the `UsageBreakdown` so tokens aren't under-counted; the `ollama launch` `--` separator is applied to resumes too.
- **`core/retry.ts`** (new): `isTransientError` (undici `fetch failed`, `ECONNRESET`/`ETIMEDOUT`/`ENOTFOUND`/`EAI_AGAIN`/`UND_ERR_*` on the error or its `cause`, `git push` network messages, HTTP 5xx and 429) and `withRetry` (4 tries, 1s/3s/9s, injectable `sleep`). `HttpError` carries `.status`.
- **`core/issues/{github,bitbucket,jira}_provider.ts`**: REST failures now throw `HttpError` (same message text as before, plus `.status`). **`core/issues/provider.ts`**: new optional `CodeHostProvider.findOpenPr(branch)`, implemented for GitHub (`GET /pulls?head=owner:branch&state=open`) and Bitbucket (PR list filtered by source branch).
- **`core/watch.ts`**: landing a SUCCESSFUL chain (push, open PR, comment, marker, transition) is retried with backoff, and PR creation is idempotent — `findOpenPr` runs inside every attempt, so a PR whose creation succeeded server-side but failed client-side is adopted, not duplicated. If a transient failure outlasts the retries, the issue is NOT blocked and the chain is NOT rerun: a new `WatchMarker.landing` records the already-built PR title/body/branch, the issue stays `working`, and the next tick's `reconcileOrphans` calls `retryLanding` (push again if the worktree is still there, open-or-adopt the PR, clear `landing`). After `MAX_LANDING_TRIES` (10) failed ticks it finally blocks, naming the branch. Non-transient errors (4xx) still block immediately. Same behaviour in the fan-out lane.
- **`core/watch.ts`**, **`core/git_helper.ts`**: a failed chain run (rejected, or a throw after the worktree exists) now calls `preserveWork` before cleanup: it commits any uncommitted changes and pushes the branch to `<branch>-wip` (`GitHandle.push` gained `{ remoteBranch, forceWithLease }`), then names that branch in the blocked comment and the `issue_blocked` notify (`wip_branch` field). Best-effort and never throws, so it cannot mask the original error. Nothing is pushed when the run left no commits.
- **`core/watch.ts`**, **`core/git_helper.ts`**: landing, `retryLanding` and the `-wip` preservation push now push the worktree's actual HEAD (`git push origin HEAD:refs/heads/<expected>`, via new `pushWorktreeHead`) instead of the expected local branch by name. Observed on issue #72: the agent ran `git checkout -b feat/...` in the worktree, the commit landed there, the expected `spf-watch/...` branch still pointed at the base, and `openPr` 422'd "No commits between" on a fully green run. Before pushing, HEAD must descend from the run's diff base (new `GitHandle.isAncestor`, `merge-base --is-ancestor`); otherwise the issue is blocked with an explicit, non-retried message and nothing is pushed (never force-pushed). A warning is logged when the checked-out branch differs from the expected one. `GitHandle.push` no longer sets an upstream (`-u`).

### Added — `issue_provider: github-projects`: a GitHub Projects v2 board as the state machine

- **`core/issues/github_projects_provider.ts`** (new, `GitHubProjectsProvider extends GitHubProvider`), **`core/data_types.ts`** (`WatchIssueProviderSchema` widened, new `GithubProjectsStatusMapSchema`/`WatchGithubProjectsConfigSchema` at `watch.github_projects`): a third tracker, where a GitHub Projects v2 board's "Status" single-select field — not `<prefix>:<state>` labels — drives intake and transitions. Distinct from the existing `watch.github.status_map` (an optional, write-only, best-effort label-to-board mirror on `issue_provider: "github"`, unchanged): here the board **is** the tracker of record, so a Status write failure on a mapped state throws (surfacing as a `watch_error`, retried next tick) rather than being logged and swallowed.
- Only the build lane's five states (`ready`/`working`/`review`/`done`/`blocked`) are required on the board; every other `WatchState` (the build lane's `feedback`, the refine lane's `spec-ready`/`spec-in-progress`, and its internal bookkeeping states) stays a real label unless deliberately mapped too — `watch.github_projects.status_map` covers all fourteen, each optional except those five. A label-only state's real label SHADOWS the board, so `core/watch.ts`'s direct `Issue.labels` reads (`rollUp`/`frontierBlockedOn`/`finishTrackedSpecs`) keep working unmodified: the provider projects the board's derived state back into `Issue.labels` as a synthetic entry on every `Issue` it returns.
- Draft items (no backing repo issue) and items from a repo other than `watch.repo`/`watch.issue_repo` are both skipped, logged. `spf` never creates or edits a Status option itself — `ensureLabels()` seeds only the type/priority/label-only-state labels; `validateBoard()` (read-only) is what `spf watch init` and `spf watch`'s own startup check run against the real board, refusing a missing required state, a misnamed option, a duplicate option name, or two states sharing one option.
- `cli/commands/watch.ts` (`resolveIssueProvider`'s new branch, both `instanceof`-gated validation blocks, the refine-lane provider gate), `core/refine.ts` (`resolveAuthoringProvider`'s new branch — load-bearing for a board-mapped `spec-ready` to ever be found again by the refine lane that created it), `cli/commands/doctor.ts` (new `watch.github_projects` + board/label-split checks; `GITHUB_TOKEN`'s message now states the `project` scope is mandatory for this provider, not optional), `cli/interview.ts` (`spf init`'s new tracker option and board prompts).
- `GITHUB_TOKEN` needs both `repo`/`public_repo` AND the `project` scope unconditionally (a classic PAT); a fine-grained PAT needs the organization-level "Projects" permission instead; `GITHUB_TOKEN` inside GitHub Actions cannot reach Projects v2 at all. See the README's "GitHub Projects v2" section for the full model, config shape, and limitations (single repo, no draft items, a claim's compare-and-set is not truly atomic).

### Added — Jev through a local Ollama

- **`jev.provider: ollama`** routes Jev decisions to a local Ollama (>= 0.35)
  serving TypeSafe's System One API directly at `{jev.ollama.base_url}
  /systemone` (default `http://localhost:11434/v1`, model `nimble`; `tev1`
  and `tev1:0.8b` are also available). Same request/response shape as
  TypeSafe, no credentials, no network beyond localhost. `HttpJevClient`
  gained an optional `apiKey: null` (no `Authorization` header) and
  `enforceOllamaLimits` rather than a new client class.
- Ollama enforces its own, stricter wire limits — a 64 KiB request body and
  2–26 options per question (TypeSafe allows 255/2–10) — checked against
  the actual serialized request before any network call; an oversized or
  over-optioned request throws, so `decide()` resolves to the fallback with
  `reason: "error"` and never reaches the wire.
- `spf doctor` reports the resolved endpoint and model, warns when
  `jev.timeout_ms` is under 5000ms (Ollama's first call after a model load
  can be slow), and — since this is the one Jev provider local and free to
  probe — makes two live, never-failing checks: `GET /api/version` (warns
  below 0.35.0 or if unreachable) and `GET /api/tags` (warns if the
  configured model was never `ollama pull`ed), gated on `--no-probe` like
  every other live probe. No "jev api key" check is shown: Ollama has no
  credentials to be missing.
- See `docs/decisions.md`'s "System One providers" section (formerly `docs/jev.md`).

### Added — Jev through Cloudflare Workers AI / AI Gateway

- **`jev.provider: cloudflare`** routes Jev decisions through Workers AI
  (`typesafe/jev`), or through an AI Gateway when `jev.cloudflare.gateway`
  is set. By default it uses spf's existing `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`. The request body and answers match TypeSafe's
  API, so every decision kind works unchanged on either provider. The
  default stays `provider: typesafe`.
- `spf doctor` reports the provider and the resolved endpoint, and warns
  about each missing credential env var by name.
- The TypeSafe client's wire format is now checked against the live API
  (model ids, 0-based score levels, a `noul` answer without confidence). See
  `docs/decisions.md`.

### Added — `watch.allowed_authors`: an explicit issue-author allowlist, separate from the label gate

- **`core/data_types.ts`** (`WatchConfigSchema.allowed_authors`), **`core/issues/provider.ts`** (`Issue.author`), **`core/watch.ts`** (`authorBlocked`/`rejectDisallowedAuthor`, wired into both `claimNewWork` and `claimSpecs`): on a tracker that accepts public issues, `<prefix>:ready`/`<prefix>:spec-ready` being a label-write-gated action does not mean the ISSUE CONTENT is trusted — anyone can open an issue and write whatever they want in its body, and a collaborator who labels a plausible-looking public issue without catching an embedded instruction hands that body to a coding agent with real Bash/write access as if it were vetted input. `watch.allowed_authors` is a second, independent gate: empty (the default, and every existing config's behavior, unchanged) is unrestricted; a non-empty list refuses any issue whose ORIGINAL author (`Issue.author` — GitHub's `user.login`, Jira's `reporter.displayName`) isn't on it, transitioning straight to `blocked` with an explanation before a worktree, lock, or chain run ever exists for it. See the README's `watch.allowed_authors` section.
- `spf doctor` reports whether this is set.

### Added — Jev rails (off by default) — #103

- **`core/jev.ts`** (new): a typed client for TypeSafe's Jev
  ("System One") decision model built on global `fetch`, with no new
  dependency. It also adds one `Jev.decide()`/`decideBatch()` policy shared
  by every future decision kind. Jev only chooses from a closed option set
  that code builds. Every decision has a deterministic fallback, which is
  used when Jev is disabled, in shadow mode, or on a missing key, timeout,
  error, invalid answer, or low confidence. `mode: shadow` (the default)
  records Jev's answer while the fallback acts.
- **`jev:` config block**: `enabled` (default `false`), `mode`, `model`,
  `threshold`, `timeout_ms`, `api_key_env` (default `TYPESAFE_API_KEY`),
  `base_url`, and per-kind `decisions.<kind>` overrides that can also carry
  a feature's own settings. Kinds are registered in `core/jev_kinds.ts`.
  `spf doctor` validates the block and warns when it is enabled without a
  key.
- **Trace**: each decision made while Jev is enabled is recorded as one
  `log`/`jev_decision` event. `findRecordedDecision()` lets a replay or
  estimate reuse it without calling Jev again. `run.jev` is wired to the
  run's trace.
- With no `jev:` block, runs behave exactly as before: no call and no trace
  event. See `docs/decisions.md`.
- **Replay and edges**: a replayed decision reuses the recorded answer and
  judges it again under today's policy and `permitted`, so a replay cannot
  act on a choice the caller no longer permits. `enabled: false` or a kind
  set to `off` wins over any replay. `isValidOptionSet()`/`optionSetProblem()`
  let a feature check a run-time option set before calling `decide()`. An
  empty `jev.decisions:` in YAML now means `{}`.

### Added — Jev decision kinds

<!-- One bullet per kind (feature ticket under epic #102), alphabetical by kind. -->

- **`chain_edge`** (#109): repo chains (`.spf/chains/*.yaml`) can declare
  transitions. A step can take an `id`, a `next:` list of step ids, a
  `default` edge and `max_visits`, and the file can set `max_steps`. At a
  step with more than one edge, Jev picks among those edges only. The
  fallback is the `default` edge, or the linear next step. The loader
  rejects a graph with a missing target, an unreachable step, an unbounded
  cycle, a default path over budget, a path that reaches any `commit`
  (including one only a Jev-picked edge reaches) while skipping a gate the
  default path runs, or a plain commit that only a Jev-picked edge
  reaches. Fan-out eligibility follows the default path. On a graph chain,
  `accepted` is the AND of every gating step's latest result. Transitions
  are traced as `chain_edge`/`chain_path` events and replay by key
  (`<step id>#<visit>`). Chains without `next:` run exactly as before.
- **`chain_router`** (#107): an optional `watch.chains` allowlist lets Jev
  route each claimed `spf watch` issue to one of the operator's chains,
  choosing from each chain's `describe`/`phases` text and the issue's
  title/body. The fallback is `watch.chain`. Under `watch.fanout.n > 1`,
  non-commit chains are filtered out in code before Jev is asked. When a
  decision is made, the chosen chain is logged; in `act` mode it is also
  posted on the issue and written into the PR body (shadow stays off the
  tracker). `core/watch.ts` re-checks every answer against the allowlist; a
  re-claim replays the recorded decision instead of re-asking
  (`jev.decisions.chain_router.replay`, default true); a `feedback`
  revision rebuilds with the chain recorded on the marker; an act-mode
  decision that cannot be traced runs in shadow. Unknown names fail
  `spf watch` startup and `spf doctor`. With no `watch.chains` or no `jev:`
  block, behavior is unchanged. See `docs/decisions.md`.
- **`diff_risk`** (#152): after a `simple_sdlc` run's suite is green and
  its review approved, and before the signoff and commit, the decision model
  answers seven keyed `touches | does_not_touch` questions over one shared,
  clipped diff: `auth`, `money`, `schema`, `data_loss`, `state`,
  `api_contract`, `secrets`, in one batched call. A code-owned path-glob and
  regex floor (`migrations/**`, `*.sql`, `.env*`, `auth/**`, secret-shaped
  strings, `DROP TABLE`, ...) is each question's fallback and reads the whole
  diff, including untracked files (up to 8 MiB each; larger ones are listed
  as unscanned, path still checked). A flag is the floor OR the model's
  `touches`; a model answer never removes a flag. Flags map through a
  code-owned table to a `risk:<key>` label and `require_human_signoff`, ORed
  into `review.require_human_signoff` (never turned off) so an unattended run
  fails closed before `commit_build`. Shadow records the flags and what act
  would add without applying anything; with no `decisions:` block the kind
  is a total no-op, floor included. A clipped diff is reported in the model's
  state, the outcome and the `decision_diff_risk` event. A diff git cannot
  read, or a phase that throws, fails closed in act mode (signoff required)
  rather than skipping the floor. The model's state is redacted (secret
  shapes replaced, secret-path files by name only). Labels are recorded in
  the trace and signoff log, not pushed to a PR (no PR-label call exists on
  the code hosts yet). **Upgrade note:** the global `decisions.mode` default
  is `shadow`, so an existing `decisions: enabled: true` config (for another
  kind) now runs `diff_risk` in shadow, which sends the clipped diff to the
  configured backend on every `simple-sdlc` run; set
  `decisions.kinds.diff_risk.mode: off` to opt out. **Act mode under
  `spf watch`/`fanout`/`loop` blocks the run** (those dispatches are
  unattended, so a flagged diff throws a typed `SignoffRequiredError` before
  `commit_build`): no PR is opened. `spf watch` still preserves the unfinished
  tree on `<branch>-wip` like any failed run, except when `secrets` was
  flagged or the diff could not be read, in which case nothing is committed
  or pushed. `spf loop` treats it as terminal (`blocked`) and does not
  re-run; `spf fanout` attempts fail independently. Use shadow for
  unattended pipelines. The secrets floor also covers `.npmrc`, `.envrc`,
  `.netrc`, `.pypirc`, `.aws/credentials`, kubeconfig and `*.tfvars`, and
  unquoted `KEY=value` / YAML credentials, URL userinfo and npm tokens.
  `decisions.kinds.diff_risk.max_diff_chars` is a hard bound on the diff the
  model reads (headers and clip marks included; 0 sends the file list
  only). New `src/chains/diff_risk.ts` and `src/core/diff_risk.ts`. See
  `docs/decisions.md`.
- **`finding_triage`** (#106): before a rejected review's unmet findings
  reach the fixing agent (`reviseLoop` and `simple_sdlc`'s revise phase),
  Jev classifies each one `real | noise | style` in one batched call. In
  act mode, `noise`/`style` findings move out of the handoff's `findings`
  (and out of `blocking` when the text matches exactly) into a
  "Deprioritized by jev" section. With
  `jev.decisions.finding_triage.drop: noise | noise_and_style` they are
  withheld from the fixer instead, and still recorded in a `jev_triage`
  trace event. The verdict is never touched, and a round is never left
  with nothing to fix: when every unmet finding is demoted, `findings` and
  `blocking` pass through unchanged and only the notes change. The
  fallback is `real`, which is today's behavior. `fixLoop` suite output is
  not triaged. The ticket's `jev.triage.drop` is spelled
  `jev.decisions.finding_triage.drop`, like every kind's settings. Invalid
  `jev.decisions.<kind>` settings now fail `startRun`, before any phase,
  and `PhaseHandle` exposes `phase_id` for decisions made inside a phase.
- **`intake_feedback` / `intake_readiness`** (#108): Jev watch intake. The
  first classifies the new PR comments behind `<prefix>:feedback` as
  `revise`, `question`, `approve`, or `out_of_scope`. Only `revise` reruns
  the chain, `question` posts an acknowledgement, and the others are
  logged. The fallback is `revise`. Re-adding `feedback` with no new PR
  comment is a human override: it revises with no Jev call. The second routes a `ready` issue
  before it is claimed, as `build`, `refine`, or `needs_human`. `refine`
  goes to `spec-ready` and is permitted only while `watch.refine.enabled`.
  `needs_human` goes to `blocked` with a needs-info comment. The fallback
  is `build`, and the router runs only once per issue. Both kinds are on
  at the global `jev.mode` once `jev.enabled` is true; each has its own
  `jev.decisions.<kind>.mode` toggle (`off` opts out). Decisions are traced under the
  issue's `issue-<id>` adw_id.
- **`loop_control`** (#105): after each failed, non-final round of
  `fixLoop`/`reviseLoop`, Jev chooses `continue | escalate_tier |
  stop_blocked` (fallback `continue`, today's loop). The configured `max`
  stays a hard ceiling. `stop_blocked` ends the loop not accepted.
  `escalate_tier` moves only the repairing role up one `tiering.tiers` rung,
  once per loop, never above `jev.decisions.loop_control.max_tier` (unset
  disables escalation; never for a `reviseLoop` whose reviewer is its
  builder), and is undone when the loop exits, `agent_map` entry included.
  Decision keys (`fix:test_1`, `fix#2:test_1`, ...) are unique within a run,
  a replay driver can reuse recorded decisions via `setLoopControlReplay`,
  the state sent to Jev is bounded, and `spf doctor` warns on a misplaced
  `jev.loop:` block. New `src/chains/loop_control.ts`; `tiering.usable` is
  now exported so the escalation check applies the same rung rule.
- **`risk_tier`** (#104): Jev can classify a run's tiering risk
  (`low | standard | high`) once in `startRun`. The fallback is the existing
  chain-weight + prompt-length heuristic. It is only asked when tiering is
  enabled. The pure `resolveTiering` takes the decision as data. The
  `tiering` trace event carries a `jev` summary. `jev.decisions.risk_tier`
  adds `max_risk` (a ceiling on escalation driven by Jev) and
  `max_prompt_chars`. `spf estimate` says where its risk came from, and
  `--replay-risk <adw_id>` reuses a recorded decision without calling Jev.
  A run resumed under the same `adw_id` and chain replays its own decision
  instead of asking again. When the kind is live, the head of the prompt
  (up to `max_prompt_chars`) is sent to Jev; `max_prompt_chars: 0` sends
  only the chain name and the heuristic's signals.

### Changed — OpenTelemetry: real SDK encoder, process-scoped metrics, outbound propagation

- **`core/otel.ts`**: the hand-rolled OTLP/HTTP-JSON span encoder is
  replaced with the real `@opentelemetry/sdk-trace-base` (`ReadableSpan`) +
  `@opentelemetry/exporter-trace-otlp-http` (`OTLPTraceExporter`) pipeline.
  The public API, the deterministic sha256 trace/span-id scheme, the
  attribute allowlist, the bounded queue, and the per-run lifecycle are all
  unchanged. Two verified wire-shape differences from the old encoder (see
  `otel.ts`'s header for the full list): `intValue` is now a JSON number,
  not a stringified one, and a root span's `parentSpanId` is omitted
  entirely rather than spelled out as `""`.
- **`core/otel_metrics.ts`** (new): a process-scoped OTel metrics pipeline
  (`@opentelemetry/sdk-metrics` + `exporter-metrics-otlp-http`), gated on
  the same `observability.otel.endpoint` as traces, plus a new
  `observability.otel.metrics` flag (default `true`) to opt out of metrics
  specifically. Five instruments: `spf.tokens`, `spf.cost_usd`,
  `spf.phase.duration`, `spf.gate.result`, `spf.agent.calls` — wired from the
  same `recordPhase`/`recordGate`/`closeAgentCall` seams the span exporter
  already used. The old "dropped spans as a resource attribute" hack is
  gone (a `Resource` is immutable per exporter instance in the real SDK);
  dropped-span/dropped-event counts now ride as real counters instead, when
  metrics are configured.
- **`core/otel_propagation.ts`** (new): outbound `traceparent`/`x-request-id`
  propagation for `coding_agent: flue`, via a real (if minimal) global
  `BasicTracerProvider` + `@opentelemetry/instrumentation-http`/`-undici` +
  a `CompositePropagator` (W3C TraceContext + a custom `x-request-id`
  propagator). Best-effort by design and documented as such — reaches any
  provider whose Node SDK issues requests through `http`/`undici`.
  **Update (#80):** flue's spans now JOIN SPF's deterministic trace instead
  of forming a separate one — via the instrumentation's per-span
  `resolveRootContext` option, backed by a session-id -> traceparent map
  `agent_flue.ts` registers around each run (`ctx.id` is flue's documented
  stable instance id, which SPF mints). This is per-span rather than a
  dispatch-time context wrap because flue's node runtime executes all
  submissions in ONE process-lifetime claim loop whose async context is
  captured once — a context wrap would silently mis-attribute every agent
  after the first into the first agent's trace (verified against
  `@flue/runtime`'s dist). Flue spans inherit the sha256 trace id per
  session, and the provider requests' wire `traceparent` carries it too —
  parity with the `claude_code` path. Unmapped sessions (backlog restarts,
  post-settlement stragglers) degrade to the old separate-trace behavior,
  never mis-attributed; the internal `executionContext.traceCarrier`
  escape hatch stays unused (not on the public dispatch surface).
  `installFluePropagation` also no longer latches `installed` before its
  fallible registrations, so a constructor-time failure is retried on the
  next call instead of permanently disabling the process.
- **`agent_cc.ts`**: `TRACEPARENT`/`ANTHROPIC_CUSTOM_HEADERS` are injected at
  the single `spawn()` choke point for `coding_agent: claude_code`, when
  `observability.otel` is configured — a real, verified guarantee (unlike
  the `flue` path above). `ANTHROPIC_CUSTOM_HEADERS`'s format (newline-
  separated `Name: Value` pairs) is verified against Claude Code's own docs
  (https://code.claude.com/docs/en/env-vars).
- **`agent_opencode.ts`**: outbound trace-context propagation for
  `coding_agent: opencode`, when `observability.otel` is configured —
  `TRACEPARENT` on the subprocess env (parity with `claude_code`;
  unverified whether the opencode CLI reads it) plus static
  `traceparent`/`x-request-id` provider headers
  (`provider.<id>.options.headers`, opencode's documented config surface)
  in the temp `opencode.json` this module already writes. Static is correct
  because one `opencode run` subprocess is exactly one agent call. A
  caller-provided `OPENCODE_CONFIG` is now MERGED into the temp config
  (SPF's own blocks win on conflict) instead of replaced outright —
  closing a regression class where enabling OTel or a `tools:` list on an
  already-configured workflow silently dropped the operator's provider
  routing/credentials config. Caveats (documented in the module's doc
  comment): a bare model id with no `provider/` prefix skips the headers,
  and a repo's own `opencode.json` merges at higher precedence and can
  override them.
- **`spf.lora_adapter`** span attribute (new): resolved from an explicit
  `agents[].lora_adapter` config override, else parsed from the model id
  (`provider/base:adapter`, or this org's `provider/adapter-name` `-lora-`
  served-model convention) — see `otel.ts`'s `loraAdapterFor()`.
- **`gen_ai.usage.cache_read.input_tokens`** (new): the semantic-convention
  twin of the existing `spf.tokens.cache_read` attribute, for the vLLM/
  OpenAI-compatible `usage.prompt_tokens_details.cached_tokens` pass-through
  (already end-to-end via `@earendil-works/pi-ai`'s OpenAI-completions
  adapter; requires the upstream vLLM server to run with
  `--enable-prompt-tokens-details`, off by default).
- **`observability.otel.allow_env`** (new, default `false`): when `true` AND
  the block is ALREADY active (`endpoint` set), the standard
  `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` env vars may
  SUPPLEMENT it — never activate it from nothing, and config always wins on
  conflict. `observability.otel`'s EXPLICIT CONFIG ONLY invariant is
  otherwise unchanged.
- New dependencies (all exact-pinned, versions current as of this change):
  `@opentelemetry/api`, `@opentelemetry/core`, `@opentelemetry/resources`,
  `@opentelemetry/semantic-conventions`, `@opentelemetry/sdk-trace-base`,
  `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/otlp-transformer`
  (used directly, for `JsonTraceSerializer` — see `otel.ts`'s `pendingJson`),
  `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http`,
  `@opentelemetry/instrumentation`, `@opentelemetry/instrumentation-http`,
  `@opentelemetry/instrumentation-undici`, `@opentelemetry/context-async-hooks`,
  `@flue/opentelemetry`.
- `.npmrc` (new, then REMOVED again — see the **Update (#81)** below):
  `legacy-peer-deps=true` — `@flue/opentelemetry@2.0.4` publishes a
  `peerDependencies` entry of `@flue/runtime: "workspace:^"`, an
  unrewritten workspace-protocol range that breaks plain `npm ci`/
  `npm install` with `EUNSUPPORTEDPROTOCOL` otherwise.
  **Update (#81):** `@flue/opentelemetry@2.0.5` (shipped 2026-09-11)
  rewrites the peer range properly (`@flue/runtime: "^2.0.5"`), so both
  flue packages are bumped to exact-pinned `2.0.5` and the `.npmrc`
  workaround is deleted — plain `npm ci` with npm's default peer
  resolution is the verified acceptance path. `@flue/runtime`'s public
  types (`dist/index.d.mts`) are byte-identical between 2.0.3 and 2.0.5,
  and 2.0.5's `builtin-providers` chunk still carries the process-lifetime
  `claimLoop()` the flue trace-unification design (#80) is built around —
  so no code change rides along with the bump.

Not part of this change (explicit owner decision): no Briefs-specific model
provider, and no `BRIEFS_*` env var — this was OTel-extension work only.

### Added — watch: `<prefix>:feedback` revision loop for the build lane

- **`core/issues/provider.ts`**: a new `WatchState` value, `feedback` — the
  build lane's own human-in-the-loop label, modeled on the refine lane's
  `needs-feedback`/`continue-refinement` pair but sourcing corrections from
  **PR comments**, not issue comments. A new optional
  `CodeHostProvider.listPrComments(pr)` seam (`PrComment[]`, oldest-first),
  implemented for both `github_provider.ts` (merging issue comments, inline
  review comments, and review verdicts into one thread, paginated up to 500
  comments) and `bitbucket_provider.ts` (its first paginated endpoint). A new
  `WatchMarker.revision` field (`{rounds, since}`) tracks how many times an
  issue has been pushed and when, both for prompt-splitting and for the
  branch-naming fix below.
- **`core/watch.ts`**: `claimFeedback` (new) claims `feedback -> working` and
  reruns the issue via `runIssueSingle(deps, issue, {revision: true})`. If
  the recorded PR is still open, it rebuilds from that PR's own branch head
  and pushes onto it in place — same PR, a new commit, no new PR number. If
  the PR was closed/declined, it opens a fresh `-rN`-suffixed branch and a
  new PR whose body notes it supersedes the old one. `buildIssuePrompt` (new,
  exported, pure) folds the PR's comment thread into the prompt, splitting
  "corrections to address" from "earlier review discussion" on
  `WatchMarker.revision.since` — the same truncation/omission-count rule as
  the refine lane's `buildSpecPrompt`. Wired into `tick()` right before
  `claimNewWork`, sharing the build lane's own `concurrency` budget rather
  than a separate one.
- **Fixes a live bug**: relabeling a `blocked` issue (a declined PR) back to
  `ready` used to always rebuild on the SAME un-suffixed branch name, which
  the remote still held commits under from the earlier push — a guaranteed
  `git push -u` non-fast-forward rejection. `branchNameFor(issue, round)`
  now suffixes `-rN` whenever `runIssueSingle` sees a prior push recorded in
  the marker, whether or not the reclaim goes through `feedback`.
- **`core/notify/channel.ts`**: a new `NotifyKind`, `pr_updated`, fired at
  `notice` level (the same `attention`-scope bucket as `pr_opened`) when a
  revision lands on an existing PR instead of opening a new one.
- Labels: `feedback` added to both providers' `STATES` (seeded by
  `spf watch init` — re-run it after upgrading). Deliberately NOT added to
  `JiraStatusMapSchema`/`GithubStatusMapSchema` — same reasoning as
  `needs-feedback`: board-visible states only.
