/**
 * `spf sync [--dry-run] [--out <file.ndjson>] [--level summary|trace|full] [--follow]`
 * — push this factory's trace to the hosted hub (#135, design doc
 * docs/design/hosted-dashboard-sync.md). Out of band: it reads the trace db
 * (local sqlite or D1) and never touches a run.
 *
 * Exit codes: 0 pushed / nothing to do / another sync holds the lock,
 * 1 usage or config error, 2 push failed (state untouched, safe to retry),
 * 3 the hub rejected this client's schema (upgrade spf).
 */
import { resolveSyncConfig, type SyncConfig } from "../../core/data_types.ts";
import { describeEndpoint, followSync, runSyncPass, type SyncPassReport } from "../../core/sync/client.ts";
import { SYNC_LEVELS, type SyncLevel } from "../../core/sync/contract.ts";
import { parseCli } from "../../core/utils.ts";
import { resolveTrace } from "./trace.ts";

const USAGE = "usage: spf sync [--dry-run] [--out <file.ndjson>] [--level summary|trace|full] [--follow] [--cwd <dir>] [--config <path>]";

function printReport(report: SyncPassReport, dryRun: boolean, sync: SyncConfig): void {
  for (const d of report.detail) {
    console.log(`  ${d.adw_id}: ${d.snapshot ? "snapshot, " : ""}${d.events} event(s), ${d.gates} gate result(s)`);
  }
  if (report.status === "ok" || (dryRun && report.detail.length > 0)) {
    const verb = dryRun ? "dry run — would push" : "pushed";
    console.log(
      `sync: ${verb} ${report.sessions} session(s): ${report.snapshots} snapshot(s), ${report.events} event(s), ${report.gates} gate result(s) in ${report.batches} batch(es), ${report.bytes} bytes` +
        (dryRun ? "" : ` -> ${describeEndpoint(sync)}`),
    );
  } else if (report.status === "nothing") {
    console.log(dryRun ? "sync: dry run — nothing new to push" : "sync: up to date");
  }
  if (report.error) console.error(`sync: ${report.status}: ${report.error}`);
}

function exitCode(report: SyncPassReport): number {
  if (report.status === "failed") return 2;
  if (report.status === "rejected") return 3;
  return 0;
}

export async function syncCommand(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseCli(argv, ["cwd", "config", "out", "level"], ["dry-run", "follow"]);
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }
  const { options, flags, positionals } = parsed;
  if (positionals.length > 0) {
    console.error(USAGE);
    return 1;
  }
  const dryRun = Boolean(flags["dry-run"]);
  if (options["out"] !== undefined && !dryRun) {
    console.error("--out only applies to --dry-run (it writes the batches that WOULD be sent)");
    return 1;
  }
  if (flags["follow"] && dryRun) {
    console.error("--follow cannot be combined with --dry-run");
    return 1;
  }

  const { dataPaths, anchor, cfg, origins } = resolveTrace(options);
  if (!cfg.sync && !dryRun) {
    console.error("sync is not configured: add a `sync:` block (endpoint, level) to .spf/spf.config.yaml — see docs/sync.md. `spf sync --dry-run` works without one.");
    return 1;
  }
  const sync = resolveSyncConfig(cfg, origins);

  let level: SyncLevel = sync.level;
  if (options["level"] !== undefined) {
    const asked = options["level"] as SyncLevel;
    if (!SYNC_LEVELS.includes(asked)) {
      console.error(`--level must be one of ${SYNC_LEVELS.join(", ")}`);
      return 1;
    }
    if (SYNC_LEVELS.indexOf(asked) > SYNC_LEVELS.indexOf(sync.level)) {
      console.error(`--level ${asked} is above the configured sync.level (${sync.level}): raise sync.level in config to opt in`);
      return 1;
    }
    level = asked;
  }

  const base = { cfg, origins, anchor, dataPaths, level, dryRun, out: options["out"] };
  if (flags["follow"]) {
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`sync: following ${describeEndpoint(sync)} every ${sync.interval_ms}ms at level ${level} (Ctrl-C to stop)`);
    try {
      const last = await followSync({ ...base, signal: controller.signal }, (r) => {
        if (r.status !== "nothing" && r.status !== "locked") printReport(r, false, sync);
      });
      return last.status === "rejected" ? 3 : 0;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }

  const report = await runSyncPass(base);
  printReport(report, dryRun, sync);
  return exitCode(report);
}
