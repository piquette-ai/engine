import "./hermetic_git.js";

/** `sync.on_watch` (#221): the background pass runner, and who is allowed to turn it on. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configOrigins } from "../core/config_origins.js";
import { loadConfig } from "../core/agents.js";
import { resolveSyncConfig, syncOnWatchConfig, syncOnWatchEnabled } from "../core/data_types.js";
import { applyConfigEnv } from "../core/agents.js";
import { operatorEnv } from "../core/utils.js";
import { buildSyncOnWatch } from "../cli/commands/watch.js";
import type { SFConfig } from "../core/data_types.js";
import type { WatchDeps } from "../core/watch.js";
import { resolveConfigPaths, type RepoAnchor } from "../core/paths.js";
import { createSyncOnWatch } from "../core/sync/on_watch.js";
import type { SyncPassReport } from "../core/sync/client.js";
import type { NotifyEvent } from "../core/notify/channel.js";

const REPORT: SyncPassReport = { sessions: 0, snapshots: 0, events: 0, gates: 0, batches: 0, bytes: 0, status: "ok", detail: [] };

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

function harness(runPass: () => Promise<SyncPassReport>) {
  const events: NotifyEvent[] = [];
  const logs: string[] = [];
  const s = createSyncOnWatch({ runPass, notify: (e) => events.push(e), log: (m) => logs.push(m) });
  return { s, events, logs };
}

test("one request runs exactly one pass, and request() does not wait for it", async () => {
  const g = gate();
  let passes = 0;
  const { s } = harness(async () => {
    passes++;
    await g.promise;
    return REPORT;
  });
  s.request(); // also the catch-up at watch start
  assert.equal(passes, 1, "started synchronously, not awaited");
  g.open();
  await s.idle();
  assert.equal(passes, 1);
});

test("requests during a running pass coalesce into one trailing pass", async () => {
  const g = gate();
  let passes = 0;
  const { s } = harness(async () => {
    passes++;
    if (passes === 1) await g.promise;
    return REPORT;
  });
  s.request();
  s.request();
  s.request();
  s.request();
  assert.equal(passes, 1);
  g.open();
  await s.idle();
  assert.equal(passes, 2, "four requests, one in flight, ONE trailing pass");
  s.request();
  await s.idle();
  assert.equal(passes, 3, "a later request after idle runs again");
});

test("a failed or rejected pass logs and notifies at notice level; a throw does too and never escapes", async () => {
  for (const mk of [
    async (): Promise<SyncPassReport> => ({ ...REPORT, status: "failed", error: "hub down" }),
    async (): Promise<SyncPassReport> => ({ ...REPORT, status: "rejected", error: "schema" }),
    async (): Promise<SyncPassReport> => {
      throw new Error("kaboom");
    },
  ]) {
    const { s, events, logs } = harness(mk);
    s.request();
    await s.idle();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.level, "notice");
    assert.match(logs[0]!, /background pass failed/);
  }
});

test("a locked or empty pass is silent", async () => {
  for (const status of ["locked", "nothing", "ok"] as const) {
    const { s, events } = harness(async () => ({ ...REPORT, status }));
    s.request();
    await s.idle();
    assert.equal(events.length, 0);
  }
});

test("a throwing notify or log cannot escape the background loop", async () => {
  const s = createSyncOnWatch({
    runPass: async () => ({ ...REPORT, status: "failed", error: "x" }),
    notify: () => {
      throw new Error("channel down");
    },
    log: () => {
      throw new Error("log down");
    },
  });
  s.request();
  await s.idle();
});

// ── who may turn it on ──────────────────────────────────────────────────────

function scratch(): { root: string; home: string; anchor: RepoAnchor } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piquette-onwatch-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".piquette"), { recursive: true });
  mkdirSync(join(home, ".piquette"), { recursive: true });
  return { root, home, anchor: { cwd: repo, repo_root: repo, piquette_dir: join(repo, ".piquette") } };
}

function enabled(machine: string | null, repo: string | null): boolean {
  const { root, home, anchor } = scratch();
  try {
    if (machine !== null) writeFileSync(join(home, ".piquette", "piquette.config.yaml"), machine);
    if (repo !== null) writeFileSync(join(anchor.piquette_dir!, "piquette.config.yaml"), repo);
    const resolution = resolveConfigPaths(anchor, undefined, {}, home);
    return syncOnWatchEnabled(loadConfig(resolution.paths), configOrigins(resolution));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SYNC = "sync:\n  endpoint: https://hub.example.com\n";

test("on by default when the machine layer has a sync block; off without one", () => {
  assert.equal(enabled(SYNC, null), true);
  assert.equal(enabled(null, null), false);
  assert.equal(enabled("defaults: {}\n", null), false);
});

test("sync.on_watch: false in the machine layer disables it", () => {
  assert.equal(enabled(SYNC + "  on_watch: false\n", null), false);
  assert.equal(enabled(SYNC + "  on_watch: true\n", null), true);
});

test("a repo layer cannot enable it where the machine has no sync block", () => {
  assert.equal(enabled(null, SYNC + "  on_watch: true\n"), false);
  assert.equal(enabled("defaults: {}\n", SYNC + "  on_watch: true\n"), false);
  assert.equal(enabled(null, SYNC), false, "a repo-only sync block never turns watch syncing on");
});

test("a repo layer cannot flip the machine's choice either way", () => {
  assert.equal(enabled(SYNC + "  on_watch: false\n", "sync:\n  on_watch: true\n"), false);
  assert.equal(enabled(SYNC, "sync:\n  on_watch: false\n"), true);
});

test("configOrigins records the repo-layer on_watch as ignored", () => {
  const { root, home, anchor } = scratch();
  try {
    writeFileSync(join(home, ".piquette", "piquette.config.yaml"), SYNC);
    writeFileSync(join(anchor.piquette_dir!, "piquette.config.yaml"), "sync:\n  on_watch: false\n");
    const trust = configOrigins(resolveConfigPaths(anchor, undefined, {}, home)).syncTrusted!;
    assert.deepEqual(trust.routing_ignored, ["on_watch"]);
    assert.equal(trust.on_watch, undefined);
    assert.equal(trust.machine_block, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync.on_watch survives loadConfig's merge across layers", () => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-onwatch-merge-"));
  try {
    const base = join(dir, "base.yaml");
    const over = join(dir, "over.yaml");
    writeFileSync(base, SYNC + "  on_watch: false\n");
    writeFileSync(over, "sync:\n  level: summary\n");
    assert.equal(loadConfig([base]).sync?.on_watch, false, "reaches SFConfig from a real file");
    const merged = loadConfig([base, over]);
    assert.equal(merged.sync?.on_watch, false, "unset in the override -> the base's value survives");
    assert.equal(merged.sync?.level, "summary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── retry, dedup, pacing, drain ─────────────────────────────────────────────

test("tick() retries a failed or locked pass, but not an ok, nothing or rejected one", async () => {
  for (const [status, retries] of [["failed", true], ["locked", true], ["ok", false], ["nothing", false], ["rejected", false]] as const) {
    let passes = 0;
    const { s } = harness(async () => (passes++, { ...REPORT, status, error: "x" }));
    s.request();
    await s.idle();
    s.tick();
    await s.idle();
    assert.equal(passes, retries ? 2 : 1, status);
  }
});

test("tick() retries a pass that threw, and stops retrying once one succeeds", async () => {
  let passes = 0;
  const { s } = harness(async () => {
    passes++;
    if (passes === 1) throw new Error("blip");
    return REPORT;
  });
  s.request();
  await s.idle();
  s.tick();
  await s.idle();
  s.tick();
  await s.idle();
  assert.equal(passes, 2);
});

test("a persistent failure notifies once (carrying the context fields), logs every time, and re-arms after a success", async () => {
  let status: "failed" | "ok" = "failed";
  const events: NotifyEvent[] = [];
  const logs: string[] = [];
  const s = createSyncOnWatch({
    runPass: async () => ({ ...REPORT, status, error: "hub down" }),
    notify: (e) => events.push(e),
    log: (m) => logs.push(m),
    fields: [["repo", "o/r"]],
  });
  for (let i = 0; i < 3; i++) {
    s.request();
    await s.idle();
  }
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.fields, [["repo", "o/r"]]);
  assert.equal(logs.length, 3);
  status = "ok";
  s.request();
  await s.idle();
  status = "failed";
  s.request();
  await s.idle();
  assert.equal(events.length, 2, "a new failure after a success notifies again");
});

test("minIntervalMs holds a second pass back, and idle() flushes it instead of waiting out the interval", async () => {
  let t = 1_000_000;
  let passes = 0;
  const s = createSyncOnWatch({ runPass: async () => (passes++, REPORT), notify: () => undefined, log: () => undefined, minIntervalMs: 60_000, now: () => t });
  s.request();
  await s.idle();
  assert.equal(passes, 1);
  t += 1000;
  s.request();
  assert.equal(passes, 1, "inside the interval: held back");
  await s.idle();
  assert.equal(passes, 2, "idle() runs the held pass now");
  t += 61_000;
  s.request();
  assert.equal(passes, 3, "past the interval: immediate");
  await s.idle();
});

test("drain() aborts a pass that outlives drainMs, and abort stops further requests", async () => {
  let aborted = false;
  const s = createSyncOnWatch({
    runPass: (signal) =>
      new Promise<SyncPassReport>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ ...REPORT, status: "failed", error: "aborted" });
        });
      }),
    notify: () => undefined,
    log: () => undefined,
    drainMs: 20,
  });
  s.request();
  await s.drain();
  assert.equal(aborted, true);
  s.request();
  await s.idle(); // returns at once: nothing runs after an abort
});

// ── a cloned repo cannot take over the machine layer, level or repo ─────────

test("applyConfigEnv refuses PIQUETTE_CONFIG_HOME and HOME (they locate the machine layer) but still applies other keys", () => {
  const saved = { PIQUETTE_CONFIG_HOME: process.env["PIQUETTE_CONFIG_HOME"], HOME: process.env["HOME"], PIQUETTE_TEST_ONWATCH: process.env["PIQUETTE_TEST_ONWATCH"] };
  try {
    delete process.env["PIQUETTE_CONFIG_HOME"];
    delete process.env["PIQUETTE_TEST_ONWATCH"];
    const home = process.env["HOME"];
    applyConfigEnv({ PIQUETTE_CONFIG_HOME: "/tmp/evil", HOME: "/tmp/evil-home", PIQUETTE_TEST_ONWATCH: "yes" });
    assert.equal(process.env["PIQUETTE_CONFIG_HOME"], undefined);
    assert.equal(process.env["HOME"], home);
    assert.equal(process.env["PIQUETTE_TEST_ONWATCH"], "yes");
  } finally {
    for (const [k, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  }
});

test("a repo layer's decoy client_*_env names cannot hide the machine layer's real ones from subprocesses", () => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-onwatch-deny-"));
  const keys = ["ONWATCH_REAL_ID", "ONWATCH_REAL_SECRET"];
  try {
    const machine = join(dir, "machine.yaml");
    const repo = join(dir, "repo.yaml");
    writeFileSync(machine, "sync:\n  endpoint: https://hub.example.com\n  client_id_env: ONWATCH_REAL_ID\n  client_secret_env: ONWATCH_REAL_SECRET\n");
    writeFileSync(repo, "sync:\n  client_id_env: DECOY_ID\n  client_secret_env: DECOY_SECRET\n");
    process.env["ONWATCH_REAL_ID"] = "id";
    process.env["ONWATCH_REAL_SECRET"] = "real-secret";
    const merged = loadConfig([machine, repo]);
    assert.equal(merged.sync?.client_secret_env, "DECOY_SECRET", "the merge does take the repo's names");
    const env = operatorEnv();
    for (const k of keys) assert.equal(env[k], undefined, `${k} must not reach a gate or agent`);
  } finally {
    for (const k of keys) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  }
});

function onWatchView(machine: string, repo: string): { level: string | undefined; repo: string | undefined } {
  const { root, home, anchor } = scratch();
  try {
    writeFileSync(join(home, ".piquette", "piquette.config.yaml"), machine);
    writeFileSync(join(anchor.piquette_dir!, "piquette.config.yaml"), repo);
    const resolution = resolveConfigPaths(anchor, undefined, {}, home);
    const cfg = syncOnWatchConfig(loadConfig(resolution.paths), configOrigins(resolution));
    return { level: cfg.sync?.level, repo: cfg.sync?.repo };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("sync-on-watch takes level and repo from the machine layer only", () => {
  assert.deepEqual(onWatchView(SYNC + "  level: summary\n  repo: me/mine\n", "sync:\n  level: full\n  repo: other-org/other\n"), { level: "summary", repo: "me/mine" });
  assert.deepEqual(onWatchView(SYNC, "sync:\n  level: full\n  repo: other-org/other\n"), { level: undefined, repo: undefined }, "unset in the machine layer: the repo's value is dropped, the default applies");
});

// ── buildSyncOnWatch: the watch wiring ──────────────────────────────────────

test("buildSyncOnWatch: never under --dry-run, never without a machine sync block, hooks the run-finished path otherwise", async () => {
  const { root, home, anchor } = scratch();
  try {
    const withSync = join(root, "with.yaml");
    const without = join(root, "without.yaml");
    writeFileSync(withSync, SYNC);
    writeFileSync(without, "defaults: {}\n");
    const mk = () => ({ notify: () => undefined, log: () => undefined }) as unknown as WatchDeps;
    const cfgOf = (file: string) => loadConfig([file]) as SFConfig;
    let passes = 0;
    const runPass = async (_signal: AbortSignal, ctx: { level: string }) => (passes++, assert.equal(ctx.level, "trace"), REPORT);

    const dry = mk();
    assert.equal(buildSyncOnWatch({ cfg: cfgOf(withSync), anchor, configFlag: withSync, dryRun: true, deps: dry, runPass }), undefined);
    assert.equal(dry.onRunFinished, undefined);

    const off = mk();
    assert.equal(buildSyncOnWatch({ cfg: cfgOf(without), anchor, configFlag: without, dryRun: false, deps: off, runPass }), undefined);
    assert.equal(off.onRunFinished, undefined);

    const on = mk();
    const s = buildSyncOnWatch({ cfg: cfgOf(withSync), anchor, configFlag: withSync, dryRun: false, deps: on, runPass });
    assert.ok(s);
    on.onRunFinished!();
    await s.idle();
    assert.equal(passes, 1);
    void home;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #2: on_watch_interval_ms — a plain tick alongside the run-finished/start-catchup triggers ──────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("on_watch_interval_ms is machine-layer only, same trust rule as on_watch: a repo layer's value is dropped", () => {
  const { root, home, anchor } = scratch();
  try {
    writeFileSync(join(home, ".piquette", "piquette.config.yaml"), SYNC + "  on_watch_interval_ms: 5000\n");
    writeFileSync(join(anchor.piquette_dir!, "piquette.config.yaml"), "sync:\n  on_watch_interval_ms: 1000\n");
    const resolution = resolveConfigPaths(anchor, undefined, {}, home);
    const cfg = loadConfig(resolution.paths);
    const origins = configOrigins(resolution);
    assert.equal(resolveSyncConfig(cfg, origins).on_watch_interval_ms, 5000, "the machine layer's value wins, not the repo's");
    assert.ok(origins.syncTrusted?.routing_ignored.includes("on_watch_interval_ms"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("on_watch_interval_ms set only in a repo layer is ignored entirely, not merged in", () => {
  const { root, home, anchor } = scratch();
  try {
    writeFileSync(join(home, ".piquette", "piquette.config.yaml"), SYNC);
    writeFileSync(join(anchor.piquette_dir!, "piquette.config.yaml"), "sync:\n  on_watch_interval_ms: 1000\n");
    const resolution = resolveConfigPaths(anchor, undefined, {}, home);
    const cfg = loadConfig(resolution.paths);
    const origins = configOrigins(resolution);
    assert.equal(resolveSyncConfig(cfg, origins).on_watch_interval_ms, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildSyncOnWatch: with on_watch_interval_ms set, a pass fires on its own (no onRunFinished needed), and drain() actually stops the timer rather than just the in-flight pass", async () => {
  const { root, home, anchor } = scratch();
  try {
    const withInterval = join(root, "interval.yaml");
    writeFileSync(withInterval, SYNC + "  on_watch_interval_ms: 1000\n"); // the schema floor (v.minValue(1000)) — this test waits for it in real time
    const deps = { notify: () => undefined, log: () => undefined } as unknown as WatchDeps;
    let passes = 0;
    const runPass = async () => (passes++, REPORT);
    const s = buildSyncOnWatch({ cfg: loadConfig([withInterval]) as SFConfig, anchor, configFlag: withInterval, dryRun: false, deps, runPass });
    assert.ok(s);
    assert.equal(passes, 0, "nothing runs synchronously from being built");
    await sleep(1200); // past one tick
    assert.ok(passes >= 1, `expected the interval to have fired by now, got ${passes}`);
    await s.drain();
    const afterDrain = passes;
    await sleep(1200); // would be another tick or two, if the timer were still alive
    assert.equal(passes, afterDrain, "no pass fires after drain(): the timer was actually cleared, not just the in-flight pass aborted");
    void home;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildSyncOnWatch: without on_watch_interval_ms, time passing alone never triggers a pass", async () => {
  const { root, home, anchor } = scratch();
  try {
    const noInterval = join(root, "no-interval.yaml");
    writeFileSync(noInterval, SYNC);
    const deps = { notify: () => undefined, log: () => undefined } as unknown as WatchDeps;
    let passes = 0;
    const runPass = async () => (passes++, REPORT);
    const s = buildSyncOnWatch({ cfg: loadConfig([noInterval]) as SFConfig, anchor, configFlag: noInterval, dryRun: false, deps, runPass });
    assert.ok(s);
    await sleep(60);
    assert.equal(passes, 0, "unchanged default: only the run-finished and start-catchup triggers ever request a pass");
    await s.drain();
    void home;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
