import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { generateKeyPair } from "jose";
import { createHmac, createSign, type KeyObject } from "node:crypto";
import { AUD, AUD2, TEAM, privateKey, publicJwk, run198, signToken, startSite, type Site } from "./harness.ts";

const exportPrivate = async (): Promise<KeyObject> => (await import("node:crypto")).KeyObject.from(privateKey as never);

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const PATHS = ["/api/receipts/issue-198", "/r/issue-198", "/assets/app-abc123.js"];

describe("access: configured site", () => {
  let site: Site;
  before(async () => {
    site = await startSite();
    await site.seed(run198());
  });
  after(() => site.dispose());

  test("the shipped wrangler.jsonc routes assets through the Worker, with the SPA fallback", () => {
    const w = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    assert.equal(w.assets.run_worker_first, true);
    assert.equal(w.assets.not_found_handling, "single-page-application");
  });

  test("no header: 401 on api, page and assets (assets do not bypass auth)", async () => {
    for (const p of PATHS) {
      const res = await site.fetch(p, { token: null });
      assert.equal(res.status, 401, p);
      assert.deepEqual(await res.json(), { error: "Cloudflare Access token required" });
    }
  });

  test("a valid token in the CF_Authorization cookie only: 401 (cookies are never read)", async () => {
    const token = await signToken();
    const res = await site.fetch("/api/receipts/issue-198", { token: null, headers: { cookie: `CF_Authorization=${token}` } });
    assert.equal(res.status, 401);
  });

  test("rejected tokens: 403 with a fixed body", async () => {
    const wrongKey = (await generateKeyPair("RS256")).privateKey;
    const now = Math.floor(Date.now() / 1000);
    const modulus = String(publicJwk.n);
    const hs = (() => {
      const head = b64(JSON.stringify({ alg: "HS256", kid: "k1", typ: "JWT" }));
      const body = b64(JSON.stringify({ sub: "u", iat: now, exp: now + 300, aud: "test-aud-123", iss: "https://test-team.cloudflareaccess.com" }));
      return `${head}.${body}.${createHmac("sha256", Buffer.from(modulus, "base64url")).update(`${head}.${body}`).digest("base64url")}`;
    })();
    const none = `${b64(JSON.stringify({ alg: "none" }))}.${b64(JSON.stringify({ sub: "u", iat: now, exp: now + 300, aud: "test-aud-123", iss: "https://test-team.cloudflareaccess.com" }))}.`;
    const cases: Record<string, string> = {
      garbage: "not-a-jwt",
      "alg none": none,
      "HS256 with the RSA modulus as secret": hs,
      "right kid, wrong key": await signToken({ key: wrongKey }),
      "unknown kid": await signToken({ kid: "nope" }),
      "wrong aud": await signToken({ aud: "other-aud" }),
      "wrong iss": await signToken({ iss: "https://evil.example.com" }),
      expired: await signToken({ exp: now - 3600 }),
      "no exp": await signToken({ exp: null }),
      "header over 8KB": `${await signToken()}.${"a".repeat(9000)}`,
    };
    for (const [name, token] of Object.entries(cases)) {
      const res = await site.fetch("/api/receipts/issue-198", { token });
      assert.equal(res.status, 403, name);
      assert.deepEqual(await res.json(), { error: "invalid Cloudflare Access token" }, name);
    }
  });

  test("a valid token: 200, and the certs are fetched once across requests", async () => {
    const before = site.certHits();
    for (const p of PATHS) assert.equal((await site.fetch(p)).status, 200, p);
    const res = await site.fetch("/api/receipts/issue-198");
    assert.equal(res.status, 200);
    assert.ok(site.certHits() - before <= 1, `certs refetched: ${site.certHits() - before}`);
    assert.equal(site.certHits(), 1);
  });
});

describe("access: fail closed on bad config", () => {
  test("empty ACCESS_AUD: 503, nothing from R2 or assets", async () => {
    const site = await startSite({ ACCESS_AUD: "" });
    try {
      await site.seed(run198());
      for (const p of PATHS) {
        const res = await site.fetch(p);
        assert.equal(res.status, 503, p);
        const text = await res.text();
        assert.match(text, /misconfigured: ACCESS_AUD/);
        assert.doesNotMatch(text, /PIQUETTE-FIXTURE-MARKER|fixture-app|issue-198/);
      }
    } finally {
      await site.dispose();
    }
  });

  test("a team domain outside cloudflareaccess.com: 503", async () => {
    const site = await startSite({ ACCESS_TEAM_DOMAIN: "evil.com" });
    try {
      const res = await site.fetch("/r/issue-198");
      assert.equal(res.status, 503);
      assert.match(await res.text(), /misconfigured: ACCESS_TEAM_DOMAIN/);
      assert.equal(site.certHits(), 0);
    } finally {
      await site.dispose();
    }
  });
});

describe("access: identity vs service token", () => {
  let site: Site;
  before(async () => {
    site = await startSite();
    await site.seed(run198());
  });
  after(() => site.dispose());

  test("either configured AUD is accepted", async () => {
    assert.equal((await site.fetch("/api/receipts/issue-198", { token: await signToken({ aud: AUD2 }) })).status, 200);
  });

  test("a token with no email (a service token) cannot read: 403", async () => {
    for (const token of [await signToken({ email: null }), await signToken({ commonName: "svc-client-id.access" })]) {
      const res = await site.fetch("/api/receipts/issue-198", { token });
      assert.equal(res.status, 403);
      await res.arrayBuffer();
    }
  });

  test("no iat: 403", async () => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64(JSON.stringify({ alg: "RS256", kid: "k1" }));
    const body = b64(JSON.stringify({ email: "me@example.com", sub: "u", exp: now + 300, aud: AUD, iss: `https://${TEAM}` }));
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(await exportPrivate());
    const res = await site.fetch("/api/receipts/issue-198", { token: `${head}.${body}.${sig.toString("base64url")}` });
    assert.equal(res.status, 403);
    await res.arrayBuffer();
  });

  test("/_piquette/status needs a token, returns no data, accepts either kind", async () => {
    let res = await site.fetch("/_piquette/status", { token: null });
    assert.equal(res.status, 401);
    await res.arrayBuffer();
    for (const token of [await signToken(), await signToken({ commonName: "svc.access" })]) {
      res = await site.fetch("/_piquette/status", { token });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { version: string; modules: Record<string, string> };
      assert.deepEqual(body.modules, { receipts: "ok", ingest: "off", dashboard: "off" });
      assert.match(body.version, /^\d+\.\d+\.\d+/);
    }
  });
});
