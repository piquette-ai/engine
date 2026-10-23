/**
 * Maps the verified service token (its `common_name`) to a tenant. The tenant
 * is ONLY ever taken from here: never from the payload.
 */
import type { D1Database } from "../env.ts";

export interface Credential {
  commonName: string;
  tenant: string;
  /** When set, this credential may push for exactly this factory. */
  factoryId: string | null;
}

export async function resolveCredential(db: D1Database, commonName: string): Promise<Credential | null> {
  const row = await db.prepare("SELECT common_name, tenant, factory_id FROM factory_credentials WHERE common_name = ?").bind(commonName).first<{ common_name: string; tenant: string; factory_id: string | null }>();
  if (!row || typeof row.tenant !== "string" || !row.tenant) return null;
  return { commonName: row.common_name, tenant: row.tenant, factoryId: row.factory_id ?? null };
}

export type FactoryAuthz = { ok: true } | { ok: false; reason: "pinned_mismatch" | "other_tenant" };

/** A pinned credential must match; a factory registered under another tenant is refused; an unseen factory registers to the credential's tenant. */
export async function authorizeFactory(db: D1Database, cred: Credential, factoryId: string): Promise<FactoryAuthz> {
  if (cred.factoryId !== null && cred.factoryId !== factoryId) return { ok: false, reason: "pinned_mismatch" };
  const row = await db.prepare("SELECT tenant FROM factories WHERE factory_id = ?").bind(factoryId).first<{ tenant: string }>();
  if (row && row.tenant !== cred.tenant) return { ok: false, reason: "other_tenant" };
  return { ok: true };
}
