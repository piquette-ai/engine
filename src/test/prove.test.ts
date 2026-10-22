/**
 * `core/prove.ts` (#159, ticket B / #174) against a REAL temporary git repo
 * and a local receipt store, with a fake recorder: PASS/FAIL/CAN'T TELL,
 * non-negotiables, evidence upload, a revision that moves mid-proof, and
 * attempt numbering. One opt-in test records for real (SPF_TEST_RECORD=1).
 */
import "./hermetic_git.js"; // MUST stay first: this file runs git in temp repos
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { JourneySpecSchema, type JourneySpec } from "../core/journeys.js";
import { prove, ProofCannotStart } from "../core/prove.js";
import { AgentBrowserTtydRecorder, missingRecorderTools, probeVideo, type ConsoleRecorder } from "../core/recorder.js";
import { readLatestReceipt, storeExclusions } from "../core/receipt.js";
import { LocalReceiptStore } from "../core/receipt_store.js";
import { repoSegment } from "../cli/commands/prove.js";

const spec = (over: Record<string, unknown>): JourneySpec => v.parse(JourneySpecSchema, { id: "P01", criterion: "c", run: "true", expect: { exit: 0 }, ...over });

function fixture(): { repo: string; storeDir: string; store: LocalReceiptStore; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), "spf-prove-repo-"));
  const storeDir = mkdtempSync(join(tmpdir(), "spf-prove-store-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=spf-test", "-c", "user.email=spf@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q");
  writeFileSync(join(repo, "app.sh"), "echo 'hello from app'\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { repo, storeDir, store: new LocalReceiptStore(storeDir), cleanup: () => [repo, storeDir].forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

const base = (f: ReturnType<typeof fixture>) => ({ repoRoot: f.repo, store: f.store, repo: "demo", runId: "run-1", issue: "179", stage: "head" as const });

class FakeRecorder implements ConsoleRecorder {
  calls: string[][] = [];
  constructor(private readonly behavior: "ok" | "throw" | "edit-repo" = "ok", private readonly repo?: string) {}
  async record(steps: { command: string }[], opts: { workDir: string }) {
    this.calls.push(steps.map((s) => s.command));
    if (this.behavior === "throw") throw new Error("captured 0 frames");
    if (this.behavior === "edit-repo") writeFileSync(join(this.repo!, "app.sh"), "echo 'changed mid-proof'\n");
    const files = { video: "video.mp4", poster: "poster.gif", contact_sheet: "contact-sheet.png", source: "source.webm", transcript: "terminal.txt" };
    const out = Object.fromEntries(Object.entries(files).map(([k, name]) => [k, join(opts.workDir, name)])) as Record<keyof typeof files, string>;
    for (const [k, f] of Object.entries(out)) writeFileSync(f, `fake ${k}`);
    return { files: out, duration_s: 12.5 };
  }
}

test("PASS without a recorder: receipt written, coverage counted, and it says nothing was recorded", async () => {
  const f = fixture();
  try {
    const { receipt, key } = await prove({ ...base(f), journeys: [spec({ run: "bash app.sh", expect: { exit: 0, output_contains: ["hello from app"] } }), spec({ id: "P02", kind: "unhappy", run: "grep -q 'not in the app' app.sh", expect: { exit_nonzero: true } })] });
    assert.equal(receipt.verdict, "PASS", receipt.reason);
    assert.equal(key, "demo/attempts/run-1/1/receipt.json");
    assert.deepEqual(receipt.observations.coverage, { happy: 1, unhappy: 1, non_negotiable: 0 });
    assert.equal(receipt.observations.recording, "not recorded (no recorder)");
    assert.deepEqual(receipt.evidence, {});
    assert.equal(receipt.revision.dirty_hash, null);
    assert.equal((await readLatestReceipt(f.store, "demo", "run-1"))?.verdict, "PASS");
  } finally {
    f.cleanup();
  }
});

test("a failing non-negotiable fails the receipt even when every ticket journey passes", async () => {
  const f = fixture();
  try {
    const { receipt } = await prove({ ...base(f), journeys: [spec({ run: "bash app.sh" })], nonNegotiables: [spec({ id: "help", criterion: "help still works", run: "exit 1", expect: { exit: 0 } })] });
    assert.equal(receipt.verdict, "FAIL");
    assert.ok(receipt.checks.some((c) => c.journey === "NN-help" && !c.pass));
    assert.deepEqual(receipt.observations.coverage, { happy: 1, unhappy: 0, non_negotiable: 1 });
  } finally {
    f.cleanup();
  }
});

test("a recording is uploaded next to the receipt with sha256s, and the recorder gets every journey command", async () => {
  const f = fixture();
  try {
    const recorder = new FakeRecorder();
    const { receipt } = await prove({ ...base(f), journeys: [spec({ run: "bash app.sh" })], nonNegotiables: [spec({ id: "nn", run: "true" })], recorder });
    assert.equal(receipt.verdict, "PASS");
    assert.deepEqual(recorder.calls, [["bash app.sh", "true"]]);
    assert.deepEqual(Object.keys(receipt.evidence).sort(), ["contact_sheet", "poster", "source", "transcript", "video"]);
    assert.equal(receipt.evidence.video.key, "demo/attempts/run-1/1/video.mp4");
    assert.equal(receipt.evidence.video.duration_s, 12.5);
    assert.match(receipt.evidence.video.sha256, /^[0-9a-f]{64}$/);
    assert.equal(new TextDecoder().decode((await f.store.get("demo/attempts/run-1/1/poster.gif"))!), "fake poster");
  } finally {
    f.cleanup();
  }
});

test("a recorder failure makes the receipt CAN'T TELL — passing checks without the evidence are not a pass", async () => {
  const f = fixture();
  try {
    const { receipt } = await prove({ ...base(f), journeys: [spec({ run: "bash app.sh" })], recorder: new FakeRecorder("throw") });
    assert.equal(receipt.verdict, "CANT_TELL");
    assert.match(receipt.reason, /recording failed: captured 0 frames/);
    assert.deepEqual(receipt.evidence, {});
  } finally {
    f.cleanup();
  }
});

test("a revision that changes during the proof is CAN'T TELL — evidence from two builds proves neither", async () => {
  const f = fixture();
  try {
    const { receipt } = await prove({ ...base(f), journeys: [spec({ run: "bash app.sh" })], recorder: new FakeRecorder("edit-repo", f.repo) });
    assert.equal(receipt.verdict, "CANT_TELL");
    assert.match(receipt.reason, /revision changed during the proof/);
  } finally {
    f.cleanup();
  }
});

test("a journey that can't run skips the recording and is CAN'T TELL", async () => {
  const f = fixture();
  try {
    const recorder = new FakeRecorder();
    const { receipt } = await prove({ ...base(f), journeys: [spec({ run: "spf-definitely-not-installed-xyz", expect: { exit_nonzero: true } })], recorder });
    assert.equal(receipt.verdict, "CANT_TELL");
    assert.deepEqual(recorder.calls, [], "no point recording a proof that already can't tell");
  } finally {
    f.cleanup();
  }
});

test("attempts number up per run, and base/head stages are kept apart", async () => {
  const f = fixture();
  try {
    const first = await prove({ ...base(f), stage: "base", journeys: [spec({ run: "exit 1" })] });
    const second = await prove({ ...base(f), journeys: [spec({ run: "true" })] });
    assert.equal(first.receipt.attempt, 1);
    assert.equal(first.receipt.verdict, "FAIL");
    assert.equal(second.receipt.attempt, 2);
    assert.equal((await readLatestReceipt(f.store, "demo", "run-1", "base"))?.attempt, 1);
    assert.equal((await readLatestReceipt(f.store, "demo", "run-1", "head"))?.attempt, 2);
  } finally {
    f.cleanup();
  }
});

test("outside a git repo there is nothing to bind to: ProofCannotStart, and no receipt is written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-prove-norepo-"));
  const storeDir = mkdtempSync(join(tmpdir(), "spf-prove-norepo-store-"));
  try {
    const store = new LocalReceiptStore(storeDir);
    await assert.rejects(prove({ repoRoot: dir, store, repo: "demo", runId: "r", issue: null, stage: "head", journeys: [spec({})] }), ProofCannotStart);
    assert.deepEqual(await store.list(""), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

// Found by dogfooding `spf prove --record` on spf itself: the default local
// store sat inside the repo at a non-ignored path, so writing the video
// created untracked files and the proof reported its own output as "the
// revision changed during the proof".
test("a local store INSIDE the repo is left out of the revision — the proof's own output doesn't make it CAN'T TELL", async () => {
  const f = fixture();
  try {
    const inRepoStore = new LocalReceiptStore(join(f.repo, "receipts"));
    const { receipt } = await prove({ ...base(f), store: inRepoStore, journeys: [spec({ run: "bash app.sh" })], recorder: new FakeRecorder() });
    assert.equal(receipt.verdict, "PASS", receipt.reason);
    assert.equal(receipt.revision.dirty_hash, null, "the store's files are not part of the revision");
  } finally {
    f.cleanup();
  }
});

test("storeExclusions: only a local store inside the repo is excluded", () => {
  assert.deepEqual(storeExclusions(new LocalReceiptStore("/r/.spf/data/receipts"), "/r"), [".spf/data/receipts"]);
  assert.deepEqual(storeExclusions(new LocalReceiptStore("/elsewhere/receipts"), "/r"), []);
  assert.deepEqual(storeExclusions(new LocalReceiptStore("/r"), "/r"), [], "the repo root itself is never excluded");
});

test("repoSegment turns a directory name into one safe store key segment", () => {
  assert.equal(repoSegment("/x/Super Portable.Factory"), "super-portable.factory");
  assert.equal(repoSegment("/x/..."), "repo");
});

const RECORD = process.env.SPF_TEST_RECORD === "1";
test("live recording through agent-browser + ttyd (set SPF_TEST_RECORD=1; needs the tools and loopback)", { skip: !RECORD && "SPF_TEST_RECORD not set" }, async () => {
  assert.deepEqual(missingRecorderTools(), []);
  const f = fixture();
  try {
    const { receipt } = await prove({ ...base(f), journeys: [spec({ run: "bash app.sh", expect: { exit: 0, output_contains: ["hello from app"] } })], recorder: new AgentBrowserTtydRecorder() });
    assert.equal(receipt.verdict, "PASS", receipt.reason);
    const videoPath = join(f.storeDir, ...receipt.evidence.video.key.split("/"));
    const { duration_s, packets } = probeVideo(videoPath);
    assert.ok(duration_s >= 1 && packets > 0, `duration ${duration_s}, packets ${packets}`);
    assert.ok(readFileSync(join(f.storeDir, ...receipt.evidence.contact_sheet.key.split("/"))).byteLength > 0);
    const transcript = readFileSync(join(f.storeDir, ...receipt.evidence.transcript.key.split("/")), "utf-8");
    assert.match(transcript, /bash app\.sh/, "the terminal transcript shows the command that was typed");
    assert.match(transcript, /hello from app/, "…and its output");
  } finally {
    f.cleanup();
  }
});
