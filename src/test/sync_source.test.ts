import "./hermetic_git.js";

/**
 * `SyncSource` parity (#135): identical rows in a local sqlite file and in the
 * fake D1 must come back deep-equal from every reader method, and produce a
 * byte-equal dry-run NDJSON — one SQL path, one `normalizeRow`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSyncPass } from "../core/sync/client.js";
import { normalizeRow, SyncSource } from "../core/sync/source.js";
import { addEvents, addGate, addSession, FIXED_FACTORY_ID, makeFixture, syncCfg, type Fixture } from "./sync_fixtures.js";

function seed(fx: Fixture): void {
  addSession(fx, "adw1");
  addSession(fx, "adw2", { ended_at: null });
  addEvents(fx, "adw1", 1, 5);
  addEvents(fx, "adw2", 1, 2, { type: "tool_call", name: "bash: ls", payload: { usage: { input_tokens: 3 } } });
  addGate(fx, "adw1");
  addGate(fx, "adw1", { violations: ["v1"] });
}

async function readAll(fx: Fixture): Promise<unknown> {
  const src = (await SyncSource.open(fx.dataPaths, { factoryId: FIXED_FACTORY_ID, fetchImpl: fx.sourceFetchImpl }))!;
  try {
    return {
      sessions: await src.listSessions(0, 10),
      evAdws: await src.adwIdsWithEventsAfter(2),
      gtAdws: await src.adwIdsWithGatesAfter(1),
      maxEv: await src.maxEventRowid(),
      maxGt: await src.maxGateId(),
      snap1: await src.snapshot("adw1"),
      snapMissing: await src.snapshot("nope"),
      events: await src.events("adw1", 1, 3),
      gates: await src.gates("adw1", 0, 10),
      count: await src.countEventsUpTo("adw1", 3),
    };
  } finally {
    await src.close();
  }
}

test("every reader method returns deep-equal rows from sqlite and from D1", async () => {
  const a = await makeFixture("sqlite");
  const b = await makeFixture("d1");
  try {
    seed(a);
    seed(b);
    const [fromSqlite, fromD1] = [await readAll(a), await readAll(b)];
    assert.deepEqual(fromSqlite, fromD1);
    const r = fromSqlite as { events: Array<{ local_rowid: number }>; count: number; maxEv: number };
    assert.deepEqual(r.events.map((e) => e.local_rowid), [2, 3, 4]);
    assert.equal(r.count, 3);
    assert.equal(r.maxEv, 7);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("the dry-run NDJSON is byte-equal between sqlite and D1", async () => {
  const outs: string[] = [];
  for (const kind of ["sqlite", "d1"] as const) {
    const fx = await makeFixture(kind);
    try {
      seed(fx);
      const out = join(fx.dir, "out.ndjson");
      const report = await runSyncPass({
        // same repo identity for both: the temp dirs' names would otherwise differ
        cfg: syncCfg(undefined, { repo: "github.com/acme/api" }),
        anchor: { repo_root: fx.dir },
        dataPaths: fx.dataPaths,
        level: "trace",
        dryRun: true,
        out,
        sourceFetchImpl: fx.sourceFetchImpl,
        now: () => "2026-02-02T00:00:00.000Z",
        log: () => {},
      });
      assert.equal(report.status, "ok", report.error);
      outs.push(readFileSync(out, "utf-8"));
    } finally {
      fx.cleanup();
    }
  }
  assert.equal(outs[0], outs[1]);
  assert.ok(outs[0]!.length > 0);
});

test("a missing optional column reads as NULL on both backends", async () => {
  for (const kind of ["sqlite", "d1"] as const) {
    const fx = await makeFixture(kind);
    try {
      // an older trace db: no checks_json, no billable_tokens
      fx.run("ALTER TABLE gate_results DROP COLUMN checks_json");
      fx.run("ALTER TABLE sessions DROP COLUMN billable_tokens");
      fx.run("INSERT OR REPLACE INTO sessions (adw_id, request, status, started_at, ended_at) VALUES ('old', 'r', 'success', 't0', 't1')");
      fx.run("INSERT INTO gate_results (adw_id, phase_id, attempt, gate, passed, violations_json, created_at) VALUES ('old', 'p', 1, 'g', 1, '[]', 't0')");
      const src = (await SyncSource.open(fx.dataPaths, { factoryId: FIXED_FACTORY_ID, fetchImpl: fx.sourceFetchImpl }))!;
      const snap = await src.snapshot("old");
      const gates = await src.gates("old", 0, 10);
      await src.close();
      assert.equal(snap!.session.billable_tokens, null, kind);
      assert.equal(gates[0]!.checks_json, null, kind);
    } finally {
      fx.cleanup();
    }
  }
});

test("normalizeRow coerces bigint and booleans, and drops undeclared columns", () => {
  const row = normalizeRow("gate_results", { adw_id: "a", attempt: 2n, passed: true, gate: 5, future_column: "LEAK", checks_json: undefined });
  assert.deepEqual(row, { adw_id: "a", phase_id: null, attempt: 2, gate: "5", passed: 1, violations_json: null, checks_json: null, created_at: null });
});

test("a local db that does not exist yet is nothing to sync; prompts read from sessions_dir and can't escape it", async () => {
  const fx = await makeFixture("sqlite");
  try {
    const none = await SyncSource.open({ ...fx.dataPaths, db: { kind: "sqlite", path: join(fx.dir, "missing.db") } }, { factoryId: FIXED_FACTORY_ID });
    assert.equal(none, null);

    const dir = join(fx.dataPaths.sessions_dir, "adw1", "planner", "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "system.md"), "SYS");
    writeFileSync(join(dir, "user.md"), "USR");
    const src = (await SyncSource.open(fx.dataPaths, { factoryId: FIXED_FACTORY_ID }))!;
    assert.deepEqual(src.prompts("adw1", ["planner", "builder", "../planner"]), [{ factory_id: FIXED_FACTORY_ID, adw_id: "adw1", agent: "planner", system: "SYS", user: "USR" }]);
    assert.deepEqual(src.prompts("../adw1", ["planner"]), []);
    await src.close();
  } finally {
    fx.cleanup();
  }
});
