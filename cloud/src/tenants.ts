/** Which tenants a signed-in reader may see: the deploy-time `reader_grants`, matched by exact email or by email domain. */
import type { MiddlewareHandler } from "hono";
import type { CloudEnv, D1Database } from "./env.ts";

/** Lowercased tenants granted to this email (exact) or its domain. Empty for anything that is not a plain address. */
export async function readerTenants(db: D1Database, email: string): Promise<string[]> {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1 || e.indexOf("@") !== at) return [];
  const { results } = await db
    .prepare("SELECT DISTINCT tenant FROM reader_grants WHERE (kind = 'email' AND value = ?) OR (kind = 'email_domain' AND value = ?) ORDER BY tenant")
    .bind(e, e.slice(at + 1))
    .all<{ tenant: string }>();
  return results.map((r) => r.tenant);
}

/** After `requireIdentity()`: puts the reader's tenants on the context, or answers 403 when the identity has none. */
export function requireTenants(): MiddlewareHandler<CloudEnv> {
  return async (c, next) => {
    const email = c.get("access")?.email;
    const db = c.env.DB;
    if (!email || !db) return c.json({ error: "no tenant for this identity" }, 403);
    const tenants = await readerTenants(db, email);
    if (tenants.length === 0) return c.json({ error: "no tenant for this identity" }, 403);
    c.set("tenants", tenants);
    await next();
  };
}
