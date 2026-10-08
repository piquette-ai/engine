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
import { createRunWorktree, findRepoRoot, makeGit } from "../core/git_helper.ts";

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
