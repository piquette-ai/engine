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
import { homedir } from "node:os";
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
  /** The HEAD the proof ran on, and whether the proved tree had uncommitted work on top. Optional: older trace rows lack them. */
  sha?: string;
  dirty?: boolean;
  /** How many checks ran and how many failed — what the PR shows next to the verdict. */
  checks?: { total: number; failed: number };
  video?: string;
  poster?: string;
  contact_sheet?: string;
  transcript?: string;
}

export function refOf(receipt: Receipt, key: string): ReceiptRef {
  const e = receipt.evidence;
  return {
    key,
    stage: receipt.stage,
    attempt: receipt.attempt,
    verdict: receipt.verdict,
    reason: receipt.reason,
    tree: receipt.revision.tree,
    sha: receipt.revision.sha,
    dirty: receipt.revision.dirty,
    checks: { total: receipt.checks.length, failed: receipt.checks.filter((c) => !c.pass).length },
    ...(e.video ? { video: e.video.key } : {}),
    ...(e.poster ? { poster: e.poster.key } : {}),
    ...(e.contact_sheet ? { contact_sheet: e.contact_sheet.key } : {}),
    ...(e.transcript ? { transcript: e.transcript.key } : {}),
  };
}

/**
 * Where a person can open a piece of evidence (#159 ticket E), keyed by
 * store key. Computed when the outcome is READ (never stored in the trace):
 * a viewer link, a presigned S3/R2 URL that expires, or — for a local store
 * — a path on the machine that ran the proof.
 */
export type EvidenceLink = { url: string; expires?: string } | { local: string };
export type EvidenceLinks = Record<string, EvidenceLink>;

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
  /** Evidence links, attached by whoever reads the outcome (spf watch) — never written to the trace. */
  links?: EvidenceLinks;
  /** The head proof's poster, committed to the `spf-receipts` branch (#203): the image to embed and where it links. Attached by spf watch, never written to the trace. */
  poster?: { image: string; href: string };
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
/**
 * The receipt a person reads (#159 ticket E) — on the PR (the body's
 * generated region, so a revision replaces it: one current receipt) and,
 * when unverified, on the issue. What happened, the before/after proofs with
 * their evidence, whether the committed code is the proved code, and — when
 * it's unverified — the decision they're being asked to make. The inline
 * poster is PR-only: pass `{ poster: false }` for the issue tracker, where the
 * nested image link may not render (Jira ADF) or be openable.
 */
export function escalationText(outcome: VerificationOutcome, opts: { poster?: boolean } = {}): string {
  const lines: string[] = [];
  if (outcome.status === "verified") {
    lines.push("**Verified.** The change failed its journeys before and passes them now.");
  } else {
    lines.push("**Unverified — a person needs to decide.** The work was not blocked; it is here for you to judge.", "");
    lines.push(...outcome.reasons.map((r) => `- ${tidy(r)}`));
  }

  const local: string[] = [];
  const rows: string[] = [];
  if (outcome.base) rows.push(`| Before the change | ${codeCell(outcome.base)} | ${resultCell(outcome.base)} | ${evidenceCell(outcome.base, outcome.links, "before the change", local)} |`);
  if (outcome.head) {
    rows.push(`| The change | ${codeCell(outcome.head)} | ${resultCell(outcome.head, outcome.failed_proofs)} | ${evidenceCell(outcome.head, outcome.links, "the change", local)} |`);
  }
  if (rows.length) lines.push("", "| Proof | Code | Result | Evidence |", "|---|---|---|---|", ...rows);

  if (outcome.committed) {
    const sha = `\`${outcome.committed.commit.slice(0, 12)}\``;
    lines.push("", outcome.committed.matches ? `Committed ${sha}: the code that was proved.` : `Committed ${sha}: **not** the code that was proved.`);
  }
  if (outcome.poster && opts.poster !== false) lines.push("", `[![Recording of the change](${outcome.poster.image})](${outcome.poster.href})`);
  if (local.length) lines.push("", "Evidence on the machine that ran the proof (local receipt store):", ...local.map((p) => `- ${p}`));
  const expires = Object.values(outcome.links ?? {})
    .map((l) => ("expires" in l ? l.expires : undefined))
    .filter((e): e is string => Boolean(e))
    .sort()[0];
  if (expires) lines.push("", `_Evidence links expire ${expires.slice(0, 10)}._`);
  if (outcome.status === "unverified") lines.push("", "Decide: merge as it is, ask for a fix, or close it.");
  return lines.join("\n");
}

const EVIDENCE_FIELDS: Array<[keyof ReceiptRef, string]> = [
  ["key", "receipt"],
  ["video", "video"],
  ["contact_sheet", "contact sheet"],
  ["transcript", "transcript"],
];

/** A reason fit for a PR: one line, the home directory shown as `~`, long tool output cut short. */
function tidy(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  const home = homedir();
  if (home && home !== "/") t = t.split(home).join("~");
  return t.length > 300 ? `${t.slice(0, 297)}…` : t;
}

function codeCell(ref: ReceiptRef): string {
  if (!ref.sha) return `tree \`${ref.tree.slice(0, 12)}\``;
  return `\`${ref.sha.slice(0, 12)}\`${ref.dirty ? " + uncommitted work" : ""}`;
}

function resultCell(ref: ReceiptRef, failedProofs = 0): string {
  const verdict = ref.verdict === "CANT_TELL" ? "CAN'T TELL" : ref.verdict;
  const counts = ref.checks
    ? ref.checks.failed === 0
      ? ` · ${ref.checks.total} of ${ref.checks.total} checks passed`
      : ` · ${ref.checks.failed} of ${ref.checks.total} checks failed`
    : "";
  const after = failedProofs > 0 && ref.verdict === "PASS" ? ` · after ${failedProofs} failed proof(s)` : "";
  return `**${verdict}**${counts}${after}`;
}

/** Linked labels for evidence with a URL; for local (or unlinked) evidence, the label here and the path in `local`. */
function evidenceCell(ref: ReceiptRef, links: EvidenceLinks | undefined, stage: string, local: string[]): string {
  const parts: string[] = [];
  for (const [field, label] of EVIDENCE_FIELDS) {
    const key = ref[field];
    if (typeof key !== "string") continue;
    const link = links?.[key];
    if (link && "url" in link) {
      parts.push(`[${label}](${link.url})`);
    } else {
      parts.push(label);
      local.push(`${stage} — ${label}: \`${link && "local" in link ? tidy(link.local) : key}\``);
    }
  }
  return parts.join(" · ") || "—";
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
