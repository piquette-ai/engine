/**
 * The proof (#159, ticket B / #174): run a ticket's journeys plus the repo's
 * non-negotiables against the current revision, optionally record them, and
 * write a receipt. `spf prove` is a thin CLI over `prove()`; ticket D's chain
 * step calls `prove()` directly.
 *
 *   revision → journeys (+ non-negotiables) → [recording → upload]
 *            → revision again → verdict → receipt
 *
 * Evidence decides, and missing evidence is never a pass: a recorder
 * failure, a journey that couldn't run, or a revision that moved during the
 * proof all make the receipt CAN'T TELL. A receipt is always written when a
 * revision could be read — a failed or inconclusive proof is evidence too.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConsoleRecorder } from "./recorder.ts";
import { waitFor } from "./recorder.ts";
import { mergeJourneys, runJourneys, type JourneySpec } from "./journeys.ts";
import {
  decideVerdict,
  evidenceKey,
  nextAttempt,
  RECEIPT_SCHEMA_VERSION,
  revisionLabel,
  revisionOf,
  sameRevision,
  storeExclusions,
  writeReceipt,
  type EvidenceItem,
  type Receipt,
  type ReceiptStage,
} from "./receipt.ts";
import { createReceiptStore, type ReceiptStore } from "./receipt_store.ts";
import type { SFConfig } from "./data_types.ts";

/** A proof that could not even start (no git revision to bind to). There is no receipt to write. */
export class ProofCannotStart extends Error {}

/** A store key segment from a directory name: lowercase, `[a-z0-9._-]`, never empty. */
export function repoSegment(repoRoot: string): string {
  const s = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "");
  return s || "repo";
}

/** The receipt store for a repo: `receipts.store`, or a local store in the gitignored data dir. Shared by `spf prove` and the chain steps. */
export function proofStore(cfg: Pick<SFConfig, "receipts">, repoRoot: string): ReceiptStore {
  return createReceiptStore(cfg.receipts?.store ?? { kind: "local", path: ".spf/data/receipts" }, { repoRoot });
}

export interface ProveParams {
  repoRoot: string;
  store: ReceiptStore;
  /** Store namespace for this repo — a single key segment. */
  repo: string;
  runId: string;
  issue: string | null;
  stage: ReceiptStage;
  journeys: JourneySpec[];
  nonNegotiables?: JourneySpec[];
  /** Records the journeys when given; no recorder means no video (the receipt says so). */
  recorder?: ConsoleRecorder;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface ProveResult {
  receipt: Receipt;
  key: string;
}

const CONTENT_TYPES: Record<string, string> = {
  video: "video/mp4",
  poster: "image/gif",
  contact_sheet: "image/png",
  source: "video/webm",
  transcript: "text/plain; charset=utf-8",
};
const FILE_NAMES: Record<string, string> = {
  video: "video.mp4",
  poster: "poster.gif",
  contact_sheet: "contact-sheet.png",
  source: "source.webm",
  transcript: "terminal.txt",
};

export async function prove(params: ProveParams): Promise<ProveResult> {
  const now = params.now ?? (() => new Date());
  // The proof's own output (a local store inside the repo) is not part of what it proves.
  const revisionOptions = { exclude: storeExclusions(params.store, params.repoRoot) };
  let revision;
  try {
    revision = revisionOf(params.repoRoot, revisionOptions);
  } catch (error) {
    throw new ProofCannotStart(`can't bind a proof to a revision: ${(error as Error).message}`);
  }

  const specs = mergeJourneys(params.journeys, params.nonNegotiables ?? []);
  const attempt = await nextAttempt(params.store, params.repo, params.runId);
  const outcome = runJourneys(specs, { cwd: params.repoRoot, env: params.env });
  const cantTell = [...outcome.cantTell];
  const evidence: Record<string, EvidenceItem> = {};
  const observations: Record<string, unknown> = {
    coverage: outcome.coverage,
    outputs: Object.fromEntries(outcome.runs.map((r) => [r.spec.id, r.output])),
  };

  if (params.recorder && cantTell.length === 0) {
    const workDir = mkdtempSync(path.join(tmpdir(), "spf-proof-"));
    try {
      const recording = await params.recorder.record(
        outcome.runs.map((r) => ({ command: r.spec.run, wait_ms: waitFor(r.ms) })),
        { cwd: params.repoRoot, workDir, title: `proof ${params.runId}#${attempt} · ${params.stage} · ${revisionLabel(revision)}` },
      );
      for (const [name, file] of Object.entries(recording.files)) {
        const stored = await params.store.put(evidenceKey(params.repo, params.runId, attempt, FILE_NAMES[name]), readFileSync(file), CONTENT_TYPES[name]);
        evidence[name] = { key: stored.key, content_type: stored.content_type, bytes: stored.bytes, sha256: stored.sha256 };
      }
      if (evidence.video) evidence.video.duration_s = recording.duration_s;
      observations.recording = "agent-browser + ttyd; the video is a second execution of the same commands";
    } catch (error) {
      cantTell.push(`recording failed: ${(error as Error).message}`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  } else if (!params.recorder) {
    observations.recording = "not recorded (no recorder)";
  }

  // Evidence from two builds proves neither.
  try {
    const after = revisionOf(params.repoRoot, revisionOptions);
    if (!sameRevision(revision, after)) {
      cantTell.push(`the revision changed during the proof (${revisionLabel(revision)} → ${revisionLabel(after)})`);
    }
  } catch (error) {
    cantTell.push(`can't re-read the revision after the proof: ${(error as Error).message}`);
  }

  const { verdict, reason, next } = decideVerdict({ checks: outcome.checks, cantTell, revisionLabel: revisionLabel(revision) });
  const receipt: Receipt = {
    schema: RECEIPT_SCHEMA_VERSION,
    run_id: params.runId,
    attempt,
    repo: params.repo,
    issue: params.issue,
    stage: params.stage,
    revision,
    verdict,
    reason,
    next,
    at: now().toISOString(),
    subject: { kind: "console" },
    journeys: outcome.journeys,
    checks: outcome.checks,
    judgments: [],
    observations,
    evidence,
  };
  const stored = await writeReceipt(params.store, receipt);
  return { receipt, key: stored.key };
}
