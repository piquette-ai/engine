/** `cloud:` schema and the pure helpers over it (#214). Fixtures use example.com and a test-team Access domain only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import { CloudConfigSchema, SFConfigSchema, type CloudConfig } from "../core/data_types.js";
import { cloudPublicUrl, effectiveViewerUrl, resolvedBasePath, resolvedWorkersDev, routePath } from "../cloud/config.js";

const ACCESS = { team_domain: "test-team.cloudflareaccess.com", aud: "aud-reader-0001" };
const parse = (c: unknown): CloudConfig => v.parse(CloudConfigSchema, c);
const rejects = (c: unknown, msg?: RegExp): void => (msg ? assert.throws(() => parse(c), msg) : assert.throws(() => parse(c)));

test("the documented example parses", () => {
  const cloud = parse({
    provider: "cloudflare",
    name: "spf",
    hostname: "spf.example.com",
    base_path: "/",
    modules: ["receipts", "ingest", "dashboard"],
    access: { team_domain: "test-team.cloudflareaccess.com", aud: ["aud-reader-0001", "aud-ingest-0002"] },
    r2: { bucket: "spf-receipts" },
    d1: { database: "spf-hub" },
    retention_days: 90,
    tenants: [{ id: "default", readers: { email_domains: ["example.com"] } }],
  });
  assert.deepEqual(cloud.access.aud, ["aud-reader-0001", "aud-ingest-0002"]);
  assert.equal(cloud.access.service_token_id_env, "CF_ACCESS_CLIENT_ID");
  assert.equal(cloud.account_id_env, "CLOUDFLARE_ACCOUNT_ID");
});

test("defaults: name, modules, retention; a single AUD string becomes a list", () => {
  const cloud = parse({ provider: "cloudflare", access: ACCESS });
  assert.equal(cloud.name, "spf");
  assert.deepEqual(cloud.modules, ["receipts"]);
  assert.equal(cloud.retention_days, 90);
  assert.equal(cloud.receipts_visibility, "perimeter");
  assert.deepEqual(cloud.access.aud, ["aud-reader-0001"]);
});

test("normalization: pasted https:// team domain, trailing slash base_path", () => {
  const cloud = parse({ provider: "cloudflare", base_path: "/spf/", access: { ...ACCESS, team_domain: " https://test-team.cloudflareaccess.com/ " } });
  assert.equal(cloud.access.team_domain, "test-team.cloudflareaccess.com");
  assert.equal(cloud.base_path, "/spf");
});

test("rejections", () => {
  const ok = { provider: "cloudflare", access: ACCESS };
  rejects({ ...ok, hostname: "a.example.com", route: "example.com/spf*", zone: "example.com" }, /mutually exclusive/);
  rejects({ ...ok, route: "example.com/spf*" }, /route requires zone/);
  rejects({ ...ok, workers_dev: false }, /needs a hostname or route/);
  rejects({ ...ok, route: "example.com/spf*", zone: "example.com", base_path: "/other" }, /base_path must equal/);
  rejects({ ...ok, base_path: "spf" });
  rejects({ ...ok, base_path: "/a/../b" });
  rejects({ ...ok, base_path: "/a//b" });
  rejects({ ...ok, chrome: { stylesheet_url: "http://example.com/x.css" } });
  rejects({ ...ok, hostnmae: "spf.example.com" });
  rejects({ ...ok, access: { ...ACCESS, team_domain: "evil.example.com" } });
  rejects({ ...ok, access: { ...ACCESS, aud: "" } });
  rejects({ ...ok, access: { ...ACCESS, aud: [] } });
  rejects({ ...ok, access: { ...ACCESS, aud: ["a b"] } });
  rejects({ ...ok, access: { ...ACCESS, service_token_id_env: "not-an-env-name" } });
  rejects({ ...ok, provider: "aws" });
  rejects({ ...ok, modules: ["receipts", "bogus"] });
  rejects({ ...ok, modules: [] });
  rejects({ ...ok, modules: ["receipts", "receipts"] });
  rejects({ ...ok, modules: ["dashboard"], tenants: [{ id: "t", readers: {} }] }, /d1/);
  rejects({ ...ok, modules: ["ingest"] }, /d1/);
  rejects({ ...ok, modules: ["dashboard"], d1: { database: "spf-hub" } }, /tenant/);
  rejects({ ...ok, d1: { database: "spf-hub" }, tenants: [{ id: "a", readers: {} }, { id: "a", readers: {} }] }, /unique/);
  rejects({ ...ok, tenants: [{ id: "Bad Id", readers: {} }] });
  rejects({ ...ok, retention_days: -1 });
  rejects({ ...ok, receipts_visibility: "public" });
  rejects({ ...ok, r2: { bucket: "A" } });
});

test("the key list has no secret-looking field", () => {
  const keys = new Set<string>();
  const walk = (o: unknown): void => {
    if (o && typeof o === "object") for (const [k, val] of Object.entries(o)) (keys.add(k), walk(val));
  };
  walk(
    parse({
      provider: "cloudflare",
      hostname: "spf.example.com",
      modules: ["receipts", "ingest", "dashboard"],
      access: ACCESS,
      r2: { bucket: "spf-receipts", prefix: "p" },
      d1: { database: "spf-hub" },
      tenants: [{ id: "default", readers: { emails: ["a@example.com"], email_domains: ["example.com"] } }],
      chrome: { stylesheet_url: "https://example.com/x.css", header_url: "https://example.com/h" },
    }),
  );
  for (const k of keys) {
    // Names of env VARS are fine (`*_env`); a field that could hold a secret is not.
    if (k.endsWith("_env")) continue;
    assert.doesNotMatch(k, /secret|token|password|key|credential/i, k);
  }
});

test("cloudPublicUrl", () => {
  const base = { provider: "cloudflare" as const, access: ACCESS };
  const cases: Array<[Record<string, unknown>, string | undefined]> = [
    [{ public_url: "https://spf.acct.workers.dev/" }, "https://spf.acct.workers.dev"],
    [{ hostname: "spf.example.com" }, "https://spf.example.com"],
    [{ hostname: "spf.example.com", base_path: "/spf" }, "https://spf.example.com/spf"],
    [{ route: "example.com/spf*", zone: "example.com" }, "https://example.com/spf"],
    [{ route: "example.com/*", zone: "example.com" }, "https://example.com"],
    [{ route: "example.com/*", zone: "example.com", base_path: "/spf" }, "https://example.com/spf"],
    [{ hostname: "spf.example.com", public_url: "https://other.example.com" }, "https://other.example.com"],
    [{}, undefined],
  ];
  for (const [extra, want] of cases) assert.equal(cloudPublicUrl(parse({ ...base, ...extra })), want, JSON.stringify(extra));
  assert.equal(cloudPublicUrl(undefined), undefined);
});

test("resolved base path, route path and workers.dev default", () => {
  assert.equal(routePath("example.com/spf*"), "/spf");
  assert.equal(routePath("example.com"), "");
  assert.equal(resolvedBasePath(parse({ provider: "cloudflare", access: ACCESS, route: "example.com/spf*", zone: "example.com" })), "/spf");
  assert.equal(resolvedBasePath(parse({ provider: "cloudflare", access: ACCESS })), "/");
  assert.equal(resolvedWorkersDev(parse({ provider: "cloudflare", access: ACCESS })), true);
  assert.equal(resolvedWorkersDev(parse({ provider: "cloudflare", access: ACCESS, hostname: "spf.example.com" })), false, "a hostname turns workers.dev off");
  assert.equal(resolvedWorkersDev(parse({ provider: "cloudflare", access: ACCESS, hostname: "spf.example.com", workers_dev: true })), true);
});

test("effectiveViewerUrl: explicit viewer_url, else the cloud when the receipts module is on", () => {
  const cfg = (c: Record<string, unknown>, receipts?: Record<string, unknown>) => v.parse(SFConfigSchema, { cloud: { provider: "cloudflare", access: ACCESS, ...c }, ...(receipts ? { receipts } : {}) });
  assert.equal(effectiveViewerUrl(cfg({ hostname: "spf.example.com" })), "https://spf.example.com");
  assert.equal(effectiveViewerUrl(cfg({ hostname: "spf.example.com" }, { viewer_url: "https://viewer.example.com/" })), "https://viewer.example.com", "explicit wins");
  assert.equal(effectiveViewerUrl(cfg({ hostname: "spf.example.com", modules: ["ingest"], d1: { database: "spf-hub" } })), undefined, "no receipts module, no viewer");
  assert.equal(effectiveViewerUrl(cfg({})), undefined, "workers.dev without public_url has no offline URL");
  assert.equal(effectiveViewerUrl(v.parse(SFConfigSchema, {})), undefined);
});
