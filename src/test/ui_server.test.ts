/**
 * Route-parity regression test for the Bun.serve -> Hono port. Builds a real
 * spf.db (via the tracer, not a fixture file) and drives runUi() with real
 * HTTP requests — the same shape as the manual verification this port was
 * checked against, kept as a regression guard rather than a one-off.
 */
import "./hermetic_git.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Tracer } from "../core/tracer.js";
import { makeEventRecord } from "../core/data_types.js";
import { runUi, type UiHandle } from "../ui/server/serve.js";
import { parseRepoSlug } from "../ui/server/repo.js";
import { LocalReceiptReader } from "../ui/server/receipt_reader_node.js";
import { runObjects, writeLocal } from "./receipt_fixture.js";

let dir: string;
let handle: UiHandle;
let dbPath: string;
let webDir: string;
const ADW_ID = "t1";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "spf-ui-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // -c user.*, not a global git config: this must pass in a fresh CI runner
  // with no git identity configured at all, not just on a dev machine that
  // already has one.
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=spf tests", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: dir },
  );

  dbPath = join(dir, "spf.db");
  const tracer = await Tracer.open(dbPath, join(dir, "sessions", ADW_ID, "events.jsonl"));
  await tracer.sessionStart(ADW_ID, "tester", "quality");
  const phase = {
    phase_id: `${ADW_ID}_01_request`,
    adw_id: ADW_ID,
    seq: 1,
    params: { name: "request", kind: "engineer" as const, owner: "tester", description: "seed phase", retries: 0 },
    status: "success" as const,
    attempt: 0,
    error: null,
    started_at: null,
    ended_at: null,
  };
  await tracer.phaseUpsert(phase);
  await tracer.event(makeEventRecord({ adw_id: ADW_ID, phase_id: phase.phase_id, type: "log", name: "request", payload: { input: "seed" } }));
  await tracer.sessionFinish(ADW_ID, true);
  await tracer.close();

  // dist/test/ui_server.test.js -> dist -> package root -> web
  webDir = join(import.meta.dirname, "..", "..", "web");
  handle = await runUi({ db: { kind: "sqlite", path: dbPath }, webDir, project: "demo-project", repo: "acme/demo", port: 0, open: false });
});

after(async () => {
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string, init?: RequestInit): Promise<{ status: number; body: any; contentType: string }> {
  const res = await fetch(handle.url + path, init);
  const contentType = res.headers.get("content-type") ?? "";
  const body: any = contentType.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body, contentType };
}

test("host defaults to loopback; an explicit host is honored in both the bind and the printed url", async () => {
  // Default: no host passed at all (distinct from the `before()` handle,
  // which is also loopback-default — this proves the omission path, not
  // just that 127.0.0.1 happens to work).
  const defaultHandle = await runUi({ db: { kind: "sqlite", path: dbPath }, webDir, port: 0, open: false });
  try {
    assert.match(defaultHandle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await defaultHandle.close();
  }

  // Explicit host, distinct from the hardcoded default's literal string
  // ("localhost", not "127.0.0.1") — proves `host` is actually threaded
  // into the listen() call and the printed url, not silently ignored.
  // NOT 127.0.0.2: that's only auto-aliased to loopback on some OSes
  // (EADDRNOTAVAIL elsewhere) — "localhost" resolves to loopback everywhere.
  const customHandle = await runUi({ db: { kind: "sqlite", path: dbPath }, webDir, port: 0, host: "localhost", open: false });
  try {
    assert.equal(customHandle.url, `http://localhost:${customHandle.port}`);
    const res = await fetch(customHandle.url + "/api/health");
    assert.equal(res.status, 200);
    // No project passed: the field is omitted rather than empty.
    const json = (await res.json()) as object;
    assert.equal("project" in json, false);
    assert.equal("repo" in json, false);
  } finally {
    await customHandle.close();
  }
});

test("GET /api/health reports the real db path and session count", async () => {
  const { status, body } = await get("/api/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.journal_mode, "wal");
  assert.equal(body.sessions, 1);
  assert.equal(body.project, "demo-project");
  assert.equal(body.repo, "acme/demo");
});

test("GET /api/sessions lists the seeded session", async () => {
  const { status, body } = await get("/api/sessions");
  assert.equal(status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].adw_id, ADW_ID);
});

test("GET /api/sessions/:adw_id returns detail; unknown id 404s as JSON", async () => {
  const ok = await get(`/api/sessions/${ADW_ID}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.session.adw_id, ADW_ID);

  const missing = await get("/api/sessions/does-not-exist");
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no session/);
});

test("POST /api/sessions/:adw_id/archive persists; GET on the same route 404s instead of falling through to the SPA", async () => {
  const post = await get(`/api/sessions/${ADW_ID}/archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(post.status, 200);
  assert.equal(post.body.archived, true);

  const afterArchive = await get("/api/sessions");
  assert.equal(afterArchive.body.length, 0, "archived sessions are excluded from the default list");

  const getOnArchive = await get(`/api/sessions/${ADW_ID}/archive`);
  assert.equal(getOnArchive.status, 404, "the deliberate behavior change from the Bun version: no silent SPA fallback here");
  assert.match(getOnArchive.contentType, /json/);
});

test("unsafe path segments (dot-segments, encoded percent) are rejected, never resolved onto disk", async () => {
  const encodedDotDot = await get(`/api/sessions/${ADW_ID}/agents/%2e%2e/prompts`);
  assert.equal(encodedDotDot.status, 404); // Hono's router normalizes this away before it reaches the handler

  const encodedPercent = await get(`/api/sessions/%2520/agents/x/prompts`);
  assert.equal(encodedPercent.status, 400);
  assert.match(encodedPercent.body.error, /invalid/);
});

test("unknown /api/* route 404s as JSON, not the SPA", async () => {
  const { status, contentType } = await get("/api/nope");
  assert.equal(status, 404);
  assert.match(contentType, /json/);
});

test("a non-API route serves the SPA's index.html (client-side routing fallback)", async () => {
  const { status, contentType, body } = await get("/some/client/route");
  assert.equal(status, 200);
  assert.match(contentType, /html/);
  assert.match(body, /<div id="app">/);
});

test("static assets are served with immutable caching; index.html is not", async () => {
  const index = await fetch(handle.url + "/");
  assert.equal(index.headers.get("cache-control"), "no-store");

  const html = await index.text();
  const assetMatch = html.match(/src="([^"]+\.js)"/);
  assert.ok(assetMatch, "index.html must reference a built JS asset");
  const asset = await fetch(handle.url + "/" + assetMatch[1].replace(/^\.\//, ""));
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
});

test("parseRepoSlug handles https, ssh, scp-style and junk remotes", () => {
  assert.equal(parseRepoSlug("https://github.com/acme/demo.git"), "acme/demo");
  assert.equal(parseRepoSlug("git@github.com:acme/demo.git\n"), "acme/demo");
  assert.equal(parseRepoSlug("ssh://git@bitbucket.org/acme/demo"), "acme/demo");
  assert.equal(parseRepoSlug("https://gitlab.com/g/sub/demo.git"), "g/sub/demo");
  assert.equal(parseRepoSlug("https://user:token@github.com/acme/demo.git"), "acme/demo");
  assert.equal(parseRepoSlug("ssh://git@host.example:2222/acme/demo.git/"), "acme/demo");
  assert.equal(parseRepoSlug("github.com:acme/demo.git"), "acme/demo");
  assert.equal(parseRepoSlug("https://dev.azure.com/org/proj/_git/demo"), "org/proj/demo");
  assert.equal(parseRepoSlug("git@ssh.dev.azure.com:v3/org/proj/demo"), "org/proj/demo");
  assert.equal(parseRepoSlug("org@vs-ssh.visualstudio.com:v3/org/proj/demo"), "org/proj/demo");
  // "v3" is only stripped on Azure hosts; elsewhere it is a real owner.
  assert.equal(parseRepoSlug("git@github.com:v3/demo.git"), "v3/demo");
  assert.equal(parseRepoSlug("https://gitlab.com/g/sub/deeper/demo.git"), "g/sub/deeper/demo");
  assert.equal(parseRepoSlug("/local/path"), undefined);
  assert.equal(parseRepoSlug("C:/src/acme/demo"), undefined);
  assert.equal(parseRepoSlug("file:///srv/git/acme/demo.git"), undefined);
  assert.equal(parseRepoSlug("https://github.com/acme"), undefined);
  assert.equal(parseRepoSlug(""), undefined);
});

// ── receipts viewer (#202) ───────────────────────────────────────────────────

test("receipts: /api/receipts, Range 206, and /r/<id> serve over real HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "spf-ui-receipts-"));
  writeLocal(root, runObjects("r", "run-1"));
  const withReceipts = await runUi({ db: { kind: "sqlite", path: dbPath }, webDir, port: 0, open: false, receipts: new LocalReceiptReader(root) });
  try {
    const run = await fetch(withReceipts.url + "/api/receipts/run-1");
    assert.equal(run.status, 200);
    assert.equal(((await run.json()) as { attempts: unknown[] }).attempts.length, 2);

    const key = encodeURIComponent("r/attempts/run-1/2/video.mp4");
    const ranged = await fetch(`${withReceipts.url}/api/receipts/run-1/file?key=${key}`, { headers: { range: "bytes=10-19" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 10-19/256");
    assert.equal((await ranged.arrayBuffer()).byteLength, 10);

    // the SPA answers the viewer path, and its relative assets resolve to the real files
    const page = await fetch(withReceipts.url + "/r/run-1");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /<div id="app"/);
    const asset = readdirSync(join(webDir, "assets"))[0];
    const served = await fetch(`${withReceipts.url}/r/assets/${asset}`);
    assert.equal(served.status, 200);
    assert.doesNotMatch(served.headers.get("content-type") ?? "", /text\/html/);
  } finally {
    await withReceipts.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipts: no reader means 404 'no receipt store', not the SPA and not a crash", async () => {
  const res = await get("/api/receipts/run-1");
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "no receipt store" });
});
