/**
 * Loopback fixture server + agent-browser session helper, for proof scripts
 * that need to exercise real client code outside the app it ships in: render
 * fixture markup with the app's own real renderer, serve it and its real
 * client JS from a scratch directory, drive it with a real browser, and read
 * real DOM state back — the thing a CSS/string check on rendered HTML can
 * never see (#4; see assets/skill/cookbooks/authoring_proof_scripts.md for
 * the full pattern and a worked example).
 *
 * Both halves exist because of a non-obvious failure mode found building one
 * of these the hard way: calling `agent-browser` with a SYNCHRONOUS spawn
 * from the same process that's also running the fixture's own HTTP server
 * deadlocks. A sync spawn blocks that process's one thread entirely, so the
 * in-process server can never answer the browser's request while the sync
 * call sits there waiting for the browser to finish — confirmed by
 * elimination (ruled out sandboxing; ruled out loopback/network issues, since
 * an independently-running server answered agent-browser fine). This is NOT
 * a problem for core/recorder.ts's own (synchronous) agent-browser calls
 * against ttyd: ttyd is a separate OS process there, so blocking this
 * thread never stops it answering on its own. The invariant is specific to
 * an in-process, same-event-loop server — which is exactly what a fixture
 * like this one is. Every agent-browser call here uses async `spawn` for
 * that reason; don't change it to `spawnSync`.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

export interface FixtureServer {
  /** e.g. "http://127.0.0.1:54321" — no trailing slash. */
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface FixtureServerOptions {
  /**
   * Runs before static lookup — for a route the fixture has no real file
   * for, such as a backend call the app under test makes (a POST the page's
   * own script sends, say). Return true once the response has been fully
   * written and ended; anything else falls through to static serving from
   * `rootDir`.
   */
  onRequest?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
}

/**
 * Serves `rootDir` on a free loopback port. Async by construction — see this
 * module's own doc comment for why that matters when the same process also
 * drives an `agentBrowserSession` against it. Files can be written into
 * `rootDir` any time before the request that needs them; nothing is cached
 * at startup.
 */
export async function startFixtureServer(rootDir: string, options: FixtureServerOptions = {}): Promise<FixtureServer> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (options.onRequest && (await options.onRequest(req, res))) return;
        const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://fixture").pathname);
        const resolved = path.join(rootDir, pathname === "/" ? "index.html" : pathname);
        const inRoot = resolved === rootDir || resolved.startsWith(rootDir + path.sep);
        if (inRoot && existsSync(resolved) && statSync(resolved).isFile()) {
          res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream" });
          res.end(readFileSync(resolved));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      } catch (error) {
        res.writeHead(500);
        res.end((error as Error).message);
      }
    })();
  });
  const port = await freePort();
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** MUST stay async spawn — see this module's own doc comment. */
export function spawnCapture(cmd: string, args: string[], what: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => reject(new Error(`${what}: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = (stderr || stdout).trim().split("\n").slice(-3).join(" ");
        reject(new Error(`${what} exited ${code}${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export interface AgentBrowserSession {
  readonly id: string;
  /** One `agent-browser --session <id> <args...>` call. Resolves to stdout, trimmed; rejects with the command's last output lines on a nonzero exit. */
  run(args: string[], what: string, timeoutMs?: number): Promise<string>;
  /**
   * Polls `eval <js>` until its stdout equals `want`, or throws after
   * `timeoutMs`. For a page's own async init (a fetch, an SDK load
   * resolving) — a condition a fixed `wait` can only guess the length of.
   *
   * `agent-browser eval` JSON-encodes whatever the expression evaluates to
   * (same as core/recorder.ts's own eval helper relies on), so a string
   * result comes back quoted — compare against `JSON.stringify(expected)`,
   * not the bare value, or this never matches.
   */
  waitFor(js: string, want: string, what: string, timeoutMs: number, pollMs?: number): Promise<void>;
  /** Best-effort `agent-browser --session <id> close` — never throws. */
  close(): Promise<void>;
}

export interface AgentBrowserSessionOptions {
  /** Replaces the real `agent-browser` spawn entirely — tests only; real proof scripts never set this. */
  run?: (args: string[], what: string, timeoutMs: number) => Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** A session id unique enough that concurrent proof scripts on the same machine don't collide. */
export function agentBrowserSession(id: string = `piquette-fixture-${process.pid}-${Date.now()}`, options: AgentBrowserSessionOptions = {}): AgentBrowserSession {
  const exec = options.run ?? ((args, what, timeoutMs) => spawnCapture("agent-browser", ["--session", id, ...args], what, timeoutMs));
  const run = (args: string[], what: string, timeoutMs = DEFAULT_TIMEOUT_MS) => exec(args, what, timeoutMs);
  return {
    id,
    run,
    async waitFor(js, want, what, timeoutMs, pollMs = 150) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const actual = await run(["eval", js], what, timeoutMs);
        if (actual === want) return;
        if (Date.now() > deadline) {
          throw new Error(`${what}: never became ${JSON.stringify(want)} within ${timeoutMs}ms (last read: ${JSON.stringify(actual)})`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
    async close() {
      try {
        await run(["close"], "close");
      } catch {
        /* best effort */
      }
    },
  };
}
