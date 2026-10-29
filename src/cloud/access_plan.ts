/**
 * `piquette cloud access-plan [--json]` (#214): print, never create, the Cloudflare
 * Access applications this deploy expects. Pure config -> text, same as
 * `deploy --dry-run`'s wrangler preview: no network call, no credential read, nothing
 * written anywhere. The org still creates these by hand (or its own IaC) and owns the
 * policy decision — the same invariant `deploy` and `provision-factory` already keep
 * (see docs/cloud.md: "the org owns its Access perimeter").
 */
import type { SFConfig } from "../core/data_types.ts";
import type { ConfigOrigins } from "../core/config_origins.ts";
import { cloudPublicUrl, resolvedWorkersDev } from "./config.ts";

export interface AccessAppPlan {
  /** What this app gates: readers (receipts/dashboard) or factories (ingest writers). */
  purpose: "reader" | "ingest";
  /** A display name only; Cloudflare does not constrain it. */
  name: string;
  domain: string;
  /** A Workers-route-style path pattern, e.g. "/*" or "/piquette/ingest*". */
  path: string;
  policy_type: "identity" | "service_auth";
  /** The suggested rule, in plain language (this tool never calls the Access API). */
  policy: string;
  after_creating: string;
}

export interface AccessPlan {
  apps: AccessAppPlan[];
  warnings: string[];
}

/** Pure: cloud config in, a plan out. Never throws, never calls the network. */
export function computeAccessPlan(cloud: NonNullable<SFConfig["cloud"]>): AccessPlan {
  const warnings: string[] = [];
  const url = cloudPublicUrl(cloud);
  if (!url) {
    warnings.push("no hostname, route or public_url resolved yet: set cloud.hostname (or cloud.route plus cloud.zone), or cloud.public_url, then run this again");
    return { apps: [], warnings };
  }
  const parsed = new URL(url);
  const domain = parsed.hostname;
  const base = parsed.pathname.replace(/\/+$/, ""); // "" at the root, "/piquette" when mounted under a path
  if (resolvedWorkersDev(cloud) && domain.endsWith(".workers.dev")) {
    warnings.push(`${domain} is a workers.dev subdomain: Access does not always accept it as an app's domain. If Access refuses it, use a custom domain on a zone in the account instead (cloud.hostname, or cloud.route plus cloud.zone)`);
  }

  const apps: AccessAppPlan[] = [];
  const wantsReaders = cloud.modules.includes("receipts") || cloud.modules.includes("dashboard");
  if (wantsReaders) {
    const emails = [...new Set((cloud.tenants ?? []).flatMap((t) => t.readers.emails ?? []))].sort();
    const domains = [...new Set((cloud.tenants ?? []).flatMap((t) => t.readers.email_domains ?? []))].sort();
    const rule = emails.length || domains.length
      ? `${[domains.length ? `email domain in {${domains.join(", ")}}` : null, emails.length ? `email in {${emails.join(", ")}}` : null].filter((s): s is string => !!s).join(" OR ")} (drawn from cloud.tenants[].readers; widen or narrow it here as you like — it only decides who reaches the app at all)`
      : "pick who should pass the perimeter (an IdP group, an email, an email domain). No cloud.tenants[].readers are configured yet to suggest from";
    apps.push({
      purpose: "reader",
      name: cloud.name,
      domain,
      path: `${base}/*`,
      policy_type: "identity",
      policy: rule,
      after_creating: "copy this app's AUD tag into cloud.access.aud, then run piquette cloud deploy so the Worker picks it up",
    });
  }
  if (cloud.modules.includes("ingest")) {
    apps.push({
      purpose: "ingest",
      name: `${cloud.name}-ingest`,
      domain,
      path: `${base}/ingest*`,
      policy_type: "service_auth",
      policy: "Any valid Service Token (the real gate is the factory_credentials row piquette cloud provision-factory writes; a valid but unmapped token still gets 403)",
      after_creating: "copy this app's AUD tag into cloud.access.aud too — it is a list, and the Worker accepts a token valid for any AUD on it — then run piquette cloud deploy",
    });
  }
  if (!apps.length) warnings.push("no module in cloud.modules needs an Access application yet (none of receipts, dashboard, ingest is enabled)");
  return { apps, warnings };
}

export interface AccessPlanOptions {
  out: (line: string) => void;
  json?: boolean;
  origins?: ConfigOrigins;
}

export function accessPlan(cfg: SFConfig, options: AccessPlanOptions): number {
  const cloud = cfg.cloud;
  if (!cloud) {
    options.out("no cloud: block in any config layer");
    return 2;
  }
  const plan = computeAccessPlan(cloud);
  // Folded into the plan's own warnings (not printed out-of-band) so --json stays one clean JSON value.
  if (options.origins?.cloud === "repo") {
    plan.warnings.unshift(`cloud block from ${options.origins.cloudPath ?? "the repo"} (repo layer): this plan reads it as-is, but a cloned repo could name any host or reader list — move it to your machine layer before you act on it unless you trust this repo`);
  }
  if (options.json) {
    options.out(JSON.stringify(plan, null, 2));
    return 0;
  }
  for (const w of plan.warnings) options.out(`warning: ${w}`);
  for (const app of plan.apps) {
    options.out("");
    options.out(`${app.purpose === "reader" ? "Reader" : "Ingest"} application — ${app.name}`);
    options.out(`  type:   self-hosted application`);
    options.out(`  domain: ${app.domain}`);
    options.out(`  path:   ${app.path}`);
    options.out(`  policy: ${app.policy_type === "identity" ? "Allow (identity-based)" : "Service Auth"} — ${app.policy}`);
    options.out(`  then:   ${app.after_creating}`);
  }
  if (plan.apps.length) {
    options.out("");
    options.out("Nothing was created: this only prints a plan. Create these in Zero Trust > Access > Applications (or your own IaC) — the org owns this perimeter, piquette never provisions it. See docs/cloud.md.");
  }
  return 0;
}
