/**
 * Turns a validated batch into parameterized D1 statements. Pure: no I/O.
 * Column lists come from the contract's row schemas, so the contract is the
 * single source and a drift test compares them to the migrated tables.
 * Every upsert is natural-key, so a replay is a no-op, and carries a
 * `src_sent_at` guard so an older batch can never overwrite a newer one.
 */
import {
  MAX_FIELD_BYTES,
  SyncAgentSessionRowSchema,
  SyncEnvelopeRowSchema,
  SyncEventRowSchema,
  SyncGateRowSchema,
  SyncPhaseRowSchema,
  SyncPromptRowSchema,
  SyncSessionRowSchema,
  type SyncBatch,
  type SyncLevel,
} from "../../../src/core/sync/contract.ts";
import type { D1Database, D1PreparedStatement } from "../env.ts";

export const D1_MAX_PARAMS = 100;

export interface IngestContext {
  tenant: string;
  /** Lowercased, trimmed. */
  repo: string;
  nowIso: string;
  level: SyncLevel;
  sentAt: string;
}

export interface PlannedStatement {
  sql: string;
  params: unknown[];
}

const keys = (schema: { entries: Record<string, unknown> }): string[] => Object.keys(schema.entries);

interface Table {
  name: string;
  columns: string[];
  pk: string[];
  /** Columns the plain `excluded.x` update leaves alone. */
  immutable?: string[];
  /** Columns written as COALESCE(excluded.x, t.x) at the given tiers. */
  coalesce?: { columns: string[]; unless: SyncLevel[] };
}

export const TABLES = {
  sessions: { name: "sessions", columns: [...keys(SyncSessionRowSchema), "tenant", "repo", "level", "synced_at", "src_sent_at"], pk: ["factory_id", "adw_id"], immutable: ["tenant"], coalesce: { columns: ["request"], unless: ["trace", "full"] } },
  phases: { name: "phases", columns: [...keys(SyncPhaseRowSchema), "src_sent_at"], pk: ["factory_id", "phase_id"], coalesce: { columns: ["error"], unless: ["trace", "full"] } },
  agent_sessions: { name: "agent_sessions", columns: [...keys(SyncAgentSessionRowSchema), "src_sent_at"], pk: ["factory_id", "adw_id", "agent"] },
  envelopes: { name: "envelopes", columns: [...keys(SyncEnvelopeRowSchema), "src_sent_at"], pk: ["factory_id", "envelope_id"], coalesce: { columns: ["payload_json"], unless: ["full"] } },
  events: { name: "events", columns: [...keys(SyncEventRowSchema), "src_sent_at"], pk: ["factory_id", "event_id"] },
  gate_results: { name: "gate_results", columns: [...keys(SyncGateRowSchema), "src_sent_at"], pk: ["factory_id", "local_id"] },
  prompts: { name: "prompts", columns: [...keys(SyncPromptRowSchema), "src_sent_at"], pk: ["factory_id", "adw_id", "agent"] },
} satisfies Record<string, Table>;

function upsertSql(t: Table, rows: number, level: SyncLevel): string {
  const cols = t.columns;
  const placeholders = `(${cols.map(() => "?").join(", ")})`;
  const coalesced = new Set(t.coalesce && !t.coalesce.unless.includes(level) ? t.coalesce.columns : []);
  const skip = new Set([...t.pk, ...(t.immutable ?? [])]);
  const sets = cols
    .filter((c) => !skip.has(c))
    .map((c) => (coalesced.has(c) ? `${c} = COALESCE(excluded.${c}, ${t.name}.${c})` : `${c} = excluded.${c}`));
  const guard = [`(${t.name}.src_sent_at IS NULL OR excluded.src_sent_at >= ${t.name}.src_sent_at)`, ...(t.immutable?.includes("tenant") ? [`${t.name}.tenant = excluded.tenant`] : [])].join(" AND ");
  return `INSERT INTO ${t.name} (${cols.join(", ")}) VALUES ${Array.from({ length: rows }, () => placeholders).join(", ")} ON CONFLICT(${t.pk.join(", ")}) DO UPDATE SET ${sets.join(", ")} WHERE ${guard}`;
}

function planRows(out: PlannedStatement[], t: Table, rows: Record<string, unknown>[], level: SyncLevel): void {
  if (rows.length === 0) return;
  const perStatement = Math.max(1, Math.floor(D1_MAX_PARAMS / t.columns.length));
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    out.push({ sql: upsertSql(t, chunk.length, level), params: chunk.flatMap((r) => t.columns.map((c) => (r[c] === undefined ? null : r[c]))) });
  }
}

export function planIngest(batch: SyncBatch, ctx: IngestContext): PlannedStatement[] {
  const out: PlannedStatement[] = [];
  // The factory goes first, and its upsert only ever updates a row of the same tenant.
  out.push({
    sql:
      "INSERT INTO factories (factory_id, tenant, name, repo, spf_version, sync_schema, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(factory_id) DO UPDATE SET name = excluded.name, repo = excluded.repo, spf_version = excluded.spf_version, sync_schema = excluded.sync_schema, " +
      "last_seen_at = MAX(factories.last_seen_at, excluded.last_seen_at) WHERE factories.tenant = excluded.tenant",
    params: [batch.factory.factory_id, ctx.tenant, batch.factory.name, ctx.repo, batch.spf_version, batch.sync_schema, ctx.nowIso, ctx.nowIso],
  });
  // Every repo a factory syncs is remembered: one machine, many repos. Same-tenant only, like the factory row.
  out.push({
    sql:
      "INSERT INTO factory_repos (factory_id, repo, tenant, last_seen_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(factory_id, repo) DO UPDATE SET last_seen_at = MAX(factory_repos.last_seen_at, excluded.last_seen_at) WHERE factory_repos.tenant = excluded.tenant",
    params: [batch.factory.factory_id, ctx.repo, ctx.tenant, ctx.nowIso],
  });
  const stamp = { src_sent_at: ctx.sentAt };
  for (const entry of batch.sessions) {
    const snap = entry.snapshot;
    if (snap) {
      planRows(out, TABLES.sessions, [{ ...snap.session, tenant: ctx.tenant, repo: ctx.repo, level: ctx.level, synced_at: ctx.nowIso, ...stamp }], ctx.level);
      planRows(out, TABLES.phases, snap.phases.map((r) => ({ ...r, ...stamp })), ctx.level);
      planRows(out, TABLES.agent_sessions, snap.agent_sessions.map((r) => ({ ...r, ...stamp })), ctx.level);
      planRows(out, TABLES.envelopes, snap.envelopes.map((r) => ({ ...r, ...stamp })), ctx.level);
      planRows(out, TABLES.prompts, snap.prompts.map((r) => ({ ...r, ...stamp })), ctx.level);
    } else {
      out.push({ sql: "UPDATE sessions SET synced_at = ? WHERE factory_id = ? AND adw_id = ? AND tenant = ?", params: [ctx.nowIso, batch.factory.factory_id, entry.adw_id, ctx.tenant] });
    }
    planRows(out, TABLES.events, entry.events.map((r) => ({ ...r, ...stamp })), ctx.level);
    planRows(out, TABLES.gate_results, entry.gate_results.map((r) => ({ ...r, ...stamp })), ctx.level);
  }
  return out;
}

export function toStatements(db: D1Database, plan: PlannedStatement[]): D1PreparedStatement[] {
  return plan.map((p) => db.prepare(p.sql).bind(...p.params));
}

const encoder = new TextEncoder();

/** Replaces any string field over MAX_FIELD_BYTES with `{"_spf_truncated":<bytes>}`. Mutates and returns the batch. */
export function truncateBatch<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (node.length * 3 <= MAX_FIELD_BYTES) return node;
      const bytes = encoder.encode(node).length;
      return bytes > MAX_FIELD_BYTES ? JSON.stringify({ _spf_truncated: bytes }) : node;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i]);
    } else if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      for (const k of Object.keys(o)) o[k] = walk(o[k]);
    }
    return node;
  };
  return walk(value) as T;
}
