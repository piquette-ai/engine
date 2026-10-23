/** `core/journey_evidence.ts` (#235): the allowlist, caps, link/FIFO handling and the read-time re-check. */
import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectJourneyEvidence, evidenceLimits, MAX_DROPPED_NOTES_PER_JOURNEY, MAX_EVIDENCE_FILES_PER_JOURNEY, readEvidenceFile } from "../core/journey_evidence.js";

function dirs(names: string[]): { root: string; dirs: Record<string, string>; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "spf-evcol-"));
  const out: Record<string, string> = {};
  for (const n of names) {
    out[n] = join(root, n);
    mkdirSync(out[n]);
  }
  return { root, dirs: out, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const limits = evidenceLimits();

test("allowlist maps extensions to content types, case-insensitively", () => {
  const t = dirs(["P01"]);
  try {
    const want: Record<string, string> = { "a.mp4": "video/mp4", "a.webm": "video/webm", "a.mov": "video/quicktime", "a.png": "image/png", "a.jpg": "image/jpeg", "b.JPG": "image/jpeg", "c.jpeg": "image/jpeg", "a.gif": "image/gif", "a.txt": "text/plain; charset=utf-8", "a.log": "text/plain; charset=utf-8", "a.json": "application/json" };
    for (const n of Object.keys(want)) writeFileSync(join(t.dirs.P01, n), "x");
    const { files, dropped } = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }], limits);
    assert.deepEqual(dropped, []);
    assert.deepEqual(Object.fromEntries(files.map((f) => [f.rel, f.contentType])), want);
    assert.deepEqual(files.map((f) => f.rel), [...files.map((f) => f.rel)].sort());
  } finally {
    t.cleanup();
  }
});

test("html, svg and exe are dropped with a reason", () => {
  const t = dirs(["P01"]);
  try {
    for (const n of ["p.html", "i.svg", "x.exe"]) writeFileSync(join(t.dirs.P01, n), "x");
    const { files, dropped } = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }], limits);
    assert.equal(files.length, 0);
    assert.equal(dropped.length, 3);
    assert.ok(dropped.every((d) => /not allowed/.test(d.reason) && d.journey === "P01"));
  } finally {
    t.cleanup();
  }
});

test("per-file cap and per-receipt cap (first come, first kept)", () => {
  const t = dirs(["P01", "P02"]);
  try {
    writeFileSync(join(t.dirs.P01, "big.png"), Buffer.alloc(2 * 1024 * 1024));
    writeFileSync(join(t.dirs.P01, "ok.png"), Buffer.alloc(600 * 1024));
    writeFileSync(join(t.dirs.P02, "late.png"), Buffer.alloc(600 * 1024));
    const l = evidenceLimits({ max_file_mb: 1, max_total_mb: 1 });
    const { files, dropped } = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }, { id: "P02", dir: t.dirs.P02 }], l);
    assert.deepEqual(files.map((f) => `${f.journey}/${f.rel}`), ["P01/ok.png"]);
    assert.match(dropped.find((d) => d.file === "big.png")!.reason, /per-file cap \(receipts\.evidence\.max_file_mb\)/);
    assert.match(dropped.find((d) => d.file === "late.png")!.reason, /per-receipt cap \(receipts\.evidence\.max_total_mb\)/);
  } finally {
    t.cleanup();
  }
});

test("symlinked file and symlinked directory are dropped, never followed", () => {
  const t = dirs(["P01", "outside"]);
  try {
    writeFileSync(join(t.dirs.outside, "secret.txt"), "secret");
    symlinkSync(join(t.dirs.outside, "secret.txt"), join(t.dirs.P01, "link.txt"));
    symlinkSync(t.dirs.outside, join(t.dirs.P01, "linkdir"));
    const { files, dropped } = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }], limits);
    assert.equal(files.length, 0);
    assert.deepEqual(dropped.map((d) => d.reason), ["symlink", "symlink"]);
  } finally {
    t.cleanup();
  }
});

test("a FIFO is dropped and the walk does not hang", () => {
  const t = dirs(["P01"]);
  try {
    assert.equal(spawnSync("mkfifo", [join(t.dirs.P01, "pipe.log")]).status, 0);
    writeFileSync(join(t.dirs.P01, "ok.log"), "x");
    const { files, dropped } = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }], limits);
    assert.deepEqual(files.map((f) => f.rel), ["ok.log"]);
    assert.equal(dropped[0].reason, "not a regular file");
  } finally {
    t.cleanup();
  }
});

test("dotfiles, unsafe names and depth over 3 are dropped", () => {
  const t = dirs(["P01"]);
  try {
    writeFileSync(join(t.dirs.P01, ".hidden.png"), "x");
    writeFileSync(join(t.dirs.P01, "has space.png"), "x");
    mkdirSync(join(t.dirs.P01, "a/b/c/d"), { recursive: true });
    writeFileSync(join(t.dirs.P01, "a/b/c/ok.png"), "x");
    writeFileSync(join(t.dirs.P01, "a/b/c/d/deep.png"), "x");
    const { files, dropped } = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }], limits);
    assert.deepEqual(files.map((f) => f.rel), ["a/b/c/ok.png"]);
    assert.deepEqual(dropped.map((d) => d.file).sort(), [".hidden.png", "a/b/c/d", "has space.png"]);
  } finally {
    t.cleanup();
  }
});

test("more than 50 files for a journey are capped", () => {
  const t = dirs(["P01"]);
  try {
    for (let i = 0; i < MAX_EVIDENCE_FILES_PER_JOURNEY + 3; i++) writeFileSync(join(t.dirs.P01, `f${String(i).padStart(3, "0")}.txt`), "x");
    const { files, dropped } = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }], limits);
    assert.equal(files.length, MAX_EVIDENCE_FILES_PER_JOURNEY);
    assert.equal(dropped.length, 3);
  } finally {
    t.cleanup();
  }
});

test("allowed_types can only narrow; missing and empty directories yield nothing", () => {
  const t = dirs(["P01", "P02"]);
  try {
    writeFileSync(join(t.dirs.P01, "a.mp4"), "x");
    writeFileSync(join(t.dirs.P01, "a.png"), "x");
    const r = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }, { id: "P02", dir: t.dirs.P02 }, { id: "P03", dir: join(t.root, "missing") }], evidenceLimits({ allowed_types: ["png"] }));
    assert.deepEqual(r.files.map((f) => f.rel), ["a.png"]);
    assert.equal(r.dropped.length, 1);
    assert.equal(collectJourneyEvidence([{ id: "P02", dir: t.dirs.P02 }], limits).files.length, 0);
  } finally {
    t.cleanup();
  }
});

test("a file swapped for a symlink between the walk and the read is rejected (O_NOFOLLOW)", () => {
  const t = dirs(["P01", "outside"]);
  try {
    writeFileSync(join(t.dirs.P01, "a.txt"), "inside");
    writeFileSync(join(t.dirs.outside, "secret.txt"), "secret");
    const { files } = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }], limits);
    assert.equal(readEvidenceFile(files[0], limits).toString(), "inside");
    unlinkSync(files[0].abs);
    symlinkSync(join(t.dirs.outside, "secret.txt"), files[0].abs);
    assert.throws(() => readEvidenceFile(files[0], limits));
  } finally {
    t.cleanup();
  }
});

test("a file swapped for a FIFO between the walk and the read is rejected, not hung on (O_NONBLOCK)", () => {
  const t = dirs(["P01"]);
  try {
    writeFileSync(join(t.dirs.P01, "a.png"), "x");
    const { files } = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }], limits);
    unlinkSync(files[0].abs);
    assert.equal(spawnSync("mkfifo", [files[0].abs]).status, 0);
    // a blocking open would hang this child until the timeout kills it
    const code = `import { readEvidenceFile } from ${JSON.stringify(new URL("../core/journey_evidence.js", import.meta.url).href)};
      try { readEvidenceFile(${JSON.stringify(files[0])}, ${JSON.stringify({ maxFileBytes: 1000, maxTotalBytes: 1000, allowed: [] })}); console.log("read"); } catch (e) { console.log("rejected:" + e.message); }`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf-8", timeout: 10_000 });
    assert.equal(r.error, undefined, "the read must not hang");
    assert.match(r.stdout, /rejected:not a regular file/);
  } finally {
    t.cleanup();
  }
});

test("a directory swapped for a symlink between the walk and the read is rejected", () => {
  const t = dirs(["P01", "outside"]);
  try {
    mkdirSync(join(t.dirs.P01, "sub"));
    writeFileSync(join(t.dirs.P01, "sub", "a.txt"), "inside");
    writeFileSync(join(t.dirs.outside, "a.txt"), "SECRET-OUTSIDE");
    const { files } = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }], limits);
    assert.equal(files[0].rel, "sub/a.txt");
    renameSync(join(t.dirs.P01, "sub"), join(t.dirs.P01, "moved"));
    symlinkSync(t.dirs.outside, join(t.dirs.P01, "sub"));
    assert.throws(() => readEvidenceFile(files[0], limits), /outside the evidence directory/);
  } finally {
    t.cleanup();
  }
});

test("a hard link is dropped at the walk and rejected at the read", () => {
  const t = dirs(["P01", "outside"]);
  try {
    writeFileSync(join(t.dirs.outside, "secret.txt"), "secret");
    linkSync(join(t.dirs.outside, "secret.txt"), join(t.dirs.P01, "s.txt"));
    const walked = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }], limits);
    assert.deepEqual(walked.files, []);
    assert.deepEqual(walked.dropped.map((d) => [d.file, d.reason]), [["s.txt", "hard-linked file"]]);
    writeFileSync(join(t.dirs.P01, "ok.txt"), "ok");
    const { files } = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }], limits);
    unlinkSync(files[0].abs);
    linkSync(join(t.dirs.outside, "secret.txt"), files[0].abs);
    assert.throws(() => readEvidenceFile(files[0], limits), /hard-linked/);
  } finally {
    t.cleanup();
  }
});

test("dropped notes are capped per journey with one summary line", () => {
  const t = dirs(["P01"]);
  try {
    for (let i = 0; i < 100; i++) writeFileSync(join(t.dirs.P01, `f${i}.exe`), "x");
    const { dropped } = collectJourneyEvidence([{ id: "P01", dir: t.dirs.P01 }], limits);
    assert.equal(dropped.length, MAX_DROPPED_NOTES_PER_JOURNEY + 1);
    assert.match(dropped.at(-1)!.reason, /and 80 more not kept/);
  } finally {
    t.cleanup();
  }
});
