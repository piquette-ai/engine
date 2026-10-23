/**
 * Cloudflare Access JWT validation: the only auth path of the cloud app.
 * The token comes from the `Cf-Access-Jwt-Assertion` header only (cookies,
 * bearer and client headers are never read), is verified RS256 against the
 * configured team's certs, and must carry the configured issuer, one of the
 * configured AUDs, and `exp` and `iat`. Bad or missing configuration fails
 * closed before any key fetch.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { MiddlewareHandler } from "hono";
import { accessConfig, type AccessConfig } from "../../src/cloud/access_config.ts";
import type { CloudEnv } from "./env.ts";

const MAX_TOKEN_BYTES = 8192;
const HEADER = "Cf-Access-Jwt-Assertion";

export type VerifyResult = { ok: true; claims: JWTPayload } | { ok: false; reason: string };

// Per-isolate cache. The key is only ever the configured certs URL.
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(url: string) {
  let set = jwks.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { cacheMaxAge: 600_000, cooldownDuration: 30_000, timeoutDuration: 5_000 });
    jwks.set(url, set);
  }
  return set;
}

export async function verifyAccessJwt(token: string, cfg: AccessConfig, keys?: JWTVerifyGetKey): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, keys ?? jwksFor(cfg.certsUrl), {
      issuer: cfg.issuer,
      audience: cfg.audiences,
      algorithms: ["RS256"],
      requiredClaims: ["iss", "aud", "exp", "iat"],
      clockTolerance: 30,
    });
    return { ok: true, claims: payload };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

type Kind = "identity" | "service" | "any";

function gate(kind: Kind): MiddlewareHandler<CloudEnv> {
  return async (c, next) => {
    const cfg = accessConfig(c.env);
    if ("error" in cfg) return c.json({ error: `cloud app misconfigured: ${cfg.error}` }, 503);
    const token = c.req.header(HEADER);
    if (!token) return c.json({ error: "Cloudflare Access token required" }, 401);
    if (token.length > MAX_TOKEN_BYTES) return c.json({ error: "invalid Cloudflare Access token" }, 403);
    const result = await verifyAccessJwt(token, cfg);
    if (!result.ok) {
      console.warn(`access: rejected token: ${result.reason}`);
      return c.json({ error: "invalid Cloudflare Access token" }, 403);
    }
    const email = typeof result.claims.email === "string" && result.claims.email ? result.claims.email : undefined;
    const commonName = typeof result.claims.common_name === "string" && result.claims.common_name ? result.claims.common_name : undefined;
    if (kind === "identity" && !email) return c.json({ error: "a signed-in identity is required (service tokens cannot read)" }, 403);
    if (kind === "service" && !commonName) return c.json({ error: "a service token is required" }, 403);
    c.set("access", { ...(email ? { email } : {}), ...(commonName ? { commonName } : {}) });
    await next();
  };
}

/** A valid JWT with a string `email`: a person. A service token (no email) is refused 403. */
export const requireIdentity = (): MiddlewareHandler<CloudEnv> => gate("identity");
/** A valid JWT with a string `common_name`: a service token. A person is refused 403. */
export const requireServiceToken = (): MiddlewareHandler<CloudEnv> => gate("service");
/** Any valid JWT. Used only by `/_spf/status`, which returns no data. */
export const requireAnyAccess = (): MiddlewareHandler<CloudEnv> => gate("any");
