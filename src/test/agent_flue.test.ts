import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { resetModelsForTests } from "@flue/runtime/internal";
import { createWebFetchTool, isKnownToolName, registrySizeForTest, resolveModel, run, stripHtml, ToolCallTracker } from "../core/agent_flue.js";
import { registerOllamaModel, resetOllamaRegistrationForTest } from "../core/ollama_provider.js";
import type { Sandbox } from "@flue/runtime";

test("resolveModel: accepts provider/model-id, rejects anything else", () => {
  assert.deepEqual(resolveModel("openrouter/google/gemini-3.6-flash"), ["openrouter", "google/gemini-3.6-flash"]);
  assert.deepEqual(resolveModel("openai/gpt-5.6-terra"), ["openai", "gpt-5.6-terra"]);
  assert.throws(() => resolveModel("gpt-5.6-terra"), /must be written as provider\/model-id/);
  assert.throws(() => resolveModel("/gpt-5.6-terra"), /must be written as provider\/model-id/);
  assert.throws(() => resolveModel("openai/"), /must be written as provider\/model-id/);
});

test("isKnownToolName: pi vocabulary maps onto Flue's seven builtins, ls is known-but-dropped, typos are unknown", () => {
  for (const name of ["read", "write", "edit", "bash", "grep", "glob", "webfetch"]) {
    assert.equal(isKnownToolName(name), true, name);
  }
  assert.equal(isKnownToolName("find"), true, "find aliases to glob");
  assert.equal(isKnownToolName("ls"), true, "ls is a known name, just dropped");
  assert.equal(isKnownToolName("subagent_create"), false, "harness_engineering-only names are unknown here");
  assert.equal(isKnownToolName("bogus"), false);
});

// ── createWebFetchTool ───────────────────────────────────────────────────

/** Only `exec` is exercised by createWebFetchTool — every other Sandbox method is unused and left unimplemented. */
function fakeSandbox(exec: Sandbox["exec"]): Sandbox {
  return { exec } as unknown as Sandbox;
}

function fakeToolContext(url: string) {
  return { toolCallId: "t1", log: { info() {}, warn() {}, error() {} }, data: { url } };
}

test("stripHtml: drops script/style blocks and tags, decodes entities, collapses whitespace", () => {
  const html = "<html><head><style>.x{}</style><script>alert(1)</script></head><body><p>Hello &amp; welcome</p>\n\n\n<p>Bye</p></body></html>";
  assert.equal(stripHtml(html), "Hello & welcome\n\nBye");
});

test("stripHtml: passes plain text/JSON through essentially unchanged", () => {
  assert.equal(stripHtml('{"a": 1}'), '{"a": 1}');
});

test("createWebFetchTool: rejects a non-http(s) URL without ever calling exec", async () => {
  let execCalled = false;
  const tool = createWebFetchTool(fakeSandbox(async () => {
    execCalled = true;
    return { stdout: "", stderr: "", exitCode: 0 };
  }));
  const result = await tool.run(fakeToolContext("file:///etc/passwd") as any);
  assert.equal(execCalled, false);
  assert.match(String(result), /unsupported scheme/);
});

test("createWebFetchTool: rejects an unparseable URL without ever calling exec", async () => {
  let execCalled = false;
  const tool = createWebFetchTool(fakeSandbox(async () => {
    execCalled = true;
    return { stdout: "", stderr: "", exitCode: 0 };
  }));
  const result = await tool.run(fakeToolContext("not a url") as any);
  assert.equal(execCalled, false);
  assert.match(String(result), /not a valid URL/);
});

test("createWebFetchTool: a successful fetch runs curl/wget through env.exec and returns cleaned text", async () => {
  let seenCommand = "";
  const tool = createWebFetchTool(fakeSandbox(async (command) => {
    seenCommand = command;
    return { stdout: "<p>Hello &amp; welcome</p>", stderr: "", exitCode: 0 };
  }));
  const result = await tool.run(fakeToolContext("https://example.com/docs") as any);
  assert.equal(result, "Hello & welcome");
  assert.match(seenCommand, /curl/);
  assert.match(seenCommand, /'https:\/\/example\.com\/docs'/);
});

test("createWebFetchTool: a failed fetch (non-zero exit) reports the failure instead of throwing", async () => {
  const tool = createWebFetchTool(fakeSandbox(async () => ({ stdout: "", stderr: "curl: (6) Could not resolve host", exitCode: 6 })));
  const result = await tool.run(fakeToolContext("https://nonexistent.invalid/") as any);
  assert.match(String(result), /webfetch: fetching https:\/\/nonexistent\.invalid\/ failed \(exit 6\)/);
  assert.match(String(result), /Could not resolve host/);
});

test("ToolCallTracker: folds tool-input + tool-output into one record", () => {
  const tracker = new ToolCallTracker();
  assert.equal(
    tracker.observe({
      type: "tool-input",
      conversationId: "c1",
      messageId: "m1",
      toolCallId: "call1",
      toolName: "bash",
      input: { command: "ls -la src" },
      position: { batch: 0, index: 0 },
    } as any),
    null,
    "tool-input alone produces no record",
  );
  const record = tracker.observe({
    type: "tool-output",
    conversationId: "c1",
    toolCallId: "call1",
    output: "src/index.ts\nsrc/core",
    durationMs: 12,
    position: { batch: 0, index: 1 },
  } as any);
  assert.ok(record);
  assert.equal(record!.tool, "bash");
  assert.equal(record!.tool_call_id, "call1");
  assert.deepEqual(record!.args, { command: "ls -la src" });
  assert.equal(record!.ok, true);
  assert.equal(record!.label, "bash: ls -la src");
  assert.equal(record!.result_snippet, "src/index.ts\nsrc/core");
  assert.equal(record!.duration_ms, 12);
});

test("ToolCallTracker: tool-output-error folds to ok:false with the error text as the snippet", () => {
  const tracker = new ToolCallTracker();
  tracker.observe({
    type: "tool-input",
    conversationId: "c1",
    messageId: "m1",
    toolCallId: "call2",
    toolName: "read",
    input: { path: "missing.txt" },
    position: { batch: 0, index: 0 },
  } as any);
  const record = tracker.observe({
    type: "tool-output-error",
    conversationId: "c1",
    toolCallId: "call2",
    errorText: "ENOENT: no such file",
    position: { batch: 0, index: 1 },
  } as any);
  assert.ok(record);
  assert.equal(record!.ok, false);
  assert.equal(record!.result_snippet, "ENOENT: no such file");
  assert.equal(record!.label, "read: missing.txt");
});

test("ToolCallTracker: a tool-output with no matching tool-input still produces a record (defensive)", () => {
  const tracker = new ToolCallTracker();
  const record = tracker.observe({
    type: "tool-output",
    conversationId: "c1",
    toolCallId: "orphan",
    output: "ok",
    position: { batch: 0, index: 0 },
  } as any);
  assert.ok(record);
  assert.equal(record!.tool, "tool");
  assert.deepEqual(record!.args, {});
});

// ── run(): REGISTRY cleanup ──────────────────────────────────────────────
//
// `REGISTRY` (module-level, holds one `RenderSpec` per in-flight session)
// is written by every `run()` call but, before this fix, never erased —
// the leak the red team flagged. Exercising it needs a REAL dispatch (no
// Flue-native way to poke the registry from outside), so this reuses
// `ollama_provider.ts`'s registration path against a local, no-network HTTP
// stub — the same "fake bridge" precedent `ollama_gateway_e2e.test.ts` uses,
// pointed at `OLLAMA_BASE_URL`. Two response shapes, both settling fast with
// no retries (verified live, <100ms each, well under Flue's crash-recovery
// `maxAttempts`, which doesn't apply to an application-level response):
//  - a real SSE chunk stream ending in a `finish_reason` — a normal success.
//  - a plain (non-streamed) JSON body — the OpenAI SDK's streaming reader
//    sees no `finish_reason` chunk and Flue settles the submission `failed`,
//    which `run()`'s catch block turns into a thrown `Error`. This is not a
//    contrived hang or timeout; it is a deterministic, immediate failure a
//    misbehaving or overloaded real endpoint could actually produce.

/** A minimal local HTTP stub standing in for an OpenAI-compatible endpoint — no real network. `respond` writes whatever this test's scenario needs; the request itself is never inspected. */
function startModelStub(respond: (res: import("node:http").ServerResponse) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => respond(res));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1` });
    });
  });
}

function sseSuccessBody(res: import("node:http").ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "chatcmpl-registry-test", object: "chat.completion.chunk", created: 0, model: "test" };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

/** A well-formed, but non-streamed, chat-completion body: valid JSON, wrong shape for the streaming request `run()` always sends — the OpenAI SDK's stream reader gets no `finish_reason` chunk and Flue settles the submission `failed`. */
function nonStreamedFailureBody(res: import("node:http").ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl-registry-test",
      object: "chat.completion",
      created: 0,
      model: "test",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

function baseAgentRequest(modelId: string, sessionId: string, dbPath: string) {
  return {
    prompt: "hello",
    system_prompt: "you are a test agent",
    model: `ollama/${modelId}`,
    thinking: "off" as const,
    session_id: sessionId,
    resume: false,
    tools: [],
    output_schema: v.looseObject({}),
    output_type_name: "TestOutput",
    cwd: process.cwd(),
    flue_db_path: dbPath,
  };
}

test("run() leaves no REGISTRY entry after success or thrown failure", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-agent-flue-registry-test-"));
  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalBaseUrl;
  });

  const dbPath = join(dir, "flue.db");

  // Success path.
  resetOllamaRegistrationForTest();
  resetModelsForTests();
  const success = await startModelStub(sseSuccessBody);
  process.env.OLLAMA_BASE_URL = success.url;
  try {
    await registerOllamaModel("registry-test-success");
    const before = registrySizeForTest();
    const result = await run(baseAgentRequest("registry-test-success", "registry-test-success-session", dbPath));
    assert.ok(result, "the success path must actually succeed for this test to prove anything");
    assert.equal(registrySizeForTest(), before, "REGISTRY must hold no leftover entry after a successful run()");
  } finally {
    await new Promise<void>((resolve) => success.server.close(() => resolve()));
  }

  // Thrown-failure path — same dispatch machinery, a response shape that
  // settles the submission failed instead.
  resetOllamaRegistrationForTest();
  resetModelsForTests();
  const failure = await startModelStub(nonStreamedFailureBody);
  process.env.OLLAMA_BASE_URL = failure.url;
  try {
    await registerOllamaModel("registry-test-failure");
    const before = registrySizeForTest();
    await assert.rejects(
      () => run(baseAgentRequest("registry-test-failure", "registry-test-failure-session", dbPath)),
      "the failure path must actually throw for this test to prove anything",
    );
    assert.equal(registrySizeForTest(), before, "REGISTRY must hold no leftover entry after a thrown run() failure either");
  } finally {
    await new Promise<void>((resolve) => failure.server.close(() => resolve()));
  }
});
