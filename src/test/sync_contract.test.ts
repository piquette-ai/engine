import "./hermetic_git.js";

/** The `spf sync` payload contract (#135): the committed JSON schema, real batches, and the import boundary. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { PACKAGE_ROOT } from "../core/paths.js";
import { runSyncPass } from "../core/sync/client.js";
import { SyncBatchSchema, SYNC_SCHEMA_VERSION } from "../core/sync/contract.js";
import { addEvents, addGate, addSession, FIXED_FACTORY_ID, makeFixture, syncCfg } from "./sync_fixtures.js";

test("the committed JSON schema equals toJsonSchema(SyncBatchSchema) — run `npm run build:cli && npm run gen:sync-schema` after changing the contract", () => {
  const committed = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "assets", "sync", "payload.v1.schema.json"), "utf-8"));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(toJsonSchema(SyncBatchSchema))));
});

test("a built batch validates, and every row carries factory_id plus its natural key — at every level", async () => {
  for (const level of ["summary", "trace", "full"] as const) {
    const fx = await makeFixture("sqlite");
    try {
      addSession(fx, "adw1");
      addEvents(fx, "adw1", 1, 2);
      addGate(fx, "adw1");
      const out = path.join(fx.dir, "out.ndjson");
      const report = await runSyncPass({
        cfg: syncCfg(undefined, { repo: "github.com/acme/api" }),
        anchor: { repo_root: fx.dir },
        dataPaths: fx.dataPaths,
        level,
        dryRun: true,
        out,
        log: () => {},
      });
      assert.equal(report.status, "ok", report.error);
      const batch = v.parse(SyncBatchSchema, JSON.parse(readFileSync(out, "utf-8").trim()));
      assert.equal(batch.sync_schema, SYNC_SCHEMA_VERSION);
      assert.equal(batch.level, level);
      assert.equal(batch.factory.factory_id, FIXED_FACTORY_ID);
      assert.equal(batch.factory.repo, "github.com/acme/api");
      assert.match(batch.batch_id, /^[0-9a-f]{64}$/);
      const s = batch.sessions[0]!;
      const snap = s.snapshot!;
      assert.equal(snap.session.factory_id, FIXED_FACTORY_ID);
      assert.ok(snap.session.adw_id);
      for (const p of snap.phases) assert.ok(p.factory_id === FIXED_FACTORY_ID && p.phase_id);
      for (const a of snap.agent_sessions) assert.ok(a.factory_id === FIXED_FACTORY_ID && a.adw_id && a.agent);
      for (const e of snap.envelopes) assert.ok(e.factory_id === FIXED_FACTORY_ID && e.envelope_id);
      for (const e of s.events) assert.ok(e.factory_id === FIXED_FACTORY_ID && e.event_id && e.local_rowid > 0);
      for (const g of s.gate_results) assert.ok(g.factory_id === FIXED_FACTORY_ID && g.local_id > 0);
      assert.ok(!("archived" in snap.session), "archived is local triage, never synced");
    } finally {
      fx.cleanup();
    }
  }
});

test("import boundary: nothing on the run path imports sync/ — directly or transitively — so sync can never block a run", () => {
  const core = path.join(PACKAGE_ROOT, "src", "core");
  const seen = new Set<string>();
  const walk = (file: string, via: string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    assert.ok(!file.includes(`${path.sep}sync${path.sep}`), `run path reaches sync code: ${[...via, path.basename(file)].join(" -> ")}`);
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(/(?:from|import)\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(file), m[1]!.replace(/\.(?:js|ts)$/, ".ts"));
      if (existsSync(target)) walk(target, [...via, path.basename(file)]);
    }
  };
  for (const file of ["tracer", "session", "runner", "watch"]) walk(path.join(core, `${file}.ts`), []);
});
