/**
 * Simple SDLC — plan, build, test, review, document, committing as it goes.
 *
 * Usage:
 *   piquette simple-sdlc "<prompt or path/to/prompt.md>" [--config <path>] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> planner -> git(commit_plan)
 *         -> code(prove: before, only with `receipts:`)
 *         -> builder -> code(test) [-> builder(fix) -> code(test) ... bounded]
 *         -> code(prove) [-> builder(fix) -> code(prove) ... bounded, only with `receipts:`]
 *         -> reviewer [-> builder(revise) -> reviewer ... bounded]
 *         -> code(retest, only if a revision changed code) -> code(prove, again, only with `receipts:`)
 *         -> code(diff_risk, only if decisions are on)
 *         -> engineer(signoff) -> git(commit_build) [-> code(committed-tree check)] -> code(changes) -> documenter -> git(commit_docs)
 *
 * The signoff phase is where "agent proposes, code disposes" gets literal:
 * `review.approved` is the AI reviewer's PROPOSAL, and this chain's
 * `commit_build` predicate is the only place in this codebase where such a
 * proposal gates a commit at all (`build-review` has no commit step). A
 * human at the keyboard DISPOSES of it — `decideSignoff` below — and their
 * answer, not `review.approved`, becomes the final predicate. Unattended
 * (`piquette watch`, CI) has nobody to ask, so it either proceeds on the AI
 * verdict alone with a loud warning, or fails the phase closed, depending on
 * `review.require_human_signoff` — see that function's own comment.
 *
 * Three commits, three work products, three authors. The plan, the code, and the
 * write-up each land in their own commit, and each commit message is the words of
 * the agent that produced it — `commit_message` on PlanOutput describes the spec,
 * on BuildOutput the code, on DocumentOutput the write-up. No agent's sentence is
 * ever reused for another agent's diff.
 *
 * Testing is CODE, not an agent. `bun test` is a command, not a judgement call:
 * an agent rediscovering it every run costs a million tokens to learn what a
 * subprocess already knows. Failures travel back to the builder as an envelope,
 * so the repair loop is unchanged — only the runner became free and repeatable.
 *
 * Two different questions still get asked, in order. The suite asks "does it
 * run"; the reviewer asks "is this what was asked for", against `plan.md` — and
 * neither can answer the other's. A revision that closes a review finding
 * re-enters the suite, so the tree that gets committed is the tree that was both
 * tested and approved.
 *
 * The code commit lands after verification, not straight after the build: fixes
 * and revisions are part of the same work product, and red code has no business
 * on the branch. A run that fails verification therefore leaves the plan
 * committed and the working tree dirty — the spec is a real artifact either way,
 * and the unfinished code stays where the engineer can see it.
 *
 * The documenter measures against the commit this run STARTED from, not against
 * `main`, because by then the run has moved `main` itself. That baseline is
 * pinned before the first commit phase and printed in the request phase.
 *
 * This is the one chain still shaped by hand rather than by a `steps` list —
 * three commits, a pinned baseline, and a conditional retest don't collapse
 * cleanly into the flat, loop-free vocabulary `./steps.ts` provides for every
 * other chain. It still reuses that module's shared helpers (`startRun`,
 * `commitEnvelope`, `logChangeset`) rather than keeping its own copies.
 */

import * as changes from "../core/changes.ts";
import * as gates from "../core/gates.ts";
import * as quality from "../core/quality.ts";
import { DOCUMENT_NOTES } from "../core/prompts.ts";
import { createAsker, isInteractive, type Asker } from "../cli/ask.ts";
import { paint } from "../core/console.ts";
import { committerIdentity, type CommitterIdentity } from "../core/git_helper.ts";
import type { ChainContext } from "./context.ts";
import { commitEnvelope, logChangeset, makeState, proveBase, proveHead, resetHeadProof, settleCommitted, startRun } from "./steps.ts";
import { resolveFindingTriage, triageReviewFindings } from "./finding_triage.ts";
import { collectDiff, decideDiffRisk, diffRiskFailure, resolveDiffRisk } from "./diff_risk.ts";
import { SignoffRequiredError, mergeSignoff, type DiffRiskOutcome } from "../core/diff_risk.ts";
import {
  BuildOutput,
  DocumentOutput,
  PlanOutput,
  ReviewOutput,
  makeAgentCall,
  makeChangeCapture,
  makePhaseParams,
  type BuildOutputT,
  type QualityResult,
  type ReviewOutputT,
} from "../core/data_types.ts";

export const REQUIRED_AGENTS = ["planner", "builder", "reviewer", "documenter"];
export const REQUIRED_SUITES: string[] = ["test"];
const MAX_FIX_LOOPS = 3;
const MAX_REVISION_LOOPS = 2;

// ── sign-off: agent proposes, code disposes, literally ──────────────────────

/** Printed (never thrown) whenever this chain commits on `review.approved` alone — nobody answered. */
export const AI_ONLY_SIGNOFF_WARNING =
  "committing on an AI-only verdict — set review.require_human_signoff or run attended";

export interface SignoffParams {
  review: ReviewOutputT;
  /** Both a real TTY (`isInteractive()`) AND an attended run (`!ctx.unattended`) — see the module comment on `ChainContext.unattended` for why neither alone is trusted. */
  canPrompt: boolean;
  requireHumanSignoff: boolean;
  /** The CONFIGURED `review.require_human_signoff` alone (before `diff_risk` is OR-ed in), so the unattended error can name every cause. */
  configuredRequireHumanSignoff?: boolean;
  /**
   * The `diff_risk` decision kind's APPLIED flags, when it ran in act mode and
   * flagged something (`undefined` otherwise). Informational here: the
   * requirement itself already arrives folded into `requireHumanSignoff` (an OR
   * with the configured value — see `mergeSignoff`). It names the cause in the
   * prompt, the fail-closed error and the log; it can never relax anything.
   */
  diffRisk?: { labels: readonly string[]; /** Set when the diff could not be read and the requirement is the fail-closed one. */ reason?: string };
  signoffTimeoutSeconds: number;
  /** `null` whenever `canPrompt` is false — the caller never spins up a real prompt it won't use. */
  asker: Asker | null;
  /** `undefined` when `git config user.name`/`user.email` is unset at this repo — see `git_helper.committerIdentity`. */
  identity: CommitterIdentity | undefined;
  /** Routes into the phase's own trace record — `ph.log`, now async (`Tracer`'s write methods all are — see `core/tracer.ts`'s header). */
  log: (payload: Record<string, unknown>) => Promise<void>;
  /** Console-only, never traced — the prompt itself and its framing, kept out of the event stream on purpose (the DECISION is what `log` records). */
  warn: (line: string) => void;
}

export interface SignoffOutcome {
  /** The chain's actual commit predicate — the human's answer where there is one, `review.approved` otherwise. */
  accepted: boolean;
  /**
   * True ONLY when a human explicitly typed "yes" through `asker.confirm`.
   * `confirm`'s own default is `false`, so this can only be true by way of
   * an explicit answer — never a TTY inference, never a timeout, never the
   * unattended AI-only path. This is the one flag `commit_build` may use to
   * decide whether a `Signed-off-by:` trailer is even considered.
   */
  recordedYes: boolean;
}

/**
 * Turn the reviewer's `approved` PROPOSAL into a human DISPOSAL wherever a
 * human is reachable; otherwise apply this release's documented default.
 *
 * Attended (`canPrompt`): shows the reviewer's findings and blocking list,
 * then asks — default `false` (never `review.approved`: an AI's own verdict
 * must never be its own auto-approval), bounded by
 * `review.signoff_timeout_seconds` (expiry resolves to that same `false` —
 * see `cli/ask.ts`'s `confirm`). The human's answer is the return value;
 * `review.approved` never overrides it either way.
 *
 * Unattended or no TTY: nobody to ask, so `require_human_signoff` decides.
 * `true` fails the phase CLOSED (throws) — this release will not let an
 * unattended run manufacture a "yes" nobody gave it. `false` (this release's
 * default) proceeds on `review.approved` alone, but never quietly: a loud
 * warning prints AND is logged every time, because the day this default
 * flips is the day silence here would have been the bug.
 */
export async function decideSignoff(params: SignoffParams): Promise<SignoffOutcome> {
  const { review, canPrompt, requireHumanSignoff, signoffTimeoutSeconds, asker, identity, log, warn } = params;
  const riskLabels = params.diffRisk?.labels ?? [];
  const riskReason = params.diffRisk?.reason;
  const riskNote = riskLabels.length > 0 || riskReason ? { diff_risk: riskLabels, ...(riskReason ? { diff_risk_unreadable: riskReason } : {}) } : {};

  if (!canPrompt) {
    if (requireHumanSignoff) {
      if (params.diffRisk) {
        // Do NOT point at `piquette watch`: every watch/fanout/loop dispatch is unattended too, so a flagged diff blocks there as well.
        const detail = [riskLabels.length > 0 ? `flagged: ${riskLabels.join(", ")}` : "", riskReason ? `diff not fully readable: ${riskReason}` : ""].filter(Boolean).join("; ");
        // Only suggest loosening diff_risk when it is the SOLE cause; with the config also requiring signoff that would not unblock the run.
        const cause = params.configuredRequireHumanSignoff
          ? `review.require_human_signoff is true in the config and the decision layer's diff_risk also requires human signoff (${detail})`
          : `review.require_human_signoff is true but this run is unattended — the decision layer's diff_risk requires human signoff (${detail})`;
        const remedy = params.configuredRequireHumanSignoff
          ? "Rerun attended, or set review.require_human_signoff to false AND decisions.kinds.diff_risk.mode to shadow/off."
          : "Rerun attended, or set decisions.kinds.diff_risk.mode to shadow/off.";
        throw new SignoffRequiredError(
          `${cause}. ${remedy} \`piquette watch\` and \`piquette fanout\` are unattended, so under them a flagged diff blocks the issue and opens no PR; \`piquette loop\` stops at once rather than re-running.`,
          riskLabels,
          riskReason ?? null,
        );
      }
      throw new Error(
        "review.require_human_signoff is true but this run is unattended — rerun attended, " +
          "or run via `piquette watch`, where a human merges the PR instead of this phase.",
      );
    }
    warn(paint("bold yellow", `⚠ ${AI_ONLY_SIGNOFF_WARNING}`));
    await log({
      decision: "ai_only",
      warning: AI_ONLY_SIGNOFF_WARNING,
      human: false,
      review_approved: review.approved,
      blocking: review.blocking,
      findings: review.findings,
      ...riskNote,
    });
    return { accepted: review.approved, recordedYes: false };
  }

  if (!asker) throw new Error("decideSignoff: canPrompt is true but no asker was supplied");

  warn("");
  warn(paint("bold", "── sign-off required before commit ──"));
  if (riskLabels.length > 0) warn(paint("bold yellow", `  ⚠ diff risk flagged: ${riskLabels.join(", ")}`));
  if (riskReason) warn(paint("bold yellow", `  ⚠ diff risk: the diff could not be fully read (${riskReason})`));
  for (const finding of review.findings) {
    const mark = finding.met ? paint("green", "met") : paint("red", "MISSING");
    warn(`  ${mark}  ${finding.requirement}${finding.evidence ? paint("dim", ` — ${finding.evidence}`) : ""}`);
  }
  if (review.blocking.length > 0) {
    warn(paint("red", `  blocking: ${review.blocking.join("; ")}`));
  }
  warn("");

  const accepted = await asker.confirm(
    identity ? `${identity.name}, approve and commit?` : "Approve and commit?",
    false,
    { timeoutMs: signoffTimeoutSeconds * 1000 },
  );
  await log({
    decision: accepted ? "approved" : "declined",
    human: true,
    engineer: identity?.name ?? null,
    review_approved: review.approved,
    blocking: review.blocking,
    findings: review.findings,
    ...riskNote,
  });
  if (accepted && !identity) {
    warn(paint("dim", "  no git committer identity (user.name/user.email) is set — sign-off recorded, no Signed-off-by trailer"));
    await log({ note: "signoff recorded without a git committer identity — trailer skipped" });
  }
  return { accepted, recordedYes: accepted };
}

/**
 * Whether `commit_build` may attach a `Signed-off-by:` trailer: only when
 * the outcome recorded an explicit human "yes" (`recordedYes`) AND there is
 * an identity to attest it with. Deliberately NOT `outcome.accepted` alone —
 * the AI-only unattended path can also produce `accepted: true` (see
 * `decideSignoff`'s unattended branch), and that path must never mint a
 * trailer. Pulled out as its own named function, rather than inlined at the
 * `commitEnvelope` call site, specifically so a refactor that swaps
 * `recordedYes` for `verified`/`accepted` there breaks a test here instead
 * of silently minting trailers for AI-only commits.
 */
export function trailerFor(outcome: SignoffOutcome, identity: CommitterIdentity | undefined): CommitterIdentity | null {
  return outcome.recordedYes && identity ? identity : null;
}

export async function main(ctx: ChainContext): Promise<number> {
  const { prompt } = ctx;
  const run = await startRun(ctx, REQUIRED_AGENTS, REQUIRED_SUITES);
  // Decision-layer finding triage (#106): null unless on — resolved once, before any
  // phase (startRun has already validated its `drop`, so a bad setting failed
  // there, before the plan/build spend). It shapes the revise handoff only,
  // never the verdict.
  const triage = resolveFindingTriage(run);
  // Decision-layer diff_risk: null unless on. Resolved here, before any phase,
  // so a bad `max_diff_chars` fails early (startRun already checked it).
  const diffRiskSettings = resolveDiffRisk(run);
  const baseline = run.git.rev("HEAD"); // pinned before this run commits anything
  // The same proof steps the step-list chains run (#159, #187), driven by a
  // ChainState of their own — no-ops without `receipts:`, and they never write
  // the commit predicate below (a proof-driven fix re-runs the suite, so
  // `state.accepted` still means "the suite passed on this code").
  const proof = makeState(prompt, {}, ctx.issue_id ?? null);
  const proveAfterTests = proveHead({ suite: "test" });
  // After a review revision the re-proof only records: a proof-driven fix there
  // would be code nobody reviewed, committed on the strength of the approval.
  const reproveReviewed = proveHead({ suite: "test", fix: false });

  await run.phase(makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: "Capture the incoming ask" }), async (ph) => {
    await ph.log({ input: prompt, baseline: run.git.shortSha(baseline) });
  });

  const plan = await run.phase(
    makePhaseParams({ name: "plan", kind: "agent", owner: "planner", description: "Turn the request into an implementable plan" }),
    (ph) => ph.call(makeAgentCall({ output_type: PlanOutput, prompt, gates: [gates.artifactsExist, gates.filesNonEmpty, gates.journeysCover] })),
  );

  await run.phase(
    makePhaseParams({ name: "commit_plan", kind: "code", owner: "git", description: "Put the spec on record before any code exists to blur it" }),
    async (ph) => await commitEnvelope(run, ph, plan),
  );

  proof.previous = plan; // the journeys file is the plan's artifact
  await proveBase()(run, proof);

  let build: BuildOutputT = await run.phase(
    makePhaseParams({ name: "build", kind: "agent", owner: "builder", description: "Implement the plan exactly" }),
    (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: plan, gates: [gates.diffMatchesClaims] })),
  );

  let test: QualityResult | null = null;
  for (let i = 1; i <= MAX_FIX_LOOPS; i++) {
    test = await run.phase(
      makePhaseParams({
        name: `test_${i}`,
        kind: "code",
        owner: "quality",
        description: "Run the suite — a known command, so code runs it and no agent has to rediscover it",
      }),
      async (ph) => {
        const result = await quality.runTests(run);
        await quality.record(ph, result);
        return result;
      },
    );

    if (test.passed) break;
    if (i === MAX_FIX_LOOPS) break; // never leave an unverified fix on the table

    build = await run.phase(
      makePhaseParams({
        name: `fix_${i}`,
        kind: "agent",
        owner: "builder",
        retries: 1,
        description: "Repair what the suite reported, from its verbatim output",
      }),
      (ph) =>
        ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: quality.asEnvelope(test!, "tests"), gates: [gates.diffMatchesClaims] })),
    );
  }

  // Prove the change. A proof-driven fix replaces the build and re-runs the
  // suite, so take both back from the shared state.
  proof.previous = build;
  proof.quality = test;
  proof.accepted = test !== null && test.passed;
  await proveAfterTests(run, proof);
  build = proof.previous as BuildOutputT;
  test = proof.quality ?? test;

  let review: ReviewOutputT | null = null;
  let revised = false;
  for (let i = 1; i <= MAX_REVISION_LOOPS; i++) {
    review = await run.phase(
      makePhaseParams({ name: `review_${i}`, kind: "agent", owner: "reviewer", description: "Confirm the build matches the plan" }),
      (ph) =>
        ph.call(makeAgentCall({ output_type: ReviewOutput, prompt, previous: build, gates: [gates.artifactsExist, gates.verdictConsistent] })),
    );

    if (review.approved || i === MAX_REVISION_LOOPS) break;

    build = await run.phase(
      makePhaseParams({ name: `revise_${i}`, kind: "agent", owner: "builder", retries: 1, description: "Close the reviewer's blocking findings" }),
      async (ph) => {
        const previous = triage ? (await triageReviewFindings(run, review!, { settings: triage, round: i, prompt, phase_id: ph.phase_id })).handoff : review!;
        return ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous, gates: [gates.diffMatchesClaims] }));
      },
    );
    revised = true;
  }

  // A revision edited code after the suite last ran, so the green light is
  // stale. Re-run it rather than commit on a result that predates the change.
  if (revised && review !== null && review.approved) {
    test = await run.phase(
      makePhaseParams({
        name: "retest",
        kind: "code",
        owner: "quality",
        description: "Re-run the suite — the revision changed code after the last green result",
      }),
      async (ph) => {
        const result = await quality.runTests(run);
        await quality.record(ph, result);
        return result;
      },
    );
  }

  // The revision (and its retest) changed code after the proof: prove again so
  // the receipt describes the tree that lands. Only on a green retest, and
  // without fixes — it can neither turn red green nor add unreviewed code.
  if (revised && review !== null && review.approved && test !== null && test.passed) {
    if (proof.verification) resetHeadProof(proof.verification);
    await reproveReviewed(run, proof);
  }

  // Red tests or a rejected review stop the chain here: the code stays
  // uncommitted and nothing is documented, because there is nothing worth
  // describing yet. The plan commit stands — it is a record of what was asked.
  const aiApproved = test !== null && test.passed && review !== null && review.approved;

  // The sign-off phase — see decideSignoff's comment and the module header —
  // only runs once the AI's own two gates (green suite, approved review) are
  // both already met; it never runs to rescue a run that failed either one.
  let verified = false;
  let recordedYes = false;
  let identity: CommitterIdentity | undefined; // hoisted: commit_build reads this too, gated by recordedYes
  // The diff exists now (uncommitted: commit_build comes after signoff) and
  // nothing has been pushed. `diff_risk` can only ADD to the signoff
  // requirement below (`mergeSignoff` is `configured || flagged`) — never
  // relax it, remove a gate, or touch the review/fix loops that already ran.
  let diffRisk: DiffRiskOutcome | null = null;
  if (aiApproved && diffRiskSettings) {
    diffRisk = await run.phase(
      makePhaseParams({
        name: "diff_risk",
        kind: "code",
        owner: "decisions",
        description: "Flag a diff that touches auth, money, schema, data loss, state, an API contract or secrets — can only add a signoff requirement",
      }),
      async (ph) => {
        try {
          return await decideDiffRisk(run, collectDiff(run, baseline), { settings: diffRiskSettings, phase_id: ph.phase_id });
        } catch (error) {
          // Advisory for the run, but never fail-open: act mode requires signoff when the decision could not run.
          await ph.log({ diff_risk: "degraded", error: (error as Error).message });
          return await diffRiskFailure(run, error, ph.phase_id);
        }
      },
    );
  }
  if (aiApproved) {
    const canPrompt = isInteractive() && !ctx.unattended; // amendment: never infer this from TTY state alone
    identity = committerIdentity(run.repo_root);
    const asker = canPrompt ? createAsker() : null;
    // A live run dashboard (cli/ui/run_dashboard.tsx) keeps writing to the
    // same stdout/stdin on its own timer even though it never reads input
    // itself — that alone is enough to corrupt this prompt's rendering if
    // both are live at once. `pause()`/`resume()` are no-ops when no
    // dashboard is mounted (every non-interactive dispatch, and any test).
    if (canPrompt) await ctx.render_hooks?.pause?.();
    try {
      const outcome = await run.phase(
        makePhaseParams({
          name: "signoff",
          kind: "engineer",
          owner: identity?.name || run.engineer,
          description: "A human disposes of the AI reviewer's approval before anything commits",
        }),
        (ph) =>
          decideSignoff({
            review: review!,
            canPrompt,
            requireHumanSignoff: mergeSignoff(run.cfg.review.require_human_signoff, diffRisk),
            configuredRequireHumanSignoff: run.cfg.review.require_human_signoff,
            ...(diffRisk?.applied && diffRisk.require_human_signoff ? { diffRisk: { labels: diffRisk.labels, ...(diffRisk.unreadable ? { reason: diffRisk.unreadable } : {}) } } : {}),
            signoffTimeoutSeconds: run.cfg.review.signoff_timeout_seconds,
            asker,
            identity,
            log: (payload) => ph.log(payload),
            warn: (line) => console.log(line),
          }),
      );
      verified = outcome.accepted;
      recordedYes = outcome.recordedYes;
    } finally {
      asker?.close();
      if (canPrompt) ctx.render_hooks?.resume?.();
    }
  }

  if (verified) {
    let commitPhaseId = "";
    await run.phase(
      makePhaseParams({ name: "commit_build", kind: "code", owner: "git", description: "Land the code only now: green suite, approved review, human sign-off" }),
      // trailerFor gates the trailer on recordedYes, not just `verified` — see
      // its own comment: a Signed-off-by line must trace back to an explicit
      // "yes", never to the AI-only path (where `verified` can also be true).
      async (ph) => {
        commitPhaseId = ph.phase_id;
        return await commitEnvelope(run, ph, build, trailerFor({ accepted: verified, recordedYes }, identity));
      },
    );
    await settleCommitted(run, proof, commitPhaseId); // the code that landed must be the code that was proved

    const changeset = await run.phase(
      makePhaseParams({ name: "changes", kind: "code", owner: "git", description: "Diff the whole run against its pinned baseline, for the documenter" }),
      async (ph) => {
        const result = changes.capture(run, makeChangeCapture({ base: baseline }));
        await logChangeset(ph, result);
        if (result.empty) {
          throw new Error(`nothing changed since ${result.base.label} (${result.base.reason}) — there is nothing to document.`);
        }
        return result;
      },
    );

    const document = await run.phase(
      makePhaseParams({ name: "document", kind: "agent", owner: "documenter", retries: 1, description: "Write up the completed change" }),
      (ph) =>
        ph.call(
          makeAgentCall({
            output_type: DocumentOutput,
            prompt,
            previous: changes.asEnvelope(changeset, DOCUMENT_NOTES),
            gates: [gates.artifactsExist, gates.filesNonEmpty],
          }),
        ),
    );

    await run.phase(
      makePhaseParams({ name: "commit_docs", kind: "code", owner: "git", description: "Ship the write-up in its own commit, beside the code it describes" }),
      async (ph) => await commitEnvelope(run, ph, document),
    );
  }

  return await run.finish(verified, "the suite or the review never came back clean, or sign-off never came");
}
