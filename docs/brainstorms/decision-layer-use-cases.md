# Decision-layer use cases

**Date:** 2026-10-20 · **Context:** epic #102 closed; the layer is being renamed to model-agnostic `decisions:` with System One and embedding backends (#150).

**Method:** four readers mapped the [`jev-use-cases` resource pack](#appendix-the-jev-use-cases-pack) and piquette's current decision seams. Five ideators, one per lens (runtime, watch/ops, porting the pack, model fit, contrarian), produced 45 ideas. An opus adversarial judge merged duplicates, spot-checked the cited seams against the code, and tried to kill each idea: 14 survived and 16 were killed.

Every survivor must keep the #102 invariants: off by default, closed option sets built by code, a deterministic fallback, shadow mode before act mode, and gates that can only be added.

## Cross-cutting themes

- Outcome join and calibration come first: nearly every survivor ships shadow-only and has no path to act mode until decision rows are joined to observable outcomes (PR merged or closed, rounds used, human relabel). Rank 1 unblocks ranks 2-7.
- The #150 embedding backend is a shared dependency for duplicate check, exemplar routing, lesson dedup and finding clustering. It needs margin-based confidence, option-vector caching per (model, text), and per-kind thresholds, because embedding scores are not portable. No embed code exists in the decision rails today.
- Ollama has no noul. Every 'score per risk or criterion' idea really becomes a per-key binary choice through decideBatch, the finding_triage pattern. A shared multi-key batch helper with 64 KiB chunking would serve diff_risk, refine_leaf, the coverage gate and rule checks.
- The 2-26 option cap forces a retrieve-then-judge pipeline (lexical or embedding prefilter, then a small choice) for duplicates, lessons, skills and routing. Build one prefilter utility.
- State redaction and clipping (hook stderr, PR comments, tool tails) is needed by several kinds. One redaction pass shared with the trace db rules beats doing it per kind.
- Several ideas depend on unbuilt features (#34 reviewPanel, #100 lessons, #125 push routing). Sequence decision kinds after their host feature and do not build hosts speculatively.
- Seam spot-checks: fanout.ts:181/228, loop.ts:273, retry.ts:29-47, watch.ts:85/93, gates.ts:142, quality.ts:34 and routeReadiness (watch.ts:2091) are accurate. The notifier path (src/core/notify/notifier.ts) and the buildIssuePrompt location (watch.ts:1007) were wrong in the proposals.

## Shortlist

| # | Tier | Effort | Shape | Use case |
|---|---|---|---|---|
| 1 | do-next | M | score | Shadow-decision calibration report (piquette decisions calibrate), deterministic outcome join (#151) |
| 2 | do-next | M | choice | diff_risk: post-diff risk flags that can only ADD a human signoff or label (#152) |
| 3 | worth-it | S | choice | fanout_winner: tiebreak only among gate-equal fan-out attempts (#153) |
| 4 | worth-it | S | choice | pr_close_reason: log-only label for PRs closed unmerged (#154) |
| 5 | worth-it | M | embedding-similarity | intake_duplicate: retrieve-then-confirm duplicate check before claim (#155) |
| 6 | worth-it | S | choice | intake_screen: agent-directed instruction tripwire on issue bodies and PR feedback (#156) |
| 7 | worth-it | M | choice | Backend cascade: tev1:0.8b -> nimble -> jev on low confidence (#157) |
| 8 | later | M | choice | refine_leaf_workable: batched gate on decomposition leaves before they become ready |
| 9 | later | S | choice | landing_failure_stop: stop landing and orphan retries early on deterministic failures |
| 10 | later | L | choice | Acceptance and spec coverage gate (per-criterion, add-rejection only) |
| 11 | later | M | embedding-similarity | Outcome-backed exemplar routing as a first stage for chain_router |
| 12 | later | M | embedding-similarity | Lesson dedup and recall over the #100 lesson store |
| 13 | later | M | embedding-similarity | Cross-persona finding clustering (finding_triage extension) |
| 14 | later | L | choice | Sandbox rule-enforcer PreToolUse hook (deny or warn only) |

## Do next

### 1. Shadow-decision calibration report (piquette decisions calibrate), deterministic outcome join (#151)

- **Where:** New CLI under src/cli/commands/ (no decisions/calibrate command exists today). Reads jev_decision log rows written by traceDecisionRecorder (src/core/jev.ts:1045) from the trace db (src/core/trace_db.ts / sqlite.ts) and joins them to outcomes code can observe: PR merged or closed, review rounds used, blocked then relabeled by a human, fanout winner merged.
- **Question:** No model call. For each (kind, backend, model), how did confidence relate to an observable outcome, and which threshold reaches a target precision?
- **Shape / options:** `score`. No options. Outcome labels are built in code per kind: risk_tier vs escalate_tier or a review failure; intake_readiness/intake_feedback vs a later human relabel; chain_router vs the run being accepted; loop_control stop vs eventual merge. Output: agree and would_act rates, a reliability table, and a suggested threshold per (kind, model).
- **Fallback:** Fewer than N labelled rows: report 'insufficient' and leave thresholds alone. Read-only. It suggests thresholds and never writes config.
- **Model fit:** No runtime model. It makes backends comparable (jev hosted, nimble, tev1:0.8b, and embedding margins once #150 lands) using recorded rows only. The proposal to use an LLM to judge 'model_better vs fallback_better' was dropped as circular.
- **Value:** Every other idea here ships shadow-first and needs this before switching to act. It replaces the global 0.7 default and manual SQL with measured per-kind numbers, and it gives the evidence to delete kinds that never beat their heuristic.
- **Risk:** Outcome proxies are noisy and samples are small. Require minimum counts and show intervals. Tests use fixture rows only.
- **Effort:** M
- **Why it survived:** It is infrastructure, not a decision kind, so the invariants cannot be broken. The gap it fills is real and documented (non-portable thresholds, no calibration tooling). Several of the 45 ideas assumed it exists. The LLM-labeler half was cut.
- **Merged from:** Recorded-decision calibration report and per-kind threshold fitting (offline eval); outcome_labeler: back-fill ground truth for shadow decisions and calibrate thresholds

### 2. diff_risk: post-diff risk flags that can only ADD a human signoff or label (#152)

- **Where:** A new kind run once after the commit step and before push/PR. It is consumed where review settings are resolved: review.require_human_signoff already exists (src/core/data_types.ts:1660, src/core/agents.ts:274). It uses the per-key batch pattern of src/chains/finding_triage.ts. The persona-selection part waits for #34, because steps.reviewPanel() does not exist yet.
- **Question:** Does this diff touch <risk>? Seven keyed questions over one shared diff state: auth, money, schema, data_loss, state, api_contract, secrets.
- **Shape / options:** `choice`. Per risk key: [touches, does_not_touch], batched in one call. Code maps hits to a closed action menu: add_label:<risk>, require_human_signoff=true, and later add_panel_persona:<name> from a code-owned risk-to-persona table. The model never names an action.
- **Fallback:** A deterministic path-glob and regex table (migrations/**, *.sql, .env*, auth/**, secret-shaped strings) sets the same flags. The model can only add flags on top of the glob result. It never removes a flag, never turns signoff off, and never cuts review rounds. The 'drop personas to save cost' mode was cut because it reduces review.
- **Model fit:** nimble 9B local as the default, using a per-key choice because Ollama has no noul. Jev hosted when calibrated probabilities are wanted. tev1:0.8b only for the obvious keys (secrets, schema) and only after shadow agreement, since 'money logic in util.ts' is the case globs miss and it needs actual reading. embeddinggemma is a poor fit.
- **Value:** Sends human attention to the risky PRs using a signoff mechanism that already exists. Unlike risk_tier, which classifies the prompt before the run, this classifies the diff that was actually produced. It is the first piquette use of a multi-key risk batch.
- **Risk:** Over-flagging: the pack's 0.2 threshold flags almost everything, so set a per-kind threshold from the calibration report and watch the hit rate in shadow. Diff truncation can hide a risky hunk, so state must say when it was clipped. It must only ever OR into require_human_signoff.
- **Effort:** M
- **Why it survived:** Strictly additive and plugs into an existing human backstop. The closed key set comes from the pack. The deterministic glob floor makes the fallback meaningful. Distinct from risk_tier (pre-run vs post-diff) and from the unbuilt #34.
- **Merged from:** Diff-risk flags that only add human review or extra gates; review_escalation: 7-risk pre-review pass that can only ADD review (port of adversarial-loop triage); Review-panel persona selection with path-glob floor

## Worth it

### 3. fanout_winner: tiebreak only among gate-equal fan-out attempts (#153)

- **Where:** src/core/fanout.ts:181 compareAttempts, applied at fanout.ts:228 (succeeded.sort(compareAttempts)). Verified.
- **Question:** These attempts passed the same gates. Which diff addresses the issue with the smallest, most reviewable change?
- **Shape / options:** `choice`. The adw_ids of succeeded attempts tied on (status, gate_failures, gate_passes), computed by code. With fewer than 2 in the tie group, no call is made. Option descriptions are diffstat, file list and reviewer summary, not agent prose. Option order is shuffled with a seed derived from the adw_ids so replay is stable.
- **Fallback:** The existing lexicographic order (cost, tokens, wall_ms, adw_id). Any non-answer, or shadow mode, keeps that order.
- **Model fit:** Jev hosted for several diff summaries, nimble 9B for 2-3 small attempts. tev1:0.8b and embeddings do not fit.
- **Value:** Today a tie goes to the cheapest attempt, which often means the laziest one. A better pick cuts revise rounds on the PR. At most one call per fan-out, and only when there is a tie.
- **Risk:** Bias toward verbose diffs and position bias. Ground truth only arrives when the PR merges, so join on 'winner merged without revise' in the calibration report before using act mode.
- **Effort:** S
- **Why it survived:** The seam was verified and the permitted set is limited to already-equal winners, so no gate can be bypassed. Cheap, and the choice set is closed and code-built.
- **Merged from:** Fanout winner tiebreak among gate-equal attempts; fanout_winner: tiebreak best-of-N attempts that tie on gates; fanout_winner: tiebreak among fan-out attempts that tie on every hard criterion

### 4. pr_close_reason: log-only label for PRs closed unmerged (#154)

- **Where:** src/core/watch.ts:1364 finishReviews (verified), at the existing 'PR closed => blocked' branch. Writes a decision row, and optionally a tag on the blocked comment.
- **Question:** Judging by the closing comments and the last review, why was this PR closed without merging?
- **Shape / options:** `choice`. stale | wrong_approach | duplicate | out_of_scope | superseded | unknown. Static.
- **Fallback:** unknown. Tracker state is unchanged either way: the issue goes blocked exactly as it does today. There is no act path that changes state.
- **Model fit:** nimble 9B local, since the input is short comment text and nothing is latency-critical. Local by default so comment text stays on the machine. tev1:0.8b only as a shadow A/B.
- **Value:** Turns a dead end that is ignored today into labelled outcome data for the calibration report, for #100 lessons and for the #134-138 hub views. Volume is low and so is cost.
- **Risk:** Operators often close without a comment, so 'unknown' should dominate and the threshold should be high. Comment text needs clipping and must not be exported to OTel.
- **Effort:** S
- **Why it survived:** It cannot violate any invariant because it never acts. The seam is verified, the set is closed, and it is cheap. Its value grows with #100, which is why it is not ranked higher.
- **Merged from:** pr_closed_reason: classify why a PR was closed unmerged; pr_close_reason: classify why a PR was closed unmerged

### 5. intake_duplicate: retrieve-then-confirm duplicate check before claim (#155)

- **Where:** src/core/watch.ts claimNewWork (:2669), next to routeReadiness (:2091, verified), before the tracker claim(). It reuses intake_readiness's override: any marker plus a human relabel to ready means build.
- **Question:** Stage 1 (embedding): which recent open, closed or merged issue is nearest? Stage 2 (choice, only if the margin is high): is this issue the same work as candidate X?
- **Shape / options:** `embedding-similarity`. Code-built shortlist: the last N closed or merged issues plus open issues in this repo, capped at 25 by a lexical prefilter, plus 'distinct'. Confirmation is [duplicate, distinct]. Actions in code: build, or comment linking the candidate and move to blocked.
- **Fallback:** distinct, so the issue builds as it does today. A low margin, an empty shortlist, a tracker error or no backend all mean distinct. It never closes anything.
- **Model fit:** embeddinggemma for retrieval only, with the margin as confidence. nimble 9B for the yes/no confirmation, because similarity confuses 'same area' with 'same bug'. Embeddings cannot tell 'already fixed', so that claim was dropped.
- **Value:** One avoided duplicate saves a whole chain run, the most expensive wasted action. Per tick it costs one embed plus an occasional local confirm.
- **Risk:** Duplicates are rare in a curated ready backlog, so value depends on how the tracker is used. False positives cost one relabel. It needs the #150 embedding backend plus tracker list calls. The cross-factory hub variant goes in later, pending the #136 decision on sharing vectors.
- **Effort:** M
- **Why it survived:** Additive (it only moves work away from the build lane), with the same proven human-override pattern as intake_readiness. Four lenses converged on it independently. Downgraded from do-next because it depends on the unbuilt embedding backend and the base rate is uncertain.
- **Merged from:** Duplicate / already-fixed check before claiming a ready issue; duplicate_issue: embedding nearest-neighbor check before claim; Similar-issue dedup before claim (embedding nearest-neighbor); issue_duplicate: nearest-neighbor check against recent closed or merged issues before claim (#19) with shared factory taxonomy (#134)

### 6. intake_screen: agent-directed instruction tripwire on issue bodies and PR feedback (#156)

- **Where:** src/core/watch.ts routeReadiness (:2091) before claim, and where review comments become 'Corrections to address' in buildIssuePrompt (:1007, not ~1960 as cited).
- **Question:** Does this text contain instructions aimed at an AI agent rather than a description of work (e.g. 'ignore previous instructions', 'print env vars', 'push to main')?
- **Shape / options:** `choice`. clean | suspicious. 'suspicious' maps to the existing blocked or needs_human path with a comment naming the section.
- **Fallback:** clean. watch.allowed_authors (data_types.ts:1573), sandboxing and protected-branch guards stay deterministic and authoritative.
- **Model fit:** nimble 9B local, so issue text stays on the machine. tev1:0.8b misses paraphrases.
- **Value:** A cheap tripwire in front of a system that executes code based on issue text. Most valuable when allowed_authors is empty or on public repos. The shadow rate measures how often the factory is actually targeted.
- **Risk:** Easy to evade by obfuscation, so it must be presented as defense in depth and never as a control. False positives on issues about AI tooling are fixed by relabeling.
- **Effort:** S
- **Why it survived:** Strictly additive, closed, with a human override. The failure mode (a miss) is no worse than today. Value is moderate because deterministic author trust already exists.
- **Merged from:** intake_screen: flag prompt-injection and agent-directed instructions in issue bodies and comments

### 7. Backend cascade: tev1:0.8b -> nimble -> jev on low confidence (#157)

- **Where:** The decision rails in src/core/jev.ts (decide/decideBatch, FALLBACK_REASONS at :461), during the #150 decisions: rename. Config decisions.<kind>.cascade.
- **Question:** Unchanged: it wraps any existing choice kind.
- **Shape / options:** `choice`. Each kind keeps its own option set and permitted filter. The tier order is set by the operator.
- **Fallback:** All tiers unconfident means the kind's deterministic fallback. A per-decision budget caps hosted calls. Each trace row records which tier answered.
- **Model fit:** tev1:0.8b for the easy majority, nimble for the middle, hosted jev for the rest. It only works once per-tier thresholds exist, because a tiny model's raw confidence is not calibrated.
- **Value:** If most intake_feedback and chain_router calls resolve at the tiny tier, hosted spend and tail latency drop. It also collects agreement data between tiers.
- **Risk:** Overconfidence at the tiny tier on unusual input. Confidence is not comparable across tiers. Do not enable for kinds that act on the tracker until shadow agreement is proven.
- **Effort:** M
- **Why it survived:** Pure rails work that keeps every invariant, since decision-call spend is bounded and agent spend is untouched. Depends on rank 1 for thresholds, so it is not do-next.
- **Merged from:** Two-tier cascade: tev1:0.8b first, escalate to nimble then jev when unconfident

## Later (depends on unbuilt hosts or calibration)

### 8. refine_leaf_workable: batched gate on decomposition leaves before they become ready

- **Where:** src/core/refine.ts (exists), where decomposition leaves become <prefix>:ready issues, next to the existing sizing rules.
- **Question:** Can a build chain work on this leaf on its own: is it specific, small, and free of dependencies on unfinished siblings?
- **Shape / options:** `choice`. workable | too_big | too_vague | depends_on_sibling, one key per leaf by content hash, in one decideBatch call (the finding_triage pattern).
- **Fallback:** workable, so leaves are filed as today and code sizing still applies. A non-workable answer only files the leaf as spec-ready or blocked with a reason. It never promotes a leaf.
- **Model fit:** nimble 9B local. Jev hosted for large trees that exceed the 64 KiB Ollama body.
- **Value:** A bad leaf costs a full chain run plus a human unblock. Checking costs one batched call per refined epic.
- **Risk:** Over-rejection stalls epics, so in shadow compare against which leaves later blocked. The dependency judgment needs tree context in state.
- **Effort:** M
- **Why it survived:** Additive and closed, with a verified host module. Ranked later because refine volume is low and no outcome join exists yet.
- **Merged from:** refine_leaf_workable: score decomposition leaves before they are filed

### 9. landing_failure_stop: stop landing and orphan retries early on deterministic failures

- **Where:** src/core/retry.ts:40 isTransientError (TRANSIENT_CODES :29 and TRANSIENT_MESSAGE :31 verified), the landing loop under MAX_LANDING_TRIES=10 (watch.ts:93), and MAX_ORPHAN_ATTEMPTS=2 (watch.ts:85).
- **Question:** For error text the regexes did not classify: will another automatic retry plausibly succeed?
- **Shape / options:** `choice`. retry_next_tick | block_now. Asked only on text that neither the status codes nor the extended regexes classified. At the ceiling, code blocks without asking. (One proposal had this permitted logic inverted.)
- **Fallback:** The existing isTransientError result and ceilings, unchanged.
- **Model fit:** nimble 9B, or tev1:0.8b if shadow agreement holds, on the last 1500 characters of redacted error text.
- **Value:** Saves up to 8 pointless landing attempts per stuck issue and surfaces the human sooner. Value is modest, since most of these cases can be handled by better regexes and status codes.
- **Risk:** Stopping early on a flaky but recoverable failure costs one relabel. Hook output can contain secrets, so redact it.
- **Effort:** S
- **Why it survived:** Only the stop-sooner half survived. The 'route hook failures to fixLoop' half adds agent spend compared with today's block, which breaks the additive rule. #125 should make that a deterministic code path, with the model at most vetoing it toward block. Extend the regexes first, and add the model only for the unclassified remainder.
- **Merged from:** Opaque error text classification for push/PR and landing retries (can only fail sooner); push_failure_class: route push-hook failures (#125) to fix loop vs block; blocked_triage: stop landing/orphan retries early; Cheap push-hook and landing failure classifier routing to fixLoop vs block

### 10. Acceptance and spec coverage gate (per-criterion, add-rejection only)

- **Where:** An additive gate next to verdictConsistent (src/core/gates.ts:142, verified), fed into fixLoop as an added finding.
- **Question:** For each criterion or spec rule extracted by code: does the diff (or the test excerpt) implement or cover it?
- **Shape / options:** `choice`. Per key c0..cN or r0..rN: [covered, not_covered], chunked to fit 64 KiB. Gate outcomes: no_opinion or add_finding(ids). There is no scope-creep key, because 'unrelated changes' cannot be told apart from necessary refactors.
- **Fallback:** no_opinion. With no bullets extracted, the call is skipped. At most one decision-driven rejection per run, and it never lowers fixRetries.
- **Model fit:** Jev hosted. nimble 9B with small chunks is shaky for judging 'implements'. Embeddings only to retrieve test files. tev1:0.8b does not fit.
- **Value:** Catches clear misses before review spend. The reviewer agent already judges acceptance, so the gain is earlier detection, not replaced work.
- **Risk:** False rejections stall good work, and both criteria extraction and lexical test retrieval are weak. Shadow only, with a high threshold.
- **Effort:** L
- **Why it survived:** Additive and closed, with a verified seam. Ranked low because confidence that a 9B can judge it is low and it overlaps with the reviewer.
- **Merged from:** Quality-gate 'diff addresses the issue' and scope-creep additive reject; spec_coverage gate: per-rule 'is there a test' check in qualityCheck (port of spec judge)

### 11. Outcome-backed exemplar routing as a first stage for chain_router

- **Where:** src/core/chain_router.ts and makeWatchChainRouter (cli/commands/watch.ts). A first stage before the existing hosted chain_router.
- **Question:** Which chain's past accepted issues is this issue nearest to?
- **Shape / options:** `embedding-similarity`. The existing operator chain menu. Each chain is represented by up to K exemplars from merged runs, keyed to the chain-definition hash, or by its describe line when it has none.
- **Fallback:** Low margin hands off to the existing chain_router choice, then to watch.chain. The allowlist recheck and replay on re-claim are unchanged.
- **Model fit:** embeddinggemma, with the margin as confidence and per-chain exemplar caps.
- **Value:** Faster routing that learns from outcomes, which addresses a weakness chain_router admits ('no learning from outcome').
- **Risk:** Biased toward chains with more history, and exemplars go stale. Needs a history that most installs do not have yet.
- **Effort:** M
- **Why it survived:** A real extension of an existing kind rather than a re-proposal. Depends on #150 embeddings and on accumulated outcomes.
- **Merged from:** Exemplar-similarity chain routing with outcome-backed exemplars

### 12. Lesson dedup and recall over the #100 lesson store

- **Where:** The #100 capture and prompt-build paths. No lesson code exists in src/ today.
- **Question:** Which stored lesson is this candidate a restatement of, and which stored lessons are relevant to this task?
- **Shape / options:** `embedding-similarity`. Lesson ids in the same scope plus 'new' (capture) or 'none' (recall).
- **Fallback:** An exact normalized-hash match, otherwise 'new' or 'none'. A match only links and bumps a recurrence counter. It never rewrites, deletes or auto-promotes.
- **Model fit:** embeddinggemma. Polarity flips ('always X' vs 'never X') embed close together, which is why it links and never merges.
- **Value:** Recurrence counts become the trigger for promotion, and prompts carry only the top-k lessons.
- **Risk:** Blocked by #100 and #150. Over-linking lessons that share vocabulary.
- **Effort:** M
- **Why it survived:** Good model fit and reversible, but it has no host until #100 ships.
- **Merged from:** Lesson dedup and scope via embedding nearest-neighbor; Lesson recall and dedup for the #100 learning loop; lesson_dedupe: cluster a candidate lesson against existing lessons (#100)

### 13. Cross-persona finding clustering (finding_triage extension)

- **Where:** src/chains/finding_triage.ts (exact sha256 fingerprints, verified). Needs #34 reviewPanel, which is not implemented.
- **Question:** Does this unmet finding restate an earlier finding in this round or the previous one?
- **Shape / options:** `embedding-similarity`. Fingerprints of other unmet findings above a high similarity floor, plus 'distinct'.
- **Fallback:** distinct. A merge only groups findings in the display, keeps both texts, and never changes the verdict.
- **Model fit:** embeddinggemma.
- **Value:** Matters only when several personas flag the same thing. With a single reviewer, duplicates are rare.
- **Risk:** Hiding a crucial difference. Mitigated by keeping both texts.
- **Effort:** M
- **Why it survived:** A real extension of finding_triage (paraphrases vs exact hashes), but its value depends on #34.
- **Merged from:** Cluster and dedup review findings across personas and rounds

### 14. Sandbox rule-enforcer PreToolUse hook (deny or warn only)

- **Where:** A hook piquette would install in the sandboxes it creates (src/core/sandbox*.ts), going through a 'piquette decide' subcommand.
- **Question:** Does this edit break rule R? Only rules whose path regex matches are asked.
- **Shape / options:** `choice`. Per matching rule: [breaks, ok]. Deny or warn text is built from the rule itself.
- **Fallback:** allow (no hook). A regex prefilter can deny without a model. The loop-guard counter lives in the trace db.
- **Model fit:** nimble for commit-diff rules. tev1:0.8b per edit only for trivially separable rules.
- **Value:** Moves violations from PR review to the moment of the edit.
- **Risk:** Network from inside the sandbox, latency on every edit, agents getting trapped by false positives. Effort L.
- **Effort:** L
- **Why it survived:** Additive (deny only), with closed per-rule options. Too costly and risky to do before the simpler kinds have shown calibration data.
- **Merged from:** Sandbox rule-enforcer hook: piquette installs a PreToolUse deny/warn gate from a repo rules file

## Killed

| Idea | Why |
|---|---|
| Per-finding pre-fix scope check (introduced | preexisting) | Mostly deterministic: code can check whether the cited path and line fall inside a diff hunk. The ambiguous remainder is already covered by finding_triage's noise class and its 'Deprioritized by jev' re-listing. |
| Semantic stuck detection / loop_stuck for piquette loop (3 variants) | Cheaper as deterministic code. 'The same failing check names across N attempts' and 'a sha seen before' (A/B/A/B oscillation) catch the churn cases. One proposal admits this. Add those rules to loop.ts:273 isStuck instead. |
| Context assembly pruning / tool_history_prune | Most of the gain comes from deterministic rules: keep the latest round, always keep failing-check output, and dedupe identical outputs. A 9B judging the relevance of build output risks dropping the line the fixer needs, and the value is modest at fewer than 3 rounds. |
| notify_collapse embedding dedup | Exact dedup on (kind, issue id, level) within a window is cheaper and safer. It also cited the wrong path: the file is src/core/notify/notifier.ts:30, not src/notify. |
| explore_rank file shortlist | A retrieval hint, not a decision. The agent's own grep is both the baseline and the fallback, and wrong hints mislead. The cited prompt seam is also wrong: buildIssuePrompt is at watch.ts:1007, not ~1960-2060. |
| skill_pick UserPromptSubmit hook | Duplicates the harness's native skill matching from SKILL.md descriptions. piquette agent runs are mostly single prompts, so a per-prompt hook adds latency with little gain. |
| browser_check chain step | A multi-step agentic navigation loop acting on live pages, not one closed decision. It belongs in a plugin outside the decision layer. |
| Port-or-not register | Not a use case and has no runtime decision. Kept as a cross-cutting theme and a docs note for #150. |
| Per-tool-call risk pre-flag with tev1:0.8b | It can only annotate (no deny), it sits on a hot path with a 150 ms budget, and the regex pre-check plus deterministic sandbox permissions cover the cases. A 0.8b model gives noise at volume. |
| Live per-line anomaly flag on the event stream | The proposal already computes identical-line hash counts in code, and that deterministic repeat counter is the detector. Calling a 0.8b model per window adds flapping and no signal. |
| spend_trajectory early stop | The proposal concedes that a median or percentile rule decides most cases. The model only breaks ties in a band where a deterministic two-phase-over-line rule is cheaper and auditable. |
| phase_stall classification (#147) | Bringing a kill forward by one tick is negligible. A deterministic silence timer plus OTel attributes gives #147 its visibility, and sending tool-output tails to a model is a secret-leak risk for little value. |
| lesson_scope (narrow-only scope choice) | The 'narrow only' rule needs a heuristic scope answer, and none exists. #100 has no lesson store yet. Premature, so revisit once #100 lands. |
| outcome_labeler LLM judge (model_better | fallback_better) | A model judging a model is circular. The deterministic outcome-join half was kept and merged into rank 1. |
| Fix-loop routing half of the push-hook classifier (fix_in_loop) | Sending a hook failure into the fix loop spends more agents than today's block, which breaks the additive rule. #125 should do this deterministically. The stop-early half survives as rank 9. |
| Review-panel cost-saving persona drop mode | Dropping reviewers reduces review, which breaks additive-only. The add-only half was merged into diff_risk (rank 2). |

## Appendix: the jev-use-cases pack

This is the resource pack for the video "7 Jev use cases for coding agents" (Claude Code hooks, skills and a plugin, each using Jev through Vercel AI Gateway). Below is what the readers mapped:

**hooks:** Read all in-scope files under the pack: hooks/ (jev.py, jev-rules.py, jev-spec-hook.py, jev-skill-pick.py, test_jev_hooks.py), jev-rules.json, jev-spec.json, settings.json, agents/adversarial-reviewer.md, agents/fixer.md, README.md. Extracted five decision patterns. Four are the ones requested (shared client, rule enforcer, spec judge hook, skill picker); the fifth is the critic/fixer debate state machine from the agents. Jev is a yes/no, choice, or score model; every Jev-backed hook fails open. Not read (outside the listed scope, referenced only by name): skills/jev-spec-check/check.py (COVERED threshold, run()), skills/adversarial-loop/ (triage), skills/jev-explore, skills/jev-browser-check, and plugins/fast-jev-compaction. Thresholds quoted from README/code only, not verified against those files.

Patterns: Shared Jev client (jev.py); Rule enforcer (PreToolUse deny/warn gate); Spec judge hook (PostToolUse coverage check); Skill picker (UserPromptSubmit router); Adversarial critic vs fixer debate (agents)

**skills:** Read all four skills under the pack/skills/ (jev-explore, adversarial-loop, jev-browser-check, jev-spec-check: SKILL.md plus each script) and the README.md. Every Jev call is a single yes/no, choice or score question over a state blob, returning a probability. Five decision patterns follow. The 7 risk questions are in adversarial-loop/jev_triage.py and match the README list (auth, money, schema, data_loss, state, api_contract, secrets). Not read: hooks/jev.py (the shared client, including its fail-open behavior and timeout handling) and the hooks, agents, plugin and settings files, which are outside the four skills and the README.

Patterns: Keyword-prefilter then batched per-file yes/no relevance scoring (jev-explore); Cheap risk triage gating review depth (7 fixed yes/no risk questions in one call); Browser agent: Jev picks the next click from a numbered list of visible controls, with write guard and a final not-allowed check (jev-browser-check); Spec-rule coverage judge: one yes/no per rule against retrieved test files (jev-spec-check)

**compaction:** fast-jev-compaction replaces LLM summarization with per-tool-call keep/drop decisions from Jev (TypeSafe System One, POST api.typesafe.ai/v1/systemone, model jev-latest). Flow: (1) collectToolCalls pairs each tool_use with its tool_result by tool_use_id and assigns short ids t1..tN; calls without a result are skipped; a call is pinned if either its call message or result message is index 0 or within the newest preserveRecentMessages (6). (2) fitState builds ONE shared state for all questions: {context (static explanation), goal (explicit or last 3 user prompts, 500 chars each), history[]} where history is the whole conversation oldest-first, {i, role, text, tool_calls:[{id, tool, input (JSON truncated to 1000 chars), result:'ok|error, N chars (omitted)'}]}; tool result bodies are never sent, only a size/ok-error note. It is shrunk to maxStateTokens (25k est.) via staged degradation, throwing if impossible. (3) For each non-pinned call, two noul (yes/no probability) questions: call_<id> ('should this call stay: knowing it was made, with its input, still matters') and result_<id> ('full output (N chars) should stay verbatim: assistant still needs its contents and re-running would not do'). (4) batchCalls greedily packs questions into requests so state + questions <= maxRequestTokens (30k, under Jev 32k limit), minus 20 token overhead; the full state is resent with each request; batches run concurrently via Promise.all, answers merged by call id. Throws if one call's questions cannot fit. (5) decideCall with keepThreshold 0.5: pinned -> keep; keepResult>=t -> keep both; else keepCall>=t -> drop_result (truncate result to first truncateHeadChars=300 chars + note '[fast-jev-compaction truncated N chars ...; re-run the tool if needed]', only if text longer than head+120); else drop_call (call and result both removed). (6) applyDecisions rebuilds messages: drops messages left empty, reuses identical object refs for untouched messages, never orphans a result; text is never altered. Failures (HTTP error, malformed JSON, missing/non-finite noul, missing API key, unfittable state) all throw; there is no partial fallback in the library. The hook (hooks/fast-jev.ts) catches errors and falls back to Claude's built-in summary via next(event); it also falls back when reductionRatio (chars) < minReductionRatio 0.25; turn.complete auto-triggers session.compact when context.percent >= compactAtPercent 60 with an in-flight guard. Hook maps output back to SessionMessage preserving engine object identity for unchanged items so engine handles are retained. Note: the test files were not read in detail (only sizes); behavior derived from src and docs.

Patterns: Dual noul keep-call / keep-result per tool call (compaction pruning); Batched questions over a shared fitted state (token-budgeted fan-out); Fail-open hook gating around Jev decisions (host integration)

**piquette (already shipped under #102):** decision rails (`src/core/jev.ts`, `jev_kinds.ts`) plus seven kinds. Every call site computes the heuristic fallback, builds a closed option set in code, calls `decide()`, and acts only on `decision.choice`. All seven kinds are `choice`; `score` and `noul` are unused. See `docs/jev.md` and [`jev-in-the-factory.md`](jev-in-the-factory.md).

Patterns: risk_tier; loop_control; finding_triage; chain_router; intake_feedback; intake_readiness; chain_edge; decision rails (shared infrastructure, not a kind)
