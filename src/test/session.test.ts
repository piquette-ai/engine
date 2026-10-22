/**
 * `session.ts`'s signal wiring — one process-wide SIGTERM/SIGINT listener,
 * not one per `ensure()` call (`spf watch` calls `ensure()` once per claimed
 * issue, in-process, for the life of the daemon).
 *
 * Two things are pinned here, both regressions a prior version of this file
 * shipped:
 *
 *  1. A fresh listener per `ensure()` call means every listener EVER
 *     registered stays registered and fires on the NEXT signal — so a
 *     signal arriving during issue 72 would also re-run issue 70 and 71's
 *     long-finished handlers, flipping their already-`success` sessions
 *     back to `fail`. `finalize()` (called from `chains/index.ts`'s
 *     `runChain()` finally, same seam as `otel.releaseOtelExporter()`)
 *     removes a run from the set the signal handler acts on the moment its
 *     own dispatch settles — proven here via `activeRunIdsForTest()`.
 *  2. The same per-`ensure()` listener kept every finished run's `Run` (and
 *     its Tracer, and its open sqlite handle) strongly reachable from
 *     `process`'s own listener array for the rest of the daemon's life —
 *     both the listener-count growth and the leak. `finalize()` closes the
 *     Tracer's sqlite handle; a query against it afterward throws, which is
 *     the only externally observable proof a handle was actually released.
 *
 * No real SIGTERM/SIGINT is ever sent in this file — the handler's own
 * `process.exit()` would end the test run. Only the bookkeeping around it
 * (registration count, the active-run set, the closed handle) is asserted.
 */
import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { RUN_KILLED_EVENT, SFConfigSchema, type SFConfig } from "../core/data_types.js";
import * as paths from "../core/paths.js";
import { Tracer } from "../core/tracer.js";
import { activeRunIdsForTest, ensure, finalize } from "../core/session.js";
import { hasLiveNotifiers, releaseNotifier, resetLiveForTest } from "../core/notify/notifier.js";

// Captured before this file's tests run any `ensure()` call, so "the shared
// listener installs at most once" can be asserted as a fixed delta rather
// than an absolute count (other test files, and node:test itself, run in
// their own process, but nothing here should assume a pristine listener
// count if that ever stops being true).
const baselineSigterm = process.listenerCount("SIGTERM");
const baselineSigint = process.listenerCount("SIGINT");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "spf-session-test-"));
}

function cfg(): SFConfig {
  return v.parse(SFConfigSchema, {}) as SFConfig;
}

test("ensure() registers a run as active, and finalize() removes it", async () => {
  const dir = tmpRepo();
  try {
    const run = await ensure(cfg(), "adw_session_finalize_a", dir, "plan");
    assert.ok(activeRunIdsForTest().includes("adw_session_finalize_a"), "a just-started run is tracked as active");

    await finalize("adw_session_finalize_a");
    assert.ok(!activeRunIdsForTest().includes("adw_session_finalize_a"), "a finalized run is no longer tracked — a later signal must not touch it");

    // The Tracer's sqlite handle is actually closed, not merely forgotten —
    // this is the memory-leak half of the fix, not just the correctness half.
    assert.throws(() => run.tracer.db.query("SELECT 1").get(), /not open/, "finalize() closes the Tracer's sqlite handle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize(id) on an id that was never registered, or already finalized, is a silent no-op", async () => {
  const dir = tmpRepo();
  try {
    await assert.doesNotReject(() => finalize("adw_never_registered"));
    await assert.doesNotReject(() => finalize(null));
    await assert.doesNotReject(() => finalize(undefined));

    const run = await ensure(cfg(), "adw_session_double_finalize", dir, "plan");
    await finalize("adw_session_double_finalize");
    // A second finalize() must not try to close an already-closed handle.
    await assert.doesNotReject(() => finalize("adw_session_double_finalize"));
    void run;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two ensure() calls in one process install the shared signal listener only once", async () => {
  const dirA = tmpRepo();
  const dirB = tmpRepo();
  try {
    await ensure(cfg(), "adw_session_listener_a", dirA, "plan");
    await ensure(cfg(), "adw_session_listener_b", dirB, "plan");

    assert.equal(process.listenerCount("SIGTERM"), baselineSigterm + 1, "a second ensure() must not add a second SIGTERM listener");
    assert.equal(process.listenerCount("SIGINT"), baselineSigint + 1, "a second ensure() must not add a second SIGINT listener");
  } finally {
    await finalize("adw_session_listener_a");
    await finalize("adw_session_listener_b");
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("a run still active (never finalized) stays in the active set — a signal must still be able to reach it", async () => {
  const dir = tmpRepo();
  try {
    await ensure(cfg(), "adw_session_still_running", dir, "plan");
    assert.ok(activeRunIdsForTest().includes("adw_session_still_running"), "an in-flight run is exactly what the signal handler must still finalize");
  } finally {
    await finalize("adw_session_still_running");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signalled run writes the run_killed marker synchronously, before the process exits (local, undrained path)", async () => {
  const dir = tmpRepo();
  try {
    const sessionUrl = new URL("../core/session.js", import.meta.url).href;
    const dataTypesUrl = new URL("../core/data_types.js", import.meta.url).href;
    const script = `
      import * as v from "valibot";
      const { ensure } = await import(${JSON.stringify(sessionUrl)});
      const { SFConfigSchema } = await import(${JSON.stringify(dataTypesUrl)});
      await ensure(v.parse(SFConfigSchema, {}), "adw_killed_marker", ${JSON.stringify(dir)}, "plan");
      setTimeout(() => {}, 5000); // keep the loop alive until the signal lands
      process.kill(process.pid, "SIGINT");
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: join(new URL("../..", import.meta.url).pathname), encoding: "utf8" });
    assert.equal(child.status, 130, `the handler exits with 128+SIGINT: ${child.stderr}`);

    const { resolveAnchor, resolveDataPaths } = paths;
    const c = cfg();
    const dbPath = resolveDataPaths(resolveAnchor(dir), c.defaults.data_dir, c.observability.db).db;
    assert.ok(dbPath, "a local db path");
    const tracer = await Tracer.open(dbPath!, join(dir, "events.jsonl"));
    try {
      const marker = (await tracer.db.query("SELECT type, name, payload_json FROM events WHERE adw_id = ? AND name = ?").all("adw_killed_marker", RUN_KILLED_EVENT)) as Array<{ type: string; payload_json: string }>;
      assert.equal(marker.length, 1, "exactly one run_killed marker");
      assert.equal(marker[0]!.type, "log", "an ordinary log row, so no status reader changes");
      assert.deepEqual(JSON.parse(marker[0]!.payload_json), { signal: "SIGINT" });
      const sess = (await tracer.db.query("SELECT status FROM sessions WHERE adw_id = ?").get("adw_killed_marker")) as { status: string };
      assert.equal(sess.status, "fail", "session semantics are unchanged: a kill is still `fail`");
    } finally {
      await tracer.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure() registers the run's notifier under its adw_id; it stays reachable after finalize() until releaseNotifier() (#31)", async () => {
  // The signal handler's notify drain is gated on this registry, not on the
  // in-flight runs: a notifier must still count as live after finalize()
  // dropped its run from the active set, until runChain's release removes it.
  resetLiveForTest();
  const dir = tmpRepo();
  const envKey = "SPF_TEST_SESSION_WEBHOOK";
  process.env[envKey] = "http://127.0.0.1:1/hook";
  try {
    // `errors`: still registers a Notifier, but run_started (info) is never sent to the dead port.
    const withNotify = v.parse(SFConfigSchema, { notifications: { events: "errors", channels: [{ kind: "webhook", webhook_url_env: envKey }] } }) as SFConfig;
    assert.equal(hasLiveNotifiers(), false);
    await ensure(withNotify, "adw_session_notify", dir, "plan");
    assert.equal(hasLiveNotifiers(), true);

    await finalize("adw_session_notify");
    assert.equal(activeRunIdsForTest().includes("adw_session_notify"), false);
    assert.equal(hasLiveNotifiers(), true, "no run is in flight, yet the registry (what drainAll drains, and what the signal gate checks) is non-empty");

    await releaseNotifier("adw_session_notify");
    assert.equal(hasLiveNotifiers(), false);
  } finally {
    delete process.env[envKey];
    resetLiveForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});
