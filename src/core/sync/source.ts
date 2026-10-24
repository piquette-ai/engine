/**
 * The ONLY reader `spf sync` has (#135), built on `TraceDb` — so a repo whose
 * `observability.db` is Cloudflare D1 syncs byte-for-byte the same payload as
 * one on local sqlite (D1-to-D1 mirroring, decided 2026-10-22). It does not
 * use `SfDb`: core must not import ui.
 *
 * Both backends run the same SQLite SQL, so there is one code path. Two
 * things keep their rows identical: every SELECT names its columns, and every
 * row goes through `normalizeRow`, which coerces each declared column to
 * `number | null` or `string | null` (bigint -> Number, boolean -> 0/1).
 * Queries are per session — no `IN (...)` lists — so D1's 100-bound-param cap
 * can never be hit. Reads are short single statements, never an explicit
 * transaction, so the WAL writer is never held up.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DataPaths } from "../paths.ts";
import { createTraceDb, type TraceDb } from "../trace_db.ts";
import type {
  SyncAgentSessionRow,
  SyncEnvelopeRow,
  SyncEventRow,
  SyncGateRow,
  SyncPhaseRow,
  SyncPromptRow,
  SyncSessionRow,
} from "./contract.ts";

type Kind = "s" | "n";
type TableSpec = Record<string, Kind>;

// The columns each table contributes to the payload. A column a tracer
// migration adds later is NOT here, so it can never leak until the contract is
// bumped; a column an older db lacks is probed and read as NULL.
const TABLES = {
  sessions: { adw_id: "s", adw_name: "s", request: "s", status: "s", engineer: "s", started_at: "s", ended_at: "s", total_tokens: "n", total_cost: "n", billable_tokens: "n", issue_label: "s", issue_url: "s", pr_label: "s", pr_url: "s" },
  phases: { phase_id: "s", adw_id: "s", seq: "n", name: "s", kind: "s", owner: "s", description: "s", status: "s", attempt: "n", retries: "n", error: "s", started_at: "s", ended_at: "s" },
  agent_sessions: { adw_id: "s", agent: "s", coding_agent: "s", model: "s", color: "s", session_id: "s", context_tokens: "n", context_window: "n", created_at: "s", last_used_at: "s" },
  envelopes: { envelope_id: "s", adw_id: "s", phase_id: "s", agent: "s", output_type: "s", payload_json: "s", valid: "n", attempt: "n", created_at: "s" },
  events: { event_id: "s", adw_id: "s", phase_id: "s", parent_id: "s", type: "s", name: "s", payload_json: "s", tokens: "n", started_at: "s", ended_at: "s" },
  gate_results: { adw_id: "s", phase_id: "s", attempt: "n", gate: "s", passed: "n", violations_json: "s", checks_json: "s", created_at: "s" },
} as const satisfies Record<string, TableSpec>;
type TableName = keyof typeof TABLES;

function toNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function toStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return null;
}

/** The single point that makes a D1 row and a sqlite row byte-identical. */
export function normalizeRow(table: TableName, raw: Record<string, unknown>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [col, kind] of Object.entries(TABLES[table] as TableSpec)) {
    out[col] = kind === "n" ? toNum(raw[col]) : toStr(raw[col]);
  }
  return out;
}

export interface RawSnapshot {
  session: SyncSessionRow;
  phases: SyncPhaseRow[];
  agent_sessions: SyncAgentSessionRow[];
  envelopes: SyncEnvelopeRow[];
}

/** `table_info` results a `--follow` loop keeps across passes, so a D1 source does not spend 6 API calls per tick re-probing a schema that rarely changes. */
export type SyncColumnCache = Map<string, Set<string>>;

export class SyncSource {
  private constructor(
    private readonly db: TraceDb,
    private readonly factoryId: string,
    private readonly sessionsDir: string,
    private readonly columnCache: SyncColumnCache,
  ) {}

  /** `null` when there is nothing to read yet: a local db file that does not exist. A D1 db is always "open"; a missing table reads as empty. */
  static async open(
    dataPaths: Pick<DataPaths, "db" | "sessions_dir">,
    options: { factoryId: string; fetchImpl?: typeof fetch; columnCache?: SyncColumnCache },
  ): Promise<SyncSource | null> {
    if (dataPaths.db.kind === "sqlite" && !existsSync(dataPaths.db.path)) return null;
    const db = createTraceDb(dataPaths.db, { readonly: true, fetchImpl: options.fetchImpl });
    if (dataPaths.db.kind === "sqlite") {
      // A running chain is writing the same file: wait out a checkpoint instead of failing the pass.
      await db.exec("PRAGMA busy_timeout = 5000");
    }
    return new SyncSource(db, options.factoryId, dataPaths.sessions_dir, options.columnCache ?? new Map());
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /** `PRAGMA table_info`, cached per table (the `SfDb` probe pattern). An empty set means the table does not exist. */
  private async columns(table: TableName): Promise<Set<string>> {
    let cols = this.columnCache.get(table);
    if (!cols) {
      const rows = await this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
      cols = new Set(rows.map((r) => r.name));
      // a missing table is not cached: the tracer may create it before the next pass
      if (cols.size > 0) this.columnCache.set(table, cols);
    }
    return cols;
  }

  /** Explicit column list; a column this db lacks is read as NULL. */
  private async select(table: TableName, extra = ""): Promise<string | null> {
    const have = await this.columns(table);
    if (have.size === 0) return null;
    const cols = Object.keys(TABLES[table]).map((c) => (have.has(c) ? c : `NULL AS ${c}`));
    return (extra ? `${extra}, ` : "") + cols.join(", ");
  }

  private async rows(table: TableName, extra: string, tail: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    const cols = await this.select(table, extra);
    if (cols === null) return [];
    return this.db.query<Record<string, unknown>, unknown[]>(`SELECT ${cols} FROM ${table} ${tail}`).all(...params);
  }

  /**
   * Every session in `rowid` order, one page at a time. `links` is the run's
   * issue and PR URLs/labels as one string (null when it has none, or the db
   * predates them): a PR opens after its run has ended, so a finished
   * session whose links changed has to become a sync candidate again even
   * though its `ended_at` did not move.
   */
  async listSessions(afterRowid: number, limit = 500): Promise<Array<{ rowid: number; adw_id: string; ended_at: string | null; links: string | null }>> {
    const cols = await this.columns("sessions");
    if (cols.size === 0) return [];
    const linkCols = ["issue_label", "issue_url", "pr_label", "pr_url"].filter((c) => cols.has(c));
    const links = linkCols.length ? `NULLIF(${linkCols.map((c) => `COALESCE(${c}, '')`).join(" || ' ' || ")}, '${" ".repeat(linkCols.length - 1)}')` : "NULL";
    const rows = await this.db
      .query<Record<string, unknown>, unknown[]>(`SELECT rowid AS rid, adw_id, ended_at, ${links} AS links FROM sessions WHERE rowid > ? ORDER BY rowid LIMIT ?`)
      .all(afterRowid, limit);
    return rows.map((r) => ({ rowid: toNum(r.rid) ?? 0, adw_id: toStr(r.adw_id) ?? "", ended_at: toStr(r.ended_at), links: toStr(r.links) }));
  }

  async adwIdsWithEventsAfter(hwm: number): Promise<string[]> {
    if ((await this.columns("events")).size === 0) return [];
    const rows = await this.db.query<Record<string, unknown>, unknown[]>("SELECT DISTINCT adw_id FROM events WHERE rowid > ? ORDER BY adw_id").all(hwm);
    return rows.map((r) => toStr(r.adw_id)).filter((s): s is string => !!s);
  }

  async adwIdsWithGatesAfter(hwm: number): Promise<string[]> {
    if ((await this.columns("gate_results")).size === 0) return [];
    const rows = await this.db.query<Record<string, unknown>, unknown[]>("SELECT DISTINCT adw_id FROM gate_results WHERE id > ? ORDER BY adw_id").all(hwm);
    return rows.map((r) => toStr(r.adw_id)).filter((s): s is string => !!s);
  }

  async maxEventRowid(): Promise<number> {
    if ((await this.columns("events")).size === 0) return 0;
    const row = await this.db.query<Record<string, unknown>, []>("SELECT MAX(rowid) AS m FROM events").get();
    return toNum(row?.m) ?? 0;
  }

  async maxGateId(): Promise<number> {
    if ((await this.columns("gate_results")).size === 0) return 0;
    const row = await this.db.query<Record<string, unknown>, []>("SELECT MAX(id) AS m FROM gate_results").get();
    return toNum(row?.m) ?? 0;
  }

  /** The session's small, idempotently-upserted rows. `null` if the session row is gone. */
  async snapshot(adwId: string): Promise<RawSnapshot | null> {
    const f = this.factoryId;
    const [session] = await this.rows("sessions", "", "WHERE adw_id = ?", [adwId]);
    if (!session) return null;
    const stamp = <T>(table: TableName, raw: Record<string, unknown>): T => ({ factory_id: f, ...normalizeRow(table, raw) }) as T;
    const phases = await this.rows("phases", "", "WHERE adw_id = ? ORDER BY seq, rowid", [adwId]);
    const agentSessions = await this.rows("agent_sessions", "", "WHERE adw_id = ? ORDER BY agent", [adwId]);
    const envelopes = await this.rows("envelopes", "", "WHERE adw_id = ? ORDER BY rowid", [adwId]);
    return {
      session: stamp<SyncSessionRow>("sessions", session),
      phases: phases.map((r) => stamp<SyncPhaseRow>("phases", r)),
      agent_sessions: agentSessions.map((r) => stamp<SyncAgentSessionRow>("agent_sessions", r)),
      envelopes: envelopes.map((r) => stamp<SyncEnvelopeRow>("envelopes", r)),
    };
  }

  async events(adwId: string, after: number, limit: number): Promise<SyncEventRow[]> {
    const rows = await this.rows("events", "rowid AS local_rowid", "WHERE adw_id = ? AND rowid > ? ORDER BY rowid LIMIT ?", [adwId, after, limit]);
    return rows.map((r) => ({ factory_id: this.factoryId, local_rowid: toNum(r.local_rowid) ?? 0, ...normalizeRow("events", r) }) as SyncEventRow);
  }

  async gates(adwId: string, after: number, limit: number): Promise<SyncGateRow[]> {
    const rows = await this.rows("gate_results", "id AS local_id", "WHERE adw_id = ? AND id > ? ORDER BY id LIMIT ?", [adwId, after, limit]);
    return rows.map((r) => ({ factory_id: this.factoryId, local_id: toNum(r.local_id) ?? 0, ...normalizeRow("gate_results", r) }) as SyncGateRow);
  }

  /** How many events the session has up to and including `rowid` — the renumbering check. */
  async countEventsUpTo(adwId: string, rowid: number): Promise<number> {
    if ((await this.columns("events")).size === 0) return 0;
    const row = await this.db.query<Record<string, unknown>, unknown[]>("SELECT COUNT(*) AS c FROM events WHERE adw_id = ? AND rowid <= ?").get(adwId, rowid);
    return toNum(row?.c) ?? 0;
  }

  /** `full` only: prompt files kept on local disk under `sessions_dir/<adw_id>/<agent>/prompts/`. Absent files read as null. */
  prompts(adwId: string, agents: string[]): SyncPromptRow[] {
    const out: SyncPromptRow[] = [];
    if (!adwId || adwId !== path.basename(adwId) || adwId === "..") return out;
    for (const agent of agents) {
      // agent names come from the db: never let one climb out of the session dir
      if (!agent || agent !== path.basename(agent) || agent === "..") continue;
      const dir = path.join(this.sessionsDir, adwId, agent, "prompts");
      const read = (name: string): string | null => {
        try {
          return readFileSync(path.join(dir, name), "utf-8");
        } catch {
          return null;
        }
      };
      const system = read("system.md");
      const user = read("user.md");
      if (system !== null || user !== null) out.push({ factory_id: this.factoryId, adw_id: adwId, agent, system, user });
    }
    return out;
  }
}
