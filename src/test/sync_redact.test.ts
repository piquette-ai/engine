import "./hermetic_git.js";

/**
 * Egress tiers (#135): sentinel strings are planted in every field that could
 * carry content, and the serialized batch must not contain them below `full`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FIELD_BYTES, type SyncSessionEntry } from "../core/sync/contract.js";
import { applyLevel, collectSecrets, scrubSecrets } from "../core/sync/redact.js";
import { loadConfig } from "../core/agents.js";

const F = "11111111-2222-4333-8444-555555555555";
const S = "SENTINEL";

function ev(i: number, type: string, name: string, payload: unknown) {
  return {
    factory_id: F, event_id: `e${i}`, local_rowid: i, adw_id: "a1", phase_id: "p1", parent_id: "", type, name,
    payload_json: JSON.stringify(payload), tokens: 12, started_at: "t0", ended_at: "t1",
  };
}

function entry(): SyncSessionEntry {
  return {
    adw_id: "a1",
    snapshot: {
      session: { factory_id: F, adw_id: "a1", adw_name: "plan", request: "KEPT-request", status: "success", engineer: "jd", started_at: "t0", ended_at: "t1", total_tokens: 10, total_cost: 1, billable_tokens: 8 },
      phases: [{ factory_id: F, phase_id: "p1", adw_id: "a1", seq: 1, name: "plan", kind: "agent", owner: "planner", description: "d", status: "fail", attempt: 1, retries: 0, error: `${S}-phase-error`, started_at: "t0", ended_at: "t1" }],
      agent_sessions: [{ factory_id: F, adw_id: "a1", agent: "planner", coding_agent: "claude_code", model: "m", color: "blue", session_id: "s", context_tokens: 1, context_window: 2, created_at: "t0", last_used_at: "t1" }],
      envelopes: [{ factory_id: F, envelope_id: "env1", adw_id: "a1", phase_id: "p1", agent: "planner", output_type: "plan", payload_json: JSON.stringify({ plan: `${S}-envelope` }), valid: 1, attempt: 1, created_at: "t0" }],
      prompts: [{ factory_id: F, adw_id: "a1", agent: "planner", system: `${S}-system-prompt`, user: `${S}-user-prompt` }],
    },
    events: [
      ev(1, "agent_end", "planner", { usage: { input_tokens: 100, output_tokens: 20, total_cost: 0.25, secret: `${S}-usage-extra` }, text: `${S}-text`, nested: { deep: { a: [`${S}-deep`] } } }),
      ev(2, "tool_call", `bash: cat ${S}`, { args: { command: `${S}-cmd` } }),
      ev(3, "log", `${S}-log-name`, { message: `${S}-log` }),
      ev(4, "feedback", "operator_feedback", { text: `${S}-feedback` }),
      ev(5, "mystery_type", `${S}-unknown-name`, { x: `${S}-x` }),
      ev(6, "phase_end", "plan", { error: `${S}-err` }),
    ],
    gate_results: [{ factory_id: F, local_id: 1, adw_id: "a1", phase_id: "p1", attempt: 1, gate: "g", passed: 0, violations_json: JSON.stringify(["tests_pass(npm test): " + S + "-violation-note", `${S}-legacy-free-text`]), checks_json: JSON.stringify([{ item: "tests pass", ok: false, note: `${S}-check-note` }]), created_at: "t0" }],
  };
}

test("trace: no sentinel survives anywhere in the serialized entry (the request is the tier's one kept free-text field), but usage numbers do", () => {
  const out = applyLevel("trace", entry());
  const json = JSON.stringify(out);
  assert.ok(!json.includes(S), `leaked: ${json.match(new RegExp(`.{20}${S}.{20}`))?.[0]}`);
  assert.deepEqual(JSON.parse(out.events[0]!.payload_json!), { usage: { input_tokens: 100, output_tokens: 20, total_cost: 0.25 } });
  assert.equal(out.events[0]!.tokens, 12);
  assert.equal(out.events[1]!.name, "bash", "a tool call keeps only the tool's own name");
  assert.equal(out.events[2]!.name, null);
  assert.equal(out.events[4]!.type, "mystery_type", "a well-formed type word is kept");
  assert.equal(out.events[4]!.name, null, "an unknown type gets a null name (fail closed)");
  assert.equal(out.events[5]!.name, "plan");
});

test("trace keeps `request` (the tier's definition) but drops envelope contents, phase errors and check notes", () => {
  const out = applyLevel("trace", entry());
  assert.equal(out.snapshot!.session.request, "KEPT-request");
  assert.equal(out.snapshot!.envelopes[0]!.payload_json, null);
  assert.equal(out.snapshot!.envelopes[0]!.output_type, "plan");
  assert.equal(out.snapshot!.phases[0]!.error, null);
  assert.deepEqual(JSON.parse(out.gate_results[0]!.checks_json!), [{ item: "tests pass", ok: false }]);
  assert.equal(out.gate_results[0]!.violations_json, JSON.stringify(["tests_pass(npm test)", "(unspecified)"]), "violations keep the item, never the note");
  assert.deepEqual(out.snapshot!.prompts, []);
});

test("summary: no events, envelopes, prompts or request — and no sentinel at all", () => {
  const out = applyLevel("summary", entry());
  assert.deepEqual(out.events, []);
  assert.deepEqual(out.snapshot!.envelopes, []);
  assert.deepEqual(out.snapshot!.prompts, []);
  assert.equal(out.snapshot!.session.request, null);
  assert.ok(!JSON.stringify(out).includes(S));
  assert.equal(out.snapshot!.session.total_tokens, 10, "usage totals stay");
});

test("full: content is present, and a secret value is [redacted] plain and JSON-escaped", () => {
  const e = entry();
  const secret = 'sk-live-abc"def\\ghi-123456';
  e.events.push(ev(7, "log", "n", { message: `token is ${secret}` }));
  e.snapshot!.session.request = `my key ${secret}`;
  const scrubbed = scrubSecrets(applyLevel("full", e), [secret]);
  const json = JSON.stringify(scrubbed);
  assert.ok(json.includes("my key [redacted]"), "full keeps the request, scrubbed");
  assert.ok(json.includes(`${S}-envelope`), "full keeps envelope contents");
  assert.ok(json.includes(`${S}-system-prompt`), "full keeps prompts");
  assert.ok(!json.includes("sk-live-abc"), "raw form gone");
  assert.ok(!json.includes(JSON.stringify(secret).slice(1, -1)), "JSON-escaped form gone");
  assert.ok(json.includes("[redacted]"));
});

test("scrubSecrets runs at every level, and short values are left alone", () => {
  for (const level of ["summary", "trace", "full"] as const) {
    const e = entry();
    e.snapshot!.session.adw_name = "built with tok-SECRETVALUE-9";
    const out = scrubSecrets(applyLevel(level, e), ["tok-SECRETVALUE-9", "short"]);
    assert.equal(out.snapshot!.session.adw_name, "built with [redacted]", level);
  }
  assert.equal(scrubSecrets({ a: "a short word" }, ["short"]).a, "a short word");
});

test("full: an oversize field is replaced by a truncation marker", () => {
  const e = entry();
  e.events[0]!.payload_json = JSON.stringify({ blob: "x".repeat(MAX_FIELD_BYTES + 10) });
  const out = applyLevel("full", e);
  const marker = JSON.parse(out.events[0]!.payload_json!) as { _piquette_truncated: number };
  assert.ok(marker._piquette_truncated > MAX_FIELD_BYTES);
  assert.ok(out.events[0]!.payload_json!.length < 100);
});

test("collectSecrets: sync credentials, the D1 token and secret-looking env values, but not short or plain values", () => {
  const saved = { ...process.env };
  try {
    process.env.PIQUETTE_SYNC_CLIENT_ID = "client-id-value-1";
    process.env.PIQUETTE_SYNC_CLIENT_SECRET = "client-secret-value-2";
    process.env.MY_SERVICE_API_KEY = "an-api-key-value-3";
    process.env.HARMLESS_SETTING = "plain-looking-value";
    process.env.TINY_TOKEN = "abc";
    const found = collectSecrets(loadConfig([]));
    for (const want of ["client-id-value-1", "client-secret-value-2", "an-api-key-value-3"]) assert.ok(found.includes(want), want);
    assert.ok(!found.includes("plain-looking-value"));
    assert.ok(!found.includes("abc"));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
