import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isSafeKey, parseRange, parseReceiptLoose, selectRun, viewerAssetPath, type ReceiptReader } from "../ui/server/receipt_reader.js";
import { LocalReceiptReader, receiptReaderFor } from "../ui/server/receipt_reader_node.js";
import { R2ReceiptReader } from "../ui/server/receipt_reader_r2.js";
import { fakeR2, receiptJson, runObjects, writeLocal, VIDEO, type FixtureObjects } from "./receipt_fixture.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "spf-receipt-reader-"));
const readerOf = (objects: FixtureObjects): ReceiptReader => new R2ReceiptReader(fakeR2(objects));

// ── parseRange ──────────────────────────────────────────────────────────────

test("parseRange: single ranges, clamping, suffix, open-ended", () => {
  assert.deepEqual(parseRange("bytes=10-19", 256), { kind: "partial", offset: 10, length: 10 });
  assert.deepEqual(parseRange("bytes=250-999", 256), { kind: "partial", offset: 250, length: 6 });
  assert.deepEqual(parseRange("bytes=100-", 256), { kind: "partial", offset: 100, length: 156 });
  assert.deepEqual(parseRange("bytes=-16", 256), { kind: "partial", offset: 240, length: 16 });
  assert.deepEqual(parseRange("bytes=-999", 256), { kind: "partial", offset: 0, length: 256 });
});

test("parseRange: unsatisfiable, ignored and empty-object cases", () => {
  assert.deepEqual(parseRange("bytes=256-", 256), { kind: "unsatisfiable" });
  assert.deepEqual(parseRange("bytes=999-1000", 256), { kind: "unsatisfiable" });
  assert.deepEqual(parseRange("bytes=-0", 256), { kind: "unsatisfiable" });
  assert.deepEqual(parseRange(undefined, 256), { kind: "full" });
  assert.deepEqual(parseRange("garbage", 256), { kind: "full" });
  assert.deepEqual(parseRange("bytes=0-1,5-6", 256), { kind: "full" });
  assert.deepEqual(parseRange("bytes=-", 256), { kind: "full" });
  assert.deepEqual(parseRange("bytes=0-9", 0), { kind: "full" });
  assert.deepEqual(parseRange("bytes=5-2", 256), { kind: "full" });
});

test("isSafeKey follows assertKey", () => {
  assert.equal(isSafeKey("a/b/c.mp4"), true);
  for (const bad of ["", "/a", "a/../b", "a//b", "a\\b", "./a"]) assert.equal(isSafeKey(bad), false, bad);
});

test("viewerAssetPath maps /r/assets/* back to /assets/* and ignores run pages", () => {
  assert.equal(viewerAssetPath("/r/assets/index-abc.js"), "/assets/index-abc.js");
  assert.equal(viewerAssetPath("/r/favicon.svg"), "/favicon.svg");
  assert.equal(viewerAssetPath("/r/issue-198"), null);
  assert.equal(viewerAssetPath("/assets/index-abc.js"), null);
});

// ── parseReceiptLoose ───────────────────────────────────────────────────────

test("parseReceiptLoose accepts a receipt and rejects the wrong schema, run_id, stage and bad JSON", () => {
  const good = receiptJson({ repo: "r", runId: "run-1", attempt: 1, stage: "base" }).json;
  assert.equal(parseReceiptLoose(good, "run-1")?.attempt, 1);
  assert.equal(parseReceiptLoose(good, "other"), null);
  assert.equal(parseReceiptLoose("{not json", "run-1"), null);
  assert.equal(parseReceiptLoose(good.replace("spf.receipt/v1", "spf.receipt/v9"), "run-1"), null);
  assert.equal(parseReceiptLoose(good.replace('"stage":"base"', '"stage":"mid"'), "run-1"), null);
  assert.equal(parseReceiptLoose(good.replace('"attempt":1', '"attempt":1.5'), "run-1"), null);
  assert.equal(parseReceiptLoose(JSON.stringify({ ...JSON.parse(good), evidence: [] }), "run-1"), null);
  assert.equal(parseReceiptLoose("null", "run-1"), null);
});

// ── selectRun ───────────────────────────────────────────────────────────────

function runWith(stages: Array<"base" | "head">, repo = "r", runId = "run-1", root: "attempts" | "kept" = "attempts"): FixtureObjects {
  const out: FixtureObjects = {};
  stages.forEach((stage, i) => {
    out[`${repo}/${root}/${runId}/${i + 1}/receipt.json`] = receiptJson({ repo, runId, attempt: i + 1, stage }).json;
  });
  return out;
}

test("selectRun: base 1 / head 2", async () => {
  const run = await selectRun(readerOf(runWith(["base", "head"])), "run-1");
  assert.ok(run && !("conflict" in run));
  assert.equal(run.repo, "r");
  assert.equal(run.base?.attempt, 1);
  assert.equal(run.head?.attempt, 2);
  assert.deepEqual(run.attempts.map((a) => a.attempt), [1, 2]);
});

test("selectRun: alternating head 1 / base 2 / head 3 gives head 3 and base 2", async () => {
  const run = await selectRun(readerOf(runWith(["head", "base", "head"])), "run-1");
  assert.ok(run && !("conflict" in run));
  assert.equal(run.head?.attempt, 3);
  assert.equal(run.base?.attempt, 2);
});

test("selectRun: head only has no base; unknown run is null", async () => {
  const reader = readerOf(runWith(["head"]));
  const run = await selectRun(reader, "run-1");
  assert.ok(run && !("conflict" in run));
  assert.equal(run.base, null);
  assert.equal(await selectRun(reader, "nope"), null);
});

test("selectRun: a malformed attempt is skipped", async () => {
  const objects = runWith(["base", "head"]);
  objects["r/attempts/run-1/1/receipt.json"] = "{broken";
  const run = await selectRun(readerOf(objects), "run-1");
  assert.ok(run && !("conflict" in run));
  assert.equal(run.base, null);
  assert.equal(run.head?.attempt, 2);
});

test("selectRun: kept/ fallback rewrites evidence keys and allows them", async () => {
  const objects = runObjects("r", "run-1", "kept");
  const run = await selectRun(readerOf(objects), "run-1");
  assert.ok(run && !("conflict" in run));
  assert.equal(run.head?.receipt.evidence["video"].key, "r/kept/run-1/2/video.mp4");
  assert.ok(run.allowed.has("r/kept/run-1/2/video.mp4"));
  assert.ok(run.allowed.has("r/kept/run-1/2/receipt.json"));
  assert.ok(!run.allowed.has("r/attempts/run-1/2/video.mp4"));
  assert.ok(!run.allowed.has("r/kept/run-1/2/secret.txt"));
});

test("selectRun: evidence keys outside the run's prefix are not allowed", async () => {
  const objects = runWith(["head"]);
  const forged = JSON.parse(objects["r/attempts/run-1/1/receipt.json"] as string);
  forged.evidence.video.key = "r/attempts/other-run/1/video.mp4";
  forged.evidence.poster = { key: "r/attempts/run-1/../../x", content_type: "x", bytes: 1, sha256: "0".repeat(64) };
  objects["r/attempts/run-1/1/receipt.json"] = JSON.stringify(forged);
  const run = await selectRun(readerOf(objects), "run-1");
  assert.ok(run && !("conflict" in run));
  assert.deepEqual([...run.allowed.keys()], ["r/attempts/run-1/1/receipt.json", "r/attempts/run-1/1/terminal.txt"]);
});

test("selectRun: two repos conflict, repo= resolves", async () => {
  const reader = readerOf({ ...runWith(["head"], "a"), ...runWith(["head"], "b") });
  const clash = await selectRun(reader, "run-1");
  assert.deepEqual(clash, { conflict: ["a", "b"] });
  const run = await selectRun(reader, "run-1", "b");
  assert.ok(run && !("conflict" in run));
  assert.equal(run.repo, "b");
});

// ── LocalReceiptReader ──────────────────────────────────────────────────────

test("LocalReceiptReader: exact range bytes, head, list, repos, text", async () => {
  const root = tmp();
  try {
    writeLocal(root, runObjects("r", "run-1"));
    const reader = new LocalReceiptReader(root);
    assert.deepEqual(await reader.repos(), ["r"]);
    const key = "r/attempts/run-1/2/video.mp4";
    assert.deepEqual(await reader.head(key), { size: 256, contentType: "video/mp4" });
    const got = await reader.get(key, { offset: 10, length: 10 });
    assert.ok(got);
    assert.equal(got.size, 256);
    const bytes = new Uint8Array(await new Response(got.body).arrayBuffer());
    assert.deepEqual([...bytes], [...VIDEO.subarray(10, 20)]);
    assert.equal(await reader.text("r/attempts/run-1/2/terminal.txt"), "hello");
    assert.equal(await reader.text("r/attempts/run-1/9/terminal.txt"), null);
    assert.equal(await reader.get("r/attempts/run-1/9/video.mp4"), null);
    assert.equal((await reader.list("r/attempts/run-1/")).length, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LocalReceiptReader: traversal and absolute keys throw", async () => {
  const root = tmp();
  try {
    const reader = new LocalReceiptReader(root);
    for (const key of ["../x", "a/../../x", "/etc/passwd", "a\\b"]) {
      await assert.rejects(reader.get(key), /receipt store key/, key);
      await assert.rejects(reader.head(key), /receipt store key/, key);
      await assert.rejects(reader.text(key), /receipt store key/, key);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LocalReceiptReader: a root reached through a symlink works", async () => {
  const base = tmp();
  try {
    const real = path.join(base, "real");
    writeLocal(real, runObjects("r", "run-1"));
    const link = path.join(base, "link");
    symlinkSync(real, link);
    const reader = new LocalReceiptReader(link);
    assert.deepEqual(await reader.repos(), ["r"]);
    const run = await selectRun(reader, "run-1");
    assert.ok(run && !("conflict" in run));
    assert.equal(run.head?.attempt, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── R2ReceiptReader ─────────────────────────────────────────────────────────

test("R2ReceiptReader: prefix is stripped, repos paginate, range passes through as {offset,length}", async () => {
  const objects: FixtureObjects = {};
  for (const [k, v] of Object.entries({ ...runObjects("a", "run-1"), ...runObjects("b", "run-1"), ...runObjects("c", "run-1") })) objects[`team/${k}`] = v;
  objects["other/x/attempts/run-1/1/receipt.json"] = "{}"; // outside the prefix
  const bucket = fakeR2(objects, 1);
  const reader = new R2ReceiptReader(bucket, { prefix: "/team/" });
  assert.deepEqual(await reader.repos(), ["a", "b", "c"]);
  assert.ok((await reader.list("a/attempts/run-1/")).every((k) => k.startsWith("a/attempts/run-1/")));
  assert.equal((await reader.list("a/attempts/run-1/")).length, 7);
  const got = await reader.get("a/attempts/run-1/2/video.mp4", { offset: 10, length: 10 });
  assert.ok(got);
  assert.equal(got.size, 256);
  assert.deepEqual(bucket.calls.get.at(-1), { key: "team/a/attempts/run-1/2/video.mp4", range: { offset: 10, length: 10 } });
  assert.deepEqual([...new Uint8Array(await new Response(got.body).arrayBuffer())], [...VIDEO.subarray(10, 20)]);
  assert.deepEqual(await reader.head("a/attempts/run-1/2/video.mp4"), { size: 256, etag: "etag-team/a/attempts/run-1/2/video.mp4", contentType: "video/mp4" });
  await reader.get("a/attempts/run-1/2/video.mp4");
  assert.equal(bucket.calls.get.at(-1)?.range, undefined);
  assert.equal(await reader.get("a/attempts/run-1/9/video.mp4"), null);
  await assert.rejects(reader.get("../x"));
});

// ── receiptReaderFor ────────────────────────────────────────────────────────

test("receiptReaderFor: default path, configured relative path, symlinked data dir", () => {
  const repo = tmp();
  try {
    // default, nothing there yet: still a reader (an empty store), at the default path
    const none = receiptReaderFor(undefined, repo);
    assert.ok(none.reader);
    assert.equal(none.note, path.resolve(repo, ".spf/data/receipts"));

    const custom = receiptReaderFor({ receipts: { store: { kind: "local", path: "my/receipts" }, max_failed_proofs: 3, record: true, poster_max_mb: 5 } }, repo);
    assert.equal(custom.reader?.location, path.resolve(repo, "my/receipts"));

    // a worktree's .spf/data is a symlink to the real data dir
    const real = path.join(repo, "real-data");
    mkdirSync(path.join(real, "receipts"), { recursive: true });
    mkdirSync(path.join(repo, ".spf"), { recursive: true });
    symlinkSync(real, path.join(repo, ".spf", "data"));
    const linked = receiptReaderFor(undefined, repo);
    assert.equal(linked.reader?.location, path.join(realpathOf(repo), "real-data", "receipts"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

import { realpathSync } from "node:fs";
const realpathOf = (p: string) => realpathSync(p);

test("receiptReaderFor: an s3 store with missing env is {reader: null} and does not throw", () => {
  const saved = { id: process.env["SPF_TEST_KEY_ID"], secret: process.env["SPF_TEST_SECRET"] };
  delete process.env["SPF_TEST_KEY_ID"];
  delete process.env["SPF_TEST_SECRET"];
  try {
    const out = receiptReaderFor(
      {
        receipts: {
          store: {
            kind: "s3",
            bucket: "bkt",
            region: "auto",
            endpoint: "https://example.invalid",
            prefix: "",
            access_key_id_env: "SPF_TEST_KEY_ID",
            secret_access_key_env: "SPF_TEST_SECRET",
            session_token_env: "SPF_TEST_TOKEN",
          },
          max_failed_proofs: 3,
          record: true,
          poster_max_mb: 5,
        },
      },
      "/tmp",
    );
    assert.equal(out.reader, null);
    assert.match(out.note, /SPF_TEST_KEY_ID/);
  } finally {
    if (saved.id !== undefined) process.env["SPF_TEST_KEY_ID"] = saved.id;
    if (saved.secret !== undefined) process.env["SPF_TEST_SECRET"] = saved.secret;
  }
});

// ── Worker safety ───────────────────────────────────────────────────────────

test("worker-path files import nothing from node:* and only hono / the pure reader / the node-free key rules", () => {
  const dist = path.join(import.meta.dirname, "..", "ui", "server");
  const allowed = new Set(["hono", "./receipt_reader.js", "../../core/receipt_keys.js"]);
  for (const name of ["receipt_reader", "receipt_routes", "receipt_reader_r2"]) {
    const src = readFileSync(path.join(dist, `${name}.js`), "utf-8");
    assert.ok(!src.includes("node:"), `${name}.js mentions node:`);
    const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    for (const spec of specs) assert.ok(allowed.has(spec), `${name}.js imports ${spec}`);
  }
  // receipt_keys is itself node-free
  const keys = readFileSync(path.join(dist, "..", "..", "core", "receipt_keys.js"), "utf-8");
  assert.ok(!keys.includes("node:") && !/\bimport\b/.test(keys));
});
