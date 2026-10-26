/**
 * Receipts viewer routes (#202), mountable anywhere Hono runs: `piquette ui`, the
 * federated microsite (#197c) and the hosted hub (#137). Worker-safe — the
 * only imports are hono and the pure reader module.
 *
 *   GET      /api/receipts/:run_id[?repo=]            base + head receipts and the attempt list
 *   GET|HEAD /api/receipts/:run_id/file?key=[&repo=]  one evidence file, with Range support
 *
 * A file is served only if the run's own receipts name it, so a key can't
 * reach another run's objects, and a forged receipt can't point elsewhere
 * (see `selectRun`). Reader exceptions propagate to the app's onError (500).
 * Nothing here runs inside `piquette watch`, so it can never block a run or a PR.
 */
import { Hono, type Context, type Env } from "hono";
import { isSafeKey, parseRange, selectRun, type LoadedAttempt, type ReceiptReader } from "./receipt_reader.ts";
import type { ApiError, ReceiptJson, ReceiptsRunResponse, ReceiptView } from "../shared/types.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const isSafeSegment = (v: string) => SAFE_SEGMENT.test(v) && v !== "." && v !== "..";

/** The types `prove` writes. Anything else (a forged receipt claiming text/html) is served as opaque bytes. */
const SERVED_TYPES: Record<string, string> = {
  "video/mp4": "video/mp4",
  "video/webm": "video/webm",
  "video/quicktime": "video/quicktime",
  "image/jpeg": "image/jpeg",
  "image/gif": "image/gif",
  "image/png": "image/png",
  "text/plain": "text/plain; charset=utf-8",
  "application/json": "application/json",
};
const servedType = (t: string | undefined) => SERVED_TYPES[(t ?? "").split(";")[0].trim().toLowerCase()] ?? "application/octet-stream";

const view = (a: LoadedAttempt | null): ReceiptView | null => (a ? { key: a.key, attempt: a.attempt, receipt: a.receipt as unknown as ReceiptJson } : null);

export function receiptRoutes<E extends Env = Env>(getReader: (c: Context<E>) => ReceiptReader | null): Hono<E> {
  const app = new Hono<E>();

  /** Shared preamble: validate the ids, find the reader and the run. Returns a Response on any early exit. */
  async function resolve(c: Context<E>) {
    const fail = (error: string, status: 400 | 404 | 409, extra: object = {}) => c.json({ error, ...extra } satisfies ApiError, status);
    const runId = c.req.param("run_id") ?? "";
    const repo = c.req.query("repo");
    if (!isSafeSegment(runId) || (repo !== undefined && !isSafeSegment(repo))) return fail("invalid run_id or repo", 400);
    const reader = getReader(c);
    if (!reader) return fail("no receipt store", 404);
    const run = await selectRun(reader, runId, repo);
    if (!run) return fail(`no receipt for ${runId}`, 404);
    if ("conflict" in run) return fail(`${runId} exists under more than one repo: ${run.conflict.join(", ")}`, 409, { candidates: run.conflict });
    return { reader, runId, run };
  }

  app.get("/api/receipts/:run_id", async (c) => {
    const r = await resolve(c);
    if (r instanceof Response) return r;
    const { run, runId } = r;
    return c.json({
      run_id: runId,
      repo: run.repo,
      head: view(run.head),
      base: view(run.base),
      attempts: run.attempts.map((a) => ({
        attempt: a.attempt,
        stage: a.receipt.stage,
        verdict: a.receipt.verdict,
        at: a.receipt.at,
        key: a.key,
        checks: { total: a.receipt.checks.length, failed: a.receipt.checks.filter((k) => !k.pass).length },
      })),
    } satisfies ReceiptsRunResponse);
  });

  app.on(["GET", "HEAD"], "/api/receipts/:run_id/file", async (c) => {
    const key = c.req.query("key");
    if (!key || !isSafeKey(key)) return c.json({ error: "missing or invalid key" } satisfies ApiError, 400);
    const r = await resolve(c);
    if (r instanceof Response) return r;
    const { reader, run } = r;
    if (!run.allowed.has(key)) return c.json({ error: `${key} is not part of this run's receipts` } satisfies ApiError, 404);
    const info = await reader.head(key);
    if (!info) return c.json({ error: `no object ${key}` } satisfies ApiError, 404);

    const item = run.allowed.get(key);
    const headers: Record<string, string> = {
      "accept-ranges": "bytes",
      "content-type": servedType(item?.content_type || info.contentType),
      "content-disposition": "inline",
      // Same origin as the dashboard API: never let a file run as a page.
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'; media-src 'self'; img-src 'self'",
    };
    if (item?.sha256) headers["etag"] = `"${item.sha256}"`;

    const range = parseRange(c.req.header("range"), info.size);
    if (range.kind === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${info.size}`, "content-length": "0" } });
    }
    // HEAD must not open the object: Hono would drop the body unread and leak the stream (an fd on disk, a paid GET on R2).
    if (c.req.method === "HEAD") {
      headers["content-length"] = String(range.kind === "partial" ? range.length : info.size);
      if (range.kind === "partial") headers["content-range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${info.size}`;
      return new Response(null, { status: range.kind === "partial" ? 206 : 200, headers });
    }
    const object = await reader.get(key, range.kind === "partial" ? { offset: range.offset, length: range.length } : undefined);
    if (!object) return c.json({ error: `no object ${key}` } satisfies ApiError, 404);
    if (range.kind === "partial") {
      headers["content-range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${info.size}`;
      headers["content-length"] = String(range.length);
      return new Response(object.body, { status: 206, headers });
    }
    headers["content-length"] = String(info.size);
    return new Response(object.body, { status: 200, headers });
  });

  return app;
}
