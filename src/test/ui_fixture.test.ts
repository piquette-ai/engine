/**
 * core/ui_fixture.ts (#4): the loopback fixture server and the agent-browser
 * session wrapper that a repo-level proof script composes to drive real
 * client JS outside the app it ships in. See
 * assets/skill/cookbooks/authoring_proof_scripts.md for the worked example
 * this exists to support.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentBrowserSession, spawnCapture, startFixtureServer } from "../core/ui_fixture.ts";

test("startFixtureServer serves index.html at '/', serves nested files by path, and 404s on a miss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-fixture-"));
  writeFileSync(join(dir, "index.html"), "<html><body>hi</body></html>");
  writeFileSync(join(dir, "app.js"), "console.log('x')");
  const server = await startFixtureServer(dir);
  try {
    const index = await fetch(`${server.url}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await index.text(), "<html><body>hi</body></html>");

    const script = await fetch(`${server.url}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /text\/javascript/);

    const missing = await fetch(`${server.url}/nope.txt`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startFixtureServer's onRequest mocks a route before static lookup falls through for everything else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-fixture-"));
  writeFileSync(join(dir, "index.html"), "real file");
  const server = await startFixtureServer(dir, {
    onRequest(req, res) {
      if (req.method === "POST" && req.url === "/api/mocked") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return true;
      }
      return false;
    },
  });
  try {
    const mocked = await fetch(`${server.url}/api/mocked`, { method: "POST" });
    assert.deepEqual(await mocked.json(), { ok: true });

    const real = await fetch(`${server.url}/`);
    assert.equal(await real.text(), "real file");
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startFixtureServer never serves a path that escapes rootDir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-fixture-"));
  writeFileSync(join(dir, "index.html"), "ok");
  const server = await startFixtureServer(dir);
  try {
    const escape = await fetch(`${server.url}/../${join(tmpdir())}/does-not-matter`);
    assert.equal(escape.status, 404);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startFixtureServer's close() actually stops the server — a later request fails to connect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-fixture-"));
  writeFileSync(join(dir, "index.html"), "ok");
  const server = await startFixtureServer(dir);
  await server.close();
  await assert.rejects(() => fetch(`${server.url}/`));
  rmSync(dir, { recursive: true, force: true });
});

test("spawnCapture resolves with trimmed stdout on a clean exit", async () => {
  const out = await spawnCapture(process.execPath, ["-e", "console.log('  hello  ')"], "node -e", 5_000);
  assert.equal(out, "hello");
});

test("spawnCapture rejects with the command's last output lines on a nonzero exit", async () => {
  await assert.rejects(
    () => spawnCapture(process.execPath, ["-e", "console.error('line one'); console.error('line two'); process.exit(2)"], "node -e", 5_000),
    /node -e exited 2: line one line two/,
  );
});

test("spawnCapture rejects when the binary itself can't be found", async () => {
  await assert.rejects(() => spawnCapture("piquette-ui-fixture-does-not-exist", [], "missing binary", 5_000), /missing binary/);
});

test("agentBrowserSession.run passes the session id and args through to the injected exec, with the default timeout", async () => {
  const calls: Array<{ args: string[]; what: string; timeoutMs: number }> = [];
  const session = agentBrowserSession("sess-1", {
    run: async (args, what, timeoutMs) => {
      calls.push({ args, what, timeoutMs });
      return "ok";
    },
  });
  assert.equal(session.id, "sess-1");
  const result = await session.run(["open", "http://example.com"], "open");
  assert.equal(result, "ok");
  assert.deepEqual(calls, [{ args: ["open", "http://example.com"], what: "open", timeoutMs: 20_000 }]);
});

test("agentBrowserSession.waitFor polls until the injected exec's stdout matches, then stops", async () => {
  let reads = 0;
  const session = agentBrowserSession("sess-2", {
    run: async () => {
      reads += 1;
      return reads < 3 ? "false" : "true";
    },
  });
  await session.waitFor("document.querySelector('x').disabled", "true", "read disabled", 2_000, 5);
  assert.equal(reads, 3);
});

test("agentBrowserSession.waitFor throws with the last-read value once the timeout passes", async () => {
  const session = agentBrowserSession("sess-3", { run: async () => "still-false" });
  await assert.rejects(
    () => session.waitFor("whatever", "true", "read flag", 30, 10),
    /read flag: never became "true" within 30ms \(last read: "still-false"\)/,
  );
});

test("agentBrowserSession.close() calls close on the session and swallows a failure", async () => {
  const calls: string[][] = [];
  const session = agentBrowserSession("sess-4", {
    run: async (args) => {
      calls.push(args);
      throw new Error("agent-browser not running");
    },
  });
  await session.close(); // must not throw
  assert.deepEqual(calls, [["close"]]);
});
