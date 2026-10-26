/** `piquette cloud deploy` with the ingest module (#214): D1 ensure/create, migrate-before-deploy, reader grants. Fake spawn and fetch only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { SFConfigSchema, type SFConfig } from "../core/data_types.js";
import { wranglerConfigFor } from "../cloud/config.js";
import { desiredGrants, deployCloud, ensureD1, migrationCount, syncReaderGrants } from "../cloud/deploy.js";
import { cfApi } from "../cloud/cf_api.js";
import { WRANGLER_VERSION, type SpawnFn } from "../cloud/wrangler.js";

const ACCESS = { team_domain: "test-team.cloudflareaccess.com", aud: ["aud-reader-0001", "aud-ingest-0002"] };
const TOKEN = "tok-SECRET-aaaa1111";
const ENV: NodeJS.ProcessEnv = { PATH: process.env["PATH"], MY_ACCT: "acct-fake-0001", MY_TOKEN: TOKEN };
const DB = "GET /accounts/acct-fake-0001/d1/database?name=piquette-hub&per_page=100";
const QUERY = "POST /accounts/acct-fake-0001/d1/database/db-uuid-1/query";

const cfgOf = (cloud: Record<string, unknown> = {}): SFConfig =>
  v.parse(SFConfigSchema, {
    cloud: {
      provider: "cloudflare", hostname: "piquette.example.com", modules: ["receipts", "ingest"], access: ACCESS, account_id_env: "MY_ACCT", api_token_env: "MY_TOKEN",
      r2: { bucket: "piquette-receipts" }, d1: { database: "piquette-hub" },
      tenants: [{ id: "default", readers: { emails: ["Jane@Example.com"], email_domains: ["example.com"] } }],
      ...cloud,
    },
  });

function packageRoot(withMigrations = true): string {
  const root = mkdtempSync(path.join(tmpdir(), "piquette-cloud-pkg-"));
  mkdirSync(path.join(root, "dist", "worker", "migrations"), { recursive: true });
  mkdirSync(path.join(root, "web"), { recursive: true });
  writeFileSync(path.join(root, "dist", "worker", "index.js"), "export default {}");
  if (withMigrations) writeFileSync(path.join(root, "dist", "worker", "migrations", "0001_init.sql"), "CREATE TABLE t (a TEXT);\n");
  writeFileSync(path.join(root, "web", "index.html"), "<html></html>");
  return root;
}

interface Call { args: string[]; env: Record<string, string>; config: Record<string, any>; at: number }
const timeline: string[] = [];
function fakeSpawn(codes: Record<string, number> = {}): { spawn: SpawnFn; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    spawn: async (_c, args, o) => {
      const file = args[args.indexOf("--config") + 1]!;
      const kind = args[2] === "d1" ? "migrate" : "deploy";
      timeline.push(`spawn ${kind}`);
      calls.push({ args, env: o.env, config: JSON.parse(readFileSync(file, "utf8")), at: timeline.length });
      return { code: codes[kind] ?? 0 };
    },
  };
}

type Handler = (body: any) => unknown;
function fakeApi(routes: Record<string, Handler>, status: Record<string, number> = {}) {
  const log: string[] = [];
  const queries: { sql: string; params: unknown[] }[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const key = `${init?.method ?? "GET"} ${url.replace("https://api.cloudflare.com/client/v4", "")}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    log.push(key);
    timeline.push(key);
    if (key === QUERY) queries.push(body);
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ errors: [{ message: "unexpected" }] }), { status: 500 });
    return new Response(JSON.stringify({ result: h(body) }), { status: status[key] ?? 200 });
  };
  return { fetch, log, queries };
}
const BUCKET_OK = { "GET /accounts/acct-fake-0001/r2/buckets/piquette-receipts": () => ({}) };

test("ensureD1: an exact name match is reused; a near match is not; absence creates", async () => {
  const found = fakeApi({ [DB]: () => [{ uuid: "other", name: "piquette-hub-2" }, { uuid: "db-uuid-1", name: "piquette-hub" }] });
  assert.equal(await ensureD1(cfApi({ token: TOKEN, tokenEnv: "MY_TOKEN" }, found.fetch), "acct-fake-0001", "piquette-hub"), "db-uuid-1");
  assert.deepEqual(found.log, [DB]);
  const absent = fakeApi({ [DB]: () => [{ uuid: "other", name: "piquette-hub-2" }], "POST /accounts/acct-fake-0001/d1/database": (b) => (assert.deepEqual(b, { name: "piquette-hub" }), { uuid: "db-uuid-9" }) });
  assert.equal(await ensureD1(cfApi({ token: TOKEN, tokenEnv: "MY_TOKEN" }, absent.fetch), "acct-fake-0001", "piquette-hub"), "db-uuid-9");
  assert.equal(absent.log.length, 2);
});

test("deploy with ingest: D1 created only when absent; migrate runs with CI=1 BEFORE deploy; grants after deploy, inserts before deletes; no secret anywhere", async () => {
  timeline.length = 0;
  const root = packageRoot();
  const sp = fakeSpawn();
  const out: string[] = [];
  const api = fakeApi({
    ...BUCKET_OK,
    [DB]: () => [],
    "POST /accounts/acct-fake-0001/d1/database": () => ({ uuid: "db-uuid-1" }),
    [QUERY]: (b) => (/^SELECT/.test(b.sql) ? [{ results: [{ tenant: "default", kind: "email", value: "gone@example.com" }, { tenant: "default", kind: "email", value: "jane@example.com" }], meta: {} }] : [{ results: [], meta: { changes: 1 } }]),
  });
  try {
    assert.equal(await deployCloud(cfgOf(), { cloud: "machine" }, { env: ENV, spawn: sp.spawn, fetch: api.fetch, out: (l) => out.push(l), packageRoot: root }), 0);
    assert.equal(sp.calls.length, 2);
    const [migrate, deploy] = sp.calls as [Call, Call];
    assert.deepEqual(migrate.args.slice(0, 7), ["--yes", `wrangler@${WRANGLER_VERSION}`, "d1", "migrations", "apply", "piquette-hub", "--remote"]);
    assert.equal(migrate.env["CI"], "1");
    assert.equal(deploy.env["CI"], undefined);
    assert.ok(migrate.at < deploy.at);
    assert.deepEqual(migrate.config["d1_databases"], [{ binding: "DB", database_name: "piquette-hub", database_id: "db-uuid-1", migrations_dir: path.join(root, "dist", "worker", "migrations") }]);
    assert.deepEqual(deploy.config["triggers"], { crons: ["17 3 * * *"] });
    assert.equal(deploy.config["vars"]["RETENTION_DAYS"], "90");

    const i = (needle: string | RegExp) => timeline.findIndex((t) => (typeof needle === "string" ? t === needle : needle.test(t)));
    assert.ok(i("POST /accounts/acct-fake-0001/d1/database") < i("spawn migrate"), "database exists before migrating");
    assert.ok(i("spawn migrate") < i("spawn deploy"));
    assert.ok(i("spawn deploy") < i(QUERY), "grants are written after the deploy");

    const inserts = api.queries.map((q, n) => ({ q, n })).filter((x) => /^INSERT OR IGNORE/.test(x.q.sql));
    const deletes = api.queries.map((q, n) => ({ q, n })).filter((x) => /^DELETE/.test(x.q.sql));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0]!.q.params, ["default", "email", "jane@example.com", "default", "email_domain", "example.com"]);
    assert.equal(deletes.length, 1);
    assert.deepEqual(deletes[0]!.q.params, ["default", "email", "gone@example.com"]);
    assert.ok(inserts[0]!.n < deletes[0]!.n, "insert before delete: never a lockout window");
    for (const q of api.queries) assert.doesNotMatch(q.sql, /example\.com|default/i, "values are parameters, not SQL text");

    const serialized = JSON.stringify(sp.calls.map((c) => [c.args, c.config])) + out.join("\n");
    assert.ok(!serialized.includes(TOKEN));
    assert.ok(!existsSync(path.dirname(migrate.args[migrate.args.indexOf("--config") + 1]!)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy with ingest: an existing database is not recreated; a failed migration stops before deploy and grants", async () => {
  timeline.length = 0;
  const root = packageRoot();
  const sp = fakeSpawn({ migrate: 5 });
  const api = fakeApi({ ...BUCKET_OK, [DB]: () => [{ uuid: "db-uuid-1", name: "piquette-hub" }] });
  try {
    await assert.rejects(deployCloud(cfgOf(), {}, { env: ENV, spawn: sp.spawn, fetch: api.fetch, out: () => {}, packageRoot: root }), /migrations apply exited 5/);
    assert.equal(sp.calls.length, 1, "no deploy after a failed migration");
    assert.ok(!api.log.some((l) => l.startsWith("POST")), "nothing created, no grants written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy with ingest but no packaged migrations is a build error, before any API call", async () => {
  const root = packageRoot(false);
  const api = fakeApi({});
  try {
    await assert.rejects(deployCloud(cfgOf(), {}, { env: ENV, spawn: fakeSpawn().spawn, fetch: api.fetch, out: () => {}, packageRoot: root }), /migrations/);
    assert.equal(api.log.length, 0);
    assert.equal(migrationCount(path.join(root, "dist", "worker", "migrations")), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry run with ingest prints the d1 config, the migrate argv and the cron, and does nothing", async () => {
  const out: string[] = [];
  const api = fakeApi({});
  const sp = fakeSpawn();
  assert.equal(await deployCloud(cfgOf(), {}, { env: {}, spawn: sp.spawn, fetch: api.fetch, out: (l) => out.push(l), dryRun: true, packageRoot: "/pkg" }), 0);
  const text = out.join("\n");
  assert.match(text, /"database_id": "<d1-database-id>"/);
  assert.match(text, /d1 migrations apply piquette-hub --remote/);
  assert.match(text, /"crons": \[\s*"17 3 \* \* \*"/);
  assert.equal(api.log.length + sp.calls.length, 0);
});

test("ingest without receipts needs no bucket; receipts alone adds no d1 binding and an empty trigger list", () => {
  const noReceipts = cfgOf({ modules: ["ingest"], r2: undefined });
  const w = wranglerConfigFor(noReceipts, { workerPath: "/w.js", webDir: "/web", prefix: "", d1: { name: "piquette-hub", id: "x" } });
  assert.equal("r2_buckets" in w, false);
  const only = wranglerConfigFor(cfgOf({ modules: ["receipts"], d1: undefined, tenants: undefined }), { workerPath: "/w.js", webDir: "/web", bucket: "piquette-receipts", prefix: "" });
  assert.equal("d1_databases" in only, false);
  assert.deepEqual(only["triggers"], { crons: [] });
});

test("grants: configured rows are lowercased and deduped; stale rows are deleted one parameterized statement each; nothing configured means nothing deleted", async () => {
  const cfg = cfgOf({ tenants: [{ id: "a", readers: { emails: ["X@Example.com", "x@example.com"] } }, { id: "b", readers: { email_domains: ["Example.org"] } }] });
  assert.deepEqual(desiredGrants(cfg.cloud!.tenants), [{ tenant: "a", kind: "email", value: "x@example.com" }, { tenant: "b", kind: "email_domain", value: "example.org" }]);
  const api = fakeApi({ [QUERY]: (b) => (/^SELECT/.test(b.sql) ? [{ results: [], meta: {} }] : [{ results: [], meta: { changes: 1 } }]) });
  const r = await syncReaderGrants(cfApi({ token: TOKEN, tokenEnv: "MY_TOKEN" }, api.fetch), "acct-fake-0001", "db-uuid-1", cfg.cloud!.tenants);
  assert.deepEqual(r, { added: 2, removed: 0 });
  // many readers: statements stay under D1's 100-parameter limit
  const many = cfgOf({ tenants: [{ id: "a", readers: { emails: Array.from({ length: 80 }, (_, i) => `u${i}@example.com`) } }] });
  const big = fakeApi({ [QUERY]: (b) => (/^SELECT/.test(b.sql) ? [{ results: [], meta: {} }] : [{ results: [], meta: {} }]) });
  await syncReaderGrants(cfApi({ token: TOKEN, tokenEnv: "MY_TOKEN" }, big.fetch), "acct-fake-0001", "db-uuid-1", many.cloud!.tenants);
  for (const q of big.queries) assert.ok(q.params.length <= 100);
  assert.equal(big.queries.filter((q) => /^INSERT/.test(q.sql)).length, 3);
});
