/**
 * `cli/commands/loop.ts`'s `billableTokensFor` — the readback rule that
 * decides what `--max-tokens` (`overCumulativeBudget`, `core/loop.ts`)
 * actually compares against for one ledger row: BILLABLE tokens, the same
 * metric `defaults.max_run_tokens` checks per-call inside one chain run —
 * never the display total (`total_tokens`, cache reads included).
 *
 * Unit-tested directly against the exact function the readback calls,
 * rather than through a real chain run — same "no gap between what is
 * proven here and what runs" reasoning `budget.test.ts` uses for
 * `assertRunBudget`.
 */

import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { billableTokensFor, loopBaselineTree } from "../cli/commands/loop.js";
import { commitEnvelope, startRun } from "../chains/steps.js";
import { makeGit } from "../core/git_helper.js";
import type { PhaseHandle, Run } from "../core/runner.js";

test("billableTokensFor: a real run reads billable_tokens, not the display total", () => {
  assert.equal(billableTokensFor({ billable_tokens: 150, total_tokens: 1_000 }), 150);
});

test("billableTokensFor: a row that predates billable tracking (billable_tokens backfilled to 0) falls back to total_tokens", () => {
  assert.equal(billableTokensFor({ billable_tokens: 0, total_tokens: 1_000 }), 1_000);
});

test("billableTokensFor: a db that has never run the billable_tokens migration at all (billable_tokens is null) falls back to total_tokens too", () => {
  assert.equal(billableTokensFor({ billable_tokens: null, total_tokens: 1_000 }), 1_000);
});

test("billableTokensFor: no session row (readback failed, or the iteration never wrote one) is 0", () => {
  assert.equal(billableTokensFor(null), 0);
  assert.equal(billableTokensFor(undefined), 0);
});

test("billableTokensFor: a genuinely free iteration (both 0) is 0, not a crash", () => {
  assert.equal(billableTokensFor({ billable_tokens: 0, total_tokens: 0 }), 0);
});

// ── explicit staging across iterations ───────────────────────────────────

/** A real repo on a `work` branch: `agent.ts` committed clean, `human.ts` carrying a human's uncommitted edit. */
function loopRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-loop-staging-"));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  sh("init", "-b", "main");
  sh("config", "user.email", "t@example.com");
  sh("config", "user.name", "t");
  writeFileSync(path.join(dir, "agent.ts"), "zero\n");
  writeFileSync(path.join(dir, "human.ts"), "mine\n");
  sh("add", "-A");
  sh("commit", "-m", "init");
  sh("switch", "-q", "-c", "work"); // commit phases refuse protected branches (#97)
  writeFileSync(path.join(dir, "human.ts"), "mine, edited\n");
  return dir;
}

test("loopBaselineTree: iteration 2 shares the loop's first baseline, so it can commit a file an unaccepted iteration 1 left dirty", async () => {
  const dir = loopRepo();
  const dataDir = mkdtempSync(path.join(tmpdir(), "spf-loop-data-"));
  try {
    const repo = { repo_root: dir, cfg: {} as never };
    const first = loopBaselineTree(dataDir, "goal1", repo);
    assert.deepEqual(Object.keys(first), ["human.ts"]);
    // Iteration 1 went red: nothing committed, its edit left in the tree.
    writeFileSync(path.join(dir, "agent.ts"), "attempt 1\n");
    // Iteration 2 (a fresh adw_id) gets the LOOP's baseline, not a new one
    // that would claim iteration 1's leftovers as the human's.
    const second = loopBaselineTree(dataDir, "goal1", repo);
    assert.deepEqual(second, first);
    writeFileSync(path.join(dir, "agent.ts"), "attempt 2\n");
    const run = { adw_id: "abcd1234", cfg: { watch: { base_branch: "main" }, git: { protected_branches: ["main", "master"] } }, repo_root: dir, git: makeGit(dir), baseline_tree: second } as unknown as Run;
    const ph = { log: async () => {} } as unknown as PhaseHandle;
    await commitEnvelope(run, ph, { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "", commit_message: "iteration 2" });
    const out = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trimEnd();
    assert.equal(out("show", "--name-only", "--format=", "HEAD"), "agent.ts");
    assert.equal(out("status", "--porcelain"), " M human.ts", "the human's own edit is still theirs, uncommitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("loopBaselineTree: a later invocation drops a path the human committed since, so the goal is not wedged on it", async () => {
  const dir = loopRepo();
  const dataDir = mkdtempSync(path.join(tmpdir(), "spf-loop-data-"));
  try {
    const repo = { repo_root: dir, cfg: {} as never };
    assert.deepEqual(Object.keys(loopBaselineTree(dataDir, "goal2", repo)), ["human.ts"]);
    const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    sh("add", "human.ts");
    sh("commit", "-m", "human");
    const second = loopBaselineTree(dataDir, "goal2", repo);
    assert.deepEqual(second, {}, "the committed file is no longer the human's uncommitted work");
    // The loop now edits that very file: it is the loop's, and commits.
    writeFileSync(path.join(dir, "human.ts"), "the loop's edit\n");
    const run = { adw_id: "abcd1234", cfg: { watch: { base_branch: "main" }, git: { protected_branches: ["main", "master"] } }, repo_root: dir, git: makeGit(dir), baseline_tree: second } as unknown as Run;
    await commitEnvelope(run, { log: async () => {} } as unknown as PhaseHandle, { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "", commit_message: "iteration" });
    assert.equal(execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim(), "human.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("startRun records ctx.baseline_tree (a loop's shared baseline) instead of snapshotting the tree again", async () => {
  const dir = loopRepo();
  try {
    writeFileSync(path.join(dir, "agent.ts"), "a previous iteration's leftovers\n");
    const configPath = path.join(dir, "spf.config.yaml");
    writeFileSync(configPath, "");
    const pinned = { "human.ts": "pinned" };
    const run = await startRun(
      { prompt: "p", config_paths: [configPath], adw_id: "adw_loop_baseline", cwd: dir, chain_name: "build", unattended: true, baseline_tree: pinned },
      [],
      [],
    );
    assert.deepEqual(run.baseline_tree, pinned);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
