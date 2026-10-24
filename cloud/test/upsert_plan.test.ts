import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { D1_MAX_PARAMS, TABLES, planIngest, truncateBatch } from "../src/ingest/upsert_plan.ts";
import { makeBatch } from "./ingest_helpers.ts";

const ctx = { tenant: "t", repo: "example.com/a/b", nowIso: "2026-01-01T00:00:00.000Z", level: "trace" as const, sentAt: "2026-01-01T00:00:00.000Z" };

test("every statement stays within D1's parameter limit, and the statement count is bounded", () => {
  const plan = planIngest(makeBatch({ events: 500, gates: 80, prompts: true, level: "full" }), { ...ctx, level: "full" });
  for (const s of plan) assert.ok(s.params.length <= D1_MAX_PARAMS, s.sql.slice(0, 40));
  // 500 events at 13 columns = 7 rows per statement, plus gates, snapshot rows and the factory
  assert.ok(plan.length <= 72 + 10 + 10, `${plan.length} statements`);
  assert.ok(plan.every((s) => (s.sql.match(/\?/g) ?? []).length === s.params.length), "placeholders match params");
});

test("the factory upsert is first and never rewrites another tenant's row", () => {
  const plan = planIngest(makeBatch(), ctx);
  assert.match(plan[0]!.sql, /^INSERT INTO factories/);
  assert.match(plan[0]!.sql, /WHERE factories\.tenant = excluded\.tenant/);
  const sessions = plan.find((s) => s.sql.startsWith("INSERT INTO sessions"))!;
  assert.match(sessions.sql, /sessions\.tenant = excluded\.tenant/);
  assert.doesNotMatch(sessions.sql, /tenant = excluded\.tenant,/, "tenant is never in the SET list");
});

test("ON CONFLICT targets equal the migrated primary keys", () => {
  const sql = readFileSync(path.join(import.meta.dirname, "..", "migrations", "0004_session_repo_key.sql"), "utf8");
  for (const t of Object.values(TABLES)) {
    const m = new RegExp(`CREATE TABLE ${t.name}_new \\(.*PRIMARY KEY \\(([^)]*)\\)`).exec(sql.split("\n").find((l) => l.startsWith(`CREATE TABLE ${t.name}_new `)) ?? "");
    assert.ok(m, t.name);
    assert.deepEqual(m![1]!.split(",").map((x) => x.trim()), t.pk, t.name);
  }
  for (const s of planIngest(makeBatch(), ctx)) {
    const target = /ON CONFLICT\(([^)]*)\)/.exec(s.sql);
    if (target) assert.ok(Object.values(TABLES).some((t) => t.pk.join(", ") === target[1]) || target[1] === "factory_id" || target[1] === "factory_id, repo");
  }
});

test("tier-gated columns coalesce: request at summary only, envelope payload below full", () => {
  const at = (level: "summary" | "trace" | "full") => planIngest(makeBatch({ level }), { ...ctx, level });
  const sess = (level: "summary" | "trace" | "full") => at(level).find((s) => s.sql.startsWith("INSERT INTO sessions"))!.sql;
  assert.match(sess("summary"), /request = COALESCE\(excluded\.request, sessions\.request\)/);
  assert.match(sess("trace"), /request = excluded\.request/);
  const env = (level: "summary" | "trace" | "full") => at(level).find((s) => s.sql.startsWith("INSERT INTO envelopes"))!.sql;
  assert.match(env("trace"), /payload_json = COALESCE/);
  assert.match(env("full"), /payload_json = excluded\.payload_json/);
});

test("issue/PR link columns always coalesce, so a batch from an older factory (no link keys) never blanks them", () => {
  for (const level of ["summary", "trace", "full"] as const) {
    const plan = planIngest(makeBatch({ level }), { ...ctx, level });
    const sess = plan.find((s) => s.sql.startsWith("INSERT INTO sessions"))!;
    for (const c of ["issue_label", "issue_url", "pr_label", "pr_url"]) {
      assert.match(sess.sql, new RegExp(`${c} = COALESCE\\(excluded\\.${c}, sessions\\.${c}\\)`), `${level} ${c}`);
      assert.equal(sess.params[TABLES.sessions.columns.indexOf(c)], null, "an omitted link binds NULL");
    }
  }
  const sent = planIngest(makeBatch({ links: { issue_label: "BT-1221", pr_url: "https://x.test/pr/2" } }), ctx).find((s) => s.sql.startsWith("INSERT INTO sessions"))!;
  assert.equal(sent.params[TABLES.sessions.columns.indexOf("issue_label")], "BT-1221");
  assert.equal(sent.params[TABLES.sessions.columns.indexOf("pr_url")], "https://x.test/pr/2");
});

test("the hub stores only credential-free http(s) link URLs, whatever the factory sent", () => {
  const plan = planIngest(makeBatch({ links: { issue_label: "#1", issue_url: "javascript:alert(1)", pr_label: "#2", pr_url: "https://user:token@x.test/pr/2" } }), ctx);
  const sess = plan.find((s) => s.sql.startsWith("INSERT INTO sessions"))!;
  assert.equal(sess.params[TABLES.sessions.columns.indexOf("issue_url")], null);
  assert.equal(sess.params[TABLES.sessions.columns.indexOf("pr_url")], null);
  assert.equal(sess.params[TABLES.sessions.columns.indexOf("issue_label")], "#1", "labels are kept");
});

test("truncateBatch replaces only oversized strings", () => {
  const b = makeBatch({ events: 1 });
  b.sessions[0]!.events[0]!.payload_json = "é".repeat(140_000); // 280,000 bytes
  b.sessions[0]!.events[0]!.name = "small";
  truncateBatch(b);
  assert.equal(b.sessions[0]!.events[0]!.payload_json, JSON.stringify({ _spf_truncated: 280_000 }));
  assert.equal(b.sessions[0]!.events[0]!.name, "small");
});

test("every repo a factory syncs is recorded, same-tenant only, after the factory row", () => {
  const plan = planIngest(makeBatch(), ctx);
  assert.match(plan[1]!.sql, /^INSERT INTO factory_repos/);
  assert.match(plan[1]!.sql, /WHERE factory_repos\.tenant = excluded\.tenant/);
  assert.deepEqual(plan[1]!.params.slice(1, 3), [ctx.repo, ctx.tenant]);
  const sql = readFileSync(path.join(import.meta.dirname, "..", "migrations", "0003_factory_repos.sql"), "utf8");
  assert.match(sql, /CREATE TABLE factory_repos \(.*PRIMARY KEY \(factory_id, repo\)\)/);
});

test("every child row carries ctx.repo, repo is in every key, and each statement stays within 100 parameters", () => {
  const plan = planIngest(makeBatch({ events: 20, gates: 9, prompts: true, level: "full" }), { ...ctx, level: "full" });
  for (const t of Object.values(TABLES)) {
    assert.ok(t.columns.includes("repo"), t.name);
    assert.ok(t.pk.includes("repo"), t.name);
    const stmts = plan.filter((s) => s.sql.startsWith(`INSERT INTO ${t.name} `));
    assert.ok(stmts.length >= 1, t.name);
    const at = t.columns.indexOf("repo");
    for (const s of stmts) {
      assert.ok(s.params.length <= D1_MAX_PARAMS);
      for (let i = at; i < s.params.length; i += t.columns.length) assert.equal(s.params[i], ctx.repo, `${t.name} row param`);
    }
  }
  const append = planIngest(makeBatch({ snapshot: false }), ctx).find((s) => s.sql.startsWith("UPDATE sessions"))!;
  assert.match(append.sql, /AND repo = \?/);
  assert.ok(append.params.includes(ctx.repo));
});
