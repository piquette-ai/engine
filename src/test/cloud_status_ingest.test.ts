/** `piquette cloud status` with the ingest module (#214): the D1 database, the migrations count, and the service-token ingest probe. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { SFConfigSchema, type SFConfig } from "../core/data_types.js";
import { cloudStatus } from "../cloud/status.js";

const TOKEN = "tok-SECRET-aaaa1111";
const CLIENT_ID = "client-id-SECRET-bbbb";
const CLIENT_SECRET = "client-secret-SECRET-cccc";
const ENV: NodeJS.ProcessEnv = { CLOUDFLARE_ACCOUNT_ID: "acct1", CLOUDFLARE_API_TOKEN: TOKEN, CF_ACCESS_CLIENT_ID: CLIENT_ID, CF_ACCESS_CLIENT_SECRET: CLIENT_SECRET };
const cfg = (): SFConfig =>
  v.parse(SFConfigSchema, { cloud: { provider: "cloudflare", hostname: "piquette.example.com", modules: ["ingest"], access: { team_domain: "test-team.cloudflareaccess.com", aud: ["aud-1"] }, d1: { database: "piquette-hub" } } });

type Route = () => Response;
const J = (status: number, body: unknown): Route => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SETTINGS = "GET /accounts/acct1/workers/scripts/piquette/settings";
const DB = "GET /accounts/acct1/d1/database?name=piquette-hub&per_page=100";
const QUERY = "POST /accounts/acct1/d1/database/db1/query";
const PERIM = "https://piquette.example.com/_piquette/status";
const INGEST = "https://piquette.example.com/ingest/v1";

function root(files: number): string {
  const r = mkdtempSync(path.join(tmpdir(), "piquette-status-pkg-"));
  mkdirSync(path.join(r, "dist", "worker", "migrations"), { recursive: true });
  for (let i = 1; i <= files; i++) writeFileSync(path.join(r, "dist", "worker", "migrations", `${String(i).padStart(4, "0")}_x.sql`), "SELECT 1;\n");
  return r;
}

function world(over: Record<string, Route> = {}) {
  const routes: Record<string, Route> = {
    [SETTINGS]: J(200, { result: { bindings: [["ACCESS_TEAM_DOMAIN", "test-team.cloudflareaccess.com"], ["ACCESS_AUD", "aud-1"], ["PIQUETTE_MODULES", "ingest"], ["BASE_PATH", "/"], ["RETENTION_DAYS", "90"]].map(([name, text]) => ({ type: "plain_text", name, text })) } }),
    [DB]: J(200, { result: [{ uuid: "db1", name: "piquette-hub" }] }),
    [QUERY]: J(200, { result: [{ results: [{ n: 1 }], meta: {} }] }),
    [`ANON ${PERIM}`]: () => new Response("", { status: 302, headers: { location: "https://test-team.cloudflareaccess.com/login" } }),
    [`TOKEN ${PERIM}`]: J(200, { modules: { receipts: "off", ingest: "ok", dashboard: "off" } }),
    [`TOKEN ${INGEST}`]: J(200, { supported: [1, 1] }),
    ...over,
  };
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.startsWith("https://api.cloudflare.com/client/v4")) {
      const h = routes[`${init?.method ?? "GET"} ${url.replace("https://api.cloudflare.com/client/v4", "")}`];
      return h ? h() : J(500, { errors: [{ message: "unexpected" }] })();
    }
    const kind = new Headers(init?.headers).has("cf-access-client-id") ? "TOKEN" : "ANON";
    const h = routes[`${kind} ${url}`];
    return h ? h() : new Response("", { status: 404 });
  };
  return { fetch };
}

async function run(w: ReturnType<typeof world>, files = 1) {
  const out: string[] = [];
  const r = root(files);
  try {
    const code = await cloudStatus(cfg(), { env: ENV, fetch: w.fetch, out: (l) => out.push(l), packageRoot: r });
    return { code, out: out.join("\n") };
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
}

test("all green: database exists, migrations match the shipped count, the service token reaches /ingest/v1; no secret printed", async () => {
  const { code, out } = await run(world());
  assert.equal(code, 0, out);
  assert.match(out, /\[pass\] d1 database: piquette-hub exists/);
  assert.match(out, /\[pass\] d1 migrations: 1 applied/);
  assert.match(out, /\[pass\] ingest: .*sync_schema 1-1/);
  for (const s of [TOKEN, CLIENT_ID, CLIENT_SECRET]) assert.ok(!out.includes(s));
});

test("missing database, behind on migrations, an unmapped token and a closed ingest each fail", async () => {
  let r = await run(world({ [DB]: J(200, { result: [] }) }));
  assert.equal(r.code, 1);
  assert.match(r.out, /\[fail\] d1 database: piquette-hub does not exist/);
  r = await run(world(), 2);
  assert.match(r.out, /\[fail\] d1 migrations: 1 applied, 2 shipped/);
  r = await run(world({ [QUERY]: J(500, { errors: [{ message: "no such table: d1_migrations" }] }) }));
  assert.match(r.out, /\[fail\] d1 migrations: .*no such table/);
  r = await run(world({ [`TOKEN ${INGEST}`]: J(403, {}) }));
  assert.equal(r.code, 1);
  assert.match(r.out, /\[fail\] ingest: .*403.*Access application/);
  r = await run(world({ [`TOKEN ${INGEST}`]: J(200, { nope: true }) }));
  assert.match(r.out, /\[fail\] ingest: /);
});

test("an unmapped status token is a warning, not a failure: the perimeter check is not a factory credential", async () => {
  const r = await run(world({ [`TOKEN ${INGEST}`]: J(403, { error: "unknown_credential" }) }));
  assert.equal(r.code, 0);
  assert.match(r.out, /\[warn\] ingest: .*not a factory credential/);
  assert.doesNotMatch(r.out, /provision-factory for the status token/);
});

test("retention drift on the deployed worker warns", async () => {
  const r = await run(world({ [SETTINGS]: J(200, { result: { bindings: [["ACCESS_TEAM_DOMAIN", "test-team.cloudflareaccess.com"], ["ACCESS_AUD", "aud-1"], ["PIQUETTE_MODULES", "ingest"], ["BASE_PATH", "/"], ["RETENTION_DAYS", "7"]].map(([name, text]) => ({ type: "plain_text", name, text })) } }) }));
  assert.match(r.out, /\[warn\] script vars: differ from config: RETENTION_DAYS/);
});
