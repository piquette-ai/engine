import "./hermetic_git.js";

/** `spf sync` the command (#135): flags, exit codes, dry run and its separate cursors. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncCommand } from "../cli/commands/sync.js";
import { startFakeHub, type FakeHub } from "./fake_hub.js";
import { addEvents, addGate, addSession, makeFixture, withSyncEnv, type Fixture } from "./sync_fixtures.js";

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    return { code: await syncCommand(argv), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function withRepo(syncYaml: string | null, fn: (fx: Fixture, hub: FakeHub, args: string[]) => Promise<void>): Promise<void> {
  const fx = await makeFixture("sqlite");
  const hub = await startFakeHub();
  try {
    addSession(fx, "adw1");
    addEvents(fx, "adw1", 1, 4);
    addGate(fx, "adw1");
    // Where credentials go is honored only from the machine layer (a repo layer's sync.endpoint is ignored).
    const machine = join(fx.dir, "machine-home");
    mkdirSync(machine, { recursive: true });
    mkdirSync(join(fx.dir, ".spf"), { recursive: true });
    if (syncYaml !== null) writeFileSync(join(machine, "spf.config.yaml"), syncYaml.replace("HUB", hub.url));
    process.env["SPF_CONFIG_HOME"] = machine;
    await withSyncEnv(() => fn(fx, hub, ["--cwd", fx.dir]));
  } finally {
    delete process.env["SPF_CONFIG_HOME"];
    await hub.close();
    fx.cleanup();
  }
}

const CONFIG = "sync:\n  endpoint: HUB\n  level: trace\n";

test("--dry-run prints per-session counts and the hub receives nothing", async () => {
  await withRepo(CONFIG, async (fx, hub, args) => {
    const r = await run([...args, "--dry-run"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /adw1: snapshot, 4 event\(s\), 1 gate result\(s\)/);
    assert.match(r.out, /dry run — would push 1 session\(s\)/);
    assert.equal(hub.requests.length, 0);
    assert.equal(existsSync(join(fx.dataPaths.data_dir, "sync-state.json")), false);
  });
});

test("--dry-run --out twice: the second file is empty, and the real sync-state.json never appears", async () => {
  await withRepo(CONFIG, async (fx, hub, args) => {
    const first = join(fx.dir, "first.ndjson");
    const second = join(fx.dir, "second.ndjson");
    assert.equal((await run([...args, "--dry-run", "--out", first])).code, 0);
    assert.equal((await run([...args, "--dry-run", "--out", second])).code, 0);
    const lines = readFileSync(first, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).sync_schema, 1);
    assert.equal(readFileSync(second, "utf-8"), "");
    assert.equal(existsSync(join(fx.dataPaths.data_dir, "sync-state.json")), false);
    assert.equal(existsSync(join(fx.dataPaths.data_dir, "sync-state.dry-run.json")), true);
    assert.equal(hub.requests.length, 0);
  });
});

test("--level above the configured level exits 1 and says to raise sync.level", async () => {
  await withRepo(CONFIG, async (_fx, hub, args) => {
    const r = await run([...args, "--level", "full"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /raise sync\.level in config to opt in/);
    assert.equal(hub.requests.length, 0);
    assert.equal((await run([...args, "--level", "bogus"])).code, 1);
    assert.equal((await run([...args, "--dry-run", "--level", "summary"])).code, 0, "lowering is fine");
  });
});

test("--out without --dry-run is an error; so is --follow with --dry-run", async () => {
  await withRepo(CONFIG, async (_fx, hub, args) => {
    const r = await run([...args, "--out", "x.ndjson"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /--out only applies to --dry-run/);
    assert.equal((await run([...args, "--follow", "--dry-run"])).code, 1);
    assert.equal(hub.requests.length, 0);
  });
});

test("without a sync: block a real push exits 1, but --dry-run works on the defaults", async () => {
  await withRepo(null, async (_fx, hub, args) => {
    const real = await run(args);
    assert.equal(real.code, 1);
    assert.match(real.err, /sync is not configured/);
    const dry = await run([...args, "--dry-run"]);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /4 event\(s\)/);
    assert.equal(hub.requests.length, 0);
  });
});

test("exit codes: 0 pushed, 2 failed (state untouched), 3 schema rejected", async () => {
  await withRepo(CONFIG, async (fx, hub, args) => {
    hub.reply(() => ({ status: 500 }));
    const failed = await run(args);
    assert.equal(failed.code, 2);
    assert.match(failed.err, /failed: hub answered HTTP 500/);
    assert.equal(existsSync(join(fx.dataPaths.data_dir, "sync-state.json")), false);

    hub.reply(undefined);
    const ok = await run(args);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /pushed 1 session\(s\)/);
    assert.ok(ok.out.trimEnd().endsWith(`-> ${hub.url}/`), `the endpoint is printed as exactly its label: ${ok.out}`);
    assert.ok(!ok.out.includes("/ingest/v1"), "never the ingest path");

    addEvents(fx, "adw1", 5, 1);
    hub.reply(() => ({ status: 409, body: { supported: [2, 2] } }));
    assert.equal((await run(args)).code, 3);
    assert.equal((await run(args)).code, 3, "and it stays 3 without hammering the hub");
  });
});
