/**
 * `piquette cloud status [--json]` (#214): is the deployed app configured as the
 * layered config says, and is it actually behind Access. Every check is pass,
 * warn or fail; output carries HTTP statuses and Cloudflare's own error
 * messages only, never env values or headers. Exit 1 on any fail, 2 with no
 * `cloud:` block.
 */
import type { SFConfig } from "../core/data_types.ts";
import { cfApi, type FetchLike } from "./cf_api.ts";
import { cloudPublicUrl, resolvedBasePath, resolvedWorkersDev } from "./config.ts";
import type { ConfigOrigins } from "../core/config_origins.ts";
import path from "node:path";
import { PACKAGE_ROOT } from "../core/paths.ts";
import { CloudDeployError, d1Query, migrationCount, resolveBucket } from "./deploy.ts";

export type CheckStatus = "pass" | "warn" | "fail";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface StatusOptions {
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  out: (line: string) => void;
  json?: boolean;
  origins?: ConfigOrigins;
  allowRepoCloud?: boolean;
  /** Where dist/worker/migrations lives. Defaults to the installed package. */
  packageRoot?: string;
}

const isAccessHost = (location: string): boolean => {
  try {
    return /\.cloudflareaccess\.com$/.test(new URL(location, "https://x.invalid").hostname);
  } catch {
    return false;
  }
};

export async function cloudStatus(cfg: SFConfig, options: StatusOptions): Promise<number> {
  const cloud = cfg.cloud;
  if (!cloud) {
    options.out("no cloud: block in any config layer");
    return 2;
  }
  const doFetch: FetchLike = options.fetch ?? fetch;
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string): void => {
    checks.push({ name, status, detail });
  };

  const url = cloudPublicUrl(cloud);
  const base = resolvedBasePath(cloud);
  let plan: ReturnType<typeof resolveBucket> | undefined;
  try {
    if (cloud.modules.includes("receipts")) plan = resolveBucket(cfg);
  } catch (error) {
    add("bucket", "fail", (error as Error).message);
  }
  add(
    "config",
    "pass",
    `${cloud.name}; modules ${cloud.modules.join(",")}; base ${base}; ${plan ? `bucket ${plan.bucket}${plan.prefix ? ` prefix ${plan.prefix}` : ""}; ` : ""}${url ? `url ${url}` : "no public URL (set cloud.public_url)"}`,
  );
  if (!url) add("public url", "warn", "no hostname, route or public_url: perimeter and service-token probes are skipped");

  // A repo-layer cloud block names the host and the env vars to send: never attach credentials to it unasked.
  const untrusted = options.origins?.cloud === "repo" && !options.allowRepoCloud;
  if (untrusted) add("config origin", "warn", `cloud block comes from ${options.origins?.cloudPath ?? "the repo"} (repo layer): credentialed checks skipped; move it to your machine layer or pass --allow-repo-cloud`);
  const account = untrusted ? "" : (options.env[cloud.account_id_env] ?? "").trim();
  const token = untrusted ? "" : (options.env[cloud.api_token_env] ?? "").trim();
  const api = cfApi({ token, tokenEnv: cloud.api_token_env }, doFetch);
  if (untrusted) {
    // no credentialed API calls
  } else if (!account || !token) {
    add("api", "warn", `${!account ? cloud.account_id_env : cloud.api_token_env} is not set: script and bucket checks skipped`);
  } else {
    const acct = `/accounts/${encodeURIComponent(account)}`;
    const settings = await api.get<{ bindings?: { type: string; name: string; text?: string }[] }>(`${acct}/workers/scripts/${encodeURIComponent(cloud.name)}/settings`);
    if (settings.status === 404) add("script", "fail", `worker ${cloud.name} is not deployed (run piquette cloud deploy)`);
    else if (!settings.ok) add("script", "fail", `reading worker settings: HTTP ${settings.status}${settings.errors.length ? `: ${settings.errors.join("; ")}` : ""}`);
    else {
      const vars = new Map((settings.result?.bindings ?? []).filter((b) => b.type === "plain_text").map((b) => [b.name, b.text ?? ""]));
      const want: Record<string, string> = {
        ACCESS_TEAM_DOMAIN: cloud.access.team_domain,
        ACCESS_AUD: cloud.access.aud.join(","),
        PIQUETTE_MODULES: cloud.modules.join(","),
        BASE_PATH: base,
        ...(plan ? { RECEIPTS_PREFIX: plan.prefix } : {}),
        ...(cloud.modules.includes("ingest") ? { RETENTION_DAYS: String(cloud.retention_days) } : {}),
        ...(cloud.modules.includes("dashboard") ? { RECEIPTS_VISIBILITY: cloud.receipts_visibility } : {}),
      };
      if (!(vars.get("ACCESS_AUD") ?? "")) add("script vars", "fail", "ACCESS_AUD is empty on the deployed worker: it answers 500 to everything");
      else {
        const drift = Object.keys(want).filter((k) => (vars.get(k) ?? "") !== want[k]);
        const trustDrift = drift.filter((k) => k === "ACCESS_TEAM_DOMAIN" || k === "ACCESS_AUD");
        add("script vars", trustDrift.length ? "fail" : drift.length ? "warn" : "pass", drift.length ? `differ from config: ${drift.join(", ")} (run piquette cloud deploy)` : "match config");
      }
    }
    if (cloud.d1 && (cloud.modules.includes("ingest") || cloud.modules.includes("dashboard"))) {
      const found = await api.get<{ uuid?: string; name?: string }[]>(`${acct}/d1/database?name=${encodeURIComponent(cloud.d1.database)}&per_page=100`);
      const db = (found.result ?? []).find((d) => d.name === cloud.d1!.database && typeof d.uuid === "string");
      if (!found.ok) add("d1 database", "fail", `HTTP ${found.status}${found.errors.length ? `: ${found.errors.join("; ")}` : ""}`);
      else if (!db?.uuid) add("d1 database", "fail", `${cloud.d1.database} does not exist (run piquette cloud deploy)`);
      else {
        add("d1 database", "pass", `${cloud.d1.database} exists`);
        const want = migrationCount(path.join(options.packageRoot ?? PACKAGE_ROOT, "dist", "worker", "migrations"));
        try {
          const applied = (await d1Query<{ n: number }>(api, account, db.uuid, "SELECT COUNT(*) AS n FROM d1_migrations")).results[0]?.n ?? 0;
          add("d1 migrations", applied === want ? "pass" : "fail", applied === want ? `${applied} applied` : `${applied} applied, ${want} shipped (run piquette cloud deploy)`);
        } catch (error) {
          add("d1 migrations", "fail", error instanceof CloudDeployError ? error.message : "could not read d1_migrations");
        }
      }
    }
    if (plan) {
      const bucket = await api.get(`${acct}/r2/buckets/${encodeURIComponent(plan.bucket)}`);
      add("r2 bucket", bucket.ok ? "pass" : "fail", bucket.ok ? `${plan.bucket} exists` : bucket.status === 404 ? `${plan.bucket} does not exist` : `HTTP ${bucket.status}${bucket.errors.length ? `: ${bucket.errors.join("; ")}` : ""}`);
    }
  }

  if (url) {
    const statusUrl = `${url}/_piquette/status`;
    const unauth = await probe(doFetch, statusUrl, {});
    if (unauth.error) add("perimeter", "fail", unauth.error);
    else if (unauth.status >= 300 && unauth.status < 400) add("perimeter", isAccessHost(unauth.location) ? "pass" : "warn", isAccessHost(unauth.location) ? `unauthenticated request redirected to Access (HTTP ${unauth.status})` : `redirected to an unexpected place (HTTP ${unauth.status})`);
    else if (unauth.status >= 200 && unauth.status < 300) add("perimeter", "fail", `unauthenticated request got HTTP ${unauth.status}: the app is open`);
    else if (unauth.status === 403 && !unauth.json) add("perimeter", "pass", "unauthenticated request refused by Access (HTTP 403)");
    else if (unauth.status === 401 && unauth.json) add("perimeter", "warn", "refused by the Worker's own 401, not by Access: no Access application in front, so signed-in users are refused too");
    else add("perimeter", "warn", `unexpected HTTP ${unauth.status}`);

    if (resolvedWorkersDev(cloud)) {
      let wd: string | undefined = new URL(url).hostname.endsWith(".workers.dev") ? url : undefined;
      if (!wd && account && token) {
        const sub = await api.get<{ subdomain?: string }>(`/accounts/${encodeURIComponent(account)}/workers/subdomain`);
        if (sub.ok && sub.result?.subdomain) wd = `https://${cloud.name}.${sub.result.subdomain}.workers.dev${base !== "/" ? base : ""}`;
      }
      if (!wd) add("workers.dev", "warn", "workers.dev is on but its address is unknown (set cloud.public_url or the API token): bypass probe skipped");
      else {
        const none = await probe(doFetch, `${wd}/_piquette/status`, {});
        const forged = await probe(doFetch, `${wd}/_piquette/status`, { "Cf-Access-Jwt-Assertion": "a.b.c" });
        const viaAccess = (r: Probe): boolean => r.status >= 300 && r.status < 400 && isAccessHost(r.location);
        const okNone = !none.error && (none.status === 401 || none.status === 403 || viaAccess(none));
        const okForged = !forged.error && (forged.status === 403 || viaAccess(forged));
        add("workers.dev", okNone && okForged ? "pass" : "fail", `no token HTTP ${none.error ? "error" : none.status}; forged token HTTP ${forged.error ? "error" : forged.status}`);
      }
    } else add("workers.dev", "pass", "off: no bypass ingress");

    const id = untrusted ? "" : (options.env[cloud.access.service_token_id_env] ?? "").trim();
    const secret = untrusted ? "" : (options.env[cloud.access.service_token_secret_env] ?? "").trim();
    if (untrusted) add("service token", "warn", "skipped: repo-layer cloud block");
    else if (!id || !secret) add("service token", "warn", `${cloud.access.service_token_id_env}/${cloud.access.service_token_secret_env} not set: end-to-end probe skipped`);
    else {
      const res = await probe(doFetch, statusUrl, { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret }, true);
      if (res.error) add("service token", "fail", res.error);
      else if (res.status !== 200) add("service token", "fail", `GET /_piquette/status with the service token: HTTP ${res.status}`);
      else {
        const modules = (res.body as { modules?: Record<string, string> } | undefined)?.modules ?? {};
        const bad = cloud.modules.filter((m) => modules[m] !== "ok");
        add("modules", bad.length ? "fail" : "pass", bad.length ? `not ok: ${bad.map((m) => `${m}=${modules[m] ?? "absent"}`).join(", ")}` : `${cloud.modules.join(", ")} ok`);
        if (cloud.modules.includes("ingest")) {
          const ingest = await probe(doFetch, `${url}/ingest/v1`, { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret }, true);
          const supported = (ingest.body as { supported?: unknown } | undefined)?.supported;
          if (ingest.error) add("ingest", "fail", ingest.error);
          else if (ingest.status === 200 && Array.isArray(supported)) add("ingest", "pass", `GET /ingest/v1 accepted the service token; sync_schema ${supported.join("-")}`);
          else if (ingest.status === 403 && (ingest.body as { error?: unknown } | undefined)?.error === "unknown_credential") add("ingest", "warn", "GET /ingest/v1 reached the Worker through Access; this status token is not a factory credential, which is expected (it is a read-only perimeter check). Factory credentials come from piquette cloud provision-factory");
          else if (ingest.status === 403) add("ingest", "fail", "GET /ingest/v1: HTTP 403 without the Worker's unknown_credential answer: the ingest Access application or its policy refuses this service token");
          else add("ingest", "fail", `GET /ingest/v1 with the service token: HTTP ${ingest.status}`);
        }
      }
    }
  }

  const exit = checks.some((c) => c.status === "fail") ? 1 : 0;
  if (options.json) options.out(JSON.stringify({ exit, checks }, null, 2));
  else for (const c of checks) options.out(`[${c.status}] ${c.name}: ${c.detail}`);
  return exit;
}

interface Probe {
  status: number;
  location: string;
  json: boolean;
  body?: unknown;
  error?: string;
}

async function probe(doFetch: FetchLike, url: string, headers: Record<string, string>, readBody = false): Promise<Probe> {
  try {
    const res = await doFetch(url, { redirect: "manual", headers });
    const json = (res.headers.get("content-type") ?? "").includes("json");
    const body = readBody ? await res.json().catch(() => undefined) : await res.arrayBuffer().then(() => undefined);
    return { status: res.status, location: res.headers.get("location") ?? "", json, body };
  } catch {
    return { status: 0, location: "", json: false, error: `request to ${new URL(url).host} failed` };
  }
}
