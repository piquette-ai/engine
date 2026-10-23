/** Synthetic receipts for the receipts viewer tests (#202): a run with a base and a head attempt, and a 256-byte video. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const VIDEO = Uint8Array.from({ length: 256 }, (_, i) => i);
export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export interface FixtureObjects {
  [key: string]: Uint8Array | string;
}

export function receiptJson(opts: {
  repo: string;
  runId: string;
  attempt: number;
  stage: "base" | "head";
  verdict?: "PASS" | "FAIL" | "CANT_TELL";
  root?: "attempts" | "kept";
  failed?: number;
  total?: number;
}): { json: string; videoKey: string } {
  const { repo, runId, attempt, stage } = opts;
  const total = opts.total ?? 3;
  const failed = opts.failed ?? (stage === "base" ? 1 : 0);
  const dir = `${repo}/attempts/${runId}/${attempt}`; // keys are written as attempts/, even once promoted
  const videoKey = `${dir}/video.mp4`;
  const receipt = {
    schema: "spf.receipt/v1",
    run_id: runId,
    attempt,
    repo,
    issue: "202",
    stage,
    revision: { sha: "a".repeat(40), tree: "b".repeat(40), dirty: false },
    verdict: opts.verdict ?? (failed ? "FAIL" : "PASS"),
    reason: failed ? `${failed} of ${total} checks failed` : "all checks passed",
    next: [],
    at: `2026-10-22T10:0${attempt}:00.000Z`,
    subject: { kind: "console" },
    journeys: [{ id: "j1", criterion: "it works", steps: [{ name: "run", ms: 10, exit: 0 }] }],
    checks: Array.from({ length: total }, (_, i) => ({ journey: "j1", name: `check-${i}`, expected: 0, actual: i < failed ? 1 : 0, pass: i >= failed })),
    judgments: [],
    observations: {},
    evidence: {
      video: { key: videoKey, content_type: "video/mp4", bytes: VIDEO.byteLength, sha256: sha(VIDEO), duration_s: 2 },
      transcript: { key: `${dir}/terminal.txt`, content_type: "text/plain", bytes: 5, sha256: sha("hello") },
    },
  };
  return { json: JSON.stringify(receipt), videoKey };
}

/** Objects for one run: attempt 1 = base (FAIL), attempt 2 = head (PASS), plus a file the receipts do not list. */
export function runObjects(repo: string, runId: string, root: "attempts" | "kept" = "attempts"): FixtureObjects {
  const out: FixtureObjects = {};
  const at = (n: number, file: string) => `${repo}/${root}/${runId}/${n}/${file}`;
  for (const [n, stage] of [[1, "base"], [2, "head"]] as const) {
    out[at(n, "receipt.json")] = receiptJson({ repo, runId, attempt: n, stage }).json;
    out[at(n, "video.mp4")] = VIDEO;
    out[at(n, "terminal.txt")] = "hello";
  }
  out[at(2, "secret.txt")] = "not listed";
  return out;
}

export function writeLocal(root: string, objects: FixtureObjects): void {
  for (const [key, body] of Object.entries(objects)) {
    const file = path.join(root, ...key.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
}

import type { R2BucketLike } from "../ui/server/receipt_reader_r2.ts";

/** An in-memory R2 bucket. `pageSize` forces list pagination; `calls` records what the reader asked for. */
export function fakeR2(objects: FixtureObjects, pageSize = 1000): R2BucketLike & { calls: { get: Array<{ key: string; range?: { offset: number; length: number } }> } } {
  const bytes = (v: Uint8Array | string) => (typeof v === "string" ? new TextEncoder().encode(v) : v);
  const calls = { get: [] as Array<{ key: string; range?: { offset: number; length: number } }> };
  const meta = (key: string) => ({ size: bytes(objects[key]).byteLength, etag: `etag-${key}`, httpMetadata: key.endsWith(".mp4") ? { contentType: "video/mp4" } : undefined });
  return {
    calls,
    async head(key) {
      return key in objects ? meta(key) : null;
    },
    async get(key, opts) {
      calls.get.push({ key, range: opts?.range });
      if (!(key in objects)) return null;
      const all = bytes(objects[key]);
      const r = opts?.range;
      const slice = r ? all.subarray(r.offset, r.offset + r.length) : all;
      return {
        ...meta(key),
        body: new ReadableStream({
          start(c) {
            c.enqueue(slice);
            c.close();
          },
        }),
        text: async () => new TextDecoder().decode(slice),
      };
    },
    async list({ prefix = "", delimiter, cursor }) {
      const keys = Object.keys(objects).filter((k) => k.startsWith(prefix)).sort();
      if (delimiter) {
        const set = new Set<string>();
        for (const k of keys) {
          const rest = k.slice(prefix.length);
          const i = rest.indexOf(delimiter);
          if (i >= 0) set.add(prefix + rest.slice(0, i + 1));
        }
        const all = [...set].sort();
        const start = cursor ? Number(cursor) : 0;
        const page = all.slice(start, start + pageSize);
        const more = start + pageSize < all.length;
        return { objects: [], delimitedPrefixes: page, truncated: more, cursor: more ? String(start + pageSize) : undefined };
      }
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + pageSize);
      const more = start + pageSize < keys.length;
      return { objects: page.map((key) => ({ key })), delimitedPrefixes: [], truncated: more, cursor: more ? String(start + pageSize) : undefined };
    },
  };
}
