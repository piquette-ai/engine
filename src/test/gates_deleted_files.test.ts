import "./hermetic_git.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { diffMatchesClaims } from "../core/gates.ts";
import type { EnvelopeBase, RunContext } from "../core/data_types.ts";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo whose `main` tracks a route group; a feature branch is where the "builder" works. */
function fixture(): { root: string; run: RunContext; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "spf-gates-del-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  mkdirSync(path.join(root, "app/(tabs)"), { recursive: true });
  writeFileSync(path.join(root, "app/(tabs)/a.tsx"), "a\n");
  writeFileSync(path.join(root, "app/(tabs)/b.tsx"), "b\n");
  writeFileSync(path.join(root, "keep.ts"), "k\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "feature");
  const run = { repo_root: root, cfg: { watch: { base_branch: "main" } } } as unknown as RunContext;
  return { root, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const envelope = (changed_files: string[]) => ({ changed_files, artifacts: [] }) as unknown as EnvelopeBase;

test("a file the builder DELETED (uncommitted) passes, noting the base it was tracked at", () => {
  const f = fixture();
  try {
    rmSync(path.join(f.root, "app/(tabs)/a.tsx"));
    const report = diffMatchesClaims(envelope(["app/(tabs)/a.tsx", "keep.ts"]), f.run);
    assert.equal(report.passed, true, report.violations.join("\n"));
    assert.match(report.checks[0].note, /^deleted \(tracked at base [0-9a-f]{7,}\)$/);
  } finally {
    f.cleanup();
  }
});

test("a file the builder deleted AND committed passes", () => {
  const f = fixture();
  try {
    git(f.root, "rm", "-q", "-r", "app");
    git(f.root, "commit", "-q", "-m", "drop route group");
    const report = diffMatchesClaims(envelope(["app/(tabs)/a.tsx", "app/(tabs)/b.tsx"]), f.run);
    assert.equal(report.passed, true, report.violations.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("a nonexistent path that was never tracked still fails", () => {
  const f = fixture();
  try {
    const report = diffMatchesClaims(envelope(["never/existed.ts"]), f.run);
    assert.deepEqual(report.violations, ["never/existed.ts: claimed changed file does not exist"]);
  } finally {
    f.cleanup();
  }
});

test("a path added and then removed within the run (never tracked at base) still fails", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.root, "tmp.ts"), "x\n");
    git(f.root, "add", "tmp.ts");
    git(f.root, "commit", "-q", "-m", "add");
    git(f.root, "rm", "-q", "tmp.ts");
    git(f.root, "commit", "-q", "-m", "rm");
    assert.equal(diffMatchesClaims(envelope(["tmp.ts"]), f.run).passed, false);
  } finally {
    f.cleanup();
  }
});

test("a directory claimed as deleted is not a tracked file and fails", () => {
  const f = fixture();
  try {
    rmSync(path.join(f.root, "app"), { recursive: true });
    assert.equal(diffMatchesClaims(envelope(["app/(tabs)"]), f.run).passed, false);
  } finally {
    f.cleanup();
  }
});

test("prose with whitespace keeps the summary-sentence hint, even if it names a deleted file", () => {
  const f = fixture();
  try {
    rmSync(path.join(f.root, "keep.ts"));
    const report = diffMatchesClaims(envelope(["3 files removed (keep.ts, ...)"]), f.run);
    assert.equal(report.passed, false);
    assert.match(report.violations[0], /looks like a summary sentence/);
  } finally {
    f.cleanup();
  }
});

test("paths outside the repo still fail", () => {
  const f = fixture();
  try {
    const report = diffMatchesClaims(envelope(["../outside.ts"]), f.run);
    assert.match(report.violations[0], /resolves outside the repo/);
  } finally {
    f.cleanup();
  }
});

test("no usable base ref (not a git repo): old behavior, absent path fails", () => {
  const root = mkdtempSync(path.join(tmpdir(), "spf-gates-nogit-"));
  try {
    const report = diffMatchesClaims(envelope(["gone.ts"]), { repo_root: root });
    assert.deepEqual(report.violations, ["gone.ts: claimed changed file does not exist"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a trailing exact ' (deleted)' annotation is stripped and verified like a plain path", () => {
  const f = fixture();
  try {
    rmSync(path.join(f.root, "app/(tabs)/a.tsx"));
    const ok = diffMatchesClaims(envelope(["app/(tabs)/a.tsx (deleted)"]), f.run);
    assert.equal(ok.passed, true, ok.violations.join("\n"));
    // annotation contradicts reality: file still exists
    const lie = diffMatchesClaims(envelope(["keep.ts (deleted)"]), f.run);
    assert.equal(lie.passed, false);
    // annotating a never-tracked path does not launder it
    assert.equal(diffMatchesClaims(envelope(["nope.ts (deleted)"]), f.run).passed, false);
    // arbitrary prose in parens is NOT stripped
    assert.equal(diffMatchesClaims(envelope(["app/(tabs)/a.tsx (removed the old tab)"]), f.run).passed, false);
    // '(added)' on a file that exists passes; on an absent one it cannot
    assert.equal(diffMatchesClaims(envelope(["keep.ts (modified)"]), f.run).passed, true);
    assert.equal(diffMatchesClaims(envelope(["app/(tabs)/a.tsx (added)"]), f.run).passed, false);
  } finally {
    f.cleanup();
  }
});
