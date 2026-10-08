import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { isKnownToolName, CcToolCallTracker, resolveClaudeCmdSpec, isOllamaLaunchCmd, run, resolveNoResultResumes, NO_RESULT_RESUMES, shutdown, _resetShutdownForTests } from "../core/agent_cc.js";
import type { AgentRequest } from "../core/data_types.js";

/** Saves/restores SPF_CLAUDE_CMD around a test — process.env is real global state. */
function withClaudeCmd(value: string | undefined, fn: () => void): void {
  const original = process.env.SPF_CLAUDE_CMD;
  if (value === undefined) delete process.env.SPF_CLAUDE_CMD;
  else process.env.SPF_CLAUDE_CMD = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.SPF_CLAUDE_CMD;
    else process.env.SPF_CLAUDE_CMD = original;
  }
}

// Regression for a real production bug: routing coding_agent: claude_code
// through `SPF_CLAUDE_CMD="ollama launch claude --model <fixed-tag>"` made
// every claude_code agent's own model: field inert — the fixed tag baked
// into the ONE process-wide env var served every agent identically,
// regardless of what each agent's own config said. `{model}` substitutes
// per call instead, so `ollama launch`'s OWN --model flag (the one that
// actually pins the served model) can vary per agent.
test("resolveClaudeCmdSpec: {model} substitutes with this call's own model", () => {
  withClaudeCmd("ollama launch claude --model {model}", () => {
    assert.equal(resolveClaudeCmdSpec("kimi-k2.7-code:cloud"), "ollama launch claude --model kimi-k2.7-code:cloud");
  });
});

test("resolveClaudeCmdSpec: a second, different agent's model reaches the same wrapper string differently — the actual bug this closes", () => {
  withClaudeCmd("ollama launch claude --model {model}", () => {
    assert.equal(resolveClaudeCmdSpec("qwen3-coder:cloud"), "ollama launch claude --model qwen3-coder:cloud");
  });
});

test("resolveClaudeCmdSpec: no {model} token in SPF_CLAUDE_CMD -> unchanged, model is simply unused", () => {
  withClaudeCmd("ollama launch claude --model granite4.1:8b", () => {
    assert.equal(resolveClaudeCmdSpec("sonnet"), "ollama launch claude --model granite4.1:8b");
  });
});

test("resolveClaudeCmdSpec: SPF_CLAUDE_CMD unset -> plain claude, byte-identical to before {model} existed", () => {
  withClaudeCmd(undefined, () => {
    assert.equal(resolveClaudeCmdSpec("sonnet"), "claude");
  });
});

// Regression for a real production bug: the dashboard showed $27.63 for a
// session run entirely through `ollama launch claude --model
// kimi-k2.7-code:cloud`. That number came straight from `claude`'s own
// total_cost_usd, which prices whatever model actually served the request
// using CC's internal Anthropic pricing table — meaningless for a model
// Ollama bills by flat subscription/local compute, not per token. `run()`
// zeroes cost whenever this returns true; see its call site in agent_cc.ts.
test("isOllamaLaunchCmd: true for the ollama launch wrapper shape, with or without a --model tag", () => {
  assert.equal(isOllamaLaunchCmd("ollama launch claude --model kimi-k2.7-code:cloud"), true);
  assert.equal(isOllamaLaunchCmd("ollama launch claude"), true);
});

test("isOllamaLaunchCmd: false for plain claude and for other wrappers/subcommands", () => {
  assert.equal(isOllamaLaunchCmd("claude"), false);
  assert.equal(isOllamaLaunchCmd("ollama run claude"), false);
  assert.equal(isOllamaLaunchCmd("some-proxy claude"), false);
});

test("isKnownToolName: SPF's lowercase vocabulary maps onto Claude Code's own tool names, ls is known-but-dropped, typos are unknown", () => {
  for (const name of ["read", "write", "edit", "bash", "grep", "glob", "webfetch"]) {
    assert.equal(isKnownToolName(name), true, name);
  }
  assert.equal(isKnownToolName("find"), true, "find aliases to glob");
  assert.equal(isKnownToolName("ls"), true, "ls is a known name, just dropped");
  assert.equal(isKnownToolName("harness_engineering_only"), false);
  assert.equal(isKnownToolName("bogus"), false);
});

// Every message shape below is a real captured line from `claude -p
// --output-format stream-json --verbose` (v2.1.237), not a guess — see
// agent_cc.ts's module doc comment for the exact commands run.

test("CcToolCallTracker: folds a real tool_use + tool_result pair into one record", () => {
  const tracker = new CcToolCallTracker();
  assert.equal(
    tracker.observe({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_01ABC", name: "Read", input: { file_path: "/private/tmp/cc-probe/test.txt" } }],
      },
      timestamp: "2026-08-20T11:40:00.000Z",
    }),
    null,
    "the assistant's tool_use alone produces no record",
  );
  const record = tracker.observe({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "toolu_01ABC", content: "1\thello world\n2\t" }],
    },
    timestamp: "2026-08-20T11:40:00.500Z",
  });
  assert.ok(record);
  assert.equal(record!.tool, "Read");
  assert.equal(record!.tool_call_id, "toolu_01ABC");
  assert.deepEqual(record!.args, { file_path: "/private/tmp/cc-probe/test.txt" });
  assert.equal(record!.ok, true);
  assert.equal(record!.label, "Read: /private/tmp/cc-probe/test.txt");
  assert.equal(record!.result_snippet, "1\thello world\n2\t");
  assert.equal(record!.duration_ms, 500);
});

test("CcToolCallTracker: a real StructuredOutput call folds like any other tool call, deliberately unfiltered", () => {
  const tracker = new CcToolCallTracker();
  tracker.observe({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_01MPFgPqyPeEzWfqRE25JLzF",
          name: "StructuredOutput",
          input: { status: "success", summary: "hello from claude code" },
        },
      ],
    },
  });
  const record = tracker.observe({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "toolu_01MPFgPqyPeEzWfqRE25JLzF", content: "Structured output provided successfully" }],
    },
  });
  assert.ok(record);
  assert.equal(record!.tool, "StructuredOutput");
  assert.equal(record!.ok, true);
  assert.equal(record!.result_snippet, "Structured output provided successfully");
});

test("CcToolCallTracker: is_error:true on the tool_result folds to ok:false", () => {
  const tracker = new CcToolCallTracker();
  tracker.observe({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_err", name: "Bash", input: { command: "false" } }] },
  });
  const record = tracker.observe({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_err", content: "command failed", is_error: true }] },
  });
  assert.ok(record);
  assert.equal(record!.ok, false);
});

test("CcToolCallTracker: non-tool message types (system, thinking-only assistant, result) produce no record", () => {
  const tracker = new CcToolCallTracker();
  assert.equal(tracker.observe({ type: "system", subtype: "init", cwd: "/tmp", session_id: "s1", tools: [] }), null);
  assert.equal(tracker.observe({ type: "assistant", message: { content: [{ type: "thinking", thinking: "..." }] } }), null);
  assert.equal(tracker.observe({ type: "result", subtype: "success", session_id: "s1" }), null);
});

test("CcToolCallTracker: a tool_result with no matching tool_use still produces a record (defensive)", () => {
  const tracker = new CcToolCallTracker();
  const record = tracker.observe({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "orphan", content: "ok" }] },
  });
  assert.ok(record);
  assert.equal(record!.tool, "tool");
  assert.deepEqual(record!.args, {});
});

// ── no-result resume ─────────────────────────────────────────────────────────

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const log = process.env.FAKE_LOG;
const prior = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const plan = JSON.parse(process.env.FAKE_PLAN);
const mode = plan[Math.min(prior, plan.length - 1)];
const out = (o) => console.log(JSON.stringify(o));
if (mode === "silent") process.exit(0);
out({ type: "system", subtype: "init", session_id: "sess-observed" });
out({ type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 5 } }, session_id: "sess-observed" });
if (mode === "noresult") process.exit(0);
if (mode === "noresult-fail") process.exit(3);
if (mode === "killed") { process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 10000); }
if (mode === "hang") { setTimeout(() => process.exit(0), 10000); return; }
out({ type: "result", subtype: mode === "error" ? "error_during_execution" : "success", is_error: mode === "error", result: "done", session_id: "sess-observed", structured_output: { ok: true }, usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.5 });
`;

function makeFake(plan: string[], name = "claude") {
  const dir = mkdtempSync(join(tmpdir(), "spf-fake-claude-"));
  const bin = join(dir, name);
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  const log = join(dir, "calls.log");
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
  const env = { ...(process.env as Record<string, string>), FAKE_LOG: log, FAKE_PLAN: JSON.stringify(plan), PATH: `${dir}:${process.env.PATH}` };
  return { dir, bin, calls, env };
}

function req(env: Record<string, string>): AgentRequest {
  return {
    prompt: "do the thing",
    system_prompt: "sys",
    model: "m",
    thinking: "low",
    session_id: "11111111-1111-1111-1111-111111111111",
    resume: false,
    output_schema: v.object({ ok: v.boolean() }),
    output_type_name: "Out",
    cwd: process.cwd(),
    flue_db_path: "",
    env,
  } as unknown as AgentRequest;
}

async function withCmd<T>(cmd: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.SPF_CLAUDE_CMD;
  process.env.SPF_CLAUDE_CMD = cmd;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.SPF_CLAUDE_CMD;
    else process.env.SPF_CLAUDE_CMD = original;
  }
}

test("run: no result on call 1, result on call 2 -> resumes the observed session, tokens sum both calls", async () => {
  const f = makeFake(["noresult", "result"]);
  const res = await withCmd(f.bin, () => run(req(f.env)));
  const calls = f.calls();
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.includes("--session-id"));
  assert.ok(!calls[0]!.includes("--resume"));
  const i = calls[1]!.indexOf("--resume");
  assert.ok(i >= 0, "second call resumes");
  assert.equal(calls[1]![i + 1], "sess-observed");
  assert.ok(!calls[1]!.includes("--session-id"));
  assert.match(calls[1]![1]!, /Do not redo any work/);
  assert.ok(calls[1]!.includes("--json-schema"));
  assert.equal(res.session_id, "sess-observed");
  // failed attempt (10+5) + result usage (100+20)
  assert.equal(res.tokens, 135);
});

test("run: no result every time -> throws 'no result message' after exactly 1 + NO_RESULT_RESUMES spawns", async () => {
  const f = makeFake(["noresult"]);
  await assert.rejects(() => withCmd(f.bin, () => run(req(f.env))), /no result message/);
  assert.equal(f.calls().length, 1 + NO_RESULT_RESUMES);
});

test("run: non-zero exit without a result but with stream output also resumes", async () => {
  const f = makeFake(["noresult-fail", "result"]);
  const res = await withCmd(f.bin, () => run(req(f.env)));
  assert.equal(f.calls().length, 2);
  assert.equal(res.tokens, 135);
});

test("run: SPF_CLAUDE_NO_RESULT_RESUMES overrides the count; invalid falls back", async () => {
  const orig = process.env.SPF_CLAUDE_NO_RESULT_RESUMES;
  try {
    process.env.SPF_CLAUDE_NO_RESULT_RESUMES = "0";
    assert.equal(resolveNoResultResumes(), 0);
    process.env.SPF_CLAUDE_NO_RESULT_RESUMES = "banana";
    assert.equal(resolveNoResultResumes(), NO_RESULT_RESUMES);
  } finally {
    if (orig === undefined) delete process.env.SPF_CLAUDE_NO_RESULT_RESUMES;
    else process.env.SPF_CLAUDE_NO_RESULT_RESUMES = orig;
  }
});

test("run: an is_error result does not resume", async () => {
  const f = makeFake(["error", "result"]);
  await assert.rejects(() => withCmd(f.bin, () => run(req(f.env))), /claude reported an error/);
  assert.equal(f.calls().length, 1);
});

test("run: a nonexistent command (spawn error) does not resume", async () => {
  const f = makeFake(["result"]);
  await assert.rejects(() => withCmd("/nonexistent/definitely-not-claude", () => run(req(f.env))));
  assert.equal(f.calls().length, 0);
});

test("run: exit 0 with no output at all does not resume", async () => {
  const f = makeFake(["silent"]);
  await assert.rejects(() => withCmd(f.bin, () => run(req(f.env))), /no result message/);
  assert.equal(f.calls().length, 1);
});

test("run: the ollama launch '--' separator is still present on the resume invocation", async () => {
  const f = makeFake(["noresult", "result"], "ollama");
  await withCmd("ollama launch claude --model {model}", () => run(req(f.env)));
  const calls = f.calls();
  assert.equal(calls.length, 2);
  for (const c of calls) {
    const sep = c.indexOf("--");
    assert.ok(sep >= 0 && c[sep + 1] === "-p", "-- directly precedes claude's own args");
  }
  assert.ok(calls[1]!.includes("--resume"));
});

test("run: a child killed by a signal is not resumed", async () => {
  const f = makeFake(["killed", "result"]);
  await assert.rejects(() => withCmd(f.bin, () => run(req(f.env))), /before producing a result/);
  assert.equal(f.calls().length, 1);
});

test("run: shutdown() while a child is streaming does not respawn it", async () => {
  const f = makeFake(["hang", "result"]);
  try {
    const p = withCmd(f.bin, () => run(req(f.env)));
    const settled = p.then(() => null, (e) => e as Error);
    const deadline = Date.now() + 5000;
    while (f.calls().length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300)); // let it stream its events
    await shutdown();
    const err = await settled;
    assert.ok(err, "run rejects after shutdown");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(f.calls().length, 1, "no replacement child spawned");
  } finally {
    _resetShutdownForTests();
  }
});
