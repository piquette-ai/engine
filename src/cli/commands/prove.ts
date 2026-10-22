/**
 * `spf prove` (#159, ticket B / #174): run a journeys file (plus the repo's
 * non-negotiables) against the current revision, optionally record it, and
 * write a receipt to the receipt store. Exit 0 PASS, 1 FAIL, 2 CAN'T TELL —
 * the same contract as beyond-done's `snack prove`.
 *
 * Works without a `receipts:` block (a local store under `.spf/data/receipts`, which `spf init` gitignores),
 * because running a proof by hand is how you try the feature before turning
 * it on for chains.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_NON_NEGOTIABLES_PATH } from "../../core/data_types.ts";
import { loadJourneysFile, type JourneySpec } from "../../core/journeys.ts";
import { prove, ProofCannotStart } from "../../core/prove.ts";
import { AgentBrowserTtydRecorder } from "../../core/recorder.ts";
import { createReceiptStore } from "../../core/receipt_store.ts";
import { parseCli } from "../../core/utils.ts";
import { resolveTrace } from "./trace.ts";

const USAGE =
  "usage: spf prove --journeys <file> [--record] [--stage head|base] [--issue <id>] [--run-id <id>] " +
  "[--non-negotiables <file> | --no-non-negotiables] [--cwd <dir>] [--config <path>] [--json]";

/** A store key segment from a directory name: lowercase, `[a-z0-9._-]`, never empty. */
export function repoSegment(repoRoot: string): string {
  const s = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "");
  return s || "repo";
}

export async function proveCommand(argv: string[]): Promise<number> {
  const { options, flags } = parseCli(argv, ["journeys", "stage", "issue", "run-id", "non-negotiables", "cwd", "config"], ["record", "json", "no-non-negotiables"]);
  if (!options["journeys"]) {
    console.error(USAGE);
    return 2;
  }
  const stage = options["stage"] ?? "head";
  if (stage !== "head" && stage !== "base") {
    console.error(`--stage must be head or base, got ${JSON.stringify(stage)}\n${USAGE}`);
    return 2;
  }

  let journeys: JourneySpec[];
  let nonNegotiables: JourneySpec[] = [];
  const { anchor, cfg } = resolveTrace(options);
  const repoRoot = anchor.repo_root;
  try {
    journeys = loadJourneysFile(path.resolve(anchor.cwd, options["journeys"]));
    if (!flags["no-non-negotiables"]) {
      const configured = options["non-negotiables"] ?? cfg.receipts?.non_negotiables;
      const file = path.resolve(repoRoot, configured ?? DEFAULT_NON_NEGOTIABLES_PATH);
      if (existsSync(file)) nonNegotiables = loadJourneysFile(file, "non_negotiable");
      else if (configured) throw new Error(`non-negotiables file ${file} does not exist (configured explicitly)`);
    }
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }

  const store = createReceiptStore(cfg.receipts?.store ?? { kind: "local", path: ".spf/data/receipts" }, { repoRoot });
  const runId = options["run-id"] ?? `prove-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;

  try {
    const { receipt, key } = await prove({
      repoRoot,
      store,
      repo: repoSegment(repoRoot),
      runId,
      issue: options["issue"] ?? null,
      stage,
      journeys,
      nonNegotiables,
      recorder: flags["record"] ? new AgentBrowserTtydRecorder() : undefined,
    });
    if (flags["json"]) {
      console.log(JSON.stringify({ verdict: receipt.verdict, reason: receipt.reason, next: receipt.next, receipt: key, store: store.location, run_id: receipt.run_id, attempt: receipt.attempt, revision: receipt.revision, coverage: receipt.observations.coverage, evidence: Object.fromEntries(Object.entries(receipt.evidence).map(([k, v]) => [k, v.key])) }, null, 2));
    } else {
      console.log(`${receipt.verdict}  ${receipt.reason}`);
      for (const line of receipt.next) console.log(`  · ${line}`);
      console.log(`receipt: ${key} (${store.location})`);
      for (const [name, item] of Object.entries(receipt.evidence)) console.log(`${name}: ${item.key}`);
    }
    return receipt.verdict === "PASS" ? 0 : receipt.verdict === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(error instanceof ProofCannotStart ? error.message : `prove failed: ${(error as Error).message}`);
    return 2;
  }
}
