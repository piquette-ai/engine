/**
 * `spf cloud deploy` (#214): provision the R2 bucket, generate a wrangler
 * config from the layered `cloud:` block, and run a pinned wrangler against
 * the packaged Worker bundle. The org owns its Access perimeter: deploy
 * never creates Access applications, and it never writes a secret anywhere.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { SFConfig } from "../core/data_types.ts";
import type { ConfigOrigins } from "../core/config_origins.ts";
import { PACKAGE_ROOT, WEB_DIR } from "../core/paths.ts";
import { cfApi, type CfApi, type FetchLike } from "./cf_api.ts";
import { cloudPublicUrl, resolvedBasePath, resolvedWorkersDev, wranglerConfigFor } from "./config.ts";
import { runWrangler, wranglerArgv, type SpawnFn } from "./wrangler.ts";

export class CloudDeployError extends Error {}

export interface DeployOptions {
  env: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  fetch?: FetchLike;
  out: (line: string) => void;
  dryRun?: boolean;
  /** Deploy although the cloud block (or its bucket) comes from the repo layer. */
  allowRepoCloud?: boolean;
  /** Where dist/worker and web/ live. Defaults to the installed package. */
  packageRoot?: string;
}

export interface BucketPlan {
  bucket: string;
  prefix: string;
}

/** `r2.bucket ?? the s3 store's bucket`; an error when both are set and differ, or neither is. */
export function resolveBucket(cfg: Pick<SFConfig, "cloud" | "receipts">): BucketPlan {
  const r2 = cfg.cloud?.r2;
  const store = cfg.receipts?.store;
  const s3 = store?.kind === "s3" ? store : undefined;
  const bucket = r2?.bucket ?? s3?.bucket;
  if (!bucket) throw new CloudDeployError("no R2 bucket: set cloud.r2.bucket (or an s3 receipts.store whose bucket is the R2 bucket)");
  if (r2?.bucket && s3 && r2.bucket !== s3.bucket) {
    throw new CloudDeployError(`cloud.r2.bucket (${r2.bucket}) and receipts.store.bucket (${s3.bucket}) differ: the Worker must read the bucket spf writes`);
  }
  const storePrefix = s3 && s3.bucket === bucket ? s3.prefix : undefined;
  if (r2?.prefix !== undefined && storePrefix !== undefined && r2.prefix !== storePrefix) {
    throw new CloudDeployError(`cloud.r2.prefix (${JSON.stringify(r2.prefix)}) and receipts.store.prefix (${JSON.stringify(storePrefix)}) differ`);
  }
  return { bucket, prefix: r2?.prefix ?? storePrefix ?? "" };
}

const accountPathOf = (account: string): string => `/accounts/${encodeURIComponent(account)}`;
const errText = (r: { status: number; errors: string[] }): string => `HTTP ${r.status}${r.errors.length ? `: ${r.errors.join("; ")}` : ""}`;

/** The D1 database id for `name`: an exact-name match, else created. */
export async function ensureD1(api: CfApi, account: string, name: string, out: (line: string) => void = () => {}): Promise<string> {
  const base = `${accountPathOf(account)}/d1/database`;
  const found = await api.get<{ uuid?: string; name?: string }[]>(`${base}?name=${encodeURIComponent(name)}&per_page=100`);
  if (!found.ok) throw new CloudDeployError(`looking up D1 database ${name} failed: ${errText(found)}`);
  const hit = (found.result ?? []).find((d) => d.name === name && typeof d.uuid === "string");
  if (hit?.uuid) {
    out(`D1 database ${name} exists`);
    return hit.uuid;
  }
  const made = await api.post<{ uuid?: string }>(base, { name });
  if (!made.ok || !made.result?.uuid) throw new CloudDeployError(`creating D1 database ${name} failed: ${errText(made)}`);
  out(`created D1 database ${name}`);
  return made.result.uuid;
}

/** One parameterized statement against a D1 database over the REST API. Values never enter the SQL text. */
export async function d1Query<T = Record<string, unknown>>(api: CfApi, account: string, dbId: string, sql: string, params: unknown[] = []): Promise<{ results: T[]; changes: number }> {
  const res = await api.post<{ results?: T[]; meta?: { changes?: number } }[]>(`${accountPathOf(account)}/d1/database/${encodeURIComponent(dbId)}/query`, { sql, params });
  if (!res.ok) throw new CloudDeployError(`D1 query failed: ${errText(res)}`);
  const first = res.result?.[0];
  return { results: first?.results ?? [], changes: first?.meta?.changes ?? 0 };
}

export interface ReaderGrant {
  tenant: string;
  kind: "email" | "email_domain";
  value: string;
}

export function desiredGrants(tenants: NonNullable<SFConfig["cloud"]>["tenants"]): ReaderGrant[] {
  const out = new Map<string, ReaderGrant>();
  for (const t of tenants ?? []) {
    for (const e of t.readers.emails ?? []) out.set(`email\0${e.toLowerCase()}\0${t.id}`, { tenant: t.id, kind: "email", value: e.toLowerCase() });
    for (const d of t.readers.email_domains ?? []) out.set(`email_domain\0${d.toLowerCase()}\0${t.id}`, { tenant: t.id, kind: "email_domain", value: d.toLowerCase() });
  }
  return [...out.values()];
}

/** Makes `reader_grants` equal the config: insert-or-ignore the desired rows FIRST, then delete the rest, so a reader is never locked out mid-sync. */
export async function syncReaderGrants(api: CfApi, account: string, dbId: string, tenants: NonNullable<SFConfig["cloud"]>["tenants"]): Promise<{ added: number; removed: number }> {
  const want = desiredGrants(tenants);
  const PER_STATEMENT = 33; // 3 params per row, under D1's 100-parameter limit
  for (let i = 0; i < want.length; i += PER_STATEMENT) {
    const chunk = want.slice(i, i + PER_STATEMENT);
    await d1Query(api, account, dbId, `INSERT OR IGNORE INTO reader_grants (tenant, kind, value) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`, chunk.flatMap((g) => [g.tenant, g.kind, g.value]));
  }
  const have = (await d1Query<ReaderGrant>(api, account, dbId, "SELECT tenant, kind, value FROM reader_grants")).results;
  const keep = new Set(want.map((g) => `${g.kind}\0${g.value}\0${g.tenant}`));
  const stale = have.filter((g) => !keep.has(`${g.kind}\0${g.value}\0${g.tenant}`));
  for (const g of stale) await d1Query(api, account, dbId, "DELETE FROM reader_grants WHERE tenant = ? AND kind = ? AND value = ?", [g.tenant, g.kind, g.value]);
  return { added: want.length, removed: stale.length };
}

/** Number of `NNNN_*.sql` files shipped beside the bundle. */
export function migrationCount(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).length;
  } catch {
    return 0;
  }
}

function missingBuild(root: string, what: string): CloudDeployError {
  const checkout = existsSync(path.join(root, "cloud", "package.json"));
  return new CloudDeployError(`${what} is missing: ${checkout ? "run `npm run build` (or `npm run build:cloud` and `npm run build:app`)" : "reinstall @gr8ful/spf"}`);
}

export async function deployCloud(cfg: SFConfig, origins: ConfigOrigins, options: DeployOptions): Promise<number> {
  const cloud = cfg.cloud;
  if (!cloud) throw new CloudDeployError("no cloud: block in any config layer (see docs/cloud.md)");
  const { out } = options;
  const root = options.packageRoot ?? PACKAGE_ROOT;
  const webDir = options.packageRoot ? path.join(root, "web") : WEB_DIR;
  const workerPath = path.join(root, "dist", "worker", "index.js");
  const names = { account_id_env: cloud.account_id_env, api_token_env: cloud.api_token_env };

  if (origins.cloud === "repo") out(`cloud block from ${origins.cloudPath ?? "the repo"} (repo layer): a repo controls where this deploys; deploy from your machine layer unless you trust it`);

  const wantsReceipts = cloud.modules.includes("receipts");
  const wantsD1 = !!cloud.d1 && (cloud.modules.includes("ingest") || cloud.modules.includes("dashboard"));
  const plan: BucketPlan | undefined = wantsReceipts ? resolveBucket(cfg) : undefined;
  const bucketFromRepoStore = wantsReceipts && !cloud.r2?.bucket && origins.receiptsStore === "repo";
  if ((origins.cloud === "repo" || bucketFromRepoStore) && !options.allowRepoCloud) {
    throw new CloudDeployError(`refusing to deploy: ${origins.cloud === "repo" ? `the cloud block comes from ${origins.cloudPath ?? "the repo"} (repo layer)` : "the R2 bucket comes from a repo-layer receipts.store"}, and a cloned repo could point Access trust or the bucket at someone else. Put the cloud: block in your machine-layer spf.config.yaml, or pass --allow-repo-cloud if you trust this repo`);
  }
  const migrationsDir = path.join(root, "dist", "worker", "migrations");
  const input = { workerPath, webDir, prefix: plan?.prefix ?? "", ...(plan ? { bucket: plan.bucket } : {}), migrationsDir };
  const dbName = wantsD1 ? cloud.d1!.database : undefined;

  if (options.dryRun) {
    const preview = wranglerConfigFor(cfg, { ...input, ...(dbName ? { d1: { name: dbName, id: "<d1-database-id>" } } : {}) });
    out(JSON.stringify(preview, null, 2));
    if (dbName) out(`npx ${wranglerArgv(["d1", "migrations", "apply", dbName, "--remote"], "<tmp>/wrangler.json").join(" ")}`);
    out(`npx ${wranglerArgv(["deploy"], "<tmp>/wrangler.json").join(" ")}`);
    out(`dry run: no API calls, nothing spawned. Would ensure ${[plan && `R2 bucket ${plan.bucket}`, dbName && `D1 database ${dbName}`].filter(Boolean).join(" and ") || "nothing"} exists.`);
    return 0;
  }

  if (!existsSync(workerPath)) throw missingBuild(root, "the packaged Worker bundle (dist/worker/index.js)");
  if (!existsSync(path.join(webDir, "index.html"))) throw missingBuild(root, "the packaged web app (web/index.html)");
  if (wantsD1 && migrationCount(migrationsDir) === 0) throw missingBuild(root, "the packaged D1 migrations (dist/worker/migrations)");
  const account = (options.env[names.account_id_env] ?? "").trim();
  const token = (options.env[names.api_token_env] ?? "").trim();
  const unset = [!account && names.account_id_env, !token && names.api_token_env].filter((n): n is string => !!n);
  if (unset.length) throw new CloudDeployError(`set ${unset.join(" and ")} in the environment`);

  const api = cfApi({ token, tokenEnv: names.api_token_env }, options.fetch);
  const accountPath = accountPathOf(account);
  if (plan) {
    const probe = await api.get(`${accountPath}/r2/buckets/${encodeURIComponent(plan.bucket)}`);
    if (probe.status === 404) {
      const made = await api.post(`${accountPath}/r2/buckets`, { name: plan.bucket });
      if (!made.ok) throw new CloudDeployError(`creating R2 bucket ${plan.bucket} failed: ${errText(made)}`);
      out(`created R2 bucket ${plan.bucket}`);
    } else if (!probe.ok) {
      throw new CloudDeployError(`checking R2 bucket ${plan.bucket} failed: ${errText(probe)}`);
    } else out(`R2 bucket ${plan.bucket} exists`);
  }

  let dbId: string | undefined;
  if (dbName) dbId = await ensureD1(api, account, dbName, out);
  const wrangler = wranglerConfigFor(cfg, { ...input, ...(dbName && dbId ? { d1: { name: dbName, id: dbId } } : {}) });

  // Schema first: the new Worker never runs against an older schema. The reverse is NOT safe: once a migration that rebuilds keys
  // (0004, #218) is applied, the previous Worker 500s on every ingest and archive write, so deploy right after it; a rollback of the Worker
  // alone is not possible (restore the D1 Time Travel bookmark taken before the migration, which discards later ingests).
  if (dbName) {
    const migrate = await runWrangler(["d1", "migrations", "apply", dbName, "--remote"], { cfgJson: wrangler, env: options.env, names, spawn: options.spawn, extraEnv: { CI: "1" } });
    if (migrate.code !== 0) throw new CloudDeployError(`wrangler d1 migrations apply exited ${migrate.code}`);
  }
  const run = await runWrangler(["deploy"], { cfgJson: wrangler, env: options.env, names, spawn: options.spawn });
  if (run.code !== 0) throw new CloudDeployError(`wrangler deploy exited ${run.code}`);
  if (dbId && cloud.tenants) {
    const g = await syncReaderGrants(api, account, dbId, cloud.tenants);
    out(`reader grants synced: ${g.added} configured, ${g.removed} removed`);
  }

  const url = cloudPublicUrl(cloud);
  if (url) {
    out(`deployed ${cloud.name}: ${url}`);
    return 0;
  }
  const sub = await api.get<{ subdomain?: string }>(`${accountPath}/workers/subdomain`);
  const base = resolvedBasePath(cloud);
  if (resolvedWorkersDev(cloud) && sub.ok && sub.result?.subdomain) {
    const derived = `https://${cloud.name}.${sub.result.subdomain}.workers.dev${base !== "/" ? base : ""}`;
    out(`deployed ${cloud.name}: ${derived}`);
    out(`add this to the cloud: block in your machine-layer spf.config.yaml so links and status know where it is:\n  public_url: ${derived}`);
  } else {
    out(`deployed ${cloud.name}; set cloud.public_url to its address`);
  }
  return 0;
}
