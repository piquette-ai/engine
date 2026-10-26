/**
 * `piquette decisions calibrate` (#151) — a read-only report that joins every
 * recorded decision to an outcome piquette can OBSERVE in its own trace db and
 * answers, per (kind, backend, provider, model): how often did the model
 * agree with the fallback, how reliable was its confidence, and which
 * threshold would have reached a target precision.
 *
 * It never calls a model, never writes config, never writes a trace row. A
 * kind with no observable outcome is reported as "no outcome signal". All
 * of the logic is in `core/decision_calibration.ts` (pure) and its reader,
 * `core/decision_calibration_db.ts`; this file is argv, I/O and printing.
 * See docs/decisions.md, "Calibrating thresholds".
 */
import { parseCli } from "../../core/utils.ts";
import {
  buildCalibrationReport,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_TARGET_PRECISION,
  formatCalibrationReport,
  OUTCOME_RULES,
} from "../../core/decision_calibration.ts";
import { DECISION_KINDS } from "../../core/decision_kinds.ts";
import { openTraceIfExists } from "./trace.ts";

const KNOWN_OPTIONS = ["config", "cwd", "kind", "target-precision", "min-samples", "since"];
const KNOWN_FLAGS = ["json"];

export function usage(): string {
  return "usage: piquette decisions calibrate [--kind <kind>] [--target-precision 0.9] [--min-samples 30] [--since <iso-date>] [--json] [--config <path>] [--cwd <dir>]";
}

export async function decisionsCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "calibrate") {
    console.error(sub === undefined ? usage() : `unknown decisions subcommand: ${sub}\n${usage()}`);
    return 1;
  }
  return calibrateCommand(rest);
}

export async function calibrateCommand(argv: string[]): Promise<number> {
  const { positionals, options, flags } = parseCli(argv, KNOWN_OPTIONS, KNOWN_FLAGS);
  if (positionals.length > 0) {
    console.error(usage());
    return 1;
  }
  const target = options["target-precision"] !== undefined ? Number(options["target-precision"]) : DEFAULT_TARGET_PRECISION;
  if (!Number.isFinite(target) || target <= 0 || target > 1) {
    console.error(`--target-precision must be a number in (0, 1], got ${JSON.stringify(options["target-precision"])}`);
    return 1;
  }
  const minSamples = options["min-samples"] !== undefined ? Number(options["min-samples"]) : DEFAULT_MIN_SAMPLES;
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    console.error(`--min-samples must be a positive integer, got ${JSON.stringify(options["min-samples"])}`);
    return 1;
  }
  if (options["since"] !== undefined && Number.isNaN(Date.parse(options["since"]))) {
    console.error(`--since must be an ISO date or timestamp, got ${JSON.stringify(options["since"])}`);
    return 1;
  }

  const { db } = await openTraceIfExists(options);
  try {
    const rows = db
      ? await db.allRecordedDecisions({
          ...(options["kind"] !== undefined ? { kind: options["kind"] } : {}),
          ...(options["since"] !== undefined ? { since: options["since"] } : {}),
        })
      : [];
    const kind = options["kind"];
    if (kind !== undefined && rows.length === 0) {
      // A typo must not read as "decisions are off": name the kinds that exist. A kind that is
      // registered (or that rows exist for) just has nothing recorded.
      if (!(kind in DECISION_KINDS)) {
        console.error(`unknown decision kind ${JSON.stringify(kind)} (and no recorded rows for it); known kinds: ${Object.keys(DECISION_KINDS).join(", ")}`);
        return 1;
      }
      if (!flags["json"]) {
        console.log(`no recorded decisions for kind ${kind}${options["since"] !== undefined ? ` since ${options["since"]}` : ""} (a kind appears once it has run in shadow or act mode).`);
        return 0;
      }
    }
    // Runs that recorded a decision whose rule needs per-phase verdicts (loop rounds).
    const adwIds = [...new Set(rows.map((r) => r.adw_id))];
    const verdictAdwIds = new Set(rows.filter((r) => OUTCOME_RULES[r.decision.kind]?.needs_verdicts).map((r) => r.adw_id));
    const facts = db && rows.length > 0 ? await db.runFacts(adwIds, verdictAdwIds) : new Map();
    const report = buildCalibrationReport(rows, facts, { target_precision: target, min_samples: minSamples });
    console.log(flags["json"] ? JSON.stringify(report, null, 2) : formatCalibrationReport(report));
    return 0;
  } finally {
    await db?.close();
  }
}
