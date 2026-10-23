/**
 * `core/receipt.ts` (#159, ticket A / #173): verdict precedence, revision
 * binding against a REAL temporary git repository, the store layout on the
 * local backend, schema rejections, and the trace row.
 *
 * `hermetic_git` MUST stay the first import: this file spawns git in temp
 * repos, and without it a pre-push run (git exports GIT_DIR to hooks)
 * committed into the real branch and set core.bare=true on the shared repo.
 */
import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import {
  decideVerdict,
  isStale,
  listAttempts,
  nextAttempt,
  readLatestReceipt,
  receiptEventRecord,
  receiptKey,
  ReceiptSchema,
  RECEIPT_SCHEMA_VERSION,
  revisionLabel,
  revisionOf,
  treeOf,
  writeReceipt,
  type Check,
  type Receipt,
} from "../core/receipt.js";
import { LocalReceiptStore } from "../core/receipt_store.js";

const pass = (name: string): Check => ({ journey: "P01", name, expected: 0, actual: 0, pass: true });
const fail = (name: string, hint?: string): Check => ({ journey: "P01", name, expected: 0, actual: 1, pass: false, ...(hint ? { hint } : {}) });

// ── verdict ─────────────────────────────────────────────────────────────────

test("decideVerdict: any CANT_TELL cause wins over passing checks", () => {
  const r = decideVerdict({ checks: [pass("a"), pass("b")], cantTell: ["recording failed: 0 frames"] });
  assert.equal(r.verdict, "CANT_TELL");
  assert.match(r.reason, /0 frames/);
});

test("decideVerdict: no checks at all is CANT_TELL, never PASS", () => {
  assert.equal(decideVerdict({ checks: [], cantTell: [] }).verdict, "CANT_TELL");
});

test("decideVerdict: all pass → PASS; any fail → FAIL with one next[] line per failure (hint first)", () => {
  const ok = decideVerdict({ checks: [pass("a")], cantTell: [], revisionLabel: "abc123" });
  assert.equal(ok.verdict, "PASS");
  assert.match(ok.reason, /1 check\(s\) passed on abc123/);

  const bad = decideVerdict({ checks: [pass("a"), fail("exit code"), fail("first line", "say the chain is unknown")], cantTell: [] });
  assert.equal(bad.verdict, "FAIL");
  assert.equal(bad.reason, "2 of 3 check(s) failed");
  assert.deepEqual(bad.next, ['P01 "exit code": expected 0, got 1', "say the chain is unknown"]);
});

// ── revision binding (real git) ─────────────────────────────────────────────

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "spf-receipt-rev-test-"));
  const g = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=spf-test", "-c", "user.email=spf@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
  };
  g("init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return dir;
}

function commitAll(dir: string, msg: string): void {
  for (const args of [["add", "-A"], ["commit", "-q", "-m", msg]]) {
    const r = spawnSync("git", ["-c", "user.name=spf-test", "-c", "user.email=spf@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
  }
}

test("revisionOf: a clean tree is HEAD's tree; tracked edits and untracked files change it; ignored files don't", () => {
  const dir = gitRepo();
  try {
    const clean = revisionOf(dir);
    assert.match(clean.sha, /^[0-9a-f]{40}$/);
    assert.equal(clean.dirty, false);
    assert.equal(clean.tree, treeOf(dir, "HEAD"));
    assert.equal(revisionLabel(clean), clean.sha.slice(0, 12));

    writeFileSync(join(dir, "ignored.log"), "noise");
    assert.equal(revisionOf(dir).tree, clean.tree, "ignored files are not part of the revision");

    writeFileSync(join(dir, "new.txt"), "brand new, unstaged");
    const untracked = revisionOf(dir);
    assert.equal(untracked.dirty, true, "an untracked file changes behavior, so it changes the revision");
    assert.notEqual(untracked.tree, clean.tree);

    writeFileSync(join(dir, "new.txt"), "brand new, edited");
    assert.notEqual(revisionOf(dir).tree, untracked.tree, "editing an untracked file changes the tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revisionOf never touches the real index — nothing is staged by computing a revision", () => {
  const dir = gitRepo();
  try {
    writeFileSync(join(dir, "new.txt"), "unstaged");
    revisionOf(dir);
    const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf-8" }).stdout.trim();
    assert.equal(staged, "", "the user's staging area is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale: an edit makes a receipt stale; reverting it is fresh again; COMMITTING the proven content stays fresh", () => {
  const dir = gitRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "built\n"); // the uncommitted build a proof runs on
    const proven = { revision: revisionOf(dir) };
    assert.equal(isStale(proven, dir).stale, false);

    writeFileSync(join(dir, "a.txt"), "edited after the proof\n");
    const edited = isStale(proven, dir);
    assert.equal(edited.stale, true);
    assert.match(edited.reason, /working tree changed/);

    writeFileSync(join(dir, "a.txt"), "built\n");
    assert.equal(isStale(proven, dir).stale, false, "same bytes as the proven state → fresh again");

    commitAll(dir, "land the build");
    assert.equal(isStale(proven, dir).stale, false, "the commit holds exactly the proven content, so the receipt still proves it");
    assert.equal(treeOf(dir, "HEAD"), proven.revision.tree);

    writeFileSync(join(dir, "a.txt"), "changed again\n");
    commitAll(dir, "another change");
    const moved = isStale(proven, dir);
    assert.equal(moved.stale, true);
    assert.match(moved.reason, /content changed \(HEAD moved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revisionOf throws outside a git repository (the caller turns that into CANT_TELL)", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-receipt-norepo-test-"));
  try {
    assert.throws(() => revisionOf(dir), /git rev-parse HEAD failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── store layout ────────────────────────────────────────────────────────────

const SHA = "a".repeat(40);
const TREE = "c".repeat(40);
function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    schema: RECEIPT_SCHEMA_VERSION,
    run_id: "run-1",
    attempt: 1,
    repo: "spf",
    issue: "179",
    stage: "head",
    revision: { sha: SHA, tree: TREE, dirty: false },
    verdict: "PASS",
    reason: "1 check(s) passed",
    next: [],
    at: "2026-10-22T12:00:00.000Z",
    subject: { kind: "console" },
    journeys: [{ id: "P01", criterion: "exits non-zero", steps: [{ name: "spf nope", ms: 250, exit: 1 }] }],
    checks: [pass("exit code")],
    judgments: [],
    observations: {},
    evidence: { video: { key: "spf/attempts/run-1/1/video.mp4", content_type: "video/mp4", bytes: 10, sha256: "b".repeat(64), duration_s: 29.5 } },
    ...over,
  };
}

test("writeReceipt/readLatestReceipt: attempts sort numerically, and a stage filter finds the latest head proof", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-receipt-store-layout-test-"));
  try {
    const store = new LocalReceiptStore(dir);
    assert.equal(await nextAttempt(store, "spf", "run-1"), 1);
    assert.equal(await readLatestReceipt(store, "spf", "run-1"), null);

    const written = await writeReceipt(store, receipt({ attempt: 1, stage: "base", verdict: "FAIL" }));
    assert.equal(written.key, "spf/attempts/run-1/1/receipt.json");
    await writeReceipt(store, receipt({ attempt: 9 }));
    await writeReceipt(store, receipt({ attempt: 10, stage: "base", verdict: "FAIL" }));
    // Evidence next to a receipt must not be mistaken for an attempt.
    await store.put("spf/attempts/run-1/11/video.mp4", "x", "video/mp4");

    assert.deepEqual(await listAttempts(store, "spf", "run-1"), [1, 9, 10]);
    assert.equal(await nextAttempt(store, "spf", "run-1"), 11);
    assert.equal((await readLatestReceipt(store, "spf", "run-1"))?.attempt, 10, "10 sorts after 9");
    assert.equal((await readLatestReceipt(store, "spf", "run-1", "head"))?.attempt, 9);
    assert.equal(receiptKey("spf", "run-1", 9), "spf/attempts/run-1/9/receipt.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeReceipt refuses an invalid receipt rather than storing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-receipt-invalid-test-"));
  try {
    const store = new LocalReceiptStore(dir);
    await assert.rejects(writeReceipt(store, receipt({ revision: { sha: "abc", tree: TREE, dirty: false } })), /40-character/);
    await assert.rejects(writeReceipt(store, receipt({ run_id: "a/b" })), /single key segment/);
    await assert.rejects(writeReceipt(store, receipt({ attempt: 0 })));
    assert.deepEqual(await store.list(""), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ReceiptSchema accepts the documented shape", () => {
  assert.equal(v.safeParse(ReceiptSchema, receipt()).success, true);
  assert.equal(v.safeParse(ReceiptSchema, { ...receipt(), verdict: "MAYBE" }).success, false);
});

// ── trace ───────────────────────────────────────────────────────────────────

test("receiptEventRecord: a log event that points at the stored receipt, not a copy of it", () => {
  const r = receipt({ checks: [pass("a"), fail("b")], verdict: "FAIL" });
  const event = receiptEventRecord(r, "spf/attempts/run-1/1/receipt.json", "adw-1", "phase-7");
  assert.equal(event.type, "log");
  assert.equal(event.name, "receipt");
  assert.equal(event.adw_id, "adw-1");
  assert.equal(event.phase_id, "phase-7");
  assert.deepEqual(event.payload, {
    run_id: "run-1",
    attempt: 1,
    stage: "head",
    verdict: "FAIL",
    reason: "1 check(s) passed",
    revision: { sha: SHA, tree: TREE, dirty: false },
    key: "spf/attempts/run-1/1/receipt.json",
    checks: { total: 2, failed: 1 },
    evidence: { video: "spf/attempts/run-1/1/video.mp4" },
  });
});

test("evidence items: an old receipt without `journey` parses, a new one round-trips (#235)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-receipt-journey-test-"));
  try {
    v.parse(ReceiptSchema, receipt());
    const item = { key: "spf/attempts/run-1/1/evidence/P01/a.mp4", content_type: "video/mp4", bytes: 3, sha256: "d".repeat(64), journey: "P01" };
    const store = new LocalReceiptStore(dir);
    await writeReceipt(store, receipt({ evidence: { "journey:P01/a.mp4": item }, observations: { evidence_dropped: [{ journey: "P01", file: "x.html", reason: "no" }] } }));
    const back = await readLatestReceipt(store, "spf", "run-1");
    assert.deepEqual(back?.evidence["journey:P01/a.mp4"], item);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
