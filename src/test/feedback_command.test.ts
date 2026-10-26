import "./hermetic_git.js";

/**
 * `piquette feedback` — operator feedback as a first-class `feedback` trace event.
 * Run against a REAL temp sqlite opened by the REAL `Tracer`, driving
 * `feedbackCommand` and `eventsCommand` end to end (console captured).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer } from "../core/tracer.js";
import { feedbackCommand, promptHash } from "../cli/commands/feedback.js";
import { eventsCommand } from "../cli/commands/events.js";

async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    return { result: await fn(), logs, errors };
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function seed(dir: string): Promise<void> {
  const tracer = await Tracer.open(join(dir, ".piquette", "data", "piquette.db"), join(dir, ".piquette", "data", "sessions", "adw_1", "events.jsonl"));
  await tracer.sessionStart("adw_1", "tester", "plan");
  await tracer.sessionRequest("adw_1", "add a widget");
  await tracer.close();
}

test("piquette feedback records a feedback event tied to run, chain and prompt hash, visible in piquette events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-feedback-test-"));
  try {
    await seed(dir);
    const { result, logs } = await captureConsole(() => feedbackCommand(["adw_1", "the", "reviewer missed the migration", "--cwd", dir]));
    assert.equal(result, 0);
    assert.match(logs.join("\n"), /recorded feedback evt_/);

    const { logs: out } = await captureConsole(() => eventsCommand(["adw_1", "--cwd", dir, "--json"]));
    const events = JSON.parse(out.join("\n"));
    const fb = events.find((e: any) => e.type === "feedback");
    assert.ok(fb, "feedback event is listed by piquette events");
    assert.equal(fb.adw_id, "adw_1");
    const payload = JSON.parse(fb.payload_json);
    assert.equal(payload.text, "the reviewer missed the migration");
    assert.equal(payload.chain, "plan");
    assert.equal(payload.prompt_hash, promptHash("add a widget"));

    const { logs: plain } = await captureConsole(() => eventsCommand(["adw_1", "--cwd", dir]));
    assert.match(plain.join("\n"), /feedback\s+operator_feedback .*migration/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("piquette feedback rejects an unknown run and missing text without writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-feedback-test-"));
  try {
    await seed(dir);
    const unknown = await captureConsole(() => feedbackCommand(["nope", "hi", "--cwd", dir]));
    assert.equal(unknown.result, 1);
    assert.match(unknown.errors.join("\n"), /no such run/);
    const noText = await captureConsole(() => feedbackCommand(["adw_1", "--cwd", dir]));
    assert.equal(noText.result, 1);
    assert.match(noText.errors.join("\n"), /usage/);
    const blank = await captureConsole(() => feedbackCommand(["adw_1", "   ", "--cwd", dir]));
    assert.equal(blank.result, 1, "whitespace-only text is no feedback at all");

    // "without writing": no row in either run's trace, and no session dir
    // conjured for the unknown id (the events.jsonl twin lands under it).
    for (const id of ["adw_1", "nope"]) {
      const { logs } = await captureConsole(() => eventsCommand([id, "--cwd", dir, "--json"]));
      assert.deepEqual(JSON.parse(logs.join("\n")).filter((e: any) => e.type === "feedback"), [], `no feedback event for ${id}`);
    }
    assert.equal(existsSync(join(dir, ".piquette", "data", "sessions", "nope")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A stand-in for the D1 HTTP API over an in-memory node:sqlite db — enough of
 * the `/query` envelope (`{sql, params}` and `{batch}`) for `Tracer` and
 * `SfDb` to run unmodified against a `kind: d1` config.
 */
function fakeD1Fetch(): typeof fetch {
  const mem = new DatabaseSync(":memory:");
  const one = (sql: string, params: SQLInputValue[] = []) => {
    const stmt = mem.prepare(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return { success: true, results: stmt.all(...params), meta: {} };
    const r = stmt.run(...params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { sql?: string; params?: SQLInputValue[]; batch?: Array<{ sql: string }> };
    const result = body.batch ? body.batch.map((b) => one(b.sql)) : [one(body.sql!, body.params)];
    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });
  }) as typeof fetch;
}

test("piquette feedback writes and reads back through a kind:d1 trace backend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-feedback-d1-test-"));
  const saved = { fetch: globalThis.fetch, acct: process.env.TEST_FB_D1_ACCOUNT, tok: process.env.TEST_FB_D1_TOKEN };
  globalThis.fetch = fakeD1Fetch();
  process.env.TEST_FB_D1_ACCOUNT = "acct";
  process.env.TEST_FB_D1_TOKEN = "tok";
  try {
    mkdirSync(join(dir, ".piquette"), { recursive: true });
    writeFileSync(
      join(dir, ".piquette", "piquette.config.yaml"),
      "observability:\n  db:\n    kind: d1\n    database_id: fb-test\n    account_id_env: TEST_FB_D1_ACCOUNT\n    api_token_env: TEST_FB_D1_TOKEN\n",
    );
    const d1 = { kind: "d1" as const, database_id: "fb-test", account_id_env: "TEST_FB_D1_ACCOUNT", api_token_env: "TEST_FB_D1_TOKEN" };
    const tracer = await Tracer.open(d1, join(dir, ".piquette", "data", "sessions", "adw_d1", "events.jsonl"));
    await tracer.sessionStart("adw_d1", "tester", "build");
    await tracer.close();

    const { result } = await captureConsole(() => feedbackCommand(["adw_d1", "wrong file touched", "--cwd", dir]));
    assert.equal(result, 0);
    const { logs } = await captureConsole(() => eventsCommand(["adw_d1", "--cwd", dir, "--json"]));
    const fb = JSON.parse(logs.join("\n")).find((e: any) => e.type === "feedback");
    assert.ok(fb, "the feedback row landed in D1, not a stray local piquette.db");
    const { operator: _operator, ...payload } = JSON.parse(fb.payload_json);
    assert.deepEqual(payload, { text: "wrong file touched", chain: "build", prompt_hash: null }, "no recorded request -> prompt_hash is null");
    assert.equal(existsSync(join(dir, ".piquette", "data", "piquette.db")), false);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [k, v] of [["TEST_FB_D1_ACCOUNT", saved.acct], ["TEST_FB_D1_TOKEN", saved.tok]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
