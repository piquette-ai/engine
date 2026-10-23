/** The ingest endpoint's door: only a valid Access service-token JWT from the header, and only a configured Access setup. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { SignJWT, generateKeyPair } from "jose";
import { AUD, TEAM, publicJwk, signToken, startSite, type Site } from "./harness.ts";
import { SVC_A, makeBatch, seedCredentials, count } from "./ingest_helpers.ts";

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");

describe("ingest access", () => {
  let site: Site;
  let db: any;
  before(async () => {
    site = await startSite({ SPF_MODULES: "ingest", D1: "1" });
    db = await site.db();
    await seedCredentials(db, [{ cn: SVC_A, tenant: "tenant-a" }]);
  });
  after(() => site.dispose());

  const body = () => JSON.stringify(makeBatch({ adw: "acc" }));
  const attempt = (init: RequestInit & { token?: string | null }) => site.fetch("/ingest/v1", { method: "POST", body: body(), ...init });

  test("401: no header, cookie only, bearer only, client headers only", async () => {
    const good = await signToken({ commonName: SVC_A });
    assert.equal((await attempt({ token: null })).status, 401);
    assert.equal((await attempt({ token: null, headers: { cookie: `CF_Authorization=${good}` } })).status, 401);
    assert.equal((await attempt({ token: null, headers: { authorization: `Bearer ${good}` } })).status, 401);
    assert.equal((await attempt({ token: null, headers: { "CF-Access-Client-Id": SVC_A, "CF-Access-Client-Secret": "s" } })).status, 401);
  });

  test("403: expired, wrong aud, wrong iss, missing exp, unknown kid, wrong key, alg none, HS256 confusion, garbage", async () => {
    const now = Math.floor(Date.now() / 1000);
    const forgedKey = (await generateKeyPair("RS256")).privateKey;
    const hs = (() => {
      const head = b64(JSON.stringify({ alg: "HS256", kid: "k1", typ: "JWT" }));
      const payload = b64(JSON.stringify({ common_name: SVC_A, iat: now, exp: now + 300, aud: AUD, iss: `https://${TEAM}` }));
      return `${head}.${payload}.${createHmac("sha256", Buffer.from(String(publicJwk.n), "base64url")).update(`${head}.${payload}`).digest("base64url")}`;
    })();
    const none = `${b64(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64(JSON.stringify({ common_name: SVC_A, iat: now, exp: now + 300, aud: AUD, iss: `https://${TEAM}` }))}.`;
    const noIat = await new SignJWT({ common_name: SVC_A }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setAudience(AUD).setIssuer(`https://${TEAM}`).setExpirationTime(now + 300).sign((await import("./harness.ts")).privateKey);
    const tokens = [
      await signToken({ commonName: SVC_A, exp: now - 3600 }),
      await signToken({ commonName: SVC_A, aud: "other-aud" }),
      await signToken({ commonName: SVC_A, iss: "https://evil.cloudflareaccess.com" }),
      await signToken({ commonName: SVC_A, exp: null }),
      await signToken({ commonName: SVC_A, kid: "nope" }),
      await signToken({ commonName: SVC_A, key: forgedKey }),
      none,
      hs,
      noIat,
      "a.b.c",
      "x".repeat(9000),
    ];
    for (const [i, token] of tokens.entries()) {
      const res = await attempt({ token });
      assert.equal(res.status, 403, `token #${i}`);
      assert.deepEqual(await res.json(), { error: "invalid Cloudflare Access token" });
    }
    assert.equal(await count(db, "sessions"), 0);
  });

  test("403: an identity token (email, no common_name) and a token naming no mapped credential write nothing", async () => {
    assert.equal((await attempt({ token: await signToken({ email: "me@example.com" }) })).status, 403);
    assert.equal((await attempt({ token: await signToken({ commonName: "svc-nobody.access" }) })).status, 403);
    assert.equal(await count(db, "sessions"), 0);
  });

  test("an empty or invalid Access config fails closed with 503 and fetches no keys", async () => {
    for (const opts of [{ ACCESS_AUD: "" }, { ACCESS_TEAM_DOMAIN: "evil.example.com" }, { ACCESS_TEAM_DOMAIN: "" }]) {
      const s = await startSite({ SPF_MODULES: "ingest", D1: "1", ...opts });
      try {
        const res = await s.fetch("/ingest/v1", { method: "POST", body: body(), token: await signToken({ commonName: SVC_A }) });
        assert.equal(res.status, 503, JSON.stringify(opts));
        assert.equal(s.certHits(), 0, "no JWKS fetch on a bad config");
      } finally {
        await s.dispose();
      }
    }
  });
});
