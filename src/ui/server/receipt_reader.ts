/**
 * Receipt reader (#202): the read-only side of a receipt store, for the
 * receipts viewer. Types and pure functions only, so the same code runs in
 * `spf ui` (Node) and in a Cloudflare Worker (#204, #137). The one import is
 * the node-free key rule; `import type` from `receipt.ts` is erased.
 *
 * Implementations: `receipt_reader_node.ts` (a directory, or any
 * `ReceiptStore`) and `receipt_reader_r2.ts` (a Workers R2 binding).
 */
import { assertKey } from "../../core/receipt_keys.ts";
import type { EvidenceItem, Receipt } from "../../core/receipt.ts";

export interface ByteRange {
  offset: number;
  /** >= 1 */
  length: number;
}
export interface ReceiptObjectInfo {
  size: number;
  contentType?: string;
  etag?: string;
}
export interface ReceiptObject extends ReceiptObjectInfo {
  body: ReadableStream<Uint8Array>;
}

export interface ReceiptReader {
  /** Human-readable location, for the startup line. */
  readonly location: string;
  /** Top-level key segments (one per repo), sorted. */
  repos(): Promise<string[]>;
  /** Same contract as `ReceiptStore.list`. */
  list(prefix: string): Promise<string[]>;
  /** A small object (receipt.json) as text; null when missing. */
  text(key: string): Promise<string | null>;
  head(key: string): Promise<ReceiptObjectInfo | null>;
  /** `size` is always the full object's size, even for a ranged read. */
  get(key: string, range?: ByteRange): Promise<ReceiptObject | null>;
}

/** `assertKey`'s rules, returning instead of throwing. */
export function isSafeKey(key: string): boolean {
  try {
    assertKey(key);
    return true;
  } catch {
    return false;
  }
}

// ── ranges ──────────────────────────────────────────────────────────────────

export type RangeResult = { kind: "full" } | { kind: "partial"; offset: number; length: number } | { kind: "unsatisfiable" };

/**
 * One `bytes=a-b`, `bytes=a-` or `bytes=-n` is honored. A missing, garbage or
 * multi-range header (or an empty object) is answered with the whole body,
 * which RFC 9110 allows for any Range a server chooses to ignore.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header || size <= 0) return { kind: "full" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "full" };
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return { kind: "unsatisfiable" };
    const length = Math.min(n, size);
    return { kind: "partial", offset: size - length, length };
  }
  const start = Number(m[1]);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return { kind: "full" }; // an inverted range is invalid, hence ignored
  return { kind: "partial", offset: start, length: end - start + 1 };
}

// ── receipts ────────────────────────────────────────────────────────────────

/**
 * A receipt, checked just enough to render: valibot is deliberately not used.
 * A malformed receipt is skipped and the page still loads.
 */
export function parseReceiptLoose(text: string, runId: string): Receipt | null {
  let r: unknown;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof r !== "object" || r === null) return null;
  const o = r as Record<string, unknown>;
  if (o["schema"] !== "spf.receipt/v1" || o["run_id"] !== runId) return null;
  if (o["stage"] !== "base" && o["stage"] !== "head") return null;
  if (!Number.isInteger(o["attempt"])) return null;
  if (typeof o["evidence"] !== "object" || o["evidence"] === null || Array.isArray(o["evidence"])) return null;
  for (const k of ["checks", "journeys", "next"]) {
    if (o[k] !== undefined && !Array.isArray(o[k])) return null;
  }
  const rev = o["revision"];
  if (typeof rev !== "object" || rev === null || typeof (rev as Record<string, unknown>)["sha"] !== "string" || typeof (rev as Record<string, unknown>)["tree"] !== "string") return null;
  return { checks: [], journeys: [], next: [], ...o } as unknown as Receipt;
}

export interface LoadedAttempt {
  /** The receipt.json key. */
  key: string;
  attempt: number;
  receipt: Receipt;
}

export interface SelectedRun {
  repo: string;
  head: LoadedAttempt | null;
  base: LoadedAttempt | null;
  /** Every readable attempt, ascending. */
  attempts: LoadedAttempt[];
  /** Keys the file route may serve -> the evidence item behind each (null for receipt.json itself). */
  allowed: Map<string, EvidenceItem | null>;
}

const RECEIPT_KEY = /^(\d+)\/receipt\.json$/;

async function receiptKeysIn(reader: ReceiptReader, repo: string, runId: string): Promise<{ root: "attempts" | "kept"; keys: string[] } | null> {
  for (const root of ["attempts", "kept"] as const) {
    const prefix = `${repo}/${root}/${runId}/`;
    const keys = (await reader.list(prefix)).filter((k) => RECEIPT_KEY.test(k.slice(prefix.length)));
    if (keys.length) return { root, keys };
  }
  return null;
}

/**
 * Find a run and choose its base and head. Attempt numbers are the ordering
 * (a fix loop re-proves the head, so attempts can alternate); the highest
 * attempt of each stage wins. `{conflict}` lists the repo segments when the
 * run id exists under more than one and `repo` did not choose.
 */
export async function selectRun(reader: ReceiptReader, runId: string, repo?: string): Promise<SelectedRun | { conflict: string[] } | null> {
  const candidates = repo ? [repo] : await reader.repos();
  const found: Array<{ repo: string; root: "attempts" | "kept"; keys: string[] }> = [];
  for (const r of candidates) {
    const hit = await receiptKeysIn(reader, r, runId);
    if (hit) found.push({ repo: r, ...hit });
  }
  if (found.length === 0) return null;
  if (found.length > 1) return { conflict: found.map((f) => f.repo) };
  const { repo: chosen, root, keys } = found[0];

  const attempts: LoadedAttempt[] = [];
  for (const key of keys) {
    const text = await reader.text(key);
    const receipt = text === null ? null : parseReceiptLoose(text, runId);
    if (receipt) attempts.push({ key, attempt: receipt.attempt, receipt });
  }
  attempts.sort((a, b) => a.attempt - b.attempt);

  // promoteRun copies the objects, but the keys inside the receipt still say `attempts/`.
  const written = `${chosen}/attempts/${runId}/`;
  const here = `${chosen}/${root}/${runId}/`;
  const allowed = new Map<string, EvidenceItem | null>();
  for (const a of attempts) {
    allowed.set(a.key, null);
    for (const item of Object.values(a.receipt.evidence)) {
      if (!item || typeof item.key !== "string") continue;
      if (root === "kept" && item.key.startsWith(written)) item.key = here + item.key.slice(written.length);
      if (item.key.startsWith(here) && isSafeKey(item.key)) allowed.set(item.key, item);
    }
  }

  const latest = (stage: "base" | "head") => [...attempts].reverse().find((a) => a.receipt.stage === stage) ?? null;
  return { repo: chosen, head: latest("head"), base: latest("base"), attempts, allowed };
}

// ── the SPA behind /r/<run_id> ──────────────────────────────────────────────

/**
 * vite builds with `base: "./"`, so at `/r/issue-198` the page asks for
 * `/r/assets/x.js`. Map that back to `/assets/x.js`; null for anything else.
 */
export function viewerAssetPath(pathname: string): string | null {
  const m = /^(.*)\/r\/(assets\/.+|[^/]+\.(?:js|css|svg|png|ico|woff2?|map))$/.exec(pathname);
  return m ? `/${m[2]}` : null;
}
