/**
 * Pure helpers over `cloud:` (#214). Node-free: no fs, no process.
 * Nothing here names an org or host; every value comes from config.
 */
import { BRAND_VAR_MAX_BYTES, brandVarBytes } from "../ui/shared/brand.ts";
import type { CloudConfig, ReceiptsConfig, SFConfig } from "../core/data_types.ts";

/** Compatibility date the generated wrangler config pins; asserted equal to cloud/wrangler.jsonc in a test. */
export const WORKER_COMPATIBILITY_DATE = "2026-07-01";

/** Daily retention sweep (ingest module). */
export const RETENTION_CRON = "17 3 * * *";

/** The BRAND_JSON var: empty when unset; refuses a brand Cloudflare would reject (one var is limited to 5 KB). */
export function brandVar(brand: CloudConfig["brand"]): string {
  if (!brand || Object.keys(brand).length === 0) return "";
  const bytes = brandVarBytes(brand);
  if (bytes > BRAND_VAR_MAX_BYTES) {
    throw new Error(`cloud.brand is ${bytes} bytes serialized; one Worker var may hold at most ${BRAND_VAR_MAX_BYTES} (Cloudflare's limit is 5 KB). Use an https logo_url or a smaller SVG.`);
  }
  return JSON.stringify(brand);
}

/** The path part of a Workers route pattern, minus trailing `*` and `/`. `""` for a bare host. */
export function routePath(route: string): string {
  const slash = route.indexOf("/");
  if (slash < 0) return "";
  return route.slice(slash).replace(/\*$/, "").replace(/\/+$/, "");
}

function routeHost(route: string): string {
  const slash = route.indexOf("/");
  return (slash < 0 ? route : route.slice(0, slash)).replace(/\*$/, "");
}

/** `base_path ?? route's path ?? "/"`. */
export function resolvedBasePath(cloud: Pick<CloudConfig, "route" | "base_path">): string {
  const fromRoute = cloud.route ? routePath(cloud.route) : "";
  return cloud.base_path ?? (fromRoute || "/");
}

/** `hostname || route ? false : true` unless set explicitly. */
export function resolvedWorkersDev(cloud: Pick<CloudConfig, "hostname" | "route" | "workers_dev">): boolean {
  return cloud.workers_dev ?? !(cloud.hostname || cloud.route);
}

/**
 * Where the app answers, derived without a network call, in order: explicit
 * `public_url`; the custom hostname plus base; the route. A workers.dev app
 * has no offline URL (the account subdomain is not config), so the operator
 * sets `public_url`.
 */
export function cloudPublicUrl(cloud: CloudConfig | undefined): string | undefined {
  if (!cloud) return undefined;
  if (cloud.public_url) return cloud.public_url.replace(/\/+$/, "");
  const base = resolvedBasePath(cloud);
  if (cloud.hostname) return `https://${cloud.hostname}${base !== "/" ? base : ""}`;
  if (cloud.route) return `https://${routeHost(cloud.route)}${routePath(cloud.route) || (base !== "/" ? base : "")}`;
  return undefined;
}

/** `receipts.viewer_url` ?? (receipts module on ? the cloud's public URL : undefined). */
export function effectiveViewerUrl(cfg: { receipts?: Pick<ReceiptsConfig, "viewer_url"> | undefined; cloud?: CloudConfig | undefined }): string | undefined {
  const explicit = cfg.receipts?.viewer_url;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (cfg.cloud?.modules.includes("receipts")) return cloudPublicUrl(cfg.cloud);
  return undefined;
}

export interface WranglerConfigInput {
  workerPath: string;
  webDir: string;
  /** Resolved R2 bucket name (r2.bucket ?? s3 store bucket); absent when the receipts module is off. */
  bucket?: string;
  /** Object-key prefix the Worker reads under. */
  prefix: string;
  /** Resolved D1 database, when the d1 block is configured and provisioned. */
  d1?: { name: string; id: string };
  /** Absolute directory of the packaged migrations (`dist/worker/migrations`), for `wrangler d1 migrations apply`. */
  migrationsDir?: string;
}

/**
 * The wrangler config a deploy writes. Every var is present on every deploy
 * (empty string when unset) because a deploy replaces all vars. No account id
 * and no credential: wrangler reads those from the environment.
 */
export function wranglerConfigFor(cfg: Pick<SFConfig, "cloud">, input: WranglerConfigInput): Record<string, unknown> {
  const cloud = cfg.cloud;
  if (!cloud) throw new Error("cloud is not configured");
  const chrome = cloud.chrome ?? { header_height: 56 };
  return {
    name: cloud.name,
    main: input.workerPath,
    no_bundle: true,
    compatibility_date: WORKER_COMPATIBILITY_DATE,
    workers_dev: resolvedWorkersDev(cloud),
    preview_urls: false,
    keep_vars: false,
    routes: cloud.hostname
      ? [{ pattern: cloud.hostname, custom_domain: true }]
      : cloud.route
        ? [{ pattern: cloud.route, zone_name: cloud.zone }]
        : [],
    assets: {
      directory: input.webDir,
      binding: "ASSETS",
      run_worker_first: true,
      not_found_handling: "single-page-application",
    },
    ...(input.bucket ? { r2_buckets: [{ binding: "RECEIPTS", bucket_name: input.bucket }] } : {}),
    ...(input.d1
      ? { d1_databases: [{ binding: "DB", database_name: input.d1.name, database_id: input.d1.id, ...(input.migrationsDir ? { migrations_dir: input.migrationsDir } : {}) }] }
      : {}),
    // The retention sweep. A deploy replaces the trigger list, so it is present (empty) when ingest is off.
    triggers: { crons: cloud.modules.includes("ingest") ? [RETENTION_CRON] : [] },
    vars: {
      ACCESS_TEAM_DOMAIN: cloud.access.team_domain,
      ACCESS_AUD: cloud.access.aud.join(","),
      PIQUETTE_MODULES: cloud.modules.join(","),
      BASE_PATH: resolvedBasePath(cloud),
      RECEIPTS_PREFIX: input.prefix,
      RETENTION_DAYS: String(cloud.retention_days),
      RECEIPTS_VISIBILITY: cloud.receipts_visibility,
      CHROME_STYLESHEET_URL: chrome.stylesheet_url ?? "",
      CHROME_HEADER_URL: chrome.header_url ?? "",
      CHROME_HEADER_HEIGHT: String(chrome.header_height ?? 56),
      CHROME_HOME_URL: chrome.home_url ?? "",
      BRAND_JSON: brandVar(cloud.brand),
    },
    observability: { enabled: true },
  };
}
