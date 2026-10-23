/**
 * `spf cloud provision-factory` (#214): mint (or adopt) one Access service
 * token for a factory and map it to a tenant in the hub's D1, so that
 * factory's `spf sync` is accepted. The only Cloudflare writes are the
 * service-token mint and one parameterized INSERT. The token secret is shown
 * ONCE, on stdout, and is never logged, written to a file or put on argv.
 *
 * Exit codes: 0 ok, 1 error, 3 the API token cannot mint service tokens
 * (the manual path is printed).
 */
import { cfApi, type FetchLike } from "./cf_api.ts";
import { CloudDeployError, d1Query } from "./deploy.ts";
import type { SFConfig } from "../core/data_types.ts";
import type { ConfigOrigins } from "../core/config_origins.ts";

export interface ProvisionOptions {
  tenant?: string;
  name: string;
  factoryId?: string;
  /** Adopt an existing service token instead of minting one. */
  clientId?: string;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  /** stdout: the credential lines only. */
  out: (line: string) => void;
  /** stderr: notes. */
  err?: (line: string) => void;
  origins?: ConfigOrigins;
  allowRepoCloud?: boolean;
  now?: () => string;
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function provisionFactory(cfg: SFConfig, options: ProvisionOptions): Promise<number> {
  const cloud = cfg.cloud;
  const err = options.err ?? (() => {});
  const fail = (message: string): number => {
    err(`cloud provision-factory: ${message}`);
    return 1;
  };
  if (!cloud) return fail("no cloud: block in any config layer");
  if (!cloud.d1 || !(cloud.modules.includes("ingest") || cloud.modules.includes("dashboard"))) return fail("the ingest module needs a d1 block (cloud.modules includes ingest, cloud.d1.database set)");
  if (options.origins?.cloud === "repo" && !options.allowRepoCloud) {
    return fail(`the cloud block comes from ${options.origins.cloudPath ?? "the repo"} (repo layer); a cloned repo must not steer where credentials are minted. Move it to your machine layer or pass --allow-repo-cloud`);
  }
  const tenants = cloud.tenants ?? [];
  const tenant = options.tenant ?? (tenants.length === 1 ? tenants[0]!.id : undefined);
  if (!tenant) return fail(`--tenant is required (one of: ${tenants.map((t) => t.id).join(", ") || "none configured: add cloud.tenants"})`);
  if (!tenants.some((t) => t.id === tenant)) return fail(`tenant "${tenant}" is not in cloud.tenants`);
  if (!NAME_RE.test(options.name)) return fail("--name must match [A-Za-z0-9._-], at most 64 characters");
  if (options.factoryId !== undefined && !UUID_RE.test(options.factoryId)) return fail("--factory-id must be a UUID");
  if (options.clientId !== undefined && !CLIENT_ID_RE.test(options.clientId)) return fail("--client-id has unexpected characters");

  const account = (options.env[cloud.account_id_env] ?? "").trim();
  const token = (options.env[cloud.api_token_env] ?? "").trim();
  const unset = [!account && cloud.account_id_env, !token && cloud.api_token_env].filter((n): n is string => !!n);
  if (unset.length) return fail(`set ${unset.join(" and ")} in the environment`);
  const api = cfApi({ token, tokenEnv: cloud.api_token_env }, options.fetch);
  const acct = `/accounts/${encodeURIComponent(account)}`;
  const tokenName = `spf-factory-${options.name}`;

  let clientId = options.clientId;
  let secret: string | undefined;
  if (!clientId) {
    const minted = await api.post<{ client_id?: string; client_secret?: string }>(`${acct}/access/service_tokens`, { name: tokenName, duration: "8760h" });
    if (minted.status === 403 || minted.status === 401) {
      err(`API token lacks Access: Service Tokens Edit. Create a service token named ${tokenName} in Zero Trust > Access > Service Auth, then run: spf cloud provision-factory --client-id <id> --tenant ${tenant}`);
      return 3;
    }
    if (!minted.ok || !minted.result?.client_id || !minted.result.client_secret) return fail(`minting the service token failed: HTTP ${minted.status}${minted.errors.length ? `: ${minted.errors.join("; ")}` : ""}`);
    clientId = minted.result.client_id;
    secret = minted.result.client_secret;
  }

  try {
    const found = await api.get<{ uuid?: string; name?: string }[]>(`${acct}/d1/database?name=${encodeURIComponent(cloud.d1.database)}&per_page=100`);
    const db = (found.result ?? []).find((d) => d.name === cloud.d1!.database && typeof d.uuid === "string");
    if (!found.ok || !db?.uuid) {
      if (secret) err(`note: the service token ${tokenName} was created but not mapped; re-run with --client-id ${clientId} once the database exists (the secret was not saved)`);
      return fail(`D1 database ${cloud.d1.database} not found: run spf cloud deploy first`);
    }
    const when = (options.now ?? (() => new Date().toISOString()))();
    // Never moves a credential to another tenant: the update only fires when the tenant is the same.
    const written = await d1Query(
      api,
      account,
      db.uuid,
      "INSERT INTO factory_credentials (common_name, tenant, factory_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(common_name) DO UPDATE SET factory_id = COALESCE(excluded.factory_id, factory_credentials.factory_id) WHERE factory_credentials.tenant = excluded.tenant",
      [clientId, tenant, options.factoryId ?? null, when],
    );
    if (written.changes === 0) {
      if (secret) err(`note: the service token ${tokenName} was created (client id ${clientId}) but is already mapped to a different tenant`);
      return fail("that service token is already mapped to a different tenant");
    }
  } catch (error) {
    if (error instanceof CloudDeployError) return fail(error.message);
    throw error;
  }

  options.out(`SPF_SYNC_CLIENT_ID=${clientId}`);
  if (secret) {
    options.out(`SPF_SYNC_CLIENT_SECRET=${secret}`);
    err("the client secret is shown once and is not stored anywhere: put it in this factory's environment now");
  } else {
    err("adopted an existing service token: keep its client secret from when you created it");
  }
  err("Access policy: the ingest Access application needs a Service Auth policy allowing \"any valid service token\"; the credential table in D1 is the gate (a token with no mapping is refused 403)");
  err(`mapped ${clientId} -> tenant ${tenant}${options.factoryId ? ` (pinned to factory ${options.factoryId})` : " (not pinned: any factory of this tenant)"}`);
  return 0;
}
