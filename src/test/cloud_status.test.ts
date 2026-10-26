/** `piquette cloud status` (#214) with a fake fetch: each outcome, the exit codes, and no secret in the output. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import { SFConfigSchema, type SFConfig } from "../core/data_types.js";
import { cloudStatus } from "../cloud/status.js";

const ACCESS = { team_domain: "test-team.cloudflareaccess.com", aud: ["aud-reader-0001"] };
const TOKEN = "tok-SECRET-aaaa1111";
const CLIENT_ID = "client-id-SECRET-bbbb";
const CLIENT_SECRET = "client-secret-SECRET-cccc";
const ENV: NodeJS.ProcessEnv = { CLOUDFLARE_ACCOUNT_ID: "acct1", CLOUDFLARE_API_TOKEN: TOKEN, CF_ACCESS_CLIENT_ID: CLIENT_ID, CF_ACCESS_CLIENT_SECRET: CLIENT_SECRET };

const cfg = (cloud: Record<string, unknown> = {}): SFConfig => v.parse(SFConfigSchema, { cloud: { provider: "cloudflare", hostname: "piquette.example.com", access: ACCESS, r2: { bucket: "piquette-receipts" }, ...cloud } });

type Route = (init?: RequestInit) => Response;
const J = (status: number, body: unknown, headers: Record<string, string> = {}): Route => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const R = (status: number, headers: Record<string, string> = {}, body = ""): Route => () => new Response(body, { status, headers });

function world(over: Record<string, Route> = {}) {
  const good: Record<string, Route> = {
    "GET /accounts/acct1/workers/scripts/piquette/settings": J(200, {
      result: { bindings: [
        { type: "plain_text", name: "ACCESS_TEAM_DOMAIN", text: ACCESS.team_domain },
        { type: "plain_text", name: "ACCESS_AUD", text: "aud-reader-0001" },
        { type: "plain_text", name: "PIQUETTE_MODULES", text: "receipts" },
        { type: "plain_text", name: "BASE_PATH", text: "/" },
        { type: "plain_text", name: "RECEIPTS_PREFIX", text: "" },
      ] },
    }),
    "GET /accounts/acct1/r2/buckets/piquette-receipts": J(200, { result: {} }),
  };
  const routes = { ...good, ...over };
  const seen: Array<{ url: string; headers: Headers }> = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, headers: new Headers(init?.headers) });
    if (url.startsWith("https://api.cloudflare.com/client/v4")) {
      const h = routes[`${init?.method ?? "GET"} ${url.replace("https://api.cloudflare.com/client/v4", "")}`];
      return h ? h(init) : J(500, { errors: [{ message: "unexpected" }] })();
    }
    const h = routes[`${new Headers(init?.headers).has("cf-access-client-id") ? "TOKEN" : new Headers(init?.headers).has("cf-access-jwt-assertion") ? "FORGED" : "ANON"} ${url}`];
    return h ? h(init) : R(404)();
  };
  return { fetch, seen };
}
const PERIM = "https://piquette.example.com/_piquette/status";
const ACCESS_REDIRECT = R(302, { location: "https://test-team.cloudflareaccess.com/cdn-cgi/access/login/piquette.example.com" });

const NO_SVC: NodeJS.ProcessEnv = { CLOUDFLARE_ACCOUNT_ID: "acct1", CLOUDFLARE_API_TOKEN: TOKEN };

async function run(c: SFConfig, w: ReturnType<typeof world>, env = ENV, json = false) {
  const out: string[] = [];
  const code = await cloudStatus(c, { env, fetch: w.fetch, out: (l) => out.push(l), json });
  return { code, out: out.join("\n") };
}
const noSecrets = (text: string): void => {
  for (const s of [TOKEN, CLIENT_ID, CLIENT_SECRET]) assert.ok(!text.includes(s), `leaked ${s}`);
};

test("all green: exit 0, the service token proves every module ok, and no secret is printed", async () => {
  const w = world({ [`ANON ${PERIM}`]: ACCESS_REDIRECT, [`TOKEN ${PERIM}`]: J(200, { version: "1.0.0", modules: { receipts: "ok", ingest: "off", dashboard: "off" } }) });
  const { code, out } = await run(cfg(), w);
  assert.equal(code, 0, out);
  assert.match(out, /\[pass\] script vars: match config/);
  assert.match(out, /\[pass\] r2 bucket: piquette-receipts exists/);
  assert.match(out, /\[pass\] perimeter: unauthenticated request redirected to Access/);
  assert.match(out, /\[pass\] workers\.dev: off/);
  assert.match(out, /\[pass\] modules: receipts ok/);
  noSecrets(out);
  noSecrets(JSON.stringify(w.seen.map((s) => s.url)));
});

test("no cloud block: exit 2", async () => {
  const out: string[] = [];
  assert.equal(await cloudStatus(v.parse(SFConfigSchema, {}), { env: ENV, out: (l) => out.push(l) }), 2);
});

test("perimeter outcomes: Access 403 passes; the Worker's own 401 warns; a 2xx fails", async () => {
  let r = await run(cfg(), world({ [`ANON ${PERIM}`]: R(403, { "content-type": "text/html" }, "<html>Access</html>") }), NO_SVC);
  assert.match(r.out, /\[pass\] perimeter: .*403/);
  r = await run(cfg(), world({ [`ANON ${PERIM}`]: J(401, { error: "Cloudflare Access token required" }) }), NO_SVC);
  assert.match(r.out, /\[warn\] perimeter: .*Worker's own 401/);
  assert.equal(r.code, 0, "a warning is not a failure");
  r = await run(cfg(), world({ [`ANON ${PERIM}`]: J(200, { modules: {} }) }), NO_SVC);
  assert.match(r.out, /\[fail\] perimeter: .*HTTP 200.*open/);
  assert.equal(r.code, 1);
  noSecrets(r.out);
});

test("script checks: not deployed fails; empty AUD fails; drift warns; empty bucket 404 fails", async () => {
  let r = await run(cfg(), world({ [`ANON ${PERIM}`]: ACCESS_REDIRECT, "GET /accounts/acct1/workers/scripts/piquette/settings": J(404, { errors: [{ message: "not found" }] }) }), NO_SVC);
  assert.match(r.out, /\[fail\] script: worker piquette is not deployed/);
  assert.equal(r.code, 1);
  r = await run(cfg(), world({ [`ANON ${PERIM}`]: ACCESS_REDIRECT, "GET /accounts/acct1/workers/scripts/piquette/settings": J(200, { result: { bindings: [{ type: "plain_text", name: "ACCESS_AUD", text: "" }] } }) }), NO_SVC);
  assert.match(r.out, /\[fail\] script vars: ACCESS_AUD is empty/);
  r = await run(cfg({ modules: ["receipts"], base_path: "/piquette" }), world({ [`ANON ${PERIM.replace("/_piquette", "/piquette/_piquette")}`]: ACCESS_REDIRECT }), NO_SVC);
  assert.match(r.out, /\[warn\] script vars: differ from config: BASE_PATH/);
  assert.equal(r.code, 0);
  r = await run(cfg(), world({ [`ANON ${PERIM}`]: ACCESS_REDIRECT, "GET /accounts/acct1/r2/buckets/piquette-receipts": J(404, { errors: [{ message: "no such bucket" }] }) }), NO_SVC);
  assert.match(r.out, /\[fail\] r2 bucket: piquette-receipts does not exist/);
});

test("workers.dev on: no token 401 and forged token 403 pass; a bypass fails", async () => {
  const wd = "https://piquette.acct.workers.dev/_piquette/status";
  const c = cfg({ hostname: undefined, public_url: "https://piquette.acct.workers.dev" });
  let r = await run(c, world({ [`ANON ${wd}`]: J(401, { error: "x" }), [`FORGED ${wd}`]: J(403, { error: "x" }) }));
  assert.match(r.out, /\[pass\] workers\.dev: no token HTTP 401; forged token HTTP 403/);
  r = await run(c, world({ [`ANON ${wd}`]: J(401, { error: "x" }), [`FORGED ${wd}`]: J(200, {}) }));
  assert.match(r.out, /\[fail\] workers\.dev: .*forged token HTTP 200/);
  assert.equal(r.code, 1);
  // workers_dev true next to a hostname: the address comes from the account subdomain
  const both = cfg({ workers_dev: true });
  r = await run(both, world({ [`ANON ${PERIM}`]: ACCESS_REDIRECT, "GET /accounts/acct1/workers/subdomain": J(200, { result: { subdomain: "acct" } }), [`ANON ${wd}`]: J(401, {}), [`FORGED ${wd}`]: J(403, {}) }));
  assert.match(r.out, /\[pass\] workers\.dev/);
});

test("a service token that does not reach every module fails; unset credentials only warn", async () => {
  const w = world({ [`ANON ${PERIM}`]: ACCESS_REDIRECT, [`TOKEN ${PERIM}`]: J(200, { modules: { receipts: "missing_binding" } }) });
  let r = await run(cfg(), w);
  assert.match(r.out, /\[fail\] modules: not ok: receipts=missing_binding/);
  r = await run(cfg(), world({ [`ANON ${PERIM}`]: ACCESS_REDIRECT, [`TOKEN ${PERIM}`]: R(403) }));
  assert.match(r.out, /\[fail\] service token: .*HTTP 403/);
  r = await run(cfg(), world({ [`ANON ${PERIM}`]: ACCESS_REDIRECT }), { PATH: "" });
  assert.match(r.out, /\[warn\] api: CLOUDFLARE_ACCOUNT_ID is not set/);
  assert.match(r.out, /\[warn\] service token: CF_ACCESS_CLIENT_ID\/CF_ACCESS_CLIENT_SECRET not set/);
  assert.equal(r.code, 0);
});

test("no public URL (workers.dev, no public_url): config warns, probes skipped", async () => {
  const r = await run(cfg({ hostname: undefined }), world());
  assert.match(r.out, /\[warn\] public url/);
  assert.doesNotMatch(r.out, /\[(pass|warn|fail)\] perimeter:/);
});

test("--json output is machine-readable and carries the same exit", async () => {
  const w = world({ [`ANON ${PERIM}`]: ACCESS_REDIRECT, [`TOKEN ${PERIM}`]: J(200, { modules: { receipts: "ok" } }) });
  const { code, out } = await run(cfg(), w, ENV, true);
  const parsed = JSON.parse(out) as { exit: number; checks: Array<{ name: string; status: string }> };
  assert.equal(parsed.exit, code);
  assert.ok(parsed.checks.every((c) => ["pass", "warn", "fail"].includes(c.status)));
  noSecrets(out);
});

test("a network failure is a failed check naming the host only", async () => {
  const w = world();
  const failing = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.startsWith("https://piquette.example.com")) throw new TypeError(`fetch failed: ${TOKEN}`);
    return w.fetch(url, init);
  };
  const out: string[] = [];
  const code = await cloudStatus(cfg(), { env: ENV, fetch: failing, out: (l) => out.push(l) });
  assert.equal(code, 1);
  assert.match(out.join("\n"), /\[fail\] perimeter: request to piquette\.example\.com failed/);
  noSecrets(out.join("\n"));
});

test("a repo-layer cloud block never receives credentials: no API call, no service-token header, repo notice", async () => {
  const w = world({ [`ANON ${PERIM}`]: ACCESS_REDIRECT });
  const out: string[] = [];
  const evil = cfg();
  const code = await cloudStatus(evil, { env: ENV, fetch: w.fetch, out: (l) => out.push(l), origins: { cloud: "repo", cloudPath: "/r/.piquette/piquette.config.yaml" } });
  const text = out.join("\n");
  assert.match(text, /\[warn\] config origin: cloud block comes from \/r\/\.piquette\/piquette\.config\.yaml \(repo layer\)/);
  assert.equal(code, 0);
  for (const s of w.seen) {
    assert.ok(!s.url.startsWith("https://api.cloudflare.com"), `credentialed API call ${s.url}`);
    assert.ok(!s.headers.has("cf-access-client-id") && !s.headers.has("cf-access-client-secret") && !s.headers.has("authorization"), `credential header to ${s.url}`);
  }
  noSecrets(text);
  // an explicit opt-in restores the credentialed checks
  const w2 = world({ [`ANON ${PERIM}`]: ACCESS_REDIRECT, [`TOKEN ${PERIM}`]: J(200, { modules: { receipts: "ok" } }) });
  const out2: string[] = [];
  await cloudStatus(cfg(), { env: ENV, fetch: w2.fetch, out: (l) => out2.push(l), origins: { cloud: "repo" }, allowRepoCloud: true });
  assert.ok(w2.seen.some((s) => s.url.startsWith("https://api.cloudflare.com")));
});

test("drift in the Access team or AUD the Worker trusts fails; other drift only warns", async () => {
  const bindings = [
    { type: "plain_text", name: "ACCESS_TEAM_DOMAIN", text: "other.cloudflareaccess.com" },
    { type: "plain_text", name: "ACCESS_AUD", text: "aud-reader-0001" },
    { type: "plain_text", name: "PIQUETTE_MODULES", text: "receipts" },
    { type: "plain_text", name: "BASE_PATH", text: "/" },
    { type: "plain_text", name: "RECEIPTS_PREFIX", text: "" },
  ];
  const r = await run(cfg(), world({ [`ANON ${PERIM}`]: ACCESS_REDIRECT, "GET /accounts/acct1/workers/scripts/piquette/settings": J(200, { result: { bindings } }) }), NO_SVC);
  assert.match(r.out, /\[fail\] script vars: differ from config: ACCESS_TEAM_DOMAIN/);
  assert.equal(r.code, 1);
});
