import path from "node:path";
import * as agents from "../../core/agents.ts";
import * as paths from "../../core/paths.ts";
import type { NormalizedObservabilityDb, SFConfig } from "../../core/data_types.ts";
import { configOrigins, trustedUiBrand } from "../../core/config_origins.ts";
import type { Brand } from "../../ui/shared/brand.ts";
import { parseCli } from "../../core/utils.ts";
import { detectRepoSlug } from "../../ui/server/repo.ts";
import { receiptReaderFor } from "../../ui/server/receipt_reader_node.ts";
import { runUi } from "../../ui/server/serve.ts";

type ConfigResolution = ReturnType<typeof paths.resolveConfigPaths>;

/** The trusted `ui.brand` for this resolution (repo-layer URLs dropped with a warning). */
function uiBrandOf(cfg: SFConfig, resolution: ConfigResolution): Brand {
  const trusted = trustedUiBrand(cfg.ui?.brand, configOrigins(resolution).uiBrandTrusted);
  for (const w of trusted.warnings) console.warn(`[spf] ui        ${w}`);
  return trusted.brand;
}

function loadUiBrand(resolution: ConfigResolution): Brand {
  return uiBrandOf(agents.loadConfig(resolution.paths), resolution);
}

export async function uiCommand(argv: string[]): Promise<number> {
  const { options, flags } = parseCli(argv, ["cwd", "config", "db", "port", "host"], ["no-open"]);
  const anchor = paths.resolveAnchor(options["cwd"]);

  let db: NormalizedObservabilityDb;
  let sessionsDir: string | undefined;
  let label: string;
  // The factory's configured repo wins (it is what watch/notify act on); the
  // origin remote is the fallback, and the only source under `--db`.
  let configuredRepo = "";
  // Receipts viewer (#202): the configured store, or the default local one under `--db`.
  let receipts: ReturnType<typeof receiptReaderFor>;
  let brand: Brand = {};
  if (options["db"]) {
    // `--db <path>` always names a local sqlite file — there is no D1
    // equivalent of "point at this one file" from the CLI yet.
    const dbPath = path.resolve(anchor.cwd, options["db"]);
    db = { kind: "sqlite", path: dbPath };
    label = dbPath;
    receipts = receiptReaderFor(undefined, anchor.repo_root);
    // `--db` only names the data file; the look still comes from config, same as without it.
    brand = loadUiBrand(paths.resolveConfigPaths(anchor, options["config"]));
  } else {
    const resolution = paths.resolveConfigPaths(anchor, options["config"]);
    const cfg = agents.loadConfig(resolution.paths);
    brand = uiBrandOf(cfg, resolution);
    const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);
    db = dataPaths.db;
    sessionsDir = dataPaths.sessions_dir;
    label = db.kind === "sqlite" ? db.path : `d1:${db.database_id}`;
    configuredRepo = cfg.watch.repo.trim();
    receipts = receiptReaderFor(cfg, anchor.repo_root);
  }

  try {
    const handle = await runUi({
      db,
      sessionsDir,
      webDir: paths.WEB_DIR,
      project: path.basename(anchor.repo_root) || path.basename(anchor.cwd),
      repo: configuredRepo || detectRepoSlug(anchor.repo_root || anchor.cwd),
      port: options["port"] ? Number.parseInt(options["port"], 10) : undefined,
      host: options["host"],
      open: !flags["no-open"],
      receipts: receipts.reader,
      brand,
    });
    console.log(`[spf] ui        ${handle.url}`);
    console.log(`[spf] db        ${label}`);
    console.log(`[spf] receipts  ${receipts.note}`);
    // runUi() already registers SIGINT/SIGTERM handlers that exit the
    // process; just keep this call from returning until then.
    await new Promise(() => {});
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}
