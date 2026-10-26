import "../../dist/test/hermetic_git.js";
/**
 * End to end, no network: the REAL `runSyncPass` (sqlite and D1 source factories) -> an Access-edge emulator
 * (checks the service-token headers, strips them, mints an RS256 JWT with the runtime key) -> the real built Worker
 * in Miniflare -> D1. The endpoint is DERIVED from a machine-layer cloud block, as in production.
 */
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import * as v from "valibot";
import { SyncSupportedSchema } from "../../src/core/sync/contract.ts";
import { signToken, startSite, type Site } from "./harness.ts";
import { count, seedCredentials } from "./ingest_helpers.ts";

const dist = (p: string) => import(`../../dist/${p}`);
const { runSyncPass } = (await dist("core/sync/client.js")) as typeof import("../../src/core/sync/client.ts");
const { CloudConfigSchema, SyncConfigSchema, effectiveSyncEndpoint } = (await dist("core/data_types.js")) as typeof import("../../src/core/data_types.ts");
const { loadConfig } = (await dist("core/agents.js")) as typeof import("../../src/core/agents.ts");
const { stateFileFor } = (await dist("core/sync/state.js")) as typeof import("../../src/core/sync/state.ts");
const fx = (await dist("test/sync_fixtures.js")) as typeof import("../../src/test/sync_fixtures.ts");

const HOST = "piquette.example.com";
const CLIENT = fx.TEST_CLIENT_ID;

function cfgWithCloud(modules: string[] = ["ingest"]) {
  const cfg = loadConfig([]);
  cfg.sync = v.parse(SyncConfigSchema, {});
  cfg.cloud = v.parse(CloudConfigSchema, {
    provider: "cloudflare",
    hostname: HOST,
    modules,
    access: { team_domain: "test-team.cloudflareaccess.com", aud: ["test-aud-123"] },
    d1: { database: "piquette-hub" },
    ...(modules.includes("dashboard") ? { tenants: [{ id: "default", readers: { email_domains: ["example.com"] } }] } : {}),
  });
  return cfg;
}

describe("e2e: piquette sync -> Access edge -> Worker -> D1", () => {
  let site: Site;
  let db: any;
  let edgeSeen: { secretWasForwarded: boolean; calls: number };

  before(async () => {
    site = await startSite({ PIQUETTE_MODULES: "ingest", D1: "1" });
    db = await site.db();
    await seedCredentials(db, [{ cn: CLIENT, tenant: "default" }]);
    edgeSeen = { secretWasForwarded: false, calls: 0 };
  });
  after(() => site.dispose());

  /** The Cloudflare Access edge: the only thing allowed to turn client credentials into a JWT. */
  const edge = (secret: string) => async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.host, HOST, "the derived endpoint is the cloud's own hostname");
    edgeSeen.calls++;
    const headers = new Headers(init?.headers);
    if (headers.get("CF-Access-Client-Id") !== CLIENT || headers.get("CF-Access-Client-Secret") !== secret) return new Response("forbidden", { status: 403 });
    headers.delete("CF-Access-Client-Id");
    headers.delete("CF-Access-Client-Secret");
    headers.set("Cf-Access-Jwt-Assertion", await signToken({ commonName: CLIENT }));
    const res = await site.mf.dispatchFetch(`https://receipts.test${url.pathname}${url.search}`, { method: init?.method, headers, body: init?.body as never } as never);
    const text = await res.text();
    if (text.includes(fx.TEST_CLIENT_SECRET)) edgeSeen.secretWasForwarded = true;
    return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  };

  for (const kind of ["sqlite", "d1"] as const) {
    test(`${kind} source: rows land, a second pass is a no-op, a lost cursor replays without duplicates, a wrong secret lands nothing`, async () => {
      const f = await fx.makeFixture(kind);
      const adw = `adw-${kind}`;
      try {
        await fx.withSyncEnv(async () => {
          fx.addSession(f, adw, { request: "REQ" });
          fx.addEvents(f, adw, 0, 5);
          fx.addGate(f, adw);
          const cfg = cfgWithCloud();
          assert.equal(effectiveSyncEndpoint(cfg, { cloud: "machine" }), `https://${HOST}`);
          const run = (secret = fx.TEST_CLIENT_SECRET, origins: { cloud: string } = { cloud: "machine" }) =>
            runSyncPass({ cfg, origins, anchor: { repo_root: f.dir }, dataPaths: f.dataPaths, level: "trace", dryRun: false, sourceFetchImpl: f.sourceFetchImpl, fetchImpl: edge(secret) as typeof fetch, now: () => "2026-02-02T00:00:00.000Z", log: () => {} });

          const first = await run();
          assert.equal(first.status, "ok", first.error);
          assert.equal(await count(db, "sessions", "adw_id = ?", adw), 1);
          assert.equal(await count(db, "events", "adw_id = ?", adw), 5);
          assert.equal(await count(db, "gate_results", "adw_id = ?", adw), 1);
          assert.equal((await db.prepare("SELECT tenant FROM sessions WHERE adw_id = ?").bind(adw).first()).tenant, "default");
          assert.equal((await db.prepare("SELECT request FROM sessions WHERE adw_id = ?").bind(adw).first()).request, "REQ");

          assert.equal((await run()).status, "nothing");
          const events = await count(db, "events");

          rmSync(stateFileFor(f.dataPaths.data_dir, false), { force: true });
          assert.equal((await run()).status, "ok");
          assert.equal(await count(db, "events"), events, "replay after a lost cursor adds nothing");

          fx.addEvents(f, adw, 5, 2);
          const wrong = await run("not-the-secret");
          assert.equal(wrong.status, "failed");
          assert.equal(await count(db, "events"), events, "a wrong secret lands no rows");
          assert.doesNotMatch(wrong.error ?? "", /not-the-secret/);
          assert.equal((await run()).status, "ok");
          assert.equal(await count(db, "events"), events + 2);
        });
      } finally {
        f.cleanup();
      }
    });
  }

  test("a repo-layer cloud block never supplies the endpoint: the client stops and sends nothing", async () => {
    const f = await fx.makeFixture("sqlite");
    try {
      await fx.withSyncEnv(async () => {
        fx.addSession(f, "adw-repo");
        const calls = edgeSeen.calls;
        const report = await runSyncPass({ cfg: cfgWithCloud(), origins: { cloud: "repo" }, anchor: { repo_root: f.dir }, dataPaths: f.dataPaths, level: "trace", dryRun: false, fetchImpl: edge(fx.TEST_CLIENT_SECRET) as typeof fetch, log: () => {} });
        assert.equal(report.status, "failed");
        assert.match(report.error ?? "", /sync\.endpoint is not derived from a repo-layer cloud block; set sync\.endpoint/);
        assert.equal(edgeSeen.calls, calls);
        assert.equal(existsSync(stateFileFor(f.dataPaths.data_dir, false)), false);
      });
    } finally {
      f.cleanup();
    }
  });

  test("the service-token secret never reaches the Worker", () => {
    assert.equal(edgeSeen.secretWasForwarded, false);
  });

  test("the probe: GET /ingest/v1 through the edge answers {supported}", async () => {
    const res = await edge(fx.TEST_CLIENT_SECRET)(`https://${HOST}/ingest/v1`, { headers: { "CF-Access-Client-Id": CLIENT, "CF-Access-Client-Secret": fx.TEST_CLIENT_SECRET } });
    assert.equal(res.status, 200);
    assert.ok(v.safeParse(SyncSupportedSchema, await res.json()).success);
  });
});
