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

import { evidenceLimits } from "../../core/journey_evidence.ts";
import path from "node:path";
import { loadJourneysFile, type JourneySpec } from "../../core/journeys.ts";
import { proofStore, prove, ProofCannotStart, repoSegment, segmentForRun } from "../../core/prove.ts";
import { AgentBrowserTtydRecorder } from "../../core/recorder.ts";
import { parseCli } from "../../core/utils.ts";
import { loadNonNegotiables } from "../../core/verification.ts";
import { resolveTrace } from "./trace.ts";

export { repoSegment };

const USAGE =
  "usage: spf prove --journeys <file> [--record] [--stage head|base] [--issue <id>] [--run-id <id>] " +
  "[--non-negotiables <file> | --no-non-negotiables] [--cwd <dir>] [--config <path>] [--json]";

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
    if (!flags["no-non-negotiables"]) nonNegotiables = loadNonNegotiables(repoRoot, cfg, options["non-negotiables"]).specs;
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }

  const store = proofStore(cfg, repoRoot);
  const runId = options["run-id"] ?? `prove-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;

  try {
    const { receipt, key } = await prove({
      repoRoot,
      store,
      repo: await segmentForRun(store, repoRoot, runId, cfg),
      runId,
      issue: options["issue"] ?? null,
      stage,
      journeys,
      nonNegotiables,
      recorder: flags["record"] ? new AgentBrowserTtydRecorder() : undefined,
      evidenceLimits: evidenceLimits(cfg.receipts?.evidence),
    });
    const evidenceDropped = (receipt.observations.evidence_dropped ?? []) as { journey: string; file: string; reason: string }[];
    if (flags["json"]) {
      console.log(JSON.stringify({ verdict: receipt.verdict, reason: receipt.reason, next: receipt.next, receipt: key, store: store.location, run_id: receipt.run_id, attempt: receipt.attempt, revision: receipt.revision, coverage: receipt.observations.coverage, evidence_dropped: evidenceDropped, evidence: Object.fromEntries(Object.entries(receipt.evidence).map(([k, v]) => [k, v.key])) }, null, 2));
    } else {
      console.log(`${receipt.verdict}  ${receipt.reason}`);
      for (const line of receipt.next) console.log(`  · ${line}`);
      console.log(`receipt: ${key} (${store.location})`);
      for (const [name, item] of Object.entries(receipt.evidence)) console.log(`${name}: ${item.key}`);
      for (const d of evidenceDropped) console.log(`evidence dropped: ${d.journey}/${d.file} (${d.reason})`);
    }
    return receipt.verdict === "PASS" ? 0 : receipt.verdict === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(error instanceof ProofCannotStart ? error.message : `prove failed: ${(error as Error).message}`);
    return 2;
  }
}
