/**
 * The notifier: the `events` filter matrix, per-channel scope override, a
 * real webhook POST against a local `node:http` receiver (not a `fetch`
 * mock — proves the actual bytes on the wire), a rejecting channel never
 * propagating, `flush()` actually awaiting pending sends, and an unset env
 * var degrading to a warning instead of a crash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as v from "valibot";
import { Notifier, resolveNotifier, drainAll, hasLiveNotifiers, releaseNotifier, resetLiveForTest, DEFAULT_NOTIFY_ENV_KEY } from "../core/notify/notifier.js";
import type { NotificationChannel, NotifyEvent } from "../core/notify/channel.js";
import { SFConfigSchema, type SFConfig } from "../core/data_types.js";
import { runChain, type ChainDefinition } from "../chains/index.js";
import type { ChainContext } from "../chains/context.js";

function baseConfig(overrides: Record<string, unknown> = {}): SFConfig {
  return v.parse(SFConfigSchema, { notifications: { events: "errors", channels: [], ...overrides } });
}

function infoEvent(): NotifyEvent {
  return { kind: "run_started", level: "info", title: "run started", fields: [] };
}
function errorEvent(): NotifyEvent {
  return { kind: "run_failed", level: "error", title: "run failed", fields: [] };
}
function noticeEvent(): NotifyEvent {
  return { kind: "issue_blocked", level: "notice", title: "issue blocked", fields: [] };
}

class RecordingChannel implements NotificationChannel {
  received: NotifyEvent[] = [];
  label = "recording";
  async send(event: NotifyEvent): Promise<void> {
    this.received.push(event);
  }
}

class RejectingChannel implements NotificationChannel {
  label = "rejecting";
  async send(): Promise<void> {
    throw new Error("boom");
  }
}

class BlockedChannel implements NotificationChannel {
  label = "blocked";
  release!: () => void;
  private gate = new Promise<void>((resolve) => (this.release = resolve));
  async send(): Promise<void> {
    await this.gate;
  }
}

/**
 * A channel whose `send()` outlives any reasonable drain budget via a real
 * (ref'd) timer — unlike `BlockedChannel`'s bare in-memory promise, this
 * keeps a genuine libuv handle alive during the race, which is what a real
 * hung webhook `fetch()` would too. `drain()`'s own deadline timer is
 * deliberately unref'd (see `notifier.ts`), so it needs some other ref'd work
 * in flight to fire on schedule instead of the process going idle first.
 */
class SlowChannel implements NotificationChannel {
  label = "slow";
  private timer: NodeJS.Timeout | null = null;
  async send(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.timer = setTimeout(resolve, 10_000);
    });
  }
  /** Release the real timer once a test is done racing against it. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

test("events: off never sends, regardless of level", () => {
  const channel = new RecordingChannel();
  const notifier = new Notifier([{ channel, scope: "off" }], 1000, false, () => {});
  notifier.send(infoEvent());
  notifier.send(errorEvent());
  assert.deepEqual(channel.received, []);
});

test("events: errors sends only level=error, not notice", () => {
  const channel = new RecordingChannel();
  const notifier = new Notifier([{ channel, scope: "errors" }], 1000, false, () => {});
  notifier.send(infoEvent());
  notifier.send(noticeEvent());
  notifier.send(errorEvent());
  assert.equal(channel.received.length, 1);
  assert.equal(channel.received[0].level, "error");
});

test("events: attention sends notice and error, not info", () => {
  const channel = new RecordingChannel();
  const notifier = new Notifier([{ channel, scope: "attention" }], 1000, false, () => {});
  notifier.send(infoEvent());
  notifier.send(noticeEvent());
  notifier.send(errorEvent());
  assert.equal(channel.received.length, 2);
  assert.deepEqual(
    channel.received.map((e) => e.level),
    ["notice", "error"],
  );
});

test("events: all sends info, notice, and error", () => {
  const channel = new RecordingChannel();
  const notifier = new Notifier([{ channel, scope: "all" }], 1000, false, () => {});
  notifier.send(infoEvent());
  notifier.send(noticeEvent());
  notifier.send(errorEvent());
  assert.equal(channel.received.length, 3);
});

test("a per-channel scope overrides the top-level scope", () => {
  const loud = new RecordingChannel();
  const quiet = new RecordingChannel();
  const notifier = new Notifier(
    [
      { channel: loud, scope: "all" },
      { channel: quiet, scope: "errors" },
    ],
    1000,
    false,
    () => {},
  );
  notifier.send(infoEvent());
  assert.equal(loud.received.length, 1);
  assert.equal(quiet.received.length, 0);
});

test("dry-run logs and sends nothing to any channel", () => {
  const channel = new RecordingChannel();
  const logs: string[] = [];
  const notifier = new Notifier([{ channel, scope: "all" }], 1000, true, (m) => logs.push(m));
  notifier.send(infoEvent());
  assert.deepEqual(channel.received, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /would notify/);
});

test("a rejecting channel logs one line and never throws or blocks other channels", async () => {
  const rejecting = new RejectingChannel();
  const ok = new RecordingChannel();
  const logs: string[] = [];
  const notifier = new Notifier(
    [
      { channel: rejecting, scope: "all" },
      { channel: ok, scope: "all" },
    ],
    1000,
    false,
    (m) => logs.push(m),
  );
  assert.doesNotThrow(() => notifier.send(infoEvent()));
  await notifier.flush();
  assert.equal(ok.received.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /rejecting notification failed: boom/);
});

test("flush() actually awaits pending sends before returning", async () => {
  const blocked = new BlockedChannel();
  const notifier = new Notifier([{ channel: blocked, scope: "all" }], 1000, false, () => {});
  notifier.send(infoEvent());
  let flushed = false;
  const flushPromise = notifier.flush().then(() => {
    flushed = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(flushed, false, "flush must not resolve before the pending send does");
  blocked.release();
  await flushPromise;
  assert.equal(flushed, true);
});

test("drain() resolves within its budget against a channel slower than the budget", async () => {
  const slow = new SlowChannel();
  const notifier = new Notifier([{ channel: slow, scope: "all" }], 20_000, false, () => {});
  notifier.send(infoEvent());
  const started = Date.now();
  await notifier.drain(100);
  assert.ok(Date.now() - started < 3_000, "a slow channel cannot stall the drain past its budget");
  slow.cancel(); // release the real timer now that the assertion is done
});

test("drain() awaits a fast pending send instead of always burning the full budget", async () => {
  const blocked = new BlockedChannel();
  const notifier = new Notifier([{ channel: blocked, scope: "all" }], 5000, false, () => {});
  notifier.send(infoEvent());
  let drained = false;
  const drainPromise = notifier.drain(5000).then(() => {
    drained = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(drained, false, "drain must not resolve before the pending send does");
  blocked.release();
  await drainPromise;
  assert.equal(drained, true);
});

test("drain() never throws even when a channel rejects", async () => {
  const rejecting = new RejectingChannel();
  const notifier = new Notifier([{ channel: rejecting, scope: "all" }], 1000, false, () => {});
  notifier.send(infoEvent());
  await assert.doesNotReject(() => notifier.drain(200));
});

test("drainAll() drains every live Notifier under one shared budget and never throws", async () => {
  // 127.0.0.1:1 is closed on every platform CI runs on — a connection
  // refusal, which is the fast path; the budget covers the hang case. Same
  // shape as otel.test.ts's drain() test, kept network-free (no server to
  // spin up or tear down) for exactly that reason.
  const envKey = "PIQUETTE_TEST_WEBHOOK_REFUSED";
  process.env[envKey] = "http://127.0.0.1:1/hook";
  try {
    const cfg = baseConfig({ events: "all", channels: [{ kind: "webhook", webhook_url_env: envKey }] });
    const notifier = resolveNotifier(cfg);
    assert.notEqual(notifier, null);
    notifier!.send(infoEvent());
    const started = Date.now();
    await assert.doesNotReject(() => drainAll(200));
    assert.ok(Date.now() - started < 3_000, "an unreachable webhook host cannot stall drainAll past its budget");
  } finally {
    delete process.env[envKey];
  }
});

test("resolveNotifier returns null when events is off", () => {
  const cfg = baseConfig({ events: "off", channels: [{ kind: "webhook", webhook_url_env: "PIQUETTE_TEST_WEBHOOK" }] });
  assert.equal(resolveNotifier(cfg), null);
});

test("resolveNotifier returns null when no channels are configured", () => {
  const cfg = baseConfig({ events: "all", channels: [] });
  assert.equal(resolveNotifier(cfg), null);
});

test("resolveNotifier skips a channel whose env var is unset, with one warning naming the key — never throws", () => {
  delete process.env["PIQUETTE_TEST_WEBHOOK_UNSET"];
  const cfg = baseConfig({ events: "all", channels: [{ kind: "webhook", webhook_url_env: "PIQUETTE_TEST_WEBHOOK_UNSET" }] });
  const logs: string[] = [];
  const notifier = resolveNotifier(cfg, { log: (m) => logs.push(m) });
  assert.equal(notifier, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /PIQUETTE_TEST_WEBHOOK_UNSET is not set/);
});

test("resolveNotifier falls back to the kind's default env key when webhook_url_env is empty", () => {
  process.env["SLACK_WEBHOOK_URL"] = "http://127.0.0.1:1/unused";
  try {
    const cfg = baseConfig({ events: "all", channels: [{ kind: "slack" }] });
    const notifier = resolveNotifier(cfg);
    assert.notEqual(notifier, null);
    assert.equal(DEFAULT_NOTIFY_ENV_KEY["slack"], "SLACK_WEBHOOK_URL");
  } finally {
    delete process.env["SLACK_WEBHOOK_URL"];
  }
});

test("Notifier tags every event's title and adds a repo field when constructed with a project", () => {
  const channel = new RecordingChannel();
  const notifier = new Notifier([{ channel, scope: "all" }], 1000, false, () => {}, "my-app");
  notifier.send(infoEvent());
  assert.equal(channel.received.length, 1);
  assert.equal(channel.received[0].title, "[my-app] run started");
  assert.deepEqual(channel.received[0].fields, [["repo", "my-app"]]);
});

test("Notifier does not duplicate an event's own repo field when tagging", () => {
  const channel = new RecordingChannel();
  const notifier = new Notifier([{ channel, scope: "all" }], 1000, false, () => {}, "my-app");
  notifier.send({ kind: "watch_started", level: "info", title: "watch started", fields: [["repo", "owner/name"]] });
  assert.equal(channel.received[0].title, "[my-app] watch started");
  assert.deepEqual(channel.received[0].fields, [["repo", "owner/name"]]);
});

test("Notifier with no project leaves events untagged", () => {
  const channel = new RecordingChannel();
  const notifier = new Notifier([{ channel, scope: "all" }], 1000, false, () => {});
  notifier.send(infoEvent());
  assert.equal(channel.received[0].title, "run started");
  assert.deepEqual(channel.received[0].fields, []);
});

test("resolveNotifier falls back to watch.repo for the project tag when notifications.project is unset", async () => {
  let receivedBody = "";
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      receivedBody = body;
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const envKey = "PIQUETTE_TEST_WEBHOOK_TAGGED";
  process.env[envKey] = `http://127.0.0.1:${port}/hook`;
  try {
    const cfg = v.parse(SFConfigSchema, {
      watch: { repo: "acme/widgets" },
      notifications: { events: "all", channels: [{ kind: "webhook", webhook_url_env: envKey }] },
    });
    const notifier = resolveNotifier(cfg);
    assert.notEqual(notifier, null);
    notifier!.send(infoEvent());
    await notifier!.flush();
    const posted = JSON.parse(receivedBody) as NotifyEvent;
    assert.equal(posted.title, "[acme/widgets] run started");
    assert.deepEqual(posted.fields, [["repo", "acme/widgets"]]);
  } finally {
    delete process.env[envKey];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a webhook channel posts the real NotifyEvent JSON over the wire to a local receiver", async () => {
  let receivedBody = "";
  let receivedContentType = "";
  const server: Server = createServer((req, res) => {
    receivedContentType = req.headers["content-type"] ?? "";
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      receivedBody = body;
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const envKey = "PIQUETTE_TEST_WEBHOOK_LIVE";
  process.env[envKey] = `http://127.0.0.1:${port}/hook`;
  try {
    const cfg = baseConfig({ events: "all", channels: [{ kind: "webhook", webhook_url_env: envKey }] });
    const notifier = resolveNotifier(cfg);
    assert.notEqual(notifier, null);
    const event: NotifyEvent = { kind: "issue_claimed", level: "info", title: "issue 42 claimed", fields: [["issue", "42"]] };
    notifier!.send(event);
    await notifier!.flush();
    assert.equal(receivedContentType, "application/json");
    assert.deepEqual(JSON.parse(receivedBody), event);
  } finally {
    delete process.env[envKey];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("resolveNotifier keys the registry by adw_id; releaseNotifier drains then removes it (#31)", async () => {
  resetLiveForTest();
  const envKey = "PIQUETTE_TEST_WEBHOOK_RELEASE";
  process.env[envKey] = "http://127.0.0.1:1/hook";
  try {
    const cfg = baseConfig({ events: "all", channels: [{ kind: "webhook", webhook_url_env: envKey }] });
    assert.equal(hasLiveNotifiers(), false);
    resolveNotifier(cfg, { adwId: "adw_a", log: () => {} })!.send(infoEvent());
    resolveNotifier(cfg, { adwId: "adw_b" });
    assert.equal(hasLiveNotifiers(), true);

    await releaseNotifier("adw_a");
    await releaseNotifier("adw_a"); // already released: silent no-op
    await releaseNotifier(null);
    await releaseNotifier("adw_never_registered");
    assert.equal(hasLiveNotifiers(), true, "adw_b is still registered after adw_a's release");

    await releaseNotifier("adw_b");
    assert.equal(hasLiveNotifiers(), false, "every released run leaves the registry empty, so nothing accumulates per issue");
  } finally {
    delete process.env[envKey];
    resetLiveForTest();
  }
});

test("releaseNotifier waits for the run's in-flight sends before removing it (#31)", async () => {
  resetLiveForTest();
  const envKey = "PIQUETTE_TEST_WEBHOOK_RELEASE_WAIT";
  const received: string[] = [];
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      received.push(req.url ?? "");
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env[envKey] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  try {
    const cfg = baseConfig({ events: "all", channels: [{ kind: "webhook", webhook_url_env: envKey }] });
    resolveNotifier(cfg, { adwId: "adw_wait" })!.send(infoEvent());
    await releaseNotifier("adw_wait");
    assert.equal(received.length, 1, "the send was flushed before release returned");
    assert.equal(hasLiveNotifiers(), false);
  } finally {
    delete process.env[envKey];
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetLiveForTest();
  }
});

test("releaseNotifier leaves a same-id replacement registered mid-drain, and never reaches an id-less notifier (#31)", async () => {
  resetLiveForTest();
  const envKey = "PIQUETTE_TEST_WEBHOOK_RELEASE_REPLACE";
  // Holds the first request open until the test says so, so the release below is provably mid-drain.
  let arrived: () => void = () => {};
  const requestArrived = new Promise<void>((resolve) => (arrived = resolve));
  const held: Array<() => void> = [];
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      held.push(() => res.end("ok"));
      arrived();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env[envKey] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  try {
    const cfg = baseConfig({ events: "all", channels: [{ kind: "webhook", webhook_url_env: envKey }] });
    resolveNotifier(cfg, { adwId: "adw_same" })!.send(infoEvent());
    await requestArrived;
    const release = releaseNotifier("adw_same");
    resolveNotifier(cfg, { adwId: "adw_same" }); // re-registered while the first one is still draining
    for (const respond of held) respond();
    await release;
    assert.equal(hasLiveNotifiers(), true, "the replacement survives the first notifier's release");
    await releaseNotifier("adw_same");
    assert.equal(hasLiveNotifiers(), false);

    resolveNotifier(cfg); // id-less (e.g. `piquette watch`'s daemon notifier): reached by drainAll/flushAll only
    await releaseNotifier("adw_same");
    await releaseNotifier("");
    assert.equal(hasLiveNotifiers(), true, "no adw_id can release an id-less notifier");
  } finally {
    delete process.env[envKey];
    for (const respond of held) respond();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetLiveForTest();
  }
});

test("runChain() releases the run's notifier on the way out, success or thrown error alike (#31)", async () => {
  resetLiveForTest();
  const envKey = "PIQUETTE_TEST_WEBHOOK_RUNCHAIN";
  process.env[envKey] = "http://127.0.0.1:1/hook";
  try {
    const cfg = baseConfig({ events: "all", channels: [{ kind: "webhook", webhook_url_env: envKey }] });
    const chainThat = (outcome: "returns" | "throws"): ChainDefinition => ({
      name: "notify-release",
      describe: "",
      phases: "",
      requiredAgents: [],
      requiredSuites: [],
      run: async (ctx) => {
        resolveNotifier(cfg, { adwId: ctx.adw_id ?? undefined });
        assert.equal(hasLiveNotifiers(), true);
        if (outcome === "throws") throw new Error("chain failed");
        return 0;
      },
    });
    const ctx = (adwId: string): ChainContext => ({ prompt: "", config_paths: [], adw_id: adwId, cwd: process.cwd(), chain_name: "notify-release", unattended: true });

    assert.equal(await runChain(chainThat("returns"), ctx("adw_runchain_ok")), 0);
    assert.equal(hasLiveNotifiers(), false, "a finished run leaves nothing registered");

    await assert.rejects(runChain(chainThat("throws"), ctx("adw_runchain_throw")), /chain failed/);
    assert.equal(hasLiveNotifiers(), false, "a run that threw is released too");
  } finally {
    delete process.env[envKey];
    resetLiveForTest();
  }
});
