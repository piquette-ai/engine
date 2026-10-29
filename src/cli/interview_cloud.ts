/**
 * `piquette cloud init`'s interview — the machine-layer `cloud:`/`sync:` block,
 * asked over the same `Asker` seam `cli/interview.ts` uses for the repo-layer
 * interview (driven by a scripted fake in tests, a real TTY asker in
 * `cloud_init.ts`). Pure Q&A: it returns `CloudInitAnswers` and never touches
 * fs or the network — `cloud/init.ts` turns the answers into config,
 * `cli/commands/cloud_init.ts` writes it.
 */
import type { Asker } from "./ask.ts";
import { TEAM_DOMAIN } from "../cloud/access_config.ts";
import { CLOUD_MODULES, type CloudInitAnswers } from "../cloud/init.ts";

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/; // mirrors data_types.ts's bareHost — see validateMerged for the real gate
const D1_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const TENANT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const splitList = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const MODULE_LABEL: Record<(typeof CLOUD_MODULES)[number], string> = {
  receipts: "receipts (the /r/<run_id> viewer)",
  ingest: "ingest (the hosted side of piquette sync)",
  dashboard: "dashboard (the hosted trace UI, multi-factory)",
};

export async function runCloudInitInterview(asker: Asker): Promise<CloudInitAnswers> {
  asker.heading("piquette cloud — machine-layer setup");
  asker.note("This writes cloud:/sync: into the MACHINE layer (shared by every repo on this box), never a repo's own .piquette/.");

  const name = await asker.text("Worker name", { default: "piquette", validate: (val) => (NAME_RE.test(val) ? null : "lowercase letters, digits and hyphens only") });

  const useRoute = await asker.confirm("Mount via a Workers route on an existing zone, instead of a custom hostname?", false);
  let hostname: string | undefined;
  let route: string | undefined;
  let zone: string | undefined;
  let basePath: string | undefined;
  if (useRoute) {
    route = await asker.text("Workers route (e.g. example.com/piquette*)", { validate: (val) => (val ? null : "required") });
    zone = await asker.text("Zone (e.g. example.com)", { validate: (val) => (val ? null : "required") });
  } else {
    hostname = await asker.text("Hostname (a domain on a zone in your Cloudflare account)", {
      validate: (val) => (HOST_RE.test(val.replace(/^https:\/\//, "").replace(/\/+$/, "")) ? null : "must be a bare host name, e.g. piquette.example.com"),
    });
    const basePathRaw = await asker.text("Mount under a path? (blank for the root)", { default: "" });
    basePath = basePathRaw || undefined;
  }

  const teamDomain = await asker.text("Cloudflare Access team domain", {
    validate: (val) => (TEAM_DOMAIN.test(val.replace(/^https:\/\//, "").replace(/\/+$/, "")) ? null : "must be <team>.cloudflareaccess.com"),
  });

  asker.note("Modules —");
  for (const m of CLOUD_MODULES) asker.note(`  ${MODULE_LABEL[m]}`);
  const modules: CloudInitAnswers["modules"] = [];
  for (const m of CLOUD_MODULES) {
    if (await asker.confirm(`Enable ${m}?`, true)) modules.push(m);
  }

  const wantsD1 = modules.includes("ingest") || modules.includes("dashboard");
  const bucket = modules.includes("receipts")
    ? await asker.text("R2 bucket name", { default: "piquette-receipts", validate: (val) => (BUCKET_RE.test(val) ? null : "lowercase, 3-63 chars, letters/digits/hyphens") })
    : undefined;
  const d1 = wantsD1 ? await asker.text("D1 database name", { default: "piquette-hub", validate: (val) => (D1_RE.test(val) ? null : "lowercase, letters/digits/hyphens") }) : undefined;

  let tenant: string | undefined;
  let readerEmails: string[] = [];
  let readerDomains: string[] = [];
  if (modules.includes("dashboard")) {
    tenant = await asker.text("Tenant id", { default: "default", validate: (val) => (TENANT_RE.test(val) ? null : "lowercase [a-z0-9_-]") });
    readerDomains = splitList(await asker.text("Reader email domain(s), comma-separated (who may open the dashboard)", { default: "" }));
    readerEmails = splitList(await asker.text("Specific reader email(s), comma-separated (optional, in addition to any domain above)", { default: "" }));
  }

  const sync = wantsD1 ? await asker.confirm("Turn on piquette sync for every repo on this machine (sync: {})?", true) : false;

  return { name, hostname, route, zone, basePath, teamDomain, modules, bucket, d1, tenant, readerEmails, readerDomains, sync };
}
