import "./hermetic_git.ts";

/**
 * `findRepoRoot()`'s contract is "never throws, always returns some root."
 * `isRepoAt()` only proves `git rev-parse --git-dir` succeeds, which is also
 * true inside a bare repo and inside a `.git/` directory itself — neither
 * has a work tree, so the follow-up `--show-toplevel` call fails there even
 * though `isRepoAt()` said yes. Regression coverage for that gap: before the
 * fix, `findRepoRoot()` let that failure propagate as an uncaught throw,
 * which — because `cli/index.ts` calls `paths.resolveAnchor()` outside its
 * top-level try/catch — crashed every command (including `spf --version`)
 * when run from a bare repo or from inside `.git/`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GIT_OUTPUT_TAIL_LINES, GitCommandError, createRunWorktree, findRepoRoot, makeGit } from "../core/git_helper.ts";

test("findRepoRoot falls back to cwd inside a bare repo (no work tree)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-bare-"));
  try {
    execFileSync("git", ["init", "--bare", dir], { stdio: "ignore" });
    const root = findRepoRoot(dir);
    assert.equal(root, path.resolve(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findRepoRoot falls back to cwd inside a repo's .git directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-dotgit-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const gitDir = path.join(dir, ".git");
    const root = findRepoRoot(gitDir);
    assert.equal(root, path.resolve(gitDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Regression coverage for `createRunWorktree`'s two up-front refusals — see
 * its doc comment. Before the fix, a `--adw-id` retry that reused a
 * deterministic name either force-removed a kept winner's uncommitted work
 * with `git worktree remove --force` (silent, exit 0), or hit a raw
 * `fatal: a branch named '...' already exists` out of `git worktree add -b`.
 */
test("createRunWorktree refuses (rather than force-removing) an existing worktree dir with uncommitted changes", () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), "spf-cru-repo-"));
  const worktreesDir = mkdtempSync(path.join(tmpdir(), "spf-cru-wts-"));
  try {
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir, stdio: "ignore" });
    writeFileSync(path.join(repoDir, "a.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

    // Stand-in for a previous fanout attempt's KEPT worktree: a real repo of
    // its own (not created via `git worktree`, which is fine — the guard
    // only ever runs `git status --porcelain`, which works the same either
    // way) with an untracked file, exactly what a winner's uncommitted
    // payload looks like when its chain has no commit step.
    const staleName = "fanout-reuse01-1";
    const stalePath = path.join(worktreesDir, staleName);
    mkdirSync(stalePath);
    execFileSync("git", ["init"], { cwd: stalePath, stdio: "ignore" });
    writeFileSync(path.join(stalePath, "kept-work.txt"), "do not delete me\n");

    assert.throws(
      () => createRunWorktree(repoDir, staleName, { worktreesDir, branch: "spf/fanout/reuse01-1", baseBranch: "main", fetchBase: false }),
      /uncommitted changes/,
    );
    // The refusal must be BEFORE any removal — the file has to survive it.
    assert.ok(existsSync(path.join(stalePath, "kept-work.txt")));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
  }
});

test("createRunWorktree refuses a branch collision with an actionable message instead of a raw git fatal", () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), "spf-cru-branch-"));
  const worktreesDir = mkdtempSync(path.join(tmpdir(), "spf-cru-branch-wts-"));
  try {
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir, stdio: "ignore" });
    writeFileSync(path.join(repoDir, "a.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
    // A leftover branch from a previous invocation, with the worktree itself
    // already cleaned up — exactly the state a killed prior run can leave.
    execFileSync("git", ["branch", "spf/fanout/reuse01-1"], { cwd: repoDir, stdio: "ignore" });

    assert.throws(
      () =>
        createRunWorktree(repoDir, "fanout-reuse01-1", {
          worktreesDir,
          branch: "spf/fanout/reuse01-1",
          baseBranch: "main",
          fetchBase: false,
        }),
      /branch spf\/fanout\/reuse01-1 already exists/,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
  }
});

test("findRepoRoot resolves the toplevel of an ordinary work tree", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-worktree-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const sub = path.join(dir, "nested");
    execFileSync("node", ["-e", `require("fs").mkdirSync(${JSON.stringify(sub)})`]);
    const root = findRepoRoot(sub);
    // git may resolve symlinked tmpdirs (e.g. macOS /tmp -> /private/tmp) —
    // compare against what git itself reports as the raw toplevel is what
    // resolveAnchor ultimately does too, so lean on findRepoRoot from the
    // repo root itself for a stable assertion.
    assert.equal(root, findRepoRoot(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── commitAll(message, paths): explicit staging ──────────────────────────

function gitOut(dir: string, args: string[]): string {
  // trimEnd, not trim: porcelain's leading " M" column is significant.
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trimEnd();
}

test("commitAll with paths leaves an unrelated dirty file unstaged", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-commit-paths-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
    writeFileSync(path.join(dir, "agent.ts"), "one\n");
    writeFileSync(path.join(dir, "gone.ts"), "bye\n");
    writeFileSync(path.join(dir, "human.ts"), "mine\n");
    writeFileSync(path.join(dir, "staged-by-human.ts"), "mine too\n");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });

    // The human's own uncommitted work: one plain edit, one already staged.
    writeFileSync(path.join(dir, "human.ts"), "mine, edited\n");
    writeFileSync(path.join(dir, "staged-by-human.ts"), "mine too, staged\n");
    execFileSync("git", ["add", "staged-by-human.ts"], { cwd: dir, stdio: "ignore" });
    // The run's work: an edit, a deletion, a new file with a glob-looking name.
    writeFileSync(path.join(dir, "agent.ts"), "two\n");
    rmSync(path.join(dir, "gone.ts"));
    writeFileSync(path.join(dir, "new[1].ts"), "fresh\n");

    makeGit(dir).commitAll("agent work", ["agent.ts", "gone.ts", "new[1].ts"]);

    assert.deepEqual(gitOut(dir, ["show", "--name-only", "--format=", "HEAD"]).split("\n").sort(), ["agent.ts", "gone.ts", "new[1].ts"]);
    // Both human files survive exactly as they were: one unstaged, one still staged.
    assert.deepEqual(gitOut(dir, ["status", "--porcelain"]).split("\n").sort(), [" M human.ts", "M  staged-by-human.ts"]);
    // An empty path list never falls back to staging everything.
    assert.throws(() => makeGit(dir).commitAll("nothing", []), /nothing to commit/);
    assert.equal(gitOut(dir, ["log", "--format=%s", "-1"]), "agent work");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A work repo with one commit and a bare "origin" — the smallest real setup `push` can be exercised against. */
function repoWithOrigin(): { dir: string; origin: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "spf-push-"));
  const origin = path.join(root, "origin.git");
  const dir = path.join(root, "work");
  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "a.txt"), "a");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  return { dir, origin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const remoteRefs = (origin: string): string[] => execFileSync("git", ["for-each-ref", "--format=%(refname:short)"], { cwd: origin, encoding: "utf-8" }).split("\n").filter(Boolean);

test("push: plain push sets upstream; remoteBranch pushes branch:remote without touching the local upstream", () => {
  const { dir, origin, cleanup } = repoWithOrigin();
  try {
    const g = makeGit(dir);
    g.push("origin", "main");
    assert.deepEqual(remoteRefs(origin), ["main"]);
    execFileSync("git", ["checkout", "-b", "feat/x"], { cwd: dir, stdio: "ignore" });
    g.push("origin", "feat/x", { remoteBranch: "feat/x-wip" });
    assert.deepEqual(remoteRefs(origin).sort(), ["feat/x-wip", "main"]);
    assert.throws(() => execFileSync("git", ["rev-parse", "--abbrev-ref", "feat/x@{u}"], { cwd: dir, stdio: "pipe" }), "no upstream was set for the renamed push");
  } finally {
    cleanup();
  }
});

test("push: forceWithLease overwrites a diverged -wip ref a previous failure left; a plain push is rejected", () => {
  const { dir, origin, cleanup } = repoWithOrigin();
  try {
    const g = makeGit(dir);
    execFileSync("git", ["checkout", "-b", "feat/y"], { cwd: dir, stdio: "ignore" });
    writeFileSync(path.join(dir, "b.txt"), "first");
    g.commitAll("first attempt");
    g.push("origin", "feat/y", { remoteBranch: "feat/y-wip", forceWithLease: true });
    // The next claim recreates the branch from base: diverged history, same -wip name.
    execFileSync("git", ["checkout", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["branch", "-D", "feat/y"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "feat/y"], { cwd: dir, stdio: "ignore" });
    writeFileSync(path.join(dir, "c.txt"), "second");
    g.commitAll("second attempt");
    assert.throws(() => g.push("origin", "feat/y", { remoteBranch: "feat/y-wip" }), /rejected|failed/);
    g.push("origin", "feat/y", { remoteBranch: "feat/y-wip", forceWithLease: true });
    const tip = execFileSync("git", ["rev-parse", "feat/y-wip"], { cwd: origin, encoding: "utf-8" }).trim();
    assert.equal(tip, execFileSync("git", ["rev-parse", "feat/y"], { cwd: dir, encoding: "utf-8" }).trim());
  } finally {
    cleanup();
  }
});

test("makeGit.push sends the worktree's HEAD to the expected remote branch even when checked out on another branch", () => {
  const root = mkdtempSync(path.join(tmpdir(), "spf-push-"));
  const sh = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  try {
    const remote = path.join(root, "remote.git");
    const work = path.join(root, "work");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    mkdirSync(work);
    sh(["init", "-b", "main"], work);
    sh(["config", "user.email", "t@example.com"], work);
    sh(["config", "user.name", "t"], work);
    sh(["config", "commit.gpgsign", "false"], work);
    writeFileSync(path.join(work, "a.txt"), "a");
    sh(["add", "."], work);
    sh(["commit", "-m", "base"], work);
    sh(["remote", "add", "origin", remote], work);
    const base = sh(["rev-parse", "HEAD"], work);
    sh(["checkout", "-b", "spf-watch/72-x"], work);
    sh(["checkout", "-b", "feat/72-agent-chose-this"], work);
    writeFileSync(path.join(work, "b.txt"), "b");
    sh(["add", "."], work);
    sh(["commit", "-m", "work"], work);
    const head = sh(["rev-parse", "HEAD"], work);

    const git = makeGit(work);
    assert.equal(git.isAncestor(base), true);
    assert.equal(git.isAncestor(head, base), false);
    git.push("origin", "spf-watch/72-x");

    assert.equal(sh(["rev-parse", "refs/heads/spf-watch/72-x"], remote), head);
    git.push("origin", "spf-watch/72-x", { remoteBranch: "spf-watch/72-x-wip", forceWithLease: true });
    assert.equal(sh(["rev-parse", "refs/heads/spf-watch/72-x-wip"], remote), head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A `pre-push` hook that fails the way a project's test hook does: its report
 * on stdout (where git leaves a pre-push hook's stdout), one line on stderr,
 * exit 1. `core.hooksPath` is set in the repo's own config so a global hooks
 * path on the machine running the suite can't swap in a different hook.
 */
function installFailingPrePush(dir: string, stdoutLines: string[]): void {
  const hooks = path.join(dir, ".test-hooks");
  mkdirSync(hooks, { recursive: true });
  const body = stdoutLines.map((l) => `echo '${l}'`).join("\n");
  writeFileSync(path.join(hooks, "pre-push"), `#!/bin/sh\n${body}\necho 'hook: checks failed' >&2\nexit 1\n`, { mode: 0o755 });
  execFileSync("git", ["config", "core.hooksPath", hooks], { cwd: dir });
}

test("push: a pre-push hook rejection carries the hook's stdout AND stderr on the error (#125)", () => {
  const { dir, origin, cleanup } = repoWithOrigin();
  try {
    installFailingPrePush(dir, ["FAIL src/db.test.ts > migrates", "Error: Test timed out in 5000ms."]);
    let caught: unknown;
    try {
      makeGit(dir).push("origin", "main");
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof GitCommandError, "a failed git command throws GitCommandError");
    assert.deepEqual(caught.args.slice(0, 1), ["push"]);
    assert.equal(caught.exitCode, 1);
    assert.match(caught.output, /FAIL src\/db\.test\.ts > migrates/, "the hook's stdout is captured");
    assert.match(caught.output, /Test timed out in 5000ms/);
    assert.match(caught.output, /hook: checks failed/, "and its stderr");
    assert.match(caught.output, /failed to push some refs/, "and git's own line");
    assert.match(caught.message, /^git push origin HEAD:refs\/heads\/main failed: /, "the message keeps its shape");
    assert.equal(caught.headline, "git push origin HEAD:refs/heads/main failed (exit 1)");
    assert.deepEqual(remoteRefs(origin), [], "nothing reached origin");
  } finally {
    cleanup();
  }
});

test("push: a long hook report is cut to its last GIT_OUTPUT_TAIL_LINES lines", () => {
  const { dir, cleanup } = repoWithOrigin();
  try {
    installFailingPrePush(dir, Array.from({ length: 120 }, (_, i) => `line ${i}`));
    let caught: unknown;
    try {
      makeGit(dir).push("origin", "main");
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof GitCommandError);
    const lines = caught.output.split("\n");
    assert.equal(lines.length, GIT_OUTPUT_TAIL_LINES);
    assert.ok(!lines.includes("line 0"), "the head of the report is dropped");
    assert.ok(lines.includes("line 119"), "the end of the report — where the failures are summarized — is kept");
    assert.match(lines.at(-1)!, /failed to push some refs/);
  } finally {
    cleanup();
  }
});

test("branchAt points a new local branch at HEAD without checking it out, and overwrites on repeat", () => {
  const { dir, cleanup } = repoWithOrigin();
  try {
    const g = makeGit(dir);
    const first = g.rev();
    g.branchAt("spf-failed/1-x-abc");
    assert.equal(g.rev("spf-failed/1-x-abc"), first);
    assert.equal(g.currentBranch(), "main", "HEAD stays where it was");
    writeFileSync(path.join(dir, "b.txt"), "b");
    g.commitAll("second");
    g.branchAt("spf-failed/1-x-abc");
    assert.equal(g.rev("spf-failed/1-x-abc"), g.rev());
  } finally {
    cleanup();
  }
});
