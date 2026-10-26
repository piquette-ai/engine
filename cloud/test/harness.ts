/** Shared Miniflare harness: loads the real wrangler bundle (dist/index.js) with R2, assets and a fake Access certs endpoint. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, type Response as MfResponse } from "miniflare";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from "jose";
import { runObjects, type FixtureObjects } from "../../src/test/receipt_fixture.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEAM = "test-team.cloudflareaccess.com";
export const AUD = "test-aud-123";
export const AUD2 = "test-aud-456";
export const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;
export const ORIGIN = "https://receipts.test";

export const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
export const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };

export interface TokenOpts {
  key?: CryptoKey;
  kid?: string;
  aud?: string;
  iss?: string;
  exp?: number | null;
  /** Omit for the default identity; `null` for a token with no email. */
  email?: string | null;
  /** A service-token JWT: carries `common_name`, no email. */
  commonName?: string;
}

export async function signToken(o: TokenOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = o.commonName ? { common_name: o.commonName } : o.email === null ? {} : { email: o.email ?? "me@example.com" };
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? "k1" })
    .setSubject("user-1")
    .setIssuedAt(now)
    .setAudience(o.aud ?? AUD)
    .setIssuer(o.iss ?? `https://${TEAM}`);
  if (o.exp !== null) jwt.setExpirationTime(o.exp ?? now + 300);
  return jwt.sign(o.key ?? privateKey);
}

/** The shipped schema, split into statements (one per `;` line, comments dropped). */
export function migrationStatements(): string[] {
  const dir = path.join(here, "..", "migrations");
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return files.flatMap((f) =>
    readFileSync(path.join(dir, f), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("--"))
      .join("\n")
      .split(/;\s*\n|;\s*$/)
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

export interface Site {
  mf: Miniflare;
  /** The D1 binding (present with `D1: "1"`). */
  db(): Promise<any>;
  certHits: () => number;
  fetch(pathAndQuery: string, init?: RequestInit & { token?: string | null }): Promise<MfResponse>;
  seed(objects: FixtureObjects, keyPrefix?: string): Promise<void>;
  dispose(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = { mp4: "video/mp4", json: "application/json", txt: "text/plain" };

/**
 * `NO_R2: "1"` leaves the RECEIPTS binding out (module-unavailable tests); `D1: "1"` adds a migrated DB binding.
 * Neither is passed to the Worker as a var. `certs` swaps the Access certs endpoint's behavior in a test.
 */
export async function startSite(options: Record<string, string> = {}): Promise<Site> {
  const { NO_R2, D1, ...bindings } = options;
  const wrangler = JSON.parse(readFileSync(path.join(here, "..", "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  let hits = 0;
  const mf = new Miniflare({
    modules: true,
    scriptPath: path.join(here, "..", "dist", "index.js"),
    script: readFileSync(path.join(here, "..", "dist", "index.js"), "utf8"),
    compatibilityDate: wrangler.compatibility_date,
    r2Buckets: NO_R2 === "1" ? [] : ["RECEIPTS"],
    ...(D1 === "1" ? { d1Databases: ["DB"] } : {}),
    bindings: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: `${AUD},${AUD2}`, PIQUETTE_MODULES: "receipts", BASE_PATH: "/", RECEIPTS_PREFIX: "", ...bindings },
    assets: {
      directory: path.join(here, "fixtures", "web"),
      binding: "ASSETS",
      // Derived from the shipped config so deleting run_worker_first there fails the tests.
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: wrangler.assets?.run_worker_first === true },
      assetConfig: { not_found_handling: wrangler.assets?.not_found_handling },
    },
    outboundService: async (req) => {
      if (req.url === CERTS_URL) {
        hits++;
        return Response.json({ keys: [publicJwk] }) as unknown as MfResponse;
      }
      return new Response("blocked", { status: 502 }) as unknown as MfResponse;
    },
  });
  await mf.ready;
  if (D1 === "1") {
    const db = await mf.getD1Database("DB");
    for (const sql of migrationStatements()) await db.prepare(sql).run();
  }
  return {
    mf,
    db: () => mf.getD1Database("DB") as never,
    certHits: () => hits,
    async fetch(p, init = {}) {
      const { token, ...rest } = init;
      const headers = new Headers(rest.headers);
      const t = token === undefined ? await signToken() : token;
      if (t) headers.set("Cf-Access-Jwt-Assertion", t);
      return mf.dispatchFetch(`${ORIGIN}${p}`, { ...rest, headers } as never);
    },
    async seed(objects, keyPrefix = "") {
      const bucket = await mf.getR2Bucket("RECEIPTS");
      for (const [key, body] of Object.entries(objects)) {
        const ext = key.split(".").pop() ?? "";
        await bucket.put(`${keyPrefix}${key}`, body, { httpMetadata: { contentType: CONTENT_TYPES[ext] ?? "application/octet-stream" } });
      }
    },
    dispose: () => mf.dispose(),
  };
}

export const run198 = () => runObjects("issue-198", "issue-198");
export const videoKey = (attempt: number) => `issue-198/attempts/issue-198/${attempt}/video.mp4`;
