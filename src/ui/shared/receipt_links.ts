/**
 * Pure helpers for surfacing a session's verification receipts in the
 * dashboard (#214): which repo segment to ask the receipts API for, how to
 * read before/after out of `/api/receipts/<run_id>`, which attempt a
 * `prove_*` phase produced, and the viewer link. No DOM, no fetch.
 */
import { segmentFromSlug } from "../../core/repo_segment_name.js";
import type { ReceiptAttemptSummary, ReceiptEvidenceItem, ReceiptJson, ReceiptsRunResponse, ReceiptVerdict } from "./types.js";

/** The receipt store's repo segment for a synced session's `host/owner/name` slug; null when unknown or empty. */
export function receiptRepoSegment(repoSlug: string | null | undefined): string | null {
  if (!repoSlug) return null;
  return segmentFromSlug(repoSlug) || null;
}

/** A phase that proves the change: `prove_base` (before) or `prove_<n>` (after). */
export function isProvePhase(name: string | null | undefined): boolean {
  return name === "prove_base" || /^prove_\d+$/.test(name ?? "");
}

export interface ReceiptSide {
  verdict: ReceiptVerdict;
  total: number;
  failed: number;
}

/**
 * Evidence journeys wrote themselves (#235), grouped by journey id, in the
 * receipt's journey order and then by file name. Entries are `[name, item]`
 * for names `journey:<id>/<rel>` whose `item.journey` is set.
 */
export function journeyEvidence(receipt: Pick<ReceiptJson, "journeys" | "evidence">): Map<string, Array<[string, ReceiptEvidenceItem]>> {
  const byJourney = new Map<string, Array<[string, ReceiptEvidenceItem]>>();
  for (const j of receipt.journeys ?? []) byJourney.set(j.id, []);
  for (const [name, item] of Object.entries(receipt.evidence)) {
    if (!name.startsWith("journey:") || !item.journey) continue;
    const list = byJourney.get(item.journey) ?? [];
    list.push([name, item]);
    byJourney.set(item.journey, list);
  }
  for (const list of byJourney.values()) list.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [id, list] of [...byJourney]) if (list.length === 0) byJourney.delete(id);
  return byJourney;
}

/** Journey evidence files that were rejected or failed to upload (#235), grouped by journey id. */
export function droppedEvidence(receipt: Pick<ReceiptJson, "observations">): Map<string, Array<{ file: string; reason: string }>> {
  const raw = receipt.observations?.evidence_dropped;
  const out = new Map<string, Array<{ file: string; reason: string }>>();
  if (!Array.isArray(raw)) return out;
  for (const d of raw as Array<{ journey?: unknown; file?: unknown; reason?: unknown }>) {
    if (typeof d?.journey !== "string" || typeof d.file !== "string") continue;
    const list = out.get(d.journey) ?? [];
    list.push({ file: d.file, reason: String(d.reason ?? "") });
    out.set(d.journey, list);
  }
  return out;
}

export type EvidenceKind = "video" | "image" | "text";
export function evidenceKind(item: Pick<ReceiptEvidenceItem, "content_type">): EvidenceKind {
  const t = item.content_type.toLowerCase();
  return t.startsWith("video/") ? "video" : t.startsWith("image/") ? "image" : "text";
}

/** The first journey video, else the first journey image, of an attempt; null when it has none. */
export function firstEvidenceMedia(v: ReceiptsRunResponse["head"]): { key: string; kind: "video" | "image" } | null {
  if (!v) return null;
  const all = [...journeyEvidence(v.receipt).values()].flat().map(([, item]) => item);
  const video = all.find((i) => evidenceKind(i) === "video");
  if (video) return { key: video.key, kind: "video" };
  const image = all.find((i) => evidenceKind(i) === "image");
  return image ? { key: image.key, kind: "image" } : null;
}

export interface ReceiptsSummary {
  before: ReceiptSide | null;
  after: ReceiptSide | null;
  /** Poster of the head attempt (falling back to base). */
  posterKey: string | null;
  /** The recording the viewer should open on: head video, else its source, else base's. */
  videoKey: string | null;
  /** The head attempt's first journey video, else first image (#235). Base is not used: the block shows the change. */
  evidenceMedia: { key: string; kind: "video" | "image" } | null;
}

const side = (v: ReceiptsRunResponse["head"]): ReceiptSide | null =>
  v ? { verdict: v.receipt.verdict, total: v.receipt.checks.length, failed: v.receipt.checks.filter((c) => !c.pass).length } : null;

const recordingOf = (v: ReceiptsRunResponse["head"]): string | null => v?.receipt.evidence["video"]?.key ?? v?.receipt.evidence["source"]?.key ?? null;

/** Null when the run has neither a base nor a head receipt. */
export function summarizeReceipts(run: ReceiptsRunResponse): ReceiptsSummary | null {
  if (!run.head && !run.base) return null;
  return {
    before: side(run.base),
    after: side(run.head),
    posterKey: run.head?.receipt.evidence["poster"]?.key ?? run.base?.receipt.evidence["poster"]?.key ?? null,
    videoKey: recordingOf(run.head) ?? recordingOf(run.base),
    evidenceMedia: firstEvidenceMedia(run.head),
  };
}

/**
 * The attempt a prove phase wrote: `prove_base` is the base attempt, `prove_<n>`
 * the n-th head attempt (a fix loop re-proves the head). Null when not recorded.
 */
export function attemptForPhase(phaseName: string | null | undefined, run: ReceiptsRunResponse | null): ReceiptAttemptSummary | null {
  if (!run || !phaseName) return null;
  if (phaseName === "prove_base") return [...run.attempts].reverse().find((a) => a.stage === "base") ?? null;
  const m = /^prove_(\d+)$/.exec(phaseName);
  if (!m) return null;
  return run.attempts.filter((a) => a.stage === "head")[Number(m[1]) - 1] ?? null;
}

/**
 * The viewer link `<base>/r/<run_id>?repo=&key=` (relative to the mount base, which may be empty).
 * `key` is an evidence or receipt key to open on.
 */
export function viewerHref(base: string, runId: string, repo?: string | null, key?: string | null): string {
  const q = [repo ? `repo=${encodeURIComponent(repo)}` : "", key ? `key=${encodeURIComponent(key)}` : ""].filter(Boolean).join("&");
  return `${base}/r/${encodeURIComponent(runId)}${q ? `?${q}` : ""}`;
}

/**
 * The receipt key a prove phase recorded in its own `log` event
 * (`{ receipt: <key> }`), the last one winning. Null when none was written.
 */
export function receiptKeyFromEvents(events: ReadonlyArray<{ type: string | null; payload_json: string | null }>): string | null {
  let key: string | null = null;
  for (const e of events) {
    if (e.type !== "log" || !e.payload_json) continue;
    try {
      const k = (JSON.parse(e.payload_json) as { receipt?: unknown }).receipt;
      if (typeof k === "string" && k) key = k;
    } catch {
      /* truncated payloads carry no key */
    }
  }
  return key;
}

/**
 * Changes once per finished prove phase (not when one starts, not every poll),
 * so a watched session refetches exactly when a receipt may have landed.
 */
export function settledProveKey(phases: ReadonlyArray<{ name: string | null; status: string | null; ended_at: string | null }>): string {
  return phases
    .filter((p) => isProvePhase(p.name) && (p.status === "success" || p.status === "fail"))
    .map((p) => `${p.name}@${p.ended_at ?? ""}`)
    .join("|");
}

export type ReceiptLoad =
  | { state: "ready"; run: ReceiptsRunResponse }
  | { state: "off" }
  | { state: "none" }
  | { state: "conflict"; candidates: string[] };

type FetchRun = (runId: string, repo: string | null) => Promise<ReceiptsRunResponse>;

/**
 * Fetch a session's receipt run and classify the outcome. A 404 under a given
 * repo segment retries without it, since a receipt written under a legacy
 * segment is still found by run id alone. 404 "no receipt store" and 503 mean
 * the module is off; a 409 carries the repos to pick from.
 */
export async function loadReceipts(fetchRun: FetchRun, runId: string, repo: string | null): Promise<ReceiptLoad> {
  type Err = Error & { status?: number; candidates?: string[] };
  const classify = (e: unknown): ReceiptLoad | "missing" => {
    const err = e as Err;
    if (err.status === 503 || (err.status === 404 && /no receipt store/.test(err.message))) return { state: "off" };
    if (err.status === 409) return { state: "conflict", candidates: err.candidates ?? [] };
    if (err.status === 404) return "missing";
    return { state: "none" };
  };
  try {
    return { state: "ready", run: await fetchRun(runId, repo) };
  } catch (e) {
    const c = classify(e);
    if (c !== "missing") return c;
    if (!repo) return { state: "none" };
  }
  try {
    return { state: "ready", run: await fetchRun(runId, null) };
  } catch (e) {
    const c = classify(e);
    return c === "missing" ? { state: "none" } : c;
  }
}
