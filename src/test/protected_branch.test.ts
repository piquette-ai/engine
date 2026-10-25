import "./hermetic_git.ts";

/**
 * #97: a commit phase fails closed when HEAD is on a `git.protected_branches`
 * branch. Real repos and real worktrees (the guard's whole job is reading git's
 * answer), a fake `Run` only for the trace and the config.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { classifyBranch, makeGit, ProtectedBranchError } from "../core/git_helper.ts";
import { loopCommand } from "../cli/commands/loop.ts";
import { commitEnvelope, startRun } from "../chains/steps.ts";
import { GitConfigSchema } from "../core/data_types.ts";
import type { Run } from "../core/runner.ts";
import type { PhaseHandle } from "../core/runner.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-pb-"));
  sh(dir, "init", "-b", "main");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-m", "init");
  return dir;
}

function runFor(dir: string, opts: { allow?: boolean; protectedBranches?: string[] } = {}): { run: Run; logs: Record<string, unknown>[] } {
  const logs: Record<string, unknown>[] = [];
  const run = {
    adw_id: "abcd1234",
    cfg: { watch: { base_branch: "main" }, git: { protected_branches: opts.protectedBranches ?? ["main", "master"] } },
    git: makeGit(dir),
    allow_protected_branch: opts.allow === true,
  } as unknown as Run;
  return { run, logs };
}

function phFor(logs: Record<string, unknown>[]): PhaseHandle {
  return { log: async (entry: Record<string, unknown>) => void logs.push(entry) } as unknown as PhaseHandle;
}

const envelope = { status: "success" as const, summary: "did it", artifacts: [] as string[], notes_for_next_agent: "", commit_message: "change" };

function dirty(dir: string): void {
  writeFileSync(path.join(dir, "b.txt"), "two\n");
}

test("config: git.protected_branches defaults to [main, master]", () => {
  assert.deepEqual(v.parse(GitConfigSchema, {}).protected_branches, ["main", "master"]);
});

test("classifyBranch: protected, unprotected and detached", () => {
  assert.deepEqual(classifyBranch("main", ["main"]), { state: "protected", branch: "main" });
  assert.deepEqual(classifyBranch("feat/x", ["main"]), { state: "ok", branch: "feat/x" });
  assert.deepEqual(classifyBranch("HEAD", ["main"]), { state: "detached" });
});

test("commit phase on a protected branch fails closed, commits nothing, and traces the refusal", async () => {
  const dir = makeRepo();
  try {
    dirty(dir);
    const { run, logs } = runFor(dir);
    await assert.rejects(commitEnvelope(run, phFor(logs), envelope), /protected branch "main".*--allow-protected-branch/);
    assert.equal(sh(dir, "rev-list", "--count", "HEAD").trim(), "1");
    assert.equal(logs[0]?.["protected_branch_refused"], true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent that already committed onto the protected branch is refused too (no already-committed short-circuit)", async () => {
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, "c.txt"), "x\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-m", "agent did it");
    const { run, logs } = runFor(dir);
    await assert.rejects(commitEnvelope(run, phFor(logs), envelope), /protected branch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit phase on an unprotected branch commits", async () => {
  const dir = makeRepo();
  try {
    sh(dir, "switch", "-c", "feat/x");
    dirty(dir);
    const { run, logs } = runFor(dir);
    await commitEnvelope(run, phFor(logs), envelope);
    assert.equal(sh(dir, "rev-list", "--count", "HEAD").trim(), "2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a custom list protects its own names; an empty list disables the guard", async () => {
  const dir = makeRepo();
  try {
    sh(dir, "switch", "-c", "release");
    dirty(dir);
    const first = runFor(dir, { protectedBranches: ["release"] });
    await assert.rejects(commitEnvelope(first.run, phFor(first.logs), envelope), /protected branch "release"/);
    const off = runFor(dir, { protectedBranches: [] });
    await commitEnvelope(off.run, phFor(off.logs), envelope);
    assert.equal(sh(dir, "rev-list", "--count", "HEAD").trim(), "2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--allow-protected-branch commits on a protected branch and records the override in the trace", async () => {
  const dir = makeRepo();
  try {
    dirty(dir);
    const { run, logs } = runFor(dir, { allow: true });
    await commitEnvelope(run, phFor(logs), envelope);
    assert.equal(sh(dir, "rev-list", "--count", "HEAD").trim(), "2");
    assert.equal(logs[0]?.["protected_branch_override"], true);
    assert.equal(logs[0]?.["branch"], "main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detached HEAD is allowed (no branch to protect) and noted in the trace", async () => {
  const dir = makeRepo();
  try {
    sh(dir, "checkout", "--detach");
    dirty(dir);
    const { run, logs } = runFor(dir);
    await commitEnvelope(run, phFor(logs), envelope);
    assert.equal(sh(dir, "rev-list", "--count", "HEAD").trim(), "2");
    assert.match(String(logs[0]?.["branch_guard"]), /detached HEAD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree: a linked worktree on a feature branch commits; one on a protected branch is refused", async () => {
  const dir = makeRepo();
  const wtRoot = mkdtempSync(path.join(tmpdir(), "spf-pb-wt-"));
  try {
    const feature = path.join(wtRoot, "feature");
    sh(dir, "worktree", "add", "-b", "spf/issue-1", feature);
    dirty(feature);
    const ok = runFor(feature);
    await commitEnvelope(ok.run, phFor(ok.logs), envelope);
    assert.equal(sh(feature, "rev-list", "--count", "HEAD").trim(), "2");

    // Main stays checked out in the primary repo; a second worktree on a protected name needs its own branch called `master`.
    const protectedWt = path.join(wtRoot, "master");
    sh(dir, "worktree", "add", "-b", "master", protectedWt);
    dirty(protectedWt);
    const blocked = runFor(protectedWt);
    await assert.rejects(commitEnvelope(blocked.run, phFor(blocked.logs), envelope), /protected branch "master"/);
    assert.equal(sh(protectedWt, "rev-list", "--count", "HEAD").trim(), "1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(wtRoot, { recursive: true, force: true });
  }
});

test("the refusal is a typed ProtectedBranchError carrying the branch", async () => {
  const dir = makeRepo();
  try {
    dirty(dir);
    const { run, logs } = runFor(dir);
    await assert.rejects(commitEnvelope(run, phFor(logs), envelope), (e: unknown) => e instanceof ProtectedBranchError && e.branch === "main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unborn HEAD: currentBranch names the branch, so the guard classifies a first commit instead of throwing a git error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-pb-unborn-"));
  try {
    sh(dir, "init", "-b", "main");
    sh(dir, "config", "user.email", "t@example.com");
    sh(dir, "config", "user.name", "t");
    assert.equal(makeGit(dir).currentBranch(), "main");
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    const { run, logs } = runFor(dir);
    await assert.rejects(commitEnvelope(run, phFor(logs), envelope), ProtectedBranchError);
    sh(dir, "switch", "-c", "feat/x");
    assert.equal(makeGit(dir).currentBranch(), "feat/x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wiring: startRun copies ctx.allow_protected_branch onto the run (default is guarded)", async () => {
  const dir = makeRepo();
  try {
    const configPath = path.join(dir, "spf.config.yaml");
    writeFileSync(configPath, "watch:\n  repo: acme/widgets\n");
    const base = { prompt: "x", config_paths: [configPath], cwd: dir, chain_name: "simple-sdlc", unattended: true };
    const guarded = await startRun({ ...base, adw_id: "adw_pb_default" }, [], []);
    const allowed = await startRun({ ...base, adw_id: "adw_pb_allow", allow_protected_branch: true }, [], []);
    try {
      assert.equal(guarded.allow_protected_branch, false);
      assert.equal(allowed.allow_protected_branch, true);
    } finally {
      await guarded.tracer.db.close();
      await allowed.tracer.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spf loop on a protected branch refuses up front, before any ledger or agent run; the flag lifts it", async () => {
  const dir = makeRepo();
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const argv = ["simple-sdlc", "goal", "--until-suite", "nosuchsuite", "--max", "2", "--cwd", dir];
    assert.equal(await loopCommand(argv), 1);
    assert.match(errors.join("\n"), /protected branch "main".*--allow-protected-branch/);
    // With the override the guard steps aside; the unconfigured suite is then what stops it (still before any spend).
    errors.length = 0;
    assert.equal(await loopCommand([...argv, "--allow-protected-branch"]), 1);
    assert.doesNotMatch(errors.join("\n"), /protected branch/);
  } finally {
    console.error = realError;
    rmSync(dir, { recursive: true, force: true });
  }
});
