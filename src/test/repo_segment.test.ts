import "./hermetic_git.js";

/** The store segment (#214): repo identity without the host, worktree-stable, legacy-sticky, never throws. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { SFConfigSchema } from "../core/data_types.js";
import { legacyRepoSegment, repoSegment, segmentForRun } from "../core/repo_slug.js";
import { LocalReceiptStore } from "../core/receipt_store.js";
import { selectRun } from "../ui/server/receipt_reader.js";
import { LocalReceiptReader } from "../ui/server/receipt_reader_node.js";
import { runObjects, writeLocal } from "./receipt_fixture.js";

const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(name: string, remotes: Record<string, string> = {}): { root: string; dir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piquette-segment-")));
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  for (const [n, url] of Object.entries(remotes)) git(dir, "remote", "add", n, url);
  return { root, dir };
}
const cfg = (yaml: Record<string, unknown> = {}) => v.parse(SFConfigSchema, yaml);

test("remote forms: https, scp, ssh://, subgroup, Azure", () => {
  const cases: Array<[string, string]> = [
    ["https://github.com/Acme/Api.git", "acme--api"],
    ["git@github.com:acme/api.git", "acme--api"],
    ["ssh://git@git.example.com:2222/acme/api.git", "acme--api"],
    ["https://gitlab.com/group/sub/api.git", "group--sub--api"],
    ["https://dev.azure.com/org/proj/_git/api", "org--proj--api"],
  ];
  for (const [url, want] of cases) {
    const { root, dir } = repo("checkout", { origin: url });
    try {
      assert.equal(repoSegment(dir, cfg()), want, url);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("upstream wins over origin (a fork shares its parent's segment); a token in the remote never leaks", () => {
  const { root, dir } = repo("fork", { origin: "https://user:ghp_TOKENVALUE@github.com/me/api.git", upstream: "https://github.com/acme/api.git" });
  try {
    assert.equal(repoSegment(dir), "acme--api");
    const { root: r2, dir: d2 } = repo("fork", { origin: "https://user:ghp_TOKENVALUE@github.com/me/api.git" });
    try {
      assert.equal(repoSegment(d2), "me--api");
      assert.doesNotMatch(repoSegment(d2), /TOKEN/);
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync.repo / watch.repo steer the segment like the slug", () => {
  const { root, dir } = repo("checkout", { origin: "git@github.com:me/api.git" });
  try {
    assert.equal(repoSegment(dir, cfg({ sync: { repo: "gitlab.com/Team/Sub/Thing" } })), "team--sub--thing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a linked worktree issue-198 of a remote-less repo alpha is segment alpha (and so is the slug fallback)", () => {
  const { root, dir } = repo("alpha");
  try {
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
    const wt = join(root, "issue-198");
    git(dir, "worktree", "add", "-q", wt, "-b", "issue-198");
    assert.equal(repoSegment(wt), "alpha");
    assert.equal(repoSegment(dir), "alpha");
    assert.equal(legacyRepoSegment(wt), "issue-198", "the legacy segment is the checkout name");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-repo directory falls back without throwing", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piquette-segment-plain-")));
  try {
    const plain = join(root, "My Project");
    mkdirSync(plain);
    assert.equal(repoSegment(plain), "my-project");
    assert.equal(repoSegment(join(root, "does-not-exist")), "does-not-exist");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy stickiness: a run that already wrote under the legacy segment stays on it", async () => {
  const { root, dir } = repo("checkout", { origin: "git@github.com:acme/api.git" });
  try {
    const store = new LocalReceiptStore(join(root, "store"));
    assert.equal(await segmentForRun(store, dir, "run-1"), "acme--api", "a fresh run takes the new segment");
    await store.put("checkout/attempts/run-1/1/receipt.json", "{}", "application/json");
    assert.equal(await segmentForRun(store, dir, "run-1"), "checkout", "legacy attempts exist: stay");
    assert.equal(await segmentForRun(store, dir, "run-2"), "acme--api", "another run is not affected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selectRun finds a run under both the legacy and the new layout", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piquette-segment-read-")));
  try {
    writeLocal(root, runObjects("issue-198", "run-legacy"));
    writeLocal(root, runObjects("acme--api", "run-new"));
    const reader = new LocalReceiptReader(root);
    for (const [run, repoKey] of [["run-legacy", "issue-198"], ["run-new", "acme--api"]] as const) {
      const sel = await selectRun(reader, run);
      assert.ok(sel && !("conflict" in sel), run);
      assert.equal((sel as { repo: string }).repo, repoKey);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
