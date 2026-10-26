/**
 * `GET`/`POST /ingest/v1`: the hosted side of `piquette sync`. Behind Access as a
 * service token only (`requireServiceToken`); the tenant comes from the
 * credential table, never from the payload. Step order is part of the
 * contract: 503 (config) -> 401/403 (token) -> 403 (credential) -> 413 ->
 * 400 (json) -> 409 (schema) -> 400 (shape) -> ownership -> authorize ->
 * truncate -> ONE atomic `db.batch` -> 200.
 * Logs carry tenant, factory id, counts, status and reason: never headers,
 * the JWT or the body.
 */
import type { Context, Hono } from "hono";
import * as v from "valibot";
import {
  SYNC_INGEST_PATH,
  SYNC_SCHEMA_HEADER,
  SYNC_SCHEMA_VERSION,
  SyncBatchSchema,
  type SyncBatch,
  type SyncSupported,
} from "../../../src/core/sync/contract.ts";
import { requireServiceToken } from "../access.ts";
import type { CloudEnv } from "../env.ts";
import { authorizeFactory, resolveCredential } from "./credentials.ts";
import { planIngest, toStatements, truncateBatch } from "./upsert_plan.ts";

export const SUPPORTED_SYNC_SCHEMA: SyncSupported["supported"] = [1, SYNC_SCHEMA_VERSION];
const DEFAULT_MAX_BODY = 8 * 1024 * 1024;

/** Pre-parses `{sync_schema:number}` loosely, BEFORE the full schema, so a future client gets a 409 with the range and not a 400. */
export function checkSchemaRange(raw: unknown): SyncSupported | null {
  const version = raw && typeof raw === "object" ? (raw as { sync_schema?: unknown }).sync_schema : undefined;
  if (typeof version !== "number") return null;
  const [min, max] = SUPPORTED_SYNC_SCHEMA;
  return version < min || version > max ? { supported: SUPPORTED_SYNC_SCHEMA } : null;
}

export type OwnershipResult = { ok: true } | { ok: false; status: 400 | 403; reason: string };

/** A row for another factory is a 403; a row for another session than its entry is a 400. */
export function checkRowOwnership(batch: SyncBatch): OwnershipResult {
  const factory = batch.factory.factory_id;
  for (const entry of batch.sessions) {
    const rows: { factory_id: string; adw_id: string | null }[] = [
      ...(entry.snapshot ? [entry.snapshot.session, ...entry.snapshot.phases, ...entry.snapshot.agent_sessions, ...entry.snapshot.envelopes, ...entry.snapshot.prompts] : []),
      ...entry.events,
      ...entry.gate_results,
    ];
    for (const row of rows) if (row.factory_id !== factory) return { ok: false, status: 403, reason: "row_factory_mismatch" };
    for (const row of rows) if (row.adw_id !== null && row.adw_id !== entry.adw_id) return { ok: false, status: 400, reason: "row_session_mismatch" };
  }
  return { ok: true };
}

function maxBodyBytes(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BODY;
}

async function readLimited(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

type C = Context<CloudEnv>;

async function credentialFor(c: C) {
  const name = c.get("access")?.commonName;
  if (!name || !c.env.DB) return null;
  return resolveCredential(c.env.DB, name);
}

async function handleGet(c: C): Promise<Response> {
  const cred = await credentialFor(c);
  if (!cred) return c.json({ error: "unknown_credential" }, 403);
  return c.json({ supported: SUPPORTED_SYNC_SCHEMA });
}

const SENT_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const SENT_AT_SKEW_MS = 5 * 60_000;

async function handlePost(c: C): Promise<Response> {
  const db = c.env.DB;
  if (!db) return c.json({ error: "module_unavailable", module: "ingest" }, 503);
  const cred = await credentialFor(c);
  if (!cred) {
    console.warn("ingest: refused: unknown credential");
    return c.json({ error: "unknown_credential" }, 403);
  }
  const bytes = await readLimited(c.req.raw, maxBodyBytes(c.env.MAX_BODY_BYTES));
  if (!bytes) return c.json({ error: "payload_too_large" }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const unsupported = checkSchemaRange(raw);
  if (unsupported) return c.json(unsupported, 409);
  const header = c.req.header(SYNC_SCHEMA_HEADER);
  if (header !== undefined && header.trim() !== String((raw as { sync_schema?: unknown })?.sync_schema)) return c.json({ error: "schema_header_mismatch" }, 400);
  const parsed = v.safeParse(SyncBatchSchema, raw);
  if (!parsed.success) {
    const paths = parsed.issues.slice(0, 5).map((i) => (i.path ?? []).map((p) => String(p.key)).join("."));
    return c.json({ error: "invalid_batch", paths }, 400);
  }
  const batch = parsed.output;
  // `sent_at` is the freshness guard on every upsert: a malformed or far-future value would freeze rows against later updates.
  const sentMs = SENT_AT_RE.test(batch.sent_at) ? Date.parse(batch.sent_at) : Number.NaN;
  if (!Number.isFinite(sentMs) || sentMs > Date.now() + SENT_AT_SKEW_MS) return c.json({ error: "invalid_sent_at" }, 400);
  const owned = checkRowOwnership(batch);
  if (!owned.ok) {
    console.warn(`ingest: refused: tenant=${cred.tenant} factory=${batch.factory.factory_id} reason=${owned.reason}`);
    return c.json({ error: owned.reason }, owned.status);
  }
  const authz = await authorizeFactory(db, cred, batch.factory.factory_id);
  if (!authz.ok) {
    console.warn(`ingest: refused: tenant=${cred.tenant} factory=${batch.factory.factory_id} reason=${authz.reason}`);
    return c.json({ error: authz.reason }, 403);
  }
  truncateBatch(batch);
  const plan = planIngest(batch, { tenant: cred.tenant, repo: batch.factory.repo.trim().toLowerCase(), nowIso: new Date().toISOString(), level: batch.level, sentAt: batch.sent_at });
  const accepted = {
    sessions: batch.sessions.length,
    events: batch.sessions.reduce((n, s) => n + s.events.length, 0),
    gates: batch.sessions.reduce((n, s) => n + s.gate_results.length, 0),
  };
  try {
    await db.batch(toStatements(db, plan));
  } catch (error) {
    console.error(`ingest: batch failed: tenant=${cred.tenant} factory=${batch.factory.factory_id} ${(error as Error).name}`);
    return c.json({ error: "ingest_failed" }, 500);
  }
  console.log(`ingest: ok tenant=${cred.tenant} factory=${batch.factory.factory_id} sessions=${accepted.sessions} events=${accepted.events} gates=${accepted.gates}`);
  return c.json({ ok: true, accepted });
}

export function mountIngest(app: Hono<CloudEnv>): void {
  app.use("/ingest", requireServiceToken());
  app.use("/ingest/*", requireServiceToken());
  app.get(SYNC_INGEST_PATH, handleGet);
  app.post(SYNC_INGEST_PATH, handlePost);
  app.all("/ingest/*", (c) => c.json({ error: "not found" }, 404));
  app.all("/ingest", (c) => c.json({ error: "not found" }, 404));
}
