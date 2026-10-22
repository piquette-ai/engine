/**
 * Verification receipts (#159, ticket A / #173): the record a proof writes
 * and a gate reads — the verdict, the checks behind it, the evidence, and
 * the exact revision it proves.
 *
 * Three verdicts, not two. CANT_TELL (missing evidence, a recorder that
 * failed, no checks at all, a revision that moved mid-proof) is never a
 * pass and never a product failure either: it means "no evidence", and it
 * wins over PASS. See docs/brainstorms/verification-receipts.md.
 *
 * A receipt belongs to ONE revision: HEAD's sha plus a hash of everything
 * not yet committed (tracked changes AND untracked files — a builder's new,
 * unstaged file changes behavior just as much as an edit does). Any later
 * commit or edit makes it stale, and a stale receipt proves nothing.
 *
 * This module is pure data + I/O helpers. Nothing here runs journeys or
 * records video (ticket B) or gates a commit (ticket D).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { makeEventRecord, type EventRecord } from "./data_types.ts";
import { assertKey, type ReceiptStore, type StoredObject } from "./receipt_store.ts";

export const RECEIPT_SCHEMA_VERSION = "spf.receipt/v1";
/** Written as `type: "log"`, like decisions — a receipt is a note about the run, not a new lifecycle stage. */
export const RECEIPT_EVENT = "receipt";

// ── schema ──────────────────────────────────────────────────────────────────

export const VERDICTS = ["PASS", "FAIL", "CANT_TELL"] as const;
export const VerdictSchema = v.picklist(VERDICTS);
export type Verdict = v.InferOutput<typeof VerdictSchema>;

/**
 * Which proof this is. `base` runs the planned journeys on the revision
 * BEFORE the change and is expected to FAIL (red-before-green: a proof that
 * passes on the broken code can't tell broken from fixed). `head` is the
 * proof of the change itself.
 */
export const ReceiptStageSchema = v.picklist(["base", "head"]);
export type ReceiptStage = v.InferOutput<typeof ReceiptStageSchema>;

export const RevisionSchema = v.object({
  /** The HEAD commit the proof ran on top of. */
  sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/, "revision.sha must be a full 40-character commit sha")),
  /** The git tree of the working tree that was proved — the receipt's identity (see `revisionOf`). */
  tree: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/, "revision.tree must be a full 40-character tree id")),
  /** True when that tree differs from HEAD's (the proof ran on uncommitted work). */
  dirty: v.boolean(),
});
export type Revision = v.InferOutput<typeof RevisionSchema>;

export const CheckSchema = v.object({
  journey: v.string(),
  name: v.string(),
  expected: v.unknown(),
  actual: v.unknown(),
  pass: v.boolean(),
  hint: v.optional(v.string()),
});
export type Check = v.InferOutput<typeof CheckSchema>;

export const JourneySchema = v.object({
  id: v.string(),
  criterion: v.string(),
  steps: v.array(
    v.object({
      name: v.string(),
      ms: v.pipe(v.number(), v.minValue(0)),
      exit: v.nullable(v.number()),
    }),
  ),
});
export type Journey = v.InferOutput<typeof JourneySchema>;

/** A decision-model judgment over observed evidence (slice 7). Empty in the walking skeleton. */
export const JudgmentSchema = v.object({
  kind: v.string(),
  model: v.string(),
  rubric_version: v.optional(v.string()),
  question: v.string(),
  p_yes: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  threshold: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});
export type Judgment = v.InferOutput<typeof JudgmentSchema>;

export const EvidenceItemSchema = v.object({
  key: v.string(),
  content_type: v.string(),
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  duration_s: v.optional(v.number()),
});
export type EvidenceItem = v.InferOutput<typeof EvidenceItemSchema>;

const segment = (what: string) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.check((s) => !s.includes("/") && s !== "." && s !== "..", `${what} must be a single key segment (no "/", ".", "..")`),
  );

export const ReceiptSchema = v.object({
  schema: v.literal(RECEIPT_SCHEMA_VERSION),
  run_id: segment("run_id"),
  attempt: v.pipe(v.number(), v.integer(), v.minValue(1)),
  repo: segment("repo"),
  issue: v.nullable(v.string()),
  stage: ReceiptStageSchema,
  revision: RevisionSchema,
  verdict: VerdictSchema,
  reason: v.string(),
  next: v.array(v.string()),
  at: v.pipe(v.string(), v.isoTimestamp()),
  subject: v.object({ kind: v.picklist(["console", "web"]), detail: v.optional(v.string()) }),
  journeys: v.array(JourneySchema),
  checks: v.array(CheckSchema),
  judgments: v.array(JudgmentSchema),
  observations: v.record(v.string(), v.unknown()),
  /** Named evidence: `video`, `poster`, `contact_sheet`, `screenshot:<name>`, … */
  evidence: v.record(v.string(), EvidenceItemSchema),
});
export type Receipt = v.InferOutput<typeof ReceiptSchema>;

// ── verdict ─────────────────────────────────────────────────────────────────

export interface VerdictInput {
  checks: Check[];
  /** Every reason the proof could not tell: missing evidence, a recorder failure, a moved revision, … */
  cantTell: string[];
  /** Short revision label for messages, e.g. `ad0f387e7070+3f2a…`. */
  revisionLabel?: string;
}

/**
 * The ONE place a verdict is derived. Precedence, by design:
 *   1. any CANT_TELL cause  → CANT_TELL (missing evidence is never a pass)
 *   2. no checks recorded   → CANT_TELL (a proof that checked nothing proved nothing)
 *   3. every check passes   → PASS
 *   4. otherwise            → FAIL
 */
export function decideVerdict(input: VerdictInput): { verdict: Verdict; reason: string; next: string[] } {
  if (input.cantTell.length > 0) {
    return {
      verdict: "CANT_TELL",
      reason: input.cantTell.join("; "),
      next: ["Missing evidence is not a product failure, and never a pass. Fix the environment, then prove again."],
    };
  }
  if (input.checks.length === 0) {
    return {
      verdict: "CANT_TELL",
      reason: "no checks were recorded",
      next: ["A proof that checked nothing proved nothing. Add at least one check per journey."],
    };
  }
  const failed = input.checks.filter((c) => !c.pass);
  const on = input.revisionLabel ? ` on ${input.revisionLabel}` : "";
  if (failed.length === 0) {
    return {
      verdict: "PASS",
      reason: `${input.checks.length} check(s) passed${on}`,
      next: ["These checks cover nothing else: watch the video for anything they missed. Any new commit or edit makes this receipt stale."],
    };
  }
  return {
    verdict: "FAIL",
    reason: `${failed.length} of ${input.checks.length} check(s) failed${on}`,
    next: failed.map((c) => c.hint ?? `${c.journey} "${c.name}": expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`),
  };
}

// ── revision binding ────────────────────────────────────────────────────────

function git(repoRoot: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, ...(env ? { env } : {}) });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${repoRoot}: ${(result.stderr || "").trim().split("\n")[0] || `exit ${result.status}`}`);
  }
  return result.stdout;
}

export interface RevisionOptions {
  /** Repo-relative paths left out of the revision — the proof's own output directory, never product code. */
  exclude?: string[];
}

/**
 * Repo-relative paths a proof must leave out of the revision: a LOCAL store
 * whose root is inside the repo (its receipts and videos are the proof's
 * output, not the thing being proved). Nothing for a remote store or a local
 * store outside the repo.
 */
export function storeExclusions(store: ReceiptStore, repoRoot: string): string[] {
  if (store.kind !== "local") return [];
  const rel = path.relative(path.resolve(repoRoot), store.location);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return [];
  return [rel.split(path.sep).join("/")];
}

/**
 * The revision a proof binds to: the git TREE of the working tree as it is
 * right now — tracked changes and untracked (non-ignored) files included —
 * plus the HEAD it sits on.
 *
 * Identity is the tree, not HEAD's sha: a proof runs on the uncommitted
 * build, and committing exactly that content produces a commit whose
 * `^{tree}` IS this tree — so a receipt still proves the commit it ends up
 * in, and any edit (committed or not) is a different tree. The tree is
 * written through a throwaway index (`GIT_INDEX_FILE`), so the user's own
 * index and staging are never touched.
 *
 * Throws when `repoRoot` is not a git repository with a HEAD commit — the
 * caller turns that into CANT_TELL, never into a revision-less receipt.
 */
export function revisionOf(repoRoot: string, options: RevisionOptions = {}): Revision {
  const sha = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  const headTree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]).trim();
  const scratch = mkdtempSync(path.join(tmpdir(), "spf-revision-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, "index") };
    git(repoRoot, ["read-tree", "HEAD"], env);
    // `:(exclude)` pathspecs keep the proof's own output (a local receipt
    // store inside the repo) out of the revision it is proving — found by
    // dogfooding: writing the video changed the revision mid-proof. Excluded
    // paths keep whatever HEAD has for them.
    //
    // Only for paths git would actually put in the tree. `git add` refuses a
    // pathspec naming an ignored path, and one reaching "beyond a symbolic
    // link" — and neither can enter the tree anyway. Both found by the #179
    // pilot: the DEFAULT store (`.spf/data/receipts`) is gitignored, and in
    // a `spf watch` worktree `.spf/data` is a symlink to the main checkout's
    // data dir; either one made every proof CAN'T TELL.
    const exclude = (options.exclude ?? []).filter((p) => gitWouldInclude(repoRoot, p));
    const pathspec = exclude.length ? ["--", ".", ...exclude.map((p) => `:(exclude)${p}`)] : [];
    git(repoRoot, ["add", "-A", ...pathspec], env);
    const tree = git(repoRoot, ["write-tree"], env).trim();
    return { sha, tree, dirty: tree !== headTree };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Whether `git add -A` could put `rel` (repo-relative) in the tree — i.e.
 * whether an `:(exclude)` for it is both needed and legal. `check-ignore`
 * exits 1 for a valid, not-ignored path; 0 means ignored, and 128 means git
 * can't even address it (e.g. it lies beyond a symbolic link). Only 1 keeps
 * the exclusion.
 */
function gitWouldInclude(repoRoot: string, rel: string): boolean {
  return spawnSync("git", ["check-ignore", "-q", rel], { cwd: repoRoot }).status === 1;
}

/** The tree a commit points at — what the commit step compares a receipt's `tree` against. */
export function treeOf(repoRoot: string, ref: string): string {
  return git(repoRoot, ["rev-parse", `${ref}^{tree}`]).trim();
}

export function revisionLabel(revision: Revision): string {
  return `${revision.sha.slice(0, 12)}${revision.dirty ? `+tree ${revision.tree.slice(0, 8)}` : ""}`;
}

/** Same content — the only identity that matters for a proof. */
export function sameRevision(a: Revision, b: Revision): boolean {
  return a.tree === b.tree;
}

/**
 * Is `receipt` still evidence for the working tree at `repoRoot`? A receipt
 * is stale after ANY commit or edit — including one that only reverts back
 * to the proven state, which is fresh again (same bytes, same hash).
 */
export function isStale(receipt: Pick<Receipt, "revision">, repoRoot: string, options: RevisionOptions = {}): { stale: boolean; current: Revision; reason: string } {
  const current = revisionOf(repoRoot, options);
  if (sameRevision(receipt.revision, current)) return { stale: false, current, reason: `fresh: proves ${revisionLabel(current)}` };
  const why =
    receipt.revision.sha !== current.sha
      ? `the content changed (HEAD moved from ${receipt.revision.sha.slice(0, 12)} to ${current.sha.slice(0, 12)})`
      : "the working tree changed since the proof";
  return { stale: true, current, reason: `stale: ${why}; this receipt proves ${revisionLabel(receipt.revision)}` };
}

// ── store layout ────────────────────────────────────────────────────────────

export function attemptPrefix(repo: string, runId: string, attempt: number): string {
  return `${repo}/attempts/${runId}/${attempt}/`;
}

export function receiptKey(repo: string, runId: string, attempt: number): string {
  return assertKey(`${attemptPrefix(repo, runId, attempt)}receipt.json`);
}

/** Where a piece of evidence for an attempt is stored, e.g. `evidenceKey(…, "video.mp4")`. */
export function evidenceKey(repo: string, runId: string, attempt: number, name: string): string {
  return assertKey(`${attemptPrefix(repo, runId, attempt)}${name}`);
}

/** Validates, then writes the receipt as pretty JSON. Refuses an invalid receipt rather than storing it. */
export async function writeReceipt(store: ReceiptStore, receipt: Receipt): Promise<StoredObject> {
  const valid = v.parse(ReceiptSchema, receipt);
  return store.put(receiptKey(valid.repo, valid.run_id, valid.attempt), JSON.stringify(valid, null, 2) + "\n", "application/json");
}

export async function readReceipt(store: ReceiptStore, key: string): Promise<Receipt | null> {
  const bytes = await store.get(key);
  if (!bytes) return null;
  return v.parse(ReceiptSchema, JSON.parse(new TextDecoder().decode(bytes)));
}

/** Attempt numbers that have a receipt for this run, ascending (numeric, so 10 sorts after 9). */
export async function listAttempts(store: ReceiptStore, repo: string, runId: string): Promise<number[]> {
  const prefix = `${repo}/attempts/${runId}/`;
  const attempts = new Set<number>();
  for (const key of await store.list(prefix)) {
    const m = key.slice(prefix.length).match(/^(\d+)\/receipt\.json$/);
    if (m) attempts.add(Number(m[1]));
  }
  return [...attempts].sort((a, b) => a - b);
}

export async function nextAttempt(store: ReceiptStore, repo: string, runId: string): Promise<number> {
  const attempts = await listAttempts(store, repo, runId);
  return attempts.length === 0 ? 1 : attempts[attempts.length - 1] + 1;
}

/** The newest receipt for a run — optionally only of one stage (the commit gate wants the latest `head`). */
export async function readLatestReceipt(store: ReceiptStore, repo: string, runId: string, stage?: ReceiptStage): Promise<Receipt | null> {
  const attempts = await listAttempts(store, repo, runId);
  for (let i = attempts.length - 1; i >= 0; i--) {
    const receipt = await readReceipt(store, receiptKey(repo, runId, attempts[i]));
    if (receipt && (!stage || receipt.stage === stage)) return receipt;
  }
  return null;
}

// ── trace ───────────────────────────────────────────────────────────────────

/** The trace row for a written receipt: enough for the dashboard and replay to find it, not a copy of it. */
export function receiptEventRecord(receipt: Receipt, storeKey: string, adwId: string, phaseId = ""): EventRecord {
  return makeEventRecord({
    adw_id: adwId,
    phase_id: phaseId,
    type: "log",
    name: RECEIPT_EVENT,
    payload: {
      run_id: receipt.run_id,
      attempt: receipt.attempt,
      stage: receipt.stage,
      verdict: receipt.verdict,
      reason: receipt.reason,
      revision: receipt.revision,
      key: storeKey,
      checks: { total: receipt.checks.length, failed: receipt.checks.filter((c) => !c.pass).length },
      evidence: Object.fromEntries(Object.entries(receipt.evidence).map(([name, item]) => [name, item.key])),
    },
  });
}
