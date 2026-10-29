/**
 * `piquette cloud init | deploy [--dry-run] | status [--json] | access-plan [--json]` (#214):
 * the one Cloudflare app an org deploys into its own account. Config comes from the
 * layered piquette.config.yaml (built-in -> machine -> repo); secrets only from the
 * environment. None of these commands ever run inside `piquette watch`.
 *
 * Exit codes: 0 ok, 1 error or a failed check, 2 no `cloud:` block.
 */
import { accessPlan } from "../../cloud/access_plan.ts";
import { CloudDeployError, deployCloud } from "../../cloud/deploy.ts";
import { provisionFactory } from "../../cloud/provision.ts";
import { cloudStatus } from "../../cloud/status.ts";
import * as agents from "../../core/agents.ts";
import { configOrigins } from "../../core/config_origins.ts";
import * as paths from "../../core/paths.ts";
import { adoptableLegacyDir, loadOrCreateFactoryId } from "../../core/sync/identity.ts";
import { parseCli } from "../../core/utils.ts";
import { cloudInitCommand } from "./cloud_init.ts";

const USAGE = "usage: piquette cloud init [--yes] [--force] [--hostname <h>] [--team-domain <d>] [--modules <csv>] ... (interactive without flags on a TTY)\n       piquette cloud deploy [--dry-run] [--allow-repo-cloud] [--cwd <dir>] [--config <path>]\n       piquette cloud status [--json] [--allow-repo-cloud] [--cwd <dir>] [--config <path>]\n       piquette cloud provision-factory --name <n> [--tenant <t>] [--factory-id <uuid>|this] [--client-id <id>] [--allow-repo-cloud] [--cwd <dir>] [--config <path>]\n       piquette cloud access-plan [--json] [--cwd <dir>] [--config <path>]";

export async function cloudCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  // `init` has no `cloud:` block to require yet — that is the whole point of running it — so it
  // bypasses the shared config-loading gate below entirely and owns its own argv parsing.
  if (sub === "init") return cloudInitCommand(rest);
  if (sub !== "deploy" && sub !== "status" && sub !== "provision-factory" && sub !== "access-plan") {
    console.error(USAGE);
    return 1;
  }
  let parsed;
  try {
    parsed = parseCli(
      rest,
      sub === "provision-factory" ? ["cwd", "config", "tenant", "name", "factory-id", "client-id"] : ["cwd", "config"],
      sub === "deploy" ? ["dry-run", "allow-repo-cloud"] : sub === "status" ? ["json", "allow-repo-cloud"] : sub === "access-plan" ? ["json"] : ["allow-repo-cloud"],
    );
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }
  if (parsed.positionals.length > 0) {
    console.error(USAGE);
    return 1;
  }
  const anchor = paths.resolveAnchor(parsed.options["cwd"]);
  const resolution = paths.resolveConfigPaths(anchor, parsed.options["config"]);
  const cfg = agents.loadConfig(resolution.paths);
  const out = (line: string): void => console.log(line);
  if (!cfg.cloud) {
    console.error("no cloud: block in any config layer. Add one to your machine-layer piquette.config.yaml (see docs/cloud.md).");
    return 2;
  }
  if (sub === "provision-factory") {
    const name = parsed.options["name"];
    if (!name) {
      console.error(`--name is required\n${USAGE}`);
      return 1;
    }
    const t = parsed.options["tenant"];
    // `--factory-id this` pins to this machine's shared factory id (minted if it does not exist yet).
    const fRaw = parsed.options["factory-id"];
    const f = fRaw === "this" ? loadOrCreateFactoryId(adoptableLegacyDir(anchor.repo_root, paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db).data_dir)) : fRaw;
    const c = parsed.options["client-id"];
    return provisionFactory(cfg, {
      name,
      ...(t ? { tenant: t } : {}),
      ...(f ? { factoryId: f } : {}),
      ...(c ? { clientId: c } : {}),
      env: process.env,
      out,
      err: (line) => console.error(line),
      origins: configOrigins(resolution),
      allowRepoCloud: Boolean(parsed.flags["allow-repo-cloud"]),
    });
  }
  if (sub === "status") return cloudStatus(cfg, { env: process.env, out, json: Boolean(parsed.flags["json"]), origins: configOrigins(resolution), allowRepoCloud: Boolean(parsed.flags["allow-repo-cloud"]) });
  if (sub === "access-plan") return accessPlan(cfg, { out, json: Boolean(parsed.flags["json"]), origins: configOrigins(resolution) });
  try {
    return await deployCloud(cfg, configOrigins(resolution), { env: process.env, out, dryRun: Boolean(parsed.flags["dry-run"]), allowRepoCloud: Boolean(parsed.flags["allow-repo-cloud"]) });
  } catch (error) {
    if (error instanceof CloudDeployError) {
      console.error(`cloud deploy: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
