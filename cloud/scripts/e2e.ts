/**
 * Real-Cloudflare end-to-end for the cloud app (#214). Run by hand with credentials, never in CI or tests:
 *
 *   npm run build            # at the repo root: the deploy uses the packaged Worker bundle
 *   set -a; . <your env file>; set +a
 *   npm --prefix cloud run e2e -- [--name spf] [--bucket spf-receipts] [--hostname spf.example.com]
 *
 * It only does what `spf cloud deploy` deliberately does not: create the R2 bucket and the Access application
 * (an org owns its perimeter). The deploys themselves go through `deployCloud` from the root `dist`, so there
 * is one generator of the wrangler config. Secret hygiene: env values, headers and request bodies are never
 * logged; errors carry a status and Cloudflare's `errors[].message` only.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_ALLOWED_EMAIL"] as const;
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const missing = REQUIRED.filter((k) => !(process.env[k] ?? "").trim());
if (missing.length) {
  console.error(`missing required env: ${missing.join(", ")}`);
  process.exit(1);
}
const env = (k: (typeof REQUIRED)[number]): string => (process.env[k] ?? "").trim();
const account = env("CLOUDFLARE_ACCOUNT_ID");
const team = env("CF_ACCESS_TEAM_DOMAIN").replace(/^https:\/\//, "").replace(/\/+$/, "");
const email = env("CF_ACCESS_ALLOWED_EMAIL");
const name = arg("name", "spf");
const bucket = arg("bucket", "spf-receipts");
const customHost = arg("hostname", (process.env["CLOUD_HOSTNAME"] ?? "").trim());

const { cfApi } = (await import(path.join(dist, "cloud", "cf_api.js"))) as typeof import("../../src/cloud/cf_api.ts");
const { deployCloud } = (await import(path.join(dist, "cloud", "deploy.js"))) as typeof import("../../src/cloud/deploy.ts");
const { SFConfigSchema } = (await import(path.join(dist, "core", "data_types.js"))) as typeof import("../../src/core/data_types.ts");
const v = (await import("valibot")) as typeof import("valibot");

const api = cfApi({ token: env("CLOUDFLARE_API_TOKEN"), tokenEnv: "CLOUDFLARE_API_TOKEN" });
const acct = `/accounts/${encodeURIComponent(account)}`;
const fail = (what: string, r: { status: number; errors: string[] }): never => {
  throw new Error(`${what}: HTTP ${r.status}${r.errors.length ? `: ${r.errors.join("; ")}` : ""}`);
};

// 1. bucket
const probe = await api.get(`${acct}/r2/buckets/${encodeURIComponent(bucket)}`);
if (probe.status === 404) {
  const made = await api.post(`${acct}/r2/buckets`, { name: bucket });
  if (!made.ok) fail("creating the bucket", made);
  console.log(`created bucket ${bucket}`);
} else if (!probe.ok) fail("checking the bucket", probe);
else console.log(`bucket ${bucket} exists`);

// 2. where it will answer
let hostname = customHost;
if (!hostname) {
  const sub = await api.get<{ subdomain?: string }>(`${acct}/workers/subdomain`);
  if (!sub.ok || !sub.result?.subdomain) throw new Error("no workers.dev subdomain on this account: set one, or pass --hostname for a custom domain");
  hostname = `${name}.${sub.result.subdomain}.workers.dev`;
}

const cfgFor = (aud: string) =>
  v.parse(SFConfigSchema, {
    cloud: {
      provider: "cloudflare",
      name,
      ...(customHost ? { hostname: customHost } : { public_url: `https://${hostname}` }),
      access: { team_domain: team, aud },
      r2: { bucket },
    },
  });
const deploy = (aud: string) => deployCloud(cfgFor(aud), { cloud: "explicit" }, { env: process.env, out: console.log });

// 3. first deploy with a placeholder AUD: it fails closed (403 to everything) until the Access app exists
await deploy("pending-aud-placeholder");

// 4. Access application + policy
const apps = await api.get<{ id: string; name: string; domain?: string }[]>(`${acct}/access/apps`);
if (!apps.ok) fail("listing Access applications", apps);
const existing = (apps.result ?? []).find((a) => a.name === name);
if (existing?.domain && existing.domain !== hostname) throw new Error(`Access app ${name} already fronts a different hostname; pass --name to deploy a separate app`);
const body = { name, domain: hostname, type: "self_hosted", session_duration: "24h", policies: [{ name: `${name} allow`, decision: "allow", include: [{ email: { email } }] }] };
const made = existing ? await putJson(`${acct}/access/apps/${existing.id}`, body) : await api.post<{ aud?: string }>(`${acct}/access/apps`, body);
const aud = made.result?.aud;
if (!made.ok || !aud) fail("creating the Access application (a workers.dev domain may need --hostname on a zone in this account)", made);
console.log(`${existing ? "updated" : "created"} Access app ${name}`);

// 5. second deploy with the real AUD
await deploy(aud!);
console.log(`\napp: https://${hostname}/r/<run_id>\nadd to the machine-layer cloud: block:\n  public_url: https://${hostname}\n  access: { team_domain: ${team}, aud: ${aud} }\nthen: spf cloud status`);

async function putJson(route: string, payload: unknown): Promise<{ ok: boolean; status: number; errors: string[]; result?: { aud?: string } }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${route}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${env("CLOUDFLARE_API_TOKEN")}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as { result?: { aud?: string }; errors?: { message?: string }[] };
  return { ok: res.ok, status: res.status, errors: (json.errors ?? []).map((e) => e.message).filter((m): m is string => !!m), result: json.result };
}
