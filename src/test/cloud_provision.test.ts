/** `piquette cloud provision-factory` (#214): mint path, the 403 degrade, adopt path, parameterized SQL, the secret on stdout only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import { SFConfigSchema, type SFConfig } from "../core/data_types.js";
import { provisionFactory } from "../cloud/provision.js";

const ACCESS = { team_domain: "test-team.cloudflareaccess.com", aud: ["aud-ingest-0002"] };
const TOKEN = "tok-SECRET-aaaa1111";
const MINTED_SECRET = "minted-secret-SECRET-dddd4444";
const ENV: NodeJS.ProcessEnv = { MY_ACCT: "acct1", MY_TOKEN: TOKEN };
const SVC = "POST /accounts/acct1/access/service_tokens";
const DB = "GET /accounts/acct1/d1/database?name=piquette-hub&per_page=100";
const QUERY = "POST /accounts/acct1/d1/database/db1/query";

const cfgOf = (cloud: Record<string, unknown> = {}): SFConfig =>
  v.parse(SFConfigSchema, { cloud: { provider: "cloudflare", hostname: "piquette.example.com", modules: ["ingest"], access: ACCESS, account_id_env: "MY_ACCT", api_token_env: "MY_TOKEN", d1: { database: "piquette-hub" }, ...cloud } });
const TWO = [{ id: "alpha", readers: { emails: ["a@example.com"] } }, { id: "beta", readers: { emails: ["b@example.com"] } }];

type Route = { status?: number; body?: unknown };
function world(routes: Record<string, Route | ((b: any) => Route)>) {
  const log: { key: string; body: any }[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const key = `${init?.method ?? "GET"} ${url.replace("https://api.cloudflare.com/client/v4", "")}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    log.push({ key, body });
    const r = routes[key];
    const res = typeof r === "function" ? r(body) : r;
    if (!res) return new Response(JSON.stringify({ errors: [{ message: "unexpected" }] }), { status: 500 });
    return new Response(JSON.stringify(res.body ?? {}), { status: res.status ?? 200 });
  };
  return { fetch, log };
}
const happy = (): Record<string, Route | ((b: any) => Route)> => ({
  [SVC]: { body: { result: { client_id: "abc123.access", client_secret: MINTED_SECRET } } },
  [DB]: { body: { result: [{ uuid: "db1", name: "piquette-hub" }] } },
  [QUERY]: { body: { result: [{ results: [], meta: { changes: 1 } }] } },
});

async function run(cfg: SFConfig, w: ReturnType<typeof world>, o: Partial<Parameters<typeof provisionFactory>[1]> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await provisionFactory(cfg, { name: "laptop", env: ENV, fetch: w.fetch, out: (l) => out.push(l), err: (l) => err.push(l), now: () => "2026-01-01T00:00:00.000Z", ...o });
  return { code, out, err };
}

test("mint path: the token is created, mapped with a parameterized INSERT, and the secret appears on stdout only", async () => {
  const w = world(happy());
  const { code, out, err } = await run(cfgOf({ tenants: [TWO[0]] }), w, { factoryId: "11111111-2222-4333-8444-555555555555" });
  assert.equal(code, 0, err.join("\n"));
  assert.deepEqual(out, ["PIQUETTE_SYNC_CLIENT_ID=abc123.access", `PIQUETTE_SYNC_CLIENT_SECRET=${MINTED_SECRET}`]);
  assert.deepEqual(w.log.find((l) => l.key === SVC)!.body, { name: "piquette-factory-laptop", duration: "8760h" });
  const q = w.log.find((l) => l.key === QUERY)!.body;
  assert.match(q.sql, /^INSERT INTO factory_credentials \(common_name, tenant, factory_id, created_at\) VALUES \(\?, \?, \?, \?\)/);
  assert.deepEqual(q.params, ["abc123.access", "alpha", "11111111-2222-4333-8444-555555555555", "2026-01-01T00:00:00.000Z"]);
  assert.doesNotMatch(q.sql, /abc123|alpha/);
  const stderr = err.join("\n");
  assert.ok(!stderr.includes(MINTED_SECRET) && !stderr.includes(TOKEN));
  assert.match(stderr, /shown once/);
  assert.match(stderr, /Service Auth/);
  assert.ok(!JSON.stringify(w.log.map((l) => l.body)).includes(MINTED_SECRET), "the secret is never sent anywhere");
});

test("re-running without --factory-id keeps an existing pin (COALESCE), never writes NULL over it", async () => {
  const w = world(happy());
  await run(cfgOf({ tenants: [TWO[0]] }), w, {});
  const q = w.log.find((l) => l.key === QUERY)!.body;
  assert.match(q.sql, /SET factory_id = COALESCE\(excluded\.factory_id, factory_credentials\.factory_id\)/);
});

test("403 on the mint degrades with the exact manual path and exit 3, and writes nothing", async () => {
  const w = world({ ...happy(), [SVC]: { status: 403, body: { errors: [{ message: "forbidden" }] } } });
  const { code, out, err } = await run(cfgOf({ tenants: [TWO[0]] }), w);
  assert.equal(code, 3);
  assert.deepEqual(out, []);
  assert.equal(err[0], "API token lacks Access: Service Tokens Edit. Create a service token named piquette-factory-laptop in Zero Trust > Access > Service Auth, then run: piquette cloud provision-factory --client-id <id> --tenant alpha");
  assert.equal(w.log.some((l) => l.key === QUERY), false);
});

test("--client-id skips the mint, prints only the id, and says the secret is the operator's", async () => {
  const w = world(happy());
  const { code, out, err } = await run(cfgOf({ tenants: [TWO[0]] }), w, { clientId: "mine.access" });
  assert.equal(code, 0);
  assert.deepEqual(out, ["PIQUETTE_SYNC_CLIENT_ID=mine.access"]);
  assert.equal(w.log.some((l) => l.key === SVC), false);
  assert.match(err.join("\n"), /adopted an existing service token/);
});

test("tenant rules: required with several, must be configured, defaults to the only one", async () => {
  const two = cfgOf({ tenants: TWO });
  let r = await run(two, world(happy()));
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /--tenant is required \(one of: alpha, beta\)/);
  r = await run(two, world(happy()), { tenant: "gamma" });
  assert.match(r.err.join("\n"), /not in cloud\.tenants/);
  r = await run(two, world(happy()), { tenant: "beta" });
  assert.equal(r.code, 0);
  r = await run(cfgOf({ tenants: [TWO[1]] }), world(happy()));
  assert.equal(r.code, 0);
  r = await run(cfgOf(), world(happy()));
  assert.equal(r.code, 1, "no tenants configured");
});

test("a credential already mapped to another tenant is refused, not moved", async () => {
  const w = world({ ...happy(), [QUERY]: { body: { result: [{ results: [], meta: { changes: 0 } }] } } });
  const { code, err } = await run(cfgOf({ tenants: TWO }), w, { tenant: "alpha", clientId: "taken.access" });
  assert.equal(code, 1);
  assert.match(err.join("\n"), /already mapped to a different tenant/);
  assert.match(w.log.find((l) => l.key === QUERY)!.body.sql, /WHERE factory_credentials\.tenant = excluded\.tenant/);
});

test("a missing database or a repo-layer cloud block stops; errors never contain a secret", async () => {
  let r = await run(cfgOf({ tenants: [TWO[0]] }), world({ ...happy(), [DB]: { body: { result: [] } } }));
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /run piquette cloud deploy first/);
  assert.ok(!r.err.join("\n").includes(MINTED_SECRET), "the minted secret is not echoed on failure paths either");
  const w = world(happy());
  r = await run(cfgOf({ tenants: [TWO[0]] }), w, { origins: { cloud: "repo", cloudPath: "/r/.piquette/piquette.config.yaml" } });
  assert.equal(r.code, 1);
  assert.equal(w.log.length, 0, "no API call for a repo-layer cloud block");
  r = await run(cfgOf({ tenants: [TWO[0]] }), world(happy()), { env: {} });
  assert.match(r.err.join("\n"), /set MY_ACCT and MY_TOKEN/);
  r = await run(cfgOf({ tenants: [TWO[0]] }), world(happy()), { name: "bad name!" });
  assert.equal(r.code, 1);
});
