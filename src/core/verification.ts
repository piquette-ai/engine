/**
 * Verification outcome (#159, ticket D / #176): turn a run's receipts into
 * VERIFIED or UNVERIFIED, with reasons written for the person who has to
 * decide what to do next.
 *
 * Verification INFORMS, it never blocks. An unverified outcome does not
 * fail the run, refuse the commit, or stop the PR: the work still lands,
 * marked unverified, and a human is told why and asked to decide. (A failed
 * proof is evidence too, and a person can judge it in a minute from the
 * video — blocking would hide the work instead.)
 *
 * The definition of done it checks (docs/brainstorms/verification-receipts.md):
 *   red on base · green on the change · at least one unhappy path ·
 *   non-negotiables in the proof · a recording · the committed code is the
 *   code that was proved.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";
import { DEFAULT_NON_NEGOTIABLES_PATH, makeEventRecord, VerifyOutput, type EventRecord, type SFConfig, type VerifyOutputT } from "./data_types.ts";
import { loadJourneysFile, type JourneySpec } from "./journeys.ts";
import type { Receipt, ReceiptStage, Verdict } from "./receipt.ts";

export const VERIFICATION_EVENT = "verification";
export const DEFAULT_MAX_FAILED_PROOFS = 3;

/** A pointer to one stored receipt — enough for a PR, a notification or a person to find it. */
export interface ReceiptRef {
  key: string;
  stage: ReceiptStage;
  attempt: number;
  verdict: Verdict;
  reason: string;
  tree: string;
  video?: string;
  transcript?: string;
}

export function refOf(receipt: Receipt, key: string): ReceiptRef {
  return {
    key,
    stage: receipt.stage,
    attempt: receipt.attempt,
    verdict: receipt.verdict,
    reason: receipt.reason,
    tree: receipt.revision.tree,
    ...(receipt.evidence.video ? { video: receipt.evidence.video.key } : {}),
    ...(receipt.evidence.transcript ? { transcript: receipt.evidence.transcript.key } : {}),
  };
}

export interface VerificationOutcome {
  status: "verified" | "unverified";
  /** Empty when verified. Each one a sentence a person can act on. */
  reasons: string[];
  journeys: string | null;
  base: ReceiptRef | null;
  head: ReceiptRef | null;
  failed_proofs: number;
  max_failed_proofs: number;
  /** Set by the commit step: the commit that landed, and whether its tree is the tree that was proved. */
  committed?: { commit: string; tree: string; matches: boolean };
}

export interface DecideInput {
  journeys: string | null;
  base: { receipt: Receipt; key: string } | null;
  head: { receipt: Receipt; key: string } | null;
  failedProofs: number;
  maxFailedProofs: number;
  /** A non-negotiables file exists, so the proof should have included it. */
  expectNonNegotiables: boolean;
  /** The run was configured to record, so the proof should carry a video. */
  expectRecording: boolean;
  /** Anything that went wrong setting the proof up (an unreadable journeys file, a proof that couldn't start, a fix that crashed), already in plain words. */
  problems?: string[];
}

export function decideVerification(input: DecideInput): VerificationOutcome {
  const reasons: string[] = [...(input.problems ?? [])];
  const base = input.base?.receipt ?? null;
  const head = input.head?.receipt ?? null;

  // A stage whose proof couldn't run already has a reason saying why; the
  // generic "never ran" line would only repeat it (seen on the #179 pilot PR).
  const explained = (stage: string) => (input.problems ?? []).some((p) => p.startsWith(`The ${stage} couldn't run`));
  if (!input.journeys) reasons.push("The plan has no journeys, so nothing proved this work.");
  if (input.journeys && !base && !explained("proof before the change")) reasons.push("The proof on the code before the change never ran.");
  if (base?.verdict === "PASS") {
    reasons.push("The journeys already pass on the code before the change, so they don't show that this work changed anything.");
  }
  if (input.journeys && !head && !explained("proof of the change")) reasons.push("The proof of the change never ran.");
  if (head?.verdict === "CANT_TELL") reasons.push(`The proof of the change couldn't tell: ${head.reason}.`);
  if (head?.verdict === "FAIL") {
    reasons.push(`The change still fails its own proof after ${input.failedProofs} of ${input.maxFailedProofs} attempt(s): ${head.reason}.`);
  }
  if (head?.verdict === "PASS") {
    const coverage = (head.observations.coverage ?? {}) as Partial<Record<"happy" | "unhappy" | "non_negotiable", number>>;
    if (!coverage.unhappy) reasons.push("No unhappy-path journey was proved, so only the path the builder built was tried.");
    if (input.expectNonNegotiables && !coverage.non_negotiable) reasons.push("The repo's non-negotiables weren't part of the proof.");
    if (input.expectRecording && !head.evidence.video) reasons.push("The proof has no recording to watch.");
  }

  return {
    status: reasons.length === 0 ? "verified" : "unverified",
    reasons,
    journeys: input.journeys,
    base: input.base ? refOf(input.base.receipt, input.base.key) : null,
    head: input.head ? refOf(input.head.receipt, input.head.key) : null,
    failed_proofs: input.failedProofs,
    max_failed_proofs: input.maxFailedProofs,
  };
}

/** After the commit: is the code that landed the code that was proved? A mismatch makes the outcome unverified. */
export function withCommit(outcome: VerificationOutcome, commit: string, tree: string): VerificationOutcome {
  const matches = outcome.head !== null && outcome.head.tree === tree;
  const reasons = [...outcome.reasons];
  if (outcome.head && !matches) {
    reasons.push(`The committed code (${commit.slice(0, 12)}) isn't the code that was proved — something changed after the last proof.`);
  }
  return { ...outcome, reasons, status: reasons.length === 0 ? "verified" : "unverified", committed: { commit, tree, matches } };
}

/** The message a human gets: what happened, the evidence, and what they're being asked to decide. */
export function escalationText(outcome: VerificationOutcome): string {
  if (outcome.status === "verified") {
    return `**Verified.** The change failed its journeys before and passes them now${outcome.head?.video ? ` (video: \`${outcome.head.video}\`)` : ""}.`;
  }
  const lines = ["**Unverified — a person needs to decide.** The work was not blocked; it is here for you to judge.", "", ...outcome.reasons.map((r) => `- ${r}`), ""];
  const evidence: string[] = [];
  if (outcome.base) evidence.push(`before the change: ${outcome.base.verdict} (\`${outcome.base.key}\`)`);
  if (outcome.head) {
    evidence.push(`the change: ${outcome.head.verdict} after ${outcome.failed_proofs} failed proof(s) (\`${outcome.head.key}\`)`);
    if (outcome.head.video) evidence.push(`video: \`${outcome.head.video}\``);
    if (outcome.head.transcript) evidence.push(`transcript: \`${outcome.head.transcript}\``);
  }
  if (evidence.length) lines.push("Evidence:", ...evidence.map((e) => `- ${e}`), "");
  lines.push("Decide: merge as it is, ask for a fix, or close it.");
  return lines.join("\n");
}

export function verificationEventRecord(outcome: VerificationOutcome, adwId: string, phaseId = ""): EventRecord {
  return makeEventRecord({
    adw_id: adwId,
    phase_id: phaseId,
    type: "log",
    name: VERIFICATION_EVENT,
    payload: outcome as unknown as Record<string, unknown>,
  });
}

/**
 * A failed proof handed to the builder, in the same envelope shape a failed
 * test suite uses. The failures are the receipt's `next[]` plus the output
 * of each failing journey, verbatim.
 */
export function receiptAsEnvelope(receipt: Receipt, key: string): VerifyOutputT {
  const outputs = (receipt.observations.outputs ?? {}) as Record<string, string>;
  const failing = [...new Set(receipt.checks.filter((c) => !c.pass).map((c) => c.journey))];
  const failures = [
    ...receipt.next,
    ...failing.map((id) => {
      const journey = receipt.journeys.find((j) => j.id === id);
      return `${id} — ${journey?.criterion ?? ""}\n$ ${journey?.steps[0]?.name ?? ""}\n${outputs[id] ?? "(no output captured)"}`;
    }),
  ];
  return v.parse(VerifyOutput.schema, {
    status: "fail",
    summary: `the proof of your change: ${receipt.reason}`,
    artifacts: [],
    notes_for_next_agent:
      `This is the proof of your change, run from OUTSIDE the code exactly as a person would (receipt ${key}). ` +
      "Fix the code so every journey passes. Do not edit the journeys file or the non-negotiables to make the proof pass — they define done.",
    passed: false,
    failures,
  });
}

/** The repo's non-negotiables (`receipts.non_negotiables`, else the default path), or none when the file doesn't exist yet. */
export function loadNonNegotiables(repoRoot: string, cfg: Pick<SFConfig, "receipts">, override?: string): { specs: JourneySpec[]; file: string | null } {
  const configured = override ?? cfg.receipts?.non_negotiables;
  const file = path.resolve(repoRoot, configured ?? DEFAULT_NON_NEGOTIABLES_PATH);
  if (!existsSync(file)) {
    if (configured) throw new Error(`non-negotiables file ${file} does not exist (configured explicitly)`);
    return { specs: [], file: null };
  }
  return { specs: loadJourneysFile(file, "non_negotiable"), file };
}
