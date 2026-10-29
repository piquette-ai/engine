/**
 * `piquette cloud init` (#214): write the cloud:/sync: block into the
 * MACHINE-layer config (never the repo's own `.piquette/`), then print the
 * Access applications it implies — the same `piquette cloud access-plan`
 * output, run automatically right after, so "zero to here's what to create
 * in Cloudflare" is one command. An interview on a TTY (`--yes` or piped
 * input skip straight to flags), mirroring `piquette init`'s own interactive
 * / non-interactive split.
 *
 * Exit codes: 0 ok (including "left alone, nothing to do"), 1 bad input or
 * the generated config fails to validate, 130 interrupted.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { accessPlan } from "../../cloud/access_plan.ts";
import { buildCloudBlock, CLOUD_MODULES, mergeMachineConfig, validateMerged, type CloudInitAnswers } from "../../cloud/init.ts";
import { machineConfigPath } from "../../core/paths.ts";
import { parseCli } from "../../core/utils.ts";
import { createAsker, inkAvailable, isInteractive, InterviewAborted, type Asker } from "../ask.ts";
import { runCloudInitInterview } from "../interview_cloud.ts";

const USAGE =
  "usage: piquette cloud init [--yes] [--force] [--skip-access-plan] [--config <path>]\n" +
  "       [--name <n>] [--hostname <h> | --route <r> --zone <z>] [--base-path <p>]\n" +
  "       [--team-domain <d>] [--modules <csv of receipts,ingest,dashboard>]\n" +
  "       [--bucket <n>] [--d1 <n>] [--tenant <id>] [--reader-email <csv>] [--reader-domain <csv>]\n" +
  "       [--sync | --no-sync]\n" +
  "       piquette cloud init --add-tenant --tenant <id> [--reader-email <csv>] [--reader-domain <csv>]\n" +
  "       [--force] [--skip-access-plan] [--config <path>]";

const GENERATED_HEADER = `# ~/.piquette/piquette.config.yaml — the cloud: block below was written (or
# last updated) by \`piquette cloud init\`, merged with whatever else was
# already in this file. Run \`piquette cloud access-plan\` any time to see the
# Access applications this implies, \`piquette cloud status\` once deployed,
# and \`piquette doctor\` for the full picture. See docs/cloud.md.
`;

const splitList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export async function cloudInitCommand(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseCli(
      argv,
      ["config", "name", "hostname", "route", "zone", "base-path", "team-domain", "modules", "bucket", "d1", "tenant", "reader-email", "reader-domain"],
      ["yes", "force", "sync", "no-sync", "skip-access-plan", "add-tenant"],
    );
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }
  if (parsed.positionals.length > 0) {
    console.error(USAGE);
    return 1;
  }
  const { options, flags } = parsed;
  const out = (line: string): void => console.log(line);
  const err = (line: string): void => console.error(line);

  const targetPath = options["config"] ? path.resolve(options["config"]) : machineConfigPath(process.env);
  const existing = existsSync(targetPath) ? ((parse(readFileSync(targetPath, "utf-8")) as Record<string, unknown> | null) ?? {}) : {};
  const alreadyConfigured = Boolean(existing["cloud"]);

  if (flags["add-tenant"]) return addTenant(existing, targetPath, options, flags, out, err);

  const interactive = !flags["yes"] && isInteractive();
  let answers: CloudInitAnswers;

  if (interactive) {
    const asker: Asker = inkAvailable() ? (await import("../ui/ink_asker.tsx")).createInkAsker() : createAsker();
    try {
      if (alreadyConfigured && !flags["force"]) {
        const reconfigure = await asker.confirm(`${targetPath} already has a cloud: block — reconfigure it?`, false);
        if (!reconfigure) {
          asker.close();
          out("left the existing config alone");
          return 0;
        }
      }
      answers = await runCloudInitInterview(asker);
      asker.close();
    } catch (error) {
      asker.close();
      if (error instanceof InterviewAborted) {
        out("cloud init interrupted — nothing written");
        return 130;
      }
      throw error;
    }
  } else {
    if (alreadyConfigured && !flags["force"]) {
      out(`${targetPath} already has a cloud: block — leaving it alone (--force to overwrite)`);
      return 0;
    }
    const moduleList = (options["modules"] ?? "receipts,ingest,dashboard").split(",").map((s) => s.trim()).filter(Boolean);
    const badModules = moduleList.filter((m) => !(CLOUD_MODULES as readonly string[]).includes(m));
    if (badModules.length) {
      err(`cloud init: unknown module(s): ${badModules.join(", ")} (valid: ${CLOUD_MODULES.join(", ")})`);
      return 1;
    }
    const modules = moduleList as CloudInitAnswers["modules"];
    if (!options["hostname"] && !options["route"]) {
      err("cloud init: --hostname (or --route and --zone) is required");
      return 1;
    }
    if (options["route"] && !options["zone"]) {
      err("cloud init: --route needs --zone");
      return 1;
    }
    if (!options["team-domain"]) {
      err("cloud init: --team-domain is required");
      return 1;
    }
    const wantsD1 = modules.includes("ingest") || modules.includes("dashboard");
    answers = {
      name: options["name"] ?? "piquette",
      hostname: options["hostname"],
      route: options["route"],
      zone: options["zone"],
      basePath: options["base-path"],
      teamDomain: options["team-domain"],
      modules,
      bucket: modules.includes("receipts") ? (options["bucket"] ?? "piquette-receipts") : undefined,
      d1: wantsD1 ? (options["d1"] ?? "piquette-hub") : undefined,
      tenant: modules.includes("dashboard") ? (options["tenant"] ?? "default") : undefined,
      readerEmails: modules.includes("dashboard") ? splitList(options["reader-email"]) : [],
      readerDomains: modules.includes("dashboard") ? splitList(options["reader-domain"]) : [],
      sync: flags["sync"] ? true : flags["no-sync"] ? false : wantsD1,
    };
  }

  const cloudBlock = buildCloudBlock(answers);
  const merged = mergeMachineConfig(existing, cloudBlock, answers.sync);
  const validated = validateMerged(merged);
  if (!validated.ok) {
    err(`cloud init: the generated config is invalid: ${validated.message}`);
    return 1;
  }

  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, GENERATED_HEADER + stringify(merged));
  out(`wrote ${targetPath}`);

  if (flags["skip-access-plan"]) {
    // access_plan.ts would otherwise say this; say it here so it is never silently missing.
    out("warning: cloud.access.aud is a placeholder — the Worker refuses every request until you replace it with the real AUD(s), then run piquette cloud deploy.");
    out("next: piquette cloud access-plan, to see what to create");
  } else {
    out("");
    accessPlan(validated.cfg, { out });
  }
  return 0;
}

/**
 * `piquette cloud init --add-tenant` — append a new tenant, or (with
 * `--force`) WIDEN an existing one's readers (union, deduped — never a
 * replace: a one-shot `--reader-email` must not silently drop readers an
 * earlier run already granted), in an ALREADY-EXISTING cloud: block.
 * Deliberately a much narrower operation than the full interview above: it
 * never touches hostname/modules/bucket/d1/sync, only `cloud.tenants`, so
 * adding a second, third, ... client/team never means hand-editing the YAML.
 */
function addTenant(
  existing: Record<string, unknown>,
  targetPath: string,
  options: Record<string, string>,
  flags: Record<string, boolean>,
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  const cloud = existing["cloud"] as Record<string, unknown> | undefined;
  if (!cloud) {
    err(`cloud init --add-tenant: no cloud: block yet in ${targetPath} — run piquette cloud init first (without --add-tenant)`);
    return 1;
  }
  const id = options["tenant"];
  if (!id) {
    err("cloud init --add-tenant: --tenant <id> is required");
    return 1;
  }
  const emails = splitList(options["reader-email"]);
  const emailDomains = splitList(options["reader-domain"]);
  if (!emails.length && !emailDomains.length) {
    err("cloud init --add-tenant: --reader-email or --reader-domain is required (who may read this tenant's data)");
    return 1;
  }

  const tenants = Array.isArray(cloud["tenants"]) ? [...(cloud["tenants"] as Record<string, unknown>[])] : [];
  const idx = tenants.findIndex((t) => (t as { id?: unknown } | null)?.id === id);
  if (idx >= 0) {
    if (!flags["force"]) {
      err(`cloud init --add-tenant: tenant "${id}" already exists — pass --force to add these readers to it`);
      return 1;
    }
    // --force WIDENS an existing tenant's readers (union, deduped) rather than replacing them — a one-shot
    // --reader-email must never silently drop readers an earlier run (or a hand-edit) already granted.
    const prior = (tenants[idx] as { readers?: { emails?: string[]; email_domains?: string[] } } | null)?.readers ?? {};
    const mergedEmails = [...new Set([...(prior.emails ?? []), ...emails])];
    const mergedDomains = [...new Set([...(prior.email_domains ?? []), ...emailDomains])];
    tenants[idx] = { id, readers: { ...(mergedDomains.length ? { email_domains: mergedDomains } : {}), ...(mergedEmails.length ? { emails: mergedEmails } : {}) } };
  } else {
    tenants.push({ id, readers: { ...(emailDomains.length ? { email_domains: emailDomains } : {}), ...(emails.length ? { emails } : {}) } });
  }

  const merged = { ...existing, cloud: { ...cloud, tenants } };
  const validated = validateMerged(merged);
  if (!validated.ok) {
    err(`cloud init --add-tenant: the generated config is invalid: ${validated.message}`);
    return 1;
  }

  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, GENERATED_HEADER + stringify(merged));
  out(`wrote ${targetPath}: tenant "${id}" ${idx >= 0 ? "updated" : "added"}`);

  const nextHint = `next: piquette cloud deploy, to write this tenant's reader_grants; then piquette cloud provision-factory --tenant ${id} --name <machine>, for any factory serving it`;
  if (flags["skip-access-plan"]) {
    out(nextHint);
  } else {
    out("");
    // The reader app's suggested policy is drawn from the UNION of every tenant's readers, so this
    // reruns it to show the (now wider) rule — a reminder that the Access app's own policy, a SEPARATE
    // thing from reader_grants, may need widening by hand to actually let this tenant's readers in.
    accessPlan(validated.cfg, { out });
    out(nextHint);
  }
  return 0;
}
