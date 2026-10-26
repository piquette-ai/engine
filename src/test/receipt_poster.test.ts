/**
 * #203: the inline poster — `publishPoster` (git plumbing to an orphan
 * `piquette-receipts` branch, against a temp bare remote), the Verification
 * section's rendering with and without it, and the never-throws fallback.
 */
import "./hermetic_git.js"; // house rule
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { posterFor } from "../cli/commands/watch.js";
import { SFConfigSchema } from "../core/data_types.js";
import { LocalReceiptStore } from "../core/receipt_store.js";
import { posterBlobUrl, posterBranchPath, publishPoster } from "../core/receipt_poster.js";
import { escalationText, type VerificationOutcome } from "../core/verification.js";

const KEY = "repo/attempts/run-1/2/poster.gif";
const GIF = Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixture(): { dir: string; work: string; remote: string; store: LocalReceiptStore } {
  const dir = mkdtempSync(join(tmpdir(), "piquette-poster-"));
  const remote = join(dir, "remote.git");
  const work = join(dir, "work");
  mkdirSync(work);
  git(dir, "init", "--bare", "-q", remote);
  git(work, "init", "-q");
  git(work, "remote", "add", "origin", remote);
  const root = join(dir, "store");
  mkdirSync(join(root, "repo/attempts/run-1/2"), { recursive: true });
  writeFileSync(join(root, KEY), GIF);
  return { dir, work, remote, store: new LocalReceiptStore(root) };
}

const MB5 = 5 * 1048576;
const logs = () => {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m) };
};

test("the first poster makes an orphan piquette-receipts branch with the gif at <run_id>/<attempt>/poster.gif", async () => {
  const f = fixture();
  try {
    const l = logs();
    const first = await publishPoster({ store: f.store, key: KEY, cwd: f.work, maxBytes: MB5, log: l.log });
    assert.equal(first?.path, "run-1/2/poster.gif");
    assert.equal(first?.commit, git(f.remote, "rev-parse", "piquette-receipts"), "names the commit that holds the poster");
    assert.deepEqual(l.lines, []);
    assert.equal(git(f.remote, "rev-list", "--parents", "-n1", "piquette-receipts").split(" ").length, 1, "root commit: no parent");
    assert.deepEqual(readFileSync(execFileSync("sh", ["-c", `git -C ${f.remote} show piquette-receipts:run-1/2/poster.gif > ${f.dir}/out.gif && echo ${f.dir}/out.gif`], { encoding: "utf8" }).trim()), GIF);
    assert.equal(existsSync(join(f.work, "run-1")), false, "no checkout — the working tree is untouched");
    assert.equal(git(f.work, "status", "--porcelain"), "");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a second poster parents on the remote tip and keeps the first; the same poster again adds no commit", async () => {
  const f = fixture();
  try {
    const l = logs();
    await publishPoster({ store: f.store, key: KEY, cwd: f.work, maxBytes: MB5, log: l.log });
    const second = "repo/attempts/run-2/1/poster.gif";
    mkdirSync(join(f.dir, "store/repo/attempts/run-2/1"), { recursive: true });
    writeFileSync(join(f.dir, "store", second), Buffer.concat([GIF, Buffer.from([0])]));
    assert.equal((await publishPoster({ store: f.store, key: second, cwd: f.work, maxBytes: MB5, log: l.log }))?.path, "run-2/1/poster.gif");
    assert.equal(git(f.remote, "rev-list", "--count", "piquette-receipts"), "2");
    assert.equal(git(f.remote, "ls-tree", "-r", "--name-only", "piquette-receipts"), "run-1/2/poster.gif\nrun-2/1/poster.gif");
    await publishPoster({ store: f.store, key: second, cwd: f.work, maxBytes: MB5, log: l.log });
    assert.equal(git(f.remote, "rev-list", "--count", "piquette-receipts"), "2", "identical bytes at the same path: nothing new to commit");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a push that loses a race refetches, re-parents on the newer tip and keeps the other poster", async () => {
  const f = fixture();
  try {
    await publishPoster({ store: f.store, key: KEY, cwd: f.work, maxBytes: MB5, log: () => {} });
    // The server refuses non-fast-forwards, and a hook lets someone else's commit land first, so our first push is really stale.
    git(f.remote, "config", "receive.denyNonFastForwards", "true");
    const other = join(f.dir, "other");
    execFileSync("git", ["clone", "-q", "--branch", "piquette-receipts", f.remote, other]);
    git(other, "config", "user.email", "o@example.com");
    git(other, "config", "user.name", "o");
    const marker = join(f.dir, "raced");
    writeFileSync(
      join(f.remote, "hooks/pre-receive"),
      `#!/bin/sh\nunset GIT_DIR GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\nif [ ! -e ${marker} ]; then touch ${marker}; cd ${other} && mkdir -p run-9/1 && echo x > run-9/1/poster.gif && git add . && git commit -qm race && git push -q origin piquette-receipts >/dev/null 2>&1; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    const second = "repo/attempts/run-2/1/poster.gif";
    mkdirSync(join(f.dir, "store/repo/attempts/run-2/1"), { recursive: true });
    writeFileSync(join(f.dir, "store", second), Buffer.concat([GIF, Buffer.from([1])]));
    const l = logs();
    const out = await publishPoster({ store: f.store, key: second, cwd: f.work, maxBytes: MB5, log: l.log });
    assert.ok(existsSync(marker), "the first push was intercepted");
    assert.equal(out?.path, "run-2/1/poster.gif", `retry landed it (${l.lines.join("; ")})`);
    assert.equal(git(f.remote, "ls-tree", "-r", "--name-only", "piquette-receipts"), "run-1/2/poster.gif\nrun-2/1/poster.gif\nrun-9/1/poster.gif");
    assert.equal(git(f.remote, "rev-list", "--count", "piquette-receipts"), "3");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the push skips the repo's pre-push hook, and a failure that isn't a lost race is not retried", async () => {
  const f = fixture();
  try {
    const hookLog = join(f.dir, "hook.log");
    writeFileSync(join(f.work, ".git/hooks/pre-push"), `#!/bin/sh\necho ran >> ${hookLog}\nexit 1\n`, { mode: 0o755 });
    const l = logs();
    assert.ok(await publishPoster({ store: f.store, key: KEY, cwd: f.work, maxBytes: MB5, log: l.log }), "landed despite a failing pre-push hook");
    assert.equal(existsSync(hookLog), false, "pre-push never ran");
    // A server-side refusal (not non-fast-forward) gives up after one push.
    const pushes = join(f.dir, "pushes");
    writeFileSync(join(f.remote, "hooks/pre-receive"), `#!/bin/sh\necho x >> ${pushes}\necho "denied by policy" >&2\nexit 1\n`, { mode: 0o755 });
    const second = "repo/attempts/run-2/1/poster.gif";
    mkdirSync(join(f.dir, "store/repo/attempts/run-2/1"), { recursive: true });
    writeFileSync(join(f.dir, "store", second), Buffer.concat([GIF, Buffer.from([2])]));
    assert.equal(await publishPoster({ store: f.store, key: second, cwd: f.work, maxBytes: MB5, log: l.log }), undefined);
    assert.equal(readFileSync(pushes, "utf8").trim().split("\n").length, 1, "one push attempt, no retry");
    assert.match(l.lines.at(-1)!, /failed .*(denied by policy|rejected)/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("over the cap, a missing poster, an odd key and an unreachable remote all skip with a reason and never throw", async () => {
  const f = fixture();
  try {
    const l = logs();
    assert.equal(await publishPoster({ store: f.store, key: KEY, cwd: f.work, maxBytes: 10, log: l.log }), undefined);
    assert.match(l.lines.at(-1)!, /over the .* cap \(receipts\.poster_max_mb\)/);
    assert.equal(await publishPoster({ store: f.store, key: "repo/attempts/run-1/2/missing.gif", cwd: f.work, maxBytes: MB5, log: l.log }), undefined);
    assert.match(l.lines.at(-1)!, /is not a <repo>/);
    assert.equal(await publishPoster({ store: f.store, key: "repo/attempts/run-1/3/poster.gif", cwd: f.work, maxBytes: MB5, log: l.log }), undefined);
    assert.match(l.lines.at(-1)!, /not in the receipt store/);
    git(f.work, "remote", "set-url", "origin", join(f.dir, "nowhere.git"));
    assert.equal(await publishPoster({ store: f.store, key: KEY, cwd: f.work, maxBytes: MB5, log: l.log }), undefined);
    assert.match(l.lines.at(-1)!, /poster not published/);
    assert.equal(await publishPoster({ store: f.store, key: KEY, cwd: join(f.dir, "not-a-dir"), maxBytes: MB5, log: l.log }), undefined);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the real pilot poster fits the default cap", () => {
  const real = "/Users/jdfiscus/dev/piquette/.piquette/data/receipts/issue-198/attempts/issue-198/2/poster.gif";
  if (!existsSync(real)) return; // a dev-machine sanity check only
  assert.ok(readFileSync(real).byteLength < MB5);
  assert.equal(posterBranchPath("issue-198/attempts/issue-198/2/poster.gif"), "issue-198/2/poster.gif");
});

test("posterBlobUrl names the blob on the piquette-receipts branch", () => {
  assert.equal(posterBlobUrl("o/r", "run 1/2/poster.gif"), "https://github.com/o/r/blob/piquette-receipts/run%201/2/poster.gif?raw=true");
});

test("posterBlobUrl pins the commit when given one", () => {
  assert.equal(posterBlobUrl("o/r", "run-1/2/poster.gif", "abc123"), "https://github.com/o/r/blob/abc123/run-1/2/poster.gif?raw=true");
});

const outcome = (poster?: { image: string; href: string }): VerificationOutcome => ({
  status: "verified",
  reasons: [],
  journeys: "j.yaml",
  base: null,
  head: { key: "repo/attempts/run-1/2/receipt.json", stage: "head", attempt: 2, verdict: "PASS", reason: "ok", tree: "a".repeat(40), poster: KEY },
  failed_proofs: 0,
  max_failed_proofs: 3,
  ...(poster ? { poster } : {}),
});

test("the Verification section embeds the poster as an image linked to its href — and is links-only without one", () => {
  const withPoster = escalationText(outcome({ image: "https://github.com/o/r/blob/piquette-receipts/run-1/2/poster.gif?raw=true", href: "https://v.example.com/r/run-1?key=k" }));
  assert.match(withPoster, /\[!\[Recording of the change\]\(https:\/\/github\.com\/o\/r\/blob\/piquette-receipts\/run-1\/2\/poster\.gif\?raw=true\)\]\(https:\/\/v\.example\.com\/r\/run-1\?key=k\)/);
  assert.doesNotMatch(escalationText(outcome()), /!\[/);
  // the issue-tracker comment never carries the image
  assert.doesNotMatch(escalationText(outcome({ image: "https://x/i.gif", href: "https://x/h" }), { poster: false }), /!\[/);
});

test("posterFor: publishes and links the viewer when set, else the blob; any failure is undefined", async () => {
  const f = fixture();
  try {
    const mk = (extra: object) =>
      v.parse(SFConfigSchema, { watch: { repo: "o/r" }, receipts: { store: { kind: "local", path: join(f.dir, "store") }, ...extra } });
    const quiet = console.log;
    console.log = () => {};
    try {
      const links = { [KEY]: { url: "https://v.example.com/r/run-1?key=p" } };
      const viewer = await posterFor(mk({ viewer_url: "https://v.example.com" }), f.work, outcome(), links);
      assert.match(viewer?.image ?? "", /^https:\/\/github\.com\/o\/r\/blob\/[0-9a-f]{40}\/run-1\/2\/poster\.gif\?raw=true$/, "pinned to the commit");
      assert.equal(viewer?.href, "https://v.example.com/r/run-1?key=p");
      const blobOnly = await posterFor(mk({}), f.work, outcome(), {});
      assert.equal(blobOnly?.href, blobOnly?.image);
      // over the cap, no head poster, a non-GitHub host, a dead remote: all just undefined
      writeFileSync(join(f.dir, "store", KEY), Buffer.concat([GIF, Buffer.alloc(20_000)]));
      assert.equal(await posterFor(mk({ poster_max_mb: 0.01 }), f.work, outcome(), {}), undefined);
      assert.equal(await posterFor(mk({}), f.work, { ...outcome(), head: { ...outcome().head!, poster: undefined } }, {}), undefined);
      assert.equal(await posterFor(v.parse(SFConfigSchema, { watch: { repo: "o/r", code_host: "bitbucket" }, receipts: {} }), f.work, outcome(), {}), undefined);
      git(f.work, "remote", "set-url", "origin", join(f.dir, "nowhere.git"));
      assert.equal(await posterFor(mk({}), f.work, outcome(), {}), undefined);
    } finally {
      console.log = quiet;
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
