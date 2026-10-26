/**
 * Shared fixtures for the `piquette sync` tests: a trace db on local sqlite OR on
 * the fake D1 (a real sqlite engine behind D1's HTTP shape), seeded with the
 * real tracer schema and plain INSERTs, plus a config pointing at a hub.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as v from "valibot";
import { loadConfig } from "../core/agents.js";
import { SyncConfigSchema, type SFConfig } from "../core/data_types.js";
import type { NormalizedObservabilityDb } from "../core/data_types.js";
import { Tracer } from "../core/tracer.js";
import { sqliteBackedFetch } from "./fake_d1.js";

export const FIXED_FACTORY_ID = "11111111-2222-4333-8444-555555555555";
export const TEST_CLIENT_ID = "test-client-id-0123456789.access";
export const TEST_CLIENT_SECRET = "test-client-secret-abcdef0123456789";

export interface Fixture {
  kind: "sqlite" | "d1";
  dir: string;
  dataPaths: { data_dir: string; db: NormalizedObservabilityDb; sessions_dir: string };
  sourceFetchImpl?: typeof fetch;
  run(sql: string, ...params: SQLInputValue[]): void;
  cleanup(): void;
}

const D1_DB = { kind: "d1" as const, database_id: "sync-test-db", account_id_env: "TEST_D1_ACCOUNT_ID", api_token_env: "TEST_D1_API_TOKEN" };

const liveHomes: string[] = [];
let originalHome: string | undefined;

export async function makeFixture(kind: "sqlite" | "d1"): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), `piquette-sync-${kind}-`));
  const data_dir = join(dir, ".piquette", "data");
  mkdirSync(data_dir, { recursive: true });
  mkdirSync(join(dir, "machine-home"), { recursive: true });
  const ownHome = join(dir, "machine-home");
  if (liveHomes.length === 0) originalHome = process.env["PIQUETTE_CONFIG_HOME"];
  liveHomes.push(ownHome);
  process.env["PIQUETTE_CONFIG_HOME"] = ownHome;
  writeFileSync(join(dir, "machine-home", "factory.json"), JSON.stringify({ factory_id: FIXED_FACTORY_ID, created_at: "2026-01-01T00:00:00.000Z" }));
  const sessions_dir = join(data_dir, "sessions");
  // Fixtures may be cleaned up in any order: the env follows the newest fixture still alive, and the original value returns when none is.
  const restoreHome = (): void => {
    const at = liveHomes.indexOf(ownHome);
    if (at >= 0) liveHomes.splice(at, 1);
    const current = liveHomes[liveHomes.length - 1];
    if (current !== undefined) process.env["PIQUETTE_CONFIG_HOME"] = current;
    else if (originalHome === undefined) delete process.env["PIQUETTE_CONFIG_HOME"];
    else process.env["PIQUETTE_CONFIG_HOME"] = originalHome;
  };


  if (kind === "sqlite") {
    const dbPath = join(data_dir, "piquette.db");
    const t = await Tracer.open(dbPath, join(dir, "events.jsonl"));
    await t.close();
    const db = new DatabaseSync(dbPath);
    return {
      kind,
      dir,
      dataPaths: { data_dir, db: { kind: "sqlite", path: dbPath }, sessions_dir },
      run: (sql, ...p) => void db.prepare(sql).run(...p),
      cleanup: () => {
        db.close();
        restoreHome();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  const mem = new DatabaseSync(":memory:");
  const fetchImpl = sqliteBackedFetch(mem);
  const saved = [process.env.TEST_D1_ACCOUNT_ID, process.env.TEST_D1_API_TOKEN];
  process.env.TEST_D1_ACCOUNT_ID = "acct-abc";
  process.env.TEST_D1_API_TOKEN = "d1-token-xyz-0123";
  const t = await Tracer.open(D1_DB, join(dir, "events.jsonl"), null, { fetchImpl });
  await t.close();
  return {
    kind,
    dir,
    dataPaths: { data_dir, db: D1_DB, sessions_dir },
    sourceFetchImpl: fetchImpl,
    run: (sql, ...p) => void mem.prepare(sql).run(...p),
    cleanup: () => {
      mem.close();
      restoreHome();
      if (saved[0] === undefined) delete process.env.TEST_D1_ACCOUNT_ID;
      else process.env.TEST_D1_ACCOUNT_ID = saved[0];
      if (saved[1] === undefined) delete process.env.TEST_D1_API_TOKEN;
      else process.env.TEST_D1_API_TOKEN = saved[1];
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function addSession(fx: Fixture, adw: string, o: { ended_at?: string | null; request?: string; status?: string } = {}): void {
  fx.run(
    "INSERT OR REPLACE INTO sessions (adw_id, adw_name, request, status, engineer, started_at, ended_at, total_tokens, total_cost, billable_tokens) VALUES (?,?,?,?,?,?,?,?,?,?)",
    adw,
    "plan + build",
    o.request ?? "REQUEST-TEXT",
    o.status ?? "success",
    "jd",
    "2026-01-01T00:00:00+00:00",
    o.ended_at === undefined ? "2026-01-01T00:10:00+00:00" : o.ended_at,
    1000,
    0.5,
    800,
  );
  fx.run("INSERT OR REPLACE INTO phases (phase_id, adw_id, seq, name, kind, owner, description, status, attempt, retries, error, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", `${adw}-p1`, adw, 1, "plan", "agent", "planner", "desc", "success", 1, 0, "PHASE-ERROR", "2026-01-01T00:00:00+00:00", "2026-01-01T00:05:00+00:00");
  fx.run("INSERT OR REPLACE INTO agent_sessions (adw_id, agent, coding_agent, model, color, session_id, context_tokens, context_window, created_at, last_used_at) VALUES (?,?,?,?,?,?,?,?,?,?)", adw, "planner", "claude_code", "sonnet", "blue", "sess-1", 100, 200000, "2026-01-01T00:00:00+00:00", "2026-01-01T00:05:00+00:00");
  fx.run("INSERT OR REPLACE INTO envelopes (envelope_id, adw_id, phase_id, agent, output_type, payload_json, valid, attempt, created_at) VALUES (?,?,?,?,?,?,?,?,?)", `${adw}-e1`, adw, `${adw}-p1`, "planner", "plan", JSON.stringify({ secret_plan: "ENVELOPE-PAYLOAD" }), 1, 1, "2026-01-01T00:05:00+00:00");
}

export function addEvents(fx: Fixture, adw: string, from: number, count: number, o: { type?: string; name?: string; payload?: unknown } = {}): void {
  for (let i = from; i < from + count; i++) {
    fx.run(
      "INSERT INTO events (event_id, adw_id, phase_id, parent_id, type, name, payload_json, tokens, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      `${adw}-ev${i}`,
      adw,
      `${adw}-p1`,
      "",
      o.type ?? "agent_end",
      o.name ?? "planner",
      JSON.stringify(o.payload ?? { usage: { input_tokens: 10, output_tokens: 5 } }),
      15,
      "2026-01-01T00:00:01+00:00",
      "2026-01-01T00:00:02+00:00",
    );
  }
}

export function addGate(fx: Fixture, adw: string, o: { checks?: unknown; violations?: unknown } = {}): void {
  fx.run(
    "INSERT INTO gate_results (adw_id, phase_id, attempt, gate, passed, violations_json, checks_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
    adw,
    `${adw}-p1`,
    1,
    "plan_gate",
    1,
    JSON.stringify(o.violations ?? []),
    JSON.stringify(o.checks ?? [{ item: "tests pass", ok: true, note: "CHECK-NOTE" }]),
    "2026-01-01T00:05:00+00:00",
  );
}

/** A loaded default config with a `sync:` block pointed at `endpoint`. */
export function syncCfg(endpoint: string | undefined, extra: Record<string, unknown> = {}): SFConfig {
  const cfg = loadConfig([]);
  cfg.sync = v.parse(SyncConfigSchema, { ...(endpoint ? { endpoint } : {}), ...extra });
  return cfg;
}

export function withSyncEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = [process.env.PIQUETTE_SYNC_CLIENT_ID, process.env.PIQUETTE_SYNC_CLIENT_SECRET];
  process.env.PIQUETTE_SYNC_CLIENT_ID = TEST_CLIENT_ID;
  process.env.PIQUETTE_SYNC_CLIENT_SECRET = TEST_CLIENT_SECRET;
  return fn().finally(() => {
    for (const [i, k] of ["PIQUETTE_SYNC_CLIENT_ID", "PIQUETTE_SYNC_CLIENT_SECRET"].entries()) {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    }
  });
}
