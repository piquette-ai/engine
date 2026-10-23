import "./hermetic_git.js";

/**
 * `spf sync`'s push client (#135) against an in-process fake hub on loopback,
 * for a local-sqlite source and a D1 source alike: headers, idempotent
 * cursors, resume, batching, every failure mode leaving state untouched, the
 * 409 stop, level changes, and secrets staying out of every message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { followSync, runSyncPass, type SyncPassOptions, type SyncPassReport } from "../core/sync/client.js";
import { MAX_BATCH_EVENTS } from "../core/sync/contract.js";
import { lockFileFor, stateFileFor, type SyncState } from "../core/sync/state.js";
import { acquirePidLock, releasePidLock } from "../core/utils.js";
import { startFakeHub, type FakeHub } from "./fake_hub.js";
import { addEvents, addGate, addSession, FIXED_FACTORY_ID, makeFixture, syncCfg, TEST_CLIENT_ID, TEST_CLIENT_SECRET, withSyncEnv, type Fixture } from "./sync_fixtures.js";

const KINDS = ["sqlite", "d1"] as const;

async function withEnv(kind: "sqlite" | "d1", fn: (fx: Fixture, hub: FakeHub) => Promise<void>): Promise<void> {
  const fx = await makeFixture(kind);
  const hub = await startFakeHub();
  try {
    await withSyncEnv(() => fn(fx, hub));
  } finally {
    await hub.close();
    fx.cleanup();
  }
}

function pass(fx: Fixture, hub: FakeHub, over: Partial<SyncPassOptions> = {}): Promise<SyncPassReport> {
  return runSyncPass({
    cfg: syncCfg(hub.url),
    anchor: { repo_root: fx.dir },
    dataPaths: fx.dataPaths,
    level: "trace",
    dryRun: false,
    sourceFetchImpl: fx.sourceFetchImpl,
    now: () => "2026-02-02T00:00:00.000Z",
    log: () => {},
    ...over,
  });
}

const readState = (fx: Fixture): SyncState => JSON.parse(readFileSync(stateFileFor(fx.dataPaths.data_dir, false), "utf-8")) as SyncState;
const readState_maybe = (fx: Fixture): SyncState | undefined => (existsSync(stateFileFor(fx.dataPaths.data_dir, false)) ? readState(fx) : undefined);
const stateBytes = (fx: Fixture): string => readFileSync(stateFileFor(fx.dataPaths.data_dir, false), "utf-8");

for (const kind of KINDS) {
  test(`${kind} source: the first pass pushes everything with the schema + Access headers; a second pass sends nothing`, async () => {
    await withEnv(kind, async (fx, hub) => {
      addSession(fx, "adw1");
      addEvents(fx, "adw1", 1, 3);
      addGate(fx, "adw1");
      const report = await pass(fx, hub);
      assert.equal(report.status, "ok", report.error);
      assert.equal(hub.posts().length, 1);
      const req = hub.posts()[0]!;
      assert.equal(req.url, "/ingest/v1");
      assert.equal(req.headers["x-spf-sync-schema"], "1");
      assert.equal(req.headers["cf-access-client-id"], TEST_CLIENT_ID);
      assert.equal(req.headers["cf-access-client-secret"], TEST_CLIENT_SECRET);
      assert.equal(req.headers["idempotency-key"], req.batch!.batch_id);
      assert.match(String(req.headers["user-agent"]), /^spf\//);
      assert.deepEqual(hub.invalid, []);
      const entry = req.batch!.sessions[0]!;
      assert.equal(req.batch!.factory.factory_id, FIXED_FACTORY_ID);
      assert.ok(entry.snapshot, "first push carries the snapshot");
      assert.equal(entry.snapshot!.session.factory_id, FIXED_FACTORY_ID);
      assert.equal(entry.events.length, 3);
      assert.equal(entry.gate_results.length, 1);
      assert.equal(readState(fx).sessions["adw1"]!.final, true);

      const again = await pass(fx, hub);
      assert.equal(again.status, "nothing");
      assert.equal(hub.posts().length, 1, "no change -> no request");
    });
  });

  test(`${kind} source: a new event is exactly one append batch, with no snapshot`, async () => {
    await withEnv(kind, async (fx, hub) => {
      addSession(fx, "adw1");
      addEvents(fx, "adw1", 1, 2);
      await pass(fx, hub);
      addEvents(fx, "adw1", 3, 1);
      const report = await pass(fx, hub);
      assert.equal(report.status, "ok", report.error);
      assert.equal(hub.posts().length, 2);
      const entry = hub.posts()[1]!.batch!.sessions[0]!;
      assert.equal(entry.snapshot, undefined);
      assert.deepEqual(entry.events.map((e) => e.event_id), ["adw1-ev3"]);
    });
  });
}

test("the sqlite and D1 sources push identical session payloads", async () => {
  const bodies: string[] = [];
  for (const kind of KINDS) {
    await withEnv(kind, async (fx, hub) => {
      addSession(fx, "adw1");
      addEvents(fx, "adw1", 1, 2);
      addGate(fx, "adw1");
      await pass(fx, hub);
      bodies.push(JSON.stringify(hub.posts()[0]!.batch!.sessions));
    });
  }
  assert.equal(bodies[0], bodies[1]);
});

test("600 events split into two batches and the cursor advances per accepted batch", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    addEvents(fx, "adw1", 1, 600);
    hub.reply((_r, n) => (n === 2 ? { status: 500 } : undefined));
    const failed = await pass(fx, hub);
    assert.equal(failed.status, "failed");
    assert.equal(hub.posts()[0]!.batch!.sessions[0]!.events.length, MAX_BATCH_EVENTS);
    const mid = readState(fx).sessions["adw1"]!;
    assert.equal(mid.events_cursor, 500);
    assert.equal(mid.events_count, 500);
    assert.equal(mid.final, false, "not final until its tail is accepted");

    hub.reply(undefined);
    const resumed = await pass(fx, hub);
    assert.equal(resumed.status, "ok", resumed.error);
    const last = hub.posts()[hub.posts().length - 1]!.batch!.sessions[0]!;
    assert.equal(last.events.length, 100);
    assert.equal(last.snapshot, undefined, "the snapshot was already accepted");
    assert.equal(hub.uniqueEventIds().size, 600);
    assert.equal(readState(fx).sessions["adw1"]!.final, true);
  });
});

for (const [label, reply] of [
  ["a 500", { status: 500 }],
  ["a 302 to Access login", { status: 302, headers: { Location: "http://127.0.0.1:9/login" } }],
  ["a 403", { status: 403 }],
  ["a timeout", { status: 200, hangMs: 2500 }],
] as const) {
  test(`${label} leaves the state file byte-identical and the next pass resends the same rows`, async () => {
    await withEnv("sqlite", async (fx, hub) => {
      addSession(fx, "adw1");
      addEvents(fx, "adw1", 1, 2);
      await pass(fx, hub);
      const before = stateBytes(fx);
      addEvents(fx, "adw1", 3, 1);
      hub.reply(() => reply);
      const failed = await pass(fx, hub, { cfg: syncCfg(hub.url, { timeout_ms: 1000 }) });
      assert.equal(failed.status, "failed");
      assert.equal(stateBytes(fx), before);
      if (label.includes("302")) assert.ok(hub.requests.every((r) => r.url === "/ingest/v1"), "a redirect is never followed (the Access secret header would travel with it)");
      const failedId = hub.posts()[hub.posts().length - 1]!.batch!.batch_id;
      hub.reply(undefined);
      const ok = await pass(fx, hub);
      assert.equal(ok.status, "ok", ok.error);
      assert.equal(hub.posts()[hub.posts().length - 1]!.batch!.batch_id, failedId, "the retry is the same batch");
    });
  });
}

test("a crash between the 2xx and the state write replays with the same batch_id", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    addEvents(fx, "adw1", 1, 2);
    const crashed = await pass(fx, hub, {
      afterAccepted: () => {
        throw new Error("simulated crash");
      },
    });
    assert.equal(crashed.status, "failed");
    assert.equal(existsSync(stateFileFor(fx.dataPaths.data_dir, false)), false, "no state was written");
    const replay = await pass(fx, hub);
    assert.equal(replay.status, "ok", replay.error);
    assert.equal(hub.posts().length, 2);
    assert.equal(hub.posts()[0]!.batch!.batch_id, hub.posts()[1]!.batch!.batch_id);
    assert.equal(hub.uniqueEventIds().size, 2, "the hub's upsert makes the replay a no-op");
  });
});

test("a 409 persists `rejected` and the next pass makes zero requests", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    hub.reply(() => ({ status: 409, body: { supported: [2, 3] } }));
    const first = await pass(fx, hub);
    assert.equal(first.status, "rejected");
    assert.deepEqual(readState(fx).rejected?.supported, [2, 3]);
    const n = hub.requests.length;
    const second = await pass(fx, hub);
    assert.equal(second.status, "rejected");
    assert.equal(hub.requests.length, n);
  });
});

test("`spf feedback` writing after the session ended is picked up through the high-water mark", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    addEvents(fx, "adw1", 1, 1);
    await pass(fx, hub);
    assert.equal(readState(fx).sessions["adw1"]!.final, true);
    addEvents(fx, "adw1", 2, 1, { type: "feedback", name: "operator_feedback", payload: { text: "FEEDBACK-TEXT" } });
    const report = await pass(fx, hub);
    assert.equal(report.status, "ok", report.error);
    const entry = hub.posts()[1]!.batch!.sessions[0]!;
    assert.deepEqual(entry.events.map((e) => e.event_id), ["adw1-ev2"]);
    assert.equal(entry.events[0]!.name, null, "feedback names are free text: null at trace");
    assert.ok(!hub.posts()[1]!.raw.includes("FEEDBACK-TEXT"));
  });
});

test("an ended_at change (a resumed session) sends a new snapshot", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1", { ended_at: null });
    await pass(fx, hub);
    assert.equal(readState(fx).sessions["adw1"]!.final, false);
    await pass(fx, hub); // not final: a candidate again, but nothing changed
    assert.equal(hub.posts().length, 1);
    addSession(fx, "adw1", { ended_at: "2026-01-01T01:00:00+00:00" });
    const report = await pass(fx, hub);
    assert.equal(report.status, "ok", report.error);
    assert.ok(hub.posts()[1]!.batch!.sessions[0]!.snapshot);
    assert.equal(readState(fx).sessions["adw1"]!.final, true);
  });
});

test("an events_count mismatch (renumbered rowids) resets the cursors and resends", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    addEvents(fx, "adw1", 1, 3);
    await pass(fx, hub);
    const state = readState(fx);
    state.sessions["adw1"]!.events_count += 5;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(stateFileFor(fx.dataPaths.data_dir, false), JSON.stringify(state));
    addEvents(fx, "adw1", 4, 1);
    const logs: string[] = [];
    const report = await pass(fx, hub, { log: (m) => logs.push(m) });
    assert.equal(report.status, "ok", report.error);
    assert.equal(hub.posts()[1]!.batch!.sessions[0]!.events.length, 4, "resent from 0, not just the new event");
    assert.ok(logs.some((l) => /renumbered/.test(l)));
  });
});

test("raising the level resends from 0; lowering it does not", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    addEvents(fx, "adw1", 1, 2);
    await pass(fx, hub, { level: "summary" });
    assert.equal(hub.posts()[0]!.batch!.sessions[0]!.events.length, 0, "summary sends no events");
    await pass(fx, hub, { level: "trace" });
    assert.equal(hub.posts().length, 2);
    assert.equal(hub.posts()[1]!.batch!.sessions[0]!.events.length, 2, "raised: backfilled from 0");
    assert.ok(hub.posts()[1]!.batch!.sessions[0]!.snapshot, "and the snapshot is resent at the new tier");
    await pass(fx, hub, { level: "summary" });
    assert.equal(hub.posts().length, 2, "lowered: nothing resent");
  });
});

test("errors and logs never contain the secret, the id or the endpoint", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    const endpoint = "http://127.0.0.1:1";
    const logs: string[] = [];
    const report = await pass(fx, hub, { cfg: syncCfg(endpoint), log: (m) => logs.push(m) });
    assert.equal(report.status, "failed");
    const all = [report.error ?? "", ...logs].join("\n");
    for (const forbidden of [TEST_CLIENT_SECRET, TEST_CLIENT_ID, endpoint]) assert.ok(!all.includes(forbidden), `leaked ${forbidden}`);

    // the one non-2xx body the client reads is a 409's: a hub echoing the secret there must not get it printed
    hub.reply(() => ({ status: 409, body: { error: TEST_CLIENT_SECRET, supported: TEST_CLIENT_SECRET } }));
    const echoed = await pass(fx, hub, { log: (m) => logs.push(m) });
    assert.equal(echoed.status, "failed", "an unparseable 409 is a retryable failure");
    assert.ok(![echoed.error ?? "", ...logs].join("\n").includes(TEST_CLIENT_SECRET));
  });
});

test("missing credentials fail the pass naming the variable, never a value", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    delete process.env.SPF_SYNC_CLIENT_SECRET;
    const report = await pass(fx, hub);
    assert.equal(report.status, "failed");
    assert.match(report.error ?? "", /SPF_SYNC_CLIENT_SECRET not set/);
    assert.equal(hub.requests.length, 0);
  });
});

test("a second concurrent pass returns `locked`", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    const lock = lockFileFor(fx.dataPaths.data_dir);
    assert.equal(acquirePidLock(lock).ok, true);
    try {
      const report = await pass(fx, hub);
      assert.equal(report.status, "locked");
      assert.equal(hub.requests.length, 0);
    } finally {
      releasePidLock(lock);
    }
    assert.equal((await pass(fx, hub)).status, "ok");
    assert.equal(existsSync(lock), false, "the lock is released after a pass");
  });
});

test("a dry run reads no credentials, sends nothing and writes no real state", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    addEvents(fx, "adw1", 1, 2);
    delete process.env.SPF_SYNC_CLIENT_ID;
    delete process.env.SPF_SYNC_CLIENT_SECRET;
    const report = await pass(fx, hub, { dryRun: true });
    assert.equal(report.status, "ok", report.error);
    assert.equal(report.events, 2);
    assert.equal(hub.requests.length, 0);
    assert.equal(existsSync(stateFileFor(fx.dataPaths.data_dir, false)), false);
    assert.equal(existsSync(stateFileFor(fx.dataPaths.data_dir, true)), false, "without --out not even dry-run state");
  });
});

test("followSync backs off after a failure, resets after a success and stops on a rejected schema", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    const controller = new AbortController();
    const waits: number[] = [];
    hub.reply((_r, n) => (n <= 2 ? { status: 500 } : n === 4 ? { status: 409, body: { supported: [3, 3] } } : undefined));
    addEvents(fx, "adw1", 1, 1);
    const reports: string[] = [];
    await followSync(
      { cfg: syncCfg(hub.url, { interval_ms: 1000 }), anchor: { repo_root: fx.dir }, dataPaths: fx.dataPaths, level: "trace", dryRun: false, log: () => {}, signal: controller.signal },
      (r) => {
        reports.push(r.status);
        if (r.status === "ok") addEvents(fx, "adw1", 10, 1); // new work so the next tick pushes again
      },
      async (ms) => void waits.push(ms),
    );
    assert.deepEqual(reports, ["failed", "failed", "ok", "rejected"]);
    assert.ok(waits[0]! >= 1600 && waits[0]! <= 2400, `first backoff ~2x interval, got ${waits[0]}`);
    assert.ok(waits[1]! >= 3200 && waits[1]! <= 4800, `second backoff ~4x interval, got ${waits[1]}`);
    assert.equal(waits[2], 1000, "a success resets the wait to the interval");
  });
});

test("a summary pass does not hide an event added to a final session: the next trace pass still sends it", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    addEvents(fx, "adw1", 1, 2);
    await pass(fx, hub);
    assert.equal(readState(fx).sessions["adw1"]!.final, true);
    addEvents(fx, "adw1", 3, 1, { type: "feedback", name: "operator_feedback" });
    const summary = await pass(fx, hub, { level: "summary" });
    assert.equal(summary.status, "nothing");
    assert.equal(readState(fx).events_hwm, 2, "a pass that did not look at events leaves the mark where it was");
    const trace = await pass(fx, hub);
    assert.equal(trace.status, "ok", trace.error);
    assert.equal(trace.events, 1);
    assert.equal(hub.uniqueEventIds().size, 3);
  });
});

test("a level raise backfilling more than one batch, failing mid-way, resumes from the cursor — never stuck `final`", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    addEvents(fx, "adw1", 1, 1200);
    await pass(fx, hub, { level: "summary" });
    assert.equal(readState(fx).sessions["adw1"]!.final, true);
    const base = hub.posts().length;
    hub.reply((_r, n) => (n === base + 2 ? { status: 500 } : undefined));
    const failed = await pass(fx, hub);
    assert.equal(failed.status, "failed");
    const mid = readState(fx).sessions["adw1"]!;
    assert.equal(mid.events_cursor, MAX_BATCH_EVENTS, "the first backfill batch was accepted");
    assert.equal(mid.final, false, "a half-backfilled session is not final");
    hub.reply(undefined);
    const resumed = await pass(fx, hub);
    assert.equal(resumed.status, "ok", resumed.error);
    assert.equal(resumed.events, 700);
    assert.equal(hub.uniqueEventIds().size, 1200);
    assert.equal(readState(fx).sessions["adw1"]!.final, true);
  });
});

test("a renumber resend that fails mid-way resumes too", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    addEvents(fx, "adw1", 1, 1200);
    await pass(fx, hub);
    const state = readState(fx);
    state.sessions["adw1"]!.events_count += 5;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(stateFileFor(fx.dataPaths.data_dir, false), JSON.stringify(state));
    addEvents(fx, "adw1", 1201, 1); // renumber detection runs for candidates: new activity makes the session one
    const base = hub.posts().length;
    hub.reply((_r, n) => (n === base + 2 ? { status: 500 } : undefined));
    assert.equal((await pass(fx, hub)).status, "failed");
    assert.equal(readState(fx).sessions["adw1"]!.final, false);
    hub.reply(undefined);
    const resumed = await pass(fx, hub);
    assert.equal(resumed.status, "ok", resumed.error);
    assert.equal(resumed.events, 701);
  });
});

test("a 409 without a {supported} range that excludes us is a retryable failure, not a persisted rejection", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    hub.reply(() => ({ status: 409, body: { error: "request in progress" } }));
    const busy = await pass(fx, hub);
    assert.equal(busy.status, "failed");
    assert.equal(readState_maybe(fx)?.rejected, undefined);
    hub.reply(() => ({ status: 409, body: { supported: [1, 1] } }));
    assert.equal((await pass(fx, hub)).status, "failed", "a range that includes our version is no rejection either");
    hub.reply(undefined);
    assert.equal((await pass(fx, hub)).status, "ok");
  });
});

test("a plain --dry-run previews against the real cursors, even after a --dry-run --out", async () => {
  await withEnv("sqlite", async (fx, hub) => {
    addSession(fx, "adw1");
    addEvents(fx, "adw1", 1, 2);
    const out = join(fx.dir, "preview.ndjson");
    await pass(fx, hub, { dryRun: true, out });
    const preview = await pass(fx, hub, { dryRun: true });
    assert.equal(preview.events, 2, "the real push would still send everything");
    assert.equal(hub.requests.length, 0);
    await pass(fx, hub);
    const after = await pass(fx, hub, { dryRun: true });
    assert.equal(after.status, "nothing", "once really pushed, there is nothing left to preview");
  });
});

test("D1 source: idle running sessions cost no snapshot reads, and --follow keeps table_info across passes", async () => {
  await withEnv("d1", async (fx, hub) => {
    for (let i = 0; i < 10; i++) addSession(fx, `run${i}`, { ended_at: null });
    let calls = 0;
    const inner = fx.sourceFetchImpl!;
    const counting = ((...a: Parameters<typeof fetch>) => {
      calls++;
      return inner(...a);
    }) as typeof fetch;
    const columnCache = new Map<string, Set<string>>();
    await pass(fx, hub, { sourceFetchImpl: counting, columnCache });
    const first = calls;
    calls = 0;
    const idle = await pass(fx, hub, { sourceFetchImpl: counting, columnCache });
    assert.equal(idle.status, "nothing");
    assert.ok(calls <= 8, `an idle pass made ${calls} D1 calls (first pass: ${first})`);
    addEvents(fx, "run3", 1, 1);
    const busy = await pass(fx, hub, { sourceFetchImpl: counting, columnCache });
    assert.deepEqual(busy.detail.map((d) => d.adw_id), ["run3"], "only the session with new events is read");
  });
});
