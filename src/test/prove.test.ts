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
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { JourneySpecSchema, runJourneys, type JourneySpec } from "../core/journeys.js";
import { prove, ProofCannotStart } from "../core/prove.js";
import { evidenceLimits } from "../core/journey_evidence.js";
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
    assert.equal(receipt.revision.dirty, false);
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

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(16)]);

test("journey evidence (#235): uploaded under evidence/<journey>/, in the receipt, capped, and never a verdict input", async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), "spf-evsrc-"));
  writeFileSync(join(dir, "screen.mp4"), MP4);
  try {
    const cmd = 'cp "$EVSRC/screen.mp4" "$SPF_EVIDENCE_DIR/screen.mp4"; printf png > "$SPF_EVIDENCE_DIR/shot.png"; echo x > "$SPF_EVIDENCE_DIR/page.html"; head -c 2097152 /dev/zero > "$SPF_EVIDENCE_DIR/big.png"; echo "evdir=$SPF_EVIDENCE_DIR"';
    const { receipt } = await prove({ ...base(f), env: { ...process.env, EVSRC: dir }, evidenceLimits: evidenceLimits({ max_file_mb: 1 }), journeys: [spec({ run: cmd })] });
    assert.equal(receipt.verdict, "PASS", receipt.reason);
    assert.ok(!/revision changed/.test(receipt.reason));
    const item = receipt.evidence["journey:P01/screen.mp4"];
    assert.equal(item.key, "demo/attempts/run-1/1/evidence/P01/screen.mp4");
    assert.equal(item.content_type, "video/mp4");
    assert.equal(item.journey, "P01");
    assert.equal(item.sha256, createHash("sha256").update(MP4).digest("hex"));
    assert.ok(receipt.evidence["journey:P01/shot.png"]);
    const dropped = receipt.observations.evidence_dropped as { file: string; reason: string }[];
    assert.deepEqual(dropped.map((d) => d.file).sort(), ["big.png", "page.html"]);
    assert.match(dropped.find((d) => d.file === "big.png")!.reason, /per-file cap/);
    const evDir = /evdir=(.*)/.exec((receipt.observations.outputs as Record<string, string>).P01)![1];
    assert.ok(!existsSync(evDir), "the temp evidence dir is removed");
    assert.ok(!evDir.startsWith(f.repo), "and it lived outside the repo");
    assert.ok(existsSync(join(f.storeDir, "demo/attempts/run-1/1/evidence/P01/screen.mp4")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    f.cleanup();
  }
});

test("journey evidence: a journey whose expect fails still has its evidence kept, and the verdict is FAIL", async () => {
  const f = fixture();
  try {
    const { receipt } = await prove({ ...base(f), journeys: [spec({ run: 'printf png > "$SPF_EVIDENCE_DIR/shot.png"; exit 3', expect: { exit: 0 } })] });
    assert.equal(receipt.verdict, "FAIL");
    assert.ok(receipt.evidence["journey:P01/shot.png"]);
  } finally {
    f.cleanup();
  }
});

test("journey evidence: each attempt starts with an empty directory; non-negotiables land under evidence/NN-<id>/", async () => {
  const f = fixture();
  try {
    const j = spec({ run: 'test -z "$(ls -A "$SPF_EVIDENCE_DIR")" && printf png > "$SPF_EVIDENCE_DIR/shot.png"' });
    const nn = spec({ id: "rule", run: 'printf png > "$SPF_EVIDENCE_DIR/nn.png"' });
    const first = await prove({ ...base(f), journeys: [j], nonNegotiables: [nn] });
    const second = await prove({ ...base(f), journeys: [j], nonNegotiables: [nn] });
    assert.equal(first.receipt.verdict, "PASS");
    assert.equal(second.receipt.attempt, 2);
    assert.equal(second.receipt.verdict, "PASS", second.receipt.reason);
    assert.equal(second.receipt.evidence["journey:NN-rule/nn.png"].key, "demo/attempts/run-1/2/evidence/NN-rule/nn.png");
  } finally {
    f.cleanup();
  }
});

test("journey evidence: an upload failure becomes a dropped note and the verdict is unchanged", async () => {
  const f = fixture();
  try {
    const store = Object.create(f.store) as LocalReceiptStore;
    const realPut = f.store.put.bind(f.store);
    store.put = async (key, body, ct) => {
      if (key.includes("/evidence/")) throw new Error("disk full");
      return realPut(key, body, ct);
    };
    const { receipt } = await prove({ ...base(f), store, journeys: [spec({ run: 'printf png > "$SPF_EVIDENCE_DIR/shot.png"' })] });
    assert.equal(receipt.verdict, "PASS");
    assert.deepEqual(receipt.evidence, {});
    assert.match((receipt.observations.evidence_dropped as { reason: string }[])[0].reason, /upload failed: disk full/);
  } finally {
    f.cleanup();
  }
});

test("journey evidence: the per-receipt cap counts bytes actually read, so files that grew after the walk are dropped", async () => {
  const f = fixture();
  try {
    // 1 byte at the walk, then grown by a detached writer before the upload loop reads it
    const cmd = 'printf a > "$SPF_EVIDENCE_DIR/a.png"; printf b > "$SPF_EVIDENCE_DIR/b.png"; (sleep 0.3; head -c 900 /dev/zero > "$SPF_EVIDENCE_DIR/a.png"; head -c 900 /dev/zero > "$SPF_EVIDENCE_DIR/b.png") >/dev/null 2>&1 &';
    const slow = Object.create(f.store) as LocalReceiptStore;
    const realPut = f.store.put.bind(f.store);
    slow.put = async (key, body, ct) => {
      if (key.includes("/evidence/")) await new Promise((r) => setTimeout(r, 500));
      return realPut(key, body, ct);
    };
    const { receipt } = await prove({ ...base(f), store: slow, evidenceLimits: { ...evidenceLimits(), maxTotalBytes: 1000, maxFileBytes: 1000 }, journeys: [spec({ run: cmd })] });
    assert.equal(receipt.verdict, "PASS", receipt.reason);
    const kept = Object.values(receipt.evidence).reduce((n, e) => n + e.bytes, 0);
    assert.ok(kept <= 1000, `kept ${kept} bytes past the 1000 byte cap`);
    assert.ok(Object.keys(receipt.evidence).length < 2);
  } finally {
    f.cleanup();
  }
});

test("journey evidence: a journey video replaces the terminal replay; image-only evidence does not", async () => {
  const f = fixture();
  try {
    const withVideo = new FakeRecorder();
    const a = await prove({ ...base(f), recorder: withVideo, journeys: [spec({ run: 'printf x > "$SPF_EVIDENCE_DIR/screen.mp4"' })] });
    assert.equal(a.receipt.verdict, "PASS", a.receipt.reason);
    assert.deepEqual(withVideo.calls, []);
    assert.match(String(a.receipt.observations.recording), /replay skipped/);
    assert.ok(a.receipt.evidence["journey:P01/screen.mp4"]);

    const imageOnly = new FakeRecorder();
    const b = await prove({ ...base(f), recorder: imageOnly, journeys: [spec({ run: 'printf x > "$SPF_EVIDENCE_DIR/shot.png"' })] });
    assert.equal(imageOnly.calls.length, 1);
    assert.ok(b.receipt.evidence.video);
  } finally {
    f.cleanup();
  }
});

test("journey evidence: an undeletable file in the evidence dir does not throw the finished proof away", async () => {
  const f = fixture();
  let leftover: string | null = null;
  try {
    const cmd = 'mkdir "$SPF_EVIDENCE_DIR/x" && touch "$SPF_EVIDENCE_DIR/x/f" && chmod 000 "$SPF_EVIDENCE_DIR/x"; printf png > "$SPF_EVIDENCE_DIR/shot.png"; echo "evdir=$SPF_EVIDENCE_DIR"';
    const { receipt } = await prove({ ...base(f), journeys: [spec({ run: cmd })] });
    assert.equal(receipt.verdict, "PASS", receipt.reason);
    assert.ok(receipt.evidence["journey:P01/shot.png"]);
    leftover = /evdir=(.*)/.exec((receipt.observations.outputs as Record<string, string>).P01)![1];
  } finally {
    if (leftover) {
      try {
        chmodSync(join(leftover, "x"), 0o700);
      } catch {}
      rmSync(join(leftover, ".."), { recursive: true, force: true });
    }
    f.cleanup();
  }
});

test("journey ids that differ only by case each get their own evidence directory", () => {
  const root = mkdtempSync(join(tmpdir(), "spf-evroot-"));
  try {
    const runs = runJourneys([spec({ id: "p01", run: 'echo "$SPF_EVIDENCE_DIR"' }), spec({ id: "P01", run: 'echo "$SPF_EVIDENCE_DIR"' })], { cwd: root, evidenceRoot: root }).runs;
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0].evidenceDir, runs[1].evidenceDir);
    assert.ok(existsSync(runs[0].evidenceDir!) && existsSync(runs[1].evidenceDir!));
  } finally {
    rmSync(root, { recursive: true, force: true });
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
    assert.equal(receipt.revision.dirty, false, "the store's files are not part of the revision");
  } finally {
    f.cleanup();
  }
});

// Found by the #179 pilot: the DEFAULT local store (`.spf/data/receipts`) is
// gitignored, and `git add` refuses a `:(exclude)` pathspec that names an
// ignored path — so every proof with the default store was CAN'T TELL
// ("can't bind a proof to a revision").
test("a local store at a GITIGNORED path inside the repo (the default) still proves — no CAN'T TELL", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, ".gitignore"), ".spf/data/\n");
    const git = (...args: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: f.repo }).status, 0);
    git("add", ".gitignore");
    git("commit", "-qm", "ignore the data dir");
    const defaultStore = new LocalReceiptStore(join(f.repo, ".spf", "data", "receipts"));
    const { receipt } = await prove({ ...base(f), store: defaultStore, journeys: [spec({ run: "bash app.sh" })], recorder: new FakeRecorder() });
    assert.equal(receipt.verdict, "PASS", receipt.reason);
    assert.equal(receipt.revision.dirty, false);
  } finally {
    f.cleanup();
  }
});

// The #179 pilot's actual layout: in a `spf watch` worktree, `.spf/data` is a
// SYMLINK to the main checkout's data dir, so the default store sits "beyond
// a symbolic link" and git refuses an `:(exclude)` pathspec for it.
test("a store reached through a symlinked .spf/data (a spf watch worktree) still proves", async () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "spf-prove-symlinked-data-"));
  try {
    writeFileSync(join(f.repo, ".gitignore"), ".spf/data/\n");
    const git = (...args: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: f.repo }).status, 0);
    git("add", ".gitignore");
    git("commit", "-qm", "ignore the data dir");
    mkdirSync(join(f.repo, ".spf"), { recursive: true });
    symlinkSync(outside, join(f.repo, ".spf", "data"));
    const watchStore = new LocalReceiptStore(join(f.repo, ".spf", "data", "receipts"));

    const first = await prove({ ...base(f), store: watchStore, journeys: [spec({ run: "bash app.sh" })], recorder: new FakeRecorder() });
    assert.equal(first.receipt.verdict, "PASS", first.receipt.reason);
    // The evidence really lands in the linked directory, and writing it doesn't move the revision.
    const second = await prove({ ...base(f), store: watchStore, journeys: [spec({ run: "bash app.sh" })] });
    assert.equal(second.receipt.revision.tree, first.receipt.revision.tree);
    assert.ok(readFileSync(join(outside, "receipts", "demo", "attempts", "run-1", "1", "receipt.json")).byteLength > 0);
  } finally {
    f.cleanup();
    rmSync(outside, { recursive: true, force: true });
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
    const { receipt } = await prove({
      ...base(f),
      journeys: [
        spec({ run: "bash app.sh", expect: { exit: 0, output_contains: ["hello from app"] } }),
        // The #179 pilot's planner wrote `…; exit $code`: in the recorded interactive shell that closed the
        // terminal and every later command went nowhere. The journey after it must still be on the recording.
        spec({ id: "P02", kind: "unhappy", run: "bash app.sh --bad; exit 3", expect: { exit: 3 } }),
        spec({ id: "P03", run: "echo after-the-exit", expect: { exit: 0, output_contains: ["after-the-exit"] } }),
      ],
      recorder: new AgentBrowserTtydRecorder(),
    });
    assert.equal(receipt.verdict, "PASS", receipt.reason);
    const videoPath = join(f.storeDir, ...receipt.evidence.video.key.split("/"));
    const { duration_s, packets } = probeVideo(videoPath);
    assert.ok(duration_s >= 1 && packets > 0, `duration ${duration_s}, packets ${packets}`);
    assert.ok(readFileSync(join(f.storeDir, ...receipt.evidence.contact_sheet.key.split("/"))).byteLength > 0);
    const transcript = readFileSync(join(f.storeDir, ...receipt.evidence.transcript.key.split("/")), "utf-8");
    assert.match(transcript, /bash app\.sh/, "the terminal transcript shows the command that was typed");
    assert.match(transcript, /hello from app/, "…and its output");
    assert.match(transcript, /\$ echo after-the-exit\nafter-the-exit/, "a journey that exits doesn't close the recorded terminal");
  } finally {
    f.cleanup();
  }
});
