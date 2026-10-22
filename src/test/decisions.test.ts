/**
 * `core/decisions.ts` — the decision model rails (#103). Every test here drives a
 * `FakeDecisionClient` (or a fake `fetch`) — none touches the network, per the
 * module header's invariant 8. Grouped by the invariant each one pins:
 *
 *   §1 off by default         — disabled/absent => no call, no record, fallback
 *   §3 fallback on everything — low confidence, timeout, error, invalid, no key
 *   §4 shadow vs act          — shadow calls+records but the fallback acts
 *   §5 recorded + replayable  — trace event round-trip, replay without a call
 *   config / merge / doctor   — schema defaults, layered merge, doctor checks
 */
import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { DecisionsConfigSchema, SFConfigSchema, type DecisionsConfigInput } from "../core/data_types.js";
import { loadConfig } from "../core/agents.js";
import { Tracer } from "../core/tracer.js";
import {
  CloudflareSystemOneClient,
  FALLBACK_REASONS,
  HttpSystemOneClient,
  DECISION_EVENT,
  SYSTEM_ONE_DEFAULT_BASE_URL,
  SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL,
  SystemOneApiError,
  confidenceFromProbabilities,
  createDecider,
  decisionsFromEvents,
  findRecordedDecision,
  isValidOptionSet,
  systemOneCredentialEnvs,
  decisionsDoctorChecks,
  systemOneOllamaDoctorChecks,
  systemOneCloudflareEndpoint,
  systemOneEndpoint,
  systemOneResolvedEndpoint,
  listRecordedDecisions,
  missingSystemOneCredentials,
  normalizeDecisionsConfig,
  optionSetProblem,
  parseDecisionExtras,
  parseRecordedDecision,
  resolveDecisionPolicy,
  setDecisionClientFactory,
  traceDecisionRecorder,
  type Decision,
  type DecisionRequest,
  type DecisionOption,
} from "../core/decisions.js";
import { defineDecisionKind, indexKinds } from "../core/decision_kinds.js";
import { doctorCommand } from "../cli/commands/doctor.js";
import { startRun } from "../chains/steps.js";
import { FakeDecisionClient } from "./fake_decisions.js";

type Risk = "low" | "standard" | "high";
const RISK_OPTIONS: DecisionOption<Risk>[] = [
  { value: "low", description: "a trivial, well-scoped change" },
  { value: "standard", description: "an ordinary change" },
  { value: "high", description: "a risky or broad change" },
];

function riskRequest(overrides: Partial<DecisionRequest<Risk>> = {}): DecisionRequest<Risk> {
  return {
    kind: "risk_tier",
    options: RISK_OPTIONS,
    instructions: "How risky is this change?",
    state: "rename a variable in README.md",
    fallback: "standard",
    ...overrides,
  };
}

function enabled(extra: DecisionsConfigInput = {}): DecisionsConfigInput {
  return { enabled: true, ...extra };
}

/** Collects what a decision model records, in order. */
function memoryRecorder(): { decisions: Decision[]; phases: string[]; recorder: (d: Decision, m: { phase_id: string }) => void } {
  const decisions: Decision[] = [];
  const phases: string[] = [];
  return { decisions, phases, recorder: (d, m) => void (decisions.push(d), phases.push(m.phase_id)) };
}

// ── §1 off by default ──────────────────────────────────────────────────────

test("decisions: no config at all => fallback, reason disabled, zero calls, nothing recorded", async () => {
  const fake = FakeDecisionClient.choosing("high", 0.99);
  const mem = memoryRecorder();
  const decider = createDecider({ client: fake, recorder: mem.recorder });
  const d = await decider.decide(riskRequest());
  assert.equal(d.choice, "standard");
  assert.equal(d.used_fallback, true);
  assert.equal(d.reason, "disabled");
  assert.equal(d.mode, "off");
  assert.equal(fake.calls.length, 0);
  assert.equal(mem.decisions.length, 0, "a disabled the decision model must not write a trace event — the trace stays byte-identical");
});

test("decisions: enabled:false with mode:act still never calls", async () => {
  const fake = FakeDecisionClient.choosing("high", 0.99);
  const decider = createDecider({ config: { enabled: false, mode: "act" }, client: fake });
  const d = await decider.decide(riskRequest());
  assert.equal(d.reason, "disabled");
  assert.equal(fake.calls.length, 0);
});

test("decisions: per-kind mode:off silences one kind — no call, no record — while others still run", async () => {
  const fake = FakeDecisionClient.choosing("high", 0.99);
  const mem = memoryRecorder();
  const decider = createDecider({ config: enabled({ mode: "act", kinds: { risk_tier: { mode: "off" } } }), client: fake, recorder: mem.recorder });
  const off = await decider.decide(riskRequest());
  assert.equal(off.reason, "kind_off");
  assert.equal(fake.calls.length, 0);
  const other = await decider.decide(riskRequest({ kind: "other_kind" }));
  assert.equal(other.choice, "high");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(mem.decisions.map((x) => x.kind), ["other_kind"]);
});

test("decisions: request validation throws even when disabled — a bad call site fails its own unit test", async () => {
  const decider = createDecider();
  await assert.rejects(decider.decide(riskRequest({ fallback: "bogus" as Risk })), /fallback "bogus" is not one of the options/);
  await assert.rejects(decider.decide(riskRequest({ options: [] })), /options is empty/);
  await assert.rejects(decider.decide(riskRequest({ options: [...RISK_OPTIONS, RISK_OPTIONS[0]!] })), /duplicate option values/);
  await assert.rejects(decider.decide(riskRequest({ permitted: ["low"] })), /permitted must include the fallback/);
  await assert.rejects(decider.decide(riskRequest({ question: "score", options: [RISK_OPTIONS[1]!], fallback: "standard" })), /2-10 levels/);
});

// ── §4 shadow vs act ───────────────────────────────────────────────────────

test("decisions: shadow (the default mode) calls the decision model and records it, but the fallback ACTS", async () => {
  const fake = FakeDecisionClient.choosing("high", 0.95);
  const mem = memoryRecorder();
  const decider = createDecider({ config: enabled(), client: fake, recorder: mem.recorder });
  const d = await decider.decide(riskRequest({ phase_id: "ph_1" }));
  assert.equal(fake.calls.length, 1);
  assert.equal(d.mode, "shadow");
  assert.equal(d.choice, "standard", "shadow: the deterministic path acts");
  assert.equal(d.model_choice, "high");
  assert.equal(d.confidence, 0.95);
  assert.equal(d.used_fallback, true);
  assert.equal(d.reason, "shadow");
  assert.equal(d.would_act, true, "valid + confident: act mode would have used it");
  assert.equal(d.agrees, false);
  assert.equal(mem.decisions.length, 1);
  assert.equal(mem.phases[0], "ph_1");
});

test("decisions: the request sent is the closed option set, as choice criteria — the decision model is never asked an open question", async () => {
  const fake = FakeDecisionClient.choosing("low", 0.9);
  const decider = createDecider({ config: enabled({ systemone: { model: "jev-1.13" } }), client: fake });
  await decider.decide(riskRequest());
  const sent = fake.calls[0]!;
  assert.equal(sent.model, "jev-1.13");
  assert.equal(sent.state, "rename a variable in README.md");
  assert.deepEqual(sent.questions, {
    q0: {
      type: "choice",
      instructions: "How risky is this change?",
      criteria: { low: "a trivial, well-scoped change", standard: "an ordinary change", high: "a risky or broad change" },
    },
  });
});

test("decisions: act + confident => the decision model's choice acts", async () => {
  const fake = FakeDecisionClient.choosing("low", 0.91);
  const mem = memoryRecorder();
  const decider = createDecider({ config: enabled({ mode: "act" }), client: fake, recorder: mem.recorder });
  const d = await decider.decide(riskRequest());
  assert.equal(d.choice, "low");
  assert.equal(d.used_fallback, false);
  assert.equal(d.reason, null);
  assert.equal(d.detail, "");
  assert.equal(d.would_act, true);
  assert.deepEqual(d.usage, { input_tokens: 10, output_tokens: 0 });
  assert.equal(mem.decisions.length, 1, "act decisions are recorded too");
});

test("decisions: a per-kind mode:act overrides a global shadow", async () => {
  const decider = createDecider({ config: enabled({ mode: "shadow", kinds: { risk_tier: { mode: "act" } } }), client: FakeDecisionClient.choosing("high", 0.9) });
  assert.equal((await decider.decide(riskRequest())).choice, "high");
});

// ── §3 fallback on every failure ───────────────────────────────────────────

test("decisions: act + confidence below threshold => fallback, reason low_confidence", async () => {
  const decider = createDecider({ config: enabled({ mode: "act", threshold: 0.8 }), client: FakeDecisionClient.choosing("high", 0.79) });
  const d = await decider.decide(riskRequest());
  assert.equal(d.choice, "standard");
  assert.equal(d.reason, "low_confidence");
  assert.equal(d.model_choice, "high", "what the decision model said is still recorded for shadow analysis");
  assert.match(d.detail, /0\.790 < threshold 0\.8/);
  assert.equal(d.would_act, false);
});

test("decisions: a per-kind threshold overrides the global one", async () => {
  const decider = createDecider({
    config: enabled({ mode: "act", threshold: 0.5, kinds: { risk_tier: { threshold: 0.95 } } }),
    client: FakeDecisionClient.choosing("high", 0.9),
  });
  assert.equal((await decider.decide(riskRequest())).reason, "low_confidence");
});

test("decisions: no confidence field => derived from probabilities with (n*peak-1)/(n-1); neither => unknown => low_confidence", async () => {
  assert.equal(confidenceFromProbabilities({ a: 1, b: 0, c: 0 }, 3), 1);
  assert.equal(confidenceFromProbabilities({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }, 3), 0);
  const derived = createDecider({
    config: enabled({ mode: "act", threshold: 0.5 }),
    client: FakeDecisionClient.answering({ q0: { type: "choice", choice: "high", probabilities: { low: 0.05, standard: 0.05, high: 0.9 } } }),
  });
  const d = await derived.decide(riskRequest());
  assert.equal(d.choice, "high");
  assert.ok(Math.abs(d.confidence! - 0.85) < 1e-9);

  const unknown = createDecider({ config: enabled({ mode: "act", threshold: 0 }), client: FakeDecisionClient.answering({ q0: { type: "choice", choice: "high" } }) });
  const u = await unknown.decide(riskRequest());
  assert.equal(u.reason, "low_confidence");
  assert.equal(u.confidence, null);
});

test("decisions: timeout => fallback, reason timeout, bounded by timeout_ms even if the client never answers", async () => {
  const mem = memoryRecorder();
  const decider = createDecider({ config: enabled({ mode: "act", timeout_ms: 25 }), client: FakeDecisionClient.hanging(), recorder: mem.recorder });
  const started = Date.now();
  const d = await decider.decide(riskRequest());
  assert.ok(Date.now() - started < 2_000);
  assert.equal(d.choice, "standard");
  assert.equal(d.reason, "timeout");
  assert.equal(mem.decisions[0]?.reason, "timeout", "failures are recorded too");
});

test("decision model: HTTP error => fallback, reason error, status in detail", async () => {
  const decider = createDecider({ config: enabled({ mode: "act" }), client: FakeDecisionClient.failing(new SystemOneApiError(529, "overloaded")) });
  const d = await decider.decide(riskRequest());
  assert.equal(d.choice, "standard");
  assert.equal(d.reason, "error");
  assert.match(d.detail, /HTTP 529/);
});

test("decisions: an answer outside the closed set => fallback, reason invalid_choice — the decision model never invents an option", async () => {
  const decider = createDecider({ config: enabled({ mode: "act" }), client: FakeDecisionClient.choosing("delete-the-gate", 0.99) });
  const d = await decider.decide(riskRequest());
  assert.equal(d.choice, "standard");
  assert.equal(d.reason, "invalid_choice");
  assert.equal(d.model_choice, null);
});

test("decisions: a missing or malformed answer => fallback, reason invalid_response", async () => {
  const missing = createDecider({ config: enabled({ mode: "act" }), client: FakeDecisionClient.answering({}) });
  assert.equal((await missing.decide(riskRequest())).reason, "invalid_response");
  const malformed = createDecider({ config: enabled({ mode: "act" }), client: FakeDecisionClient.answering({ q0: { choice: 42 } }) });
  assert.equal((await malformed.decide(riskRequest())).reason, "invalid_response");
});

test("decisions: a valid answer outside `permitted` => fallback, reason not_permitted (monotone authority)", async () => {
  const decider = createDecider({ config: enabled({ mode: "act" }), client: FakeDecisionClient.choosing("high", 0.99) });
  const d = await decider.decide(riskRequest({ permitted: ["low", "standard"] }));
  assert.equal(d.choice, "standard");
  assert.equal(d.reason, "not_permitted");
  assert.equal(d.model_choice, "high");
});

test("decisions: enabled with no API key and no injected client => no_api_key, no network", async () => {
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("must not fetch");
  }) as typeof fetch;
  try {
    const mem = memoryRecorder();
    const decider = createDecider({ config: enabled({ mode: "act" }), env: {}, recorder: mem.recorder });
    const d = await decider.decide(riskRequest());
    assert.equal(d.reason, "no_api_key");
    assert.match(d.detail, /TYPESAFE_API_KEY is not set/);
    assert.equal(fetched, false);
    assert.equal(mem.decisions.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("decisions: a throwing recorder never fails the decision", async () => {
  const decider = createDecider({
    config: enabled({ mode: "act" }),
    client: FakeDecisionClient.choosing("low", 0.9),
    recorder: () => {
      throw new Error("db is gone");
    },
  });
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal((await decider.decide(riskRequest())).choice, "low");
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("decisions: FALLBACK_REASONS is the closed, ordered reason vocabulary", () => {
  assert.deepEqual(
    [...FALLBACK_REASONS],
    ["disabled", "kind_off", "replay_missing", "no_api_key", "timeout", "error", "invalid_response", "invalid_choice", "not_permitted", "low_confidence", "shadow"],
  );
});

// ── score + batch ──────────────────────────────────────────────────────────

test("decisions: a score question maps the argmax level onto the ordered rubric", async () => {
  const fake = FakeDecisionClient.scoring(2, 0.9);
  const decider = createDecider({ config: enabled({ mode: "act" }), client: fake });
  const d = await decider.decide(riskRequest({ question: "score" }));
  assert.equal(fake.calls[0]!.questions.q0!.type, "score");
  assert.deepEqual((fake.calls[0]!.questions.q0 as { criteria: string[] }).criteria, RISK_OPTIONS.map((o) => o.description));
  assert.equal(d.question, "score");
  assert.equal(d.choice, "high");
  assert.equal(d.score, 2);
});

test("decisions: a 1-based score legend is detected; an out-of-range level is invalid_choice", async () => {
  const oneBased = createDecider({
    config: enabled({ mode: "act" }),
    client: FakeDecisionClient.answering({ q0: { type: "score", score: 1.2, legend: { "1": "a", "2": "b", "3": "c" }, confidence: 0.9 } }),
  });
  assert.equal((await oneBased.decide(riskRequest({ question: "score" }))).choice, "low");
  const outOfRange = createDecider({ config: enabled({ mode: "act" }), client: FakeDecisionClient.answering({ q0: { type: "score", score: 7, confidence: 0.9 } }) });
  assert.equal((await outOfRange.decide(riskRequest({ question: "score" }))).reason, "invalid_choice");
});

test("decisions: decideBatch sends ONE call for every live item, skips off kinds, and returns results in item order", async () => {
  const fake = new FakeDecisionClient(() => ({
    answers: { q0: { type: "choice", choice: "noise", confidence: 0.9 }, q2: { type: "choice", choice: "real", confidence: 0.4 } },
  }));
  const mem = memoryRecorder();
  const decider = createDecider({ config: enabled({ mode: "act", kinds: { muted: { mode: "off" } } }), client: fake, recorder: mem.recorder });
  const options: DecisionOption<"real" | "noise">[] = [
    { value: "real", description: "a real defect" },
    { value: "noise", description: "not actionable" },
  ];
  const results = await decider.decideBatch("the diff", [
    { kind: "finding_triage", key: "f1", options, instructions: "finding 1", fallback: "real" },
    { kind: "muted", key: "f2", options, instructions: "finding 2", fallback: "real" },
    { kind: "finding_triage", key: "f3", options, instructions: "finding 3", fallback: "real" },
  ]);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(Object.keys(fake.calls[0]!.questions), ["q0", "q2"]);
  assert.deepEqual(results.map((r) => [r.key, r.choice, r.reason]), [["f1", "noise", null], ["f2", "real", "kind_off"], ["f3", "real", "low_confidence"]]);
  assert.deepEqual(mem.decisions.map((d) => d.key), ["f1", "f3"]);
});

// ── §5 recorded + replayable ───────────────────────────────────────────────

test("decisions: decisions round-trip through the real trace db as one log/decision event, and replay reuses them without a call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-decisions-trace-"));
  try {
    const tracer = await Tracer.open(join(dir, "trace.db"), join(dir, "events.jsonl"));
    const fake = FakeDecisionClient.choosing("high", 0.93);
    const decider = createDecider({ config: enabled({ mode: "act" }), client: fake, recorder: traceDecisionRecorder(tracer, "adw_1") });
    const live = await decider.decide(riskRequest({ key: "run", phase_id: "ph_x" }));
    await decider.decide(riskRequest({ key: "other" }));

    const rows = (await tracer.db.query("SELECT type, name, phase_id FROM events WHERE adw_id=?").all("adw_1")) as Array<{ type: string; name: string; phase_id: string }>;
    assert.deepEqual(rows.map((r) => [r.type, r.name]), [["log", DECISION_EVENT], ["log", DECISION_EVENT]]);
    assert.equal(rows[0]!.phase_id, "ph_x");

    const recorded = await findRecordedDecision(tracer.db, "adw_1", "risk_tier", "run");
    assert.ok(recorded);
    assert.equal(recorded!.choice, "high");
    assert.equal(recorded!.input_sha256, live.input_sha256);
    assert.equal((await listRecordedDecisions(tracer.db, "adw_1")).length, 2);
    assert.equal(await findRecordedDecision(tracer.db, "adw_1", "risk_tier", "nope"), null);

    // Replay: a fresh the decision model with a client that would answer differently is never called.
    const replayFake = FakeDecisionClient.choosing("low", 0.99);
    const replayDecider = createDecider({ config: enabled({ mode: "act" }), client: replayFake });
    const replayed = await replayDecider.decide(riskRequest({ key: "run", replay: recorded }));
    assert.equal(replayFake.calls.length, 0);
    assert.equal(replayed.choice, "high");
    assert.equal(replayed.replayed, true);

    // replay: null => "replay mode, nothing recorded" => fallback, still no call.
    const missing = await replayDecider.decide(riskRequest({ key: "run", replay: null }));
    assert.equal(missing.reason, "replay_missing");
    assert.equal(replayFake.calls.length, 0);

    // A recorded decision for a different question is not a replay of this one.
    const mismatched = await replayDecider.decide(riskRequest({ key: "run", fallback: "low", replay: recorded }));
    assert.equal(mismatched.choice, "low");
    assert.equal(mismatched.reason, "replay_missing");
    assert.equal(replayFake.calls.length, 0);
    await tracer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decisions: decisionsFromEvents/parseRecordedDecision ignore foreign and corrupt payloads", () => {
  const good = { kind: "k", options: ["a", "b"], choice: "a", fallback: "b", used_fallback: false, mode: "act" };
  assert.ok(parseRecordedDecision(good));
  assert.equal(parseRecordedDecision({ ...good, choice: "zzz" }), null, "a choice outside its own options is not a decision");
  assert.equal(parseRecordedDecision({ tiering: true }), null);
  const found = decisionsFromEvents([
    { type: "log", name: "tiering", payload: good },
    { type: "log", name: DECISION_EVENT, payload: { junk: 1 } },
    { type: "log", name: DECISION_EVENT, payload: good },
  ]);
  assert.equal(found.length, 1);
});

test("decisions: setDecisionClientFactory injects a fake process-wide, for code that builds its own Decider", async () => {
  const fake = FakeDecisionClient.choosing("low", 0.9);
  setDecisionClientFactory(() => fake);
  try {
    const decider = createDecider({ config: enabled({ mode: "act" }), env: {} });
    assert.equal((await decider.decide(riskRequest())).choice, "low", "the override needs no API key");
  } finally {
    setDecisionClientFactory(null);
  }
  assert.equal((await createDecider({ config: enabled(), env: {} }).decide(riskRequest())).reason, "no_api_key");
});

// ── HttpSystemOneClient (fake fetch — never the real network) ─────────────────────

test("decisions: HttpSystemOneClient POSTs {model,state,questions} to <base>/systemone with a Bearer key; non-2xx => SystemOneApiError", async () => {
  assert.equal(systemOneEndpoint(""), "https://api.typesafe.ai/v1/systemone");
  assert.equal(systemOneEndpoint("https://proxy.example/v1/"), "https://proxy.example/v1/systemone");
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ model: "jev-1.13", answers: { q0: { type: "choice", choice: "low", confidence: 0.9 } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new HttpSystemOneClient({ apiKey: "sk-test", fetchImpl });
  const decider = createDecider({ config: enabled({ mode: "act" }), client });
  const d = await decider.decide(riskRequest());
  assert.equal(d.choice, "low");
  assert.equal(d.model, "jev-1.13");
  assert.equal(seen[0]!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, "Bearer sk-test");
  assert.deepEqual(Object.keys(JSON.parse(seen[0]!.init.body as string)), ["model", "state", "questions"]);

  const failing = new HttpSystemOneClient({ apiKey: "sk-test", fetchImpl: (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch });
  const failed = await createDecider({ config: enabled({ mode: "act" }), client: failing }).decide(riskRequest());
  assert.equal(failed.reason, "error");
  assert.match(failed.detail, /HTTP 429/);
  assert.doesNotMatch(failed.detail, /sk-test/);
});

// ── CloudflareSystemOneClient (fake fetch — never the real network) ───────────────

test("decisions: CloudflareSystemOneClient POSTs {state,questions} (no model) to Workers AI /ai/run/@cf/cloudflare/clef (Clef, #164) and unwraps {result}", async () => {
  assert.equal(systemOneCloudflareEndpoint("acct1", ""), "https://api.cloudflare.com/client/v4/accounts/acct1/ai/run/%40cf/cloudflare/clef");
  assert.equal(systemOneCloudflareEndpoint("acct1", "my-gw"), "https://gateway.ai.cloudflare.com/v1/acct1/my-gw/workers-ai/%40cf/cloudflare/clef");
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const result = { model: "jev-1.13.0", answers: { q0: { type: "choice", choice: "high", confidence: 0.95 } }, usage: { input_tokens: 10, output_tokens: 2 } };
    return new Response(JSON.stringify({ result, success: true, errors: [], messages: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new CloudflareSystemOneClient({ apiToken: "cf-test", accountId: "acct1", gateway: "my-gw", fetchImpl });
  const d = await createDecider({ config: enabled({ mode: "act", systemone: { provider: "cloudflare" } }), client }).decide(riskRequest());
  assert.equal(d.choice, "high");
  assert.equal(d.model, "jev-1.13.0");
  assert.equal(seen[0]!.url, "https://gateway.ai.cloudflare.com/v1/acct1/my-gw/workers-ai/%40cf/cloudflare/clef");
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, "Bearer cf-test");
  assert.deepEqual(Object.keys(JSON.parse(seen[0]!.init.body as string)), ["state", "questions"]);
});

test("decisions: CloudflareSystemOneClient — success:false, non-2xx, and a bare (unenveloped) answer", async () => {
  const respond = (body: unknown, status = 200) =>
    new CloudflareSystemOneClient({ apiToken: "cf-secret", accountId: "a", fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch });
  const act = (client: CloudflareSystemOneClient) => createDecider({ config: enabled({ mode: "act", systemone: { provider: "cloudflare" } }), client }).decide(riskRequest());

  const refused = await act(respond({ result: null, success: false, errors: [{ code: 5007, message: "No such model" }] }));
  assert.equal(refused.reason, "error");
  assert.match(refused.detail, /No such model/);

  const denied = await act(respond({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403));
  assert.equal(denied.reason, "error");
  assert.match(denied.detail, /HTTP 403/);
  assert.doesNotMatch(denied.detail, /cf-secret/);

  const bare = await act(respond({ model: "jev-1.13.0", answers: { q0: { type: "choice", choice: "low", confidence: 0.9 } } }));
  assert.equal(bare.choice, "low");
});

test("decisions: provider cloudflare with credentials unset => no_api_key naming BOTH env vars; doctor reports provider + endpoint", async () => {
  const d = await createDecider({ config: enabled({ mode: "act", systemone: { provider: "cloudflare" } }), env: {} }).decide(riskRequest());
  assert.equal(d.reason, "no_api_key");
  assert.match(d.detail, /CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID are not set/);

  const checks = decisionsDoctorChecks(enabled({ systemone: { provider: "cloudflare", cloudflare: { gateway: "gw" } } }), { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct9" });
  const head = checks.find((c) => c.name === "decisions")!;
  assert.match(head.detail, /provider=cloudflare/);
  assert.match(head.detail, /model=@cf\/cloudflare\/clef/);
  assert.match(head.detail, /gateway\.ai\.cloudflare\.com\/v1\/acct9\/gw\/workers-ai\/%40cf\/cloudflare\/clef/);
  assert.equal(checks.find((c) => c.name === "decisions.systemone.cloudflare.model"), undefined, "the default id is prefixed — no warning");
  assert.equal(checks.find((c) => c.name === "decisions api key")!.severity, "info");
  assert.deepEqual(missingSystemOneCredentials(normalizeDecisionsConfig(enabled({ systemone: { provider: "cloudflare" } })), { CLOUDFLARE_API_TOKEN: "t" }), ["CLOUDFLARE_ACCOUNT_ID"]);
});

test("decisions doctor: a Cloudflare model id without an @cf/ or @hf/ prefix warns (it 404s and every decision falls back, #164)", () => {
  const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" };
  for (const model of ["typesafe/jev", "cloudflare/clef", "clef"]) {
    const warn = decisionsDoctorChecks(enabled({ systemone: { provider: "cloudflare", cloudflare: { model } } }), env).find((c) => c.name === "decisions.systemone.cloudflare.model");
    assert.ok(warn, model);
    assert.equal(warn!.severity, "warn");
    assert.match(warn!.detail, /@cf\//);
  }
  for (const model of ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash", "@hf/some/model"]) {
    assert.equal(decisionsDoctorChecks(enabled({ systemone: { provider: "cloudflare", cloudflare: { model } } }), env).find((c) => c.name === "decisions.systemone.cloudflare.model"), undefined, model);
  }
  // Only the cloudflare provider is checked.
  assert.equal(decisionsDoctorChecks(enabled({ systemone: { provider: "typesafe", cloudflare: { model: "typesafe/jev" } } }), { TYPESAFE_API_KEY: "k" }).find((c) => c.name === "decisions.systemone.cloudflare.model"), undefined);
});

// ── Ollama (local System One) — fake fetch, never the real network ──────────

test("decisions: provider ollama needs no credentials — decide() reaches the wire (via a stubbed global fetch), never no_api_key", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ model: "nimble", answers: { q0: { type: "choice", choice: "low", confidence: 0.9 } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const decider = createDecider({ config: enabled({ mode: "act", systemone: { provider: "ollama" } }), env: {} });
    const d = await decider.decide(riskRequest());
    assert.notEqual(d.reason, "no_api_key");
    assert.equal(d.choice, "low");
    assert.ok(seen);
    assert.equal(seen!.url, "http://localhost:11434/v1/systemone");
    assert.equal((seen!.init.headers as Record<string, string>).authorization, undefined, "ollama has no auth of its own");
    assert.equal(JSON.parse(seen!.init.body as string).model, "nimble");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(missingSystemOneCredentials(normalizeDecisionsConfig(enabled({ systemone: { provider: "ollama" } })), {}), []);
  assert.deepEqual(systemOneCredentialEnvs(normalizeDecisionsConfig(enabled({ systemone: { provider: "ollama" } }))), []);
});

test("decisions: ollama client POSTs {model,state,questions} to <ollama.base_url>/systemone, model defaults to nimble, base_url is configurable", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ model: "nimble", answers: { q0: { type: "choice", choice: "standard", confidence: 0.9 } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const decider = createDecider({
      config: enabled({ mode: "act", systemone: { provider: "ollama", ollama: { base_url: "http://box:11434/v1", model: "tev1" } } }),
      env: {},
    });
    const d = await decider.decide(riskRequest());
    assert.equal(d.choice, "standard");
    assert.equal(seen[0]!.url, "http://box:11434/v1/systemone");
    assert.deepEqual(Object.keys(JSON.parse(seen[0]!.init.body as string)), ["model", "state", "questions"]);
    assert.equal(JSON.parse(seen[0]!.init.body as string).model, "tev1");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("decisions: ollama — an oversize request body (>64 KiB) falls back with reason error and never touches fetch", async () => {
  let fetched = false;
  const fetchImpl = (async () => {
    fetched = true;
    throw new Error("must not fetch");
  }) as unknown as typeof fetch;
  const decider = createDecider({ config: enabled({ mode: "act", systemone: { provider: "ollama" } }), env: {} });
  const hugeState = "x".repeat(70 * 1024);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const d = await decider.decide(riskRequest({ state: hugeState }));
    assert.equal(d.reason, "error");
    assert.match(d.detail, /64 ?KiB|65536|body/i);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("decisions: ollama — a question with more than 26 choice options falls back with reason error and never touches fetch (TypeSafe allows up to 255)", async () => {
  let fetched = false;
  const fetchImpl = (async () => {
    fetched = true;
    throw new Error("must not fetch");
  }) as unknown as typeof fetch;
  const manyOptions: DecisionOption[] = Array.from({ length: 30 }, (_, i) => ({ value: `opt${i}`, description: `option ${i}` }));
  const decider = createDecider({ config: enabled({ mode: "act", systemone: { provider: "ollama" } }), env: {} });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const d = await decider.decide({ kind: "risk_tier", options: manyOptions, instructions: "pick one", state: "s", fallback: "opt0" });
    assert.equal(d.reason, "error");
    assert.match(d.detail, /2.?26|option/i);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("decisions config: ollama block defaults to localhost:11434/v1 and model nimble", () => {
  const cfg = normalizeDecisionsConfig({});
  assert.deepEqual(cfg.systemone.ollama, { base_url: "http://localhost:11434/v1", model: "nimble" });
});

test("decisions doctor: provider ollama — resolved endpoint+model shown; timeout_ms < 5000 warns about cold-start latency; no api-key check", () => {
  const checks = decisionsDoctorChecks(enabled({ systemone: { provider: "ollama" } }), {});
  const head = checks.find((c) => c.name === "decisions")!;
  assert.match(head.detail, /provider=ollama/);
  assert.match(head.detail, /model=nimble/);
  assert.match(head.detail, /http:\/\/localhost:11434\/v1\/systemone/);
  assert.equal(checks.find((c) => c.name === "decisions api key"), undefined, "ollama needs no credentials — no api-key check at all");

  const timeoutCheck = checks.find((c) => c.name === "decisions timeout_ms")!;
  assert.ok(timeoutCheck, "expected a cold-start timeout warning for the default 2000ms timeout");
  assert.equal(timeoutCheck.severity, "warn");
  assert.match(timeoutCheck.detail, /5000|cold.start/i);

  const longTimeout = decisionsDoctorChecks(enabled({ systemone: { provider: "ollama" }, timeout_ms: 8000 }), {});
  const noWarn = longTimeout.find((c) => c.name === "decisions timeout_ms");
  assert.equal(noWarn, undefined, "timeout_ms >= 5000 should not warn");
});

test("decisions doctor: systemOneOllamaDoctorChecks probes /api/version and /api/tags via an injectable prober — no network, never fails hard", async () => {
  const oldEnough = await systemOneOllamaDoctorChecks(enabled({ systemone: { provider: "ollama" } }), {
    version: async () => ({ ok: true, version: "0.35.2" }),
    tags: async () => ({ ok: true, models: ["nimble:latest", "tev1"] }),
  });
  const versionCheck = oldEnough.find((c) => c.name === "decisions ollama version")!;
  assert.equal(versionCheck.ok, true);
  assert.equal(versionCheck.severity, "info");
  assert.match(versionCheck.detail, /0\.35\.2/);
  const modelCheck = oldEnough.find((c) => c.name === "decisions ollama model")!;
  assert.equal(modelCheck.severity, "info");
  assert.match(modelCheck.detail, /nimble/);

  const tooOld = await systemOneOllamaDoctorChecks(enabled({ systemone: { provider: "ollama" } }), {
    version: async () => ({ ok: true, version: "0.34.0" }),
    tags: async () => ({ ok: true, models: ["nimble:latest"] }),
  });
  const oldVersionCheck = tooOld.find((c) => c.name === "decisions ollama version")!;
  assert.equal(oldVersionCheck.ok, true, "never fails doctor hard");
  assert.equal(oldVersionCheck.severity, "warn");
  assert.match(oldVersionCheck.detail, /0\.34\.0/);
  assert.match(oldVersionCheck.detail, /0\.35/);

  const unreachable = await systemOneOllamaDoctorChecks(enabled({ systemone: { provider: "ollama" } }), {
    version: async () => ({ ok: false, error: "connect ECONNREFUSED" }),
    tags: async () => ({ ok: false, error: "connect ECONNREFUSED" }),
  });
  assert.equal(unreachable.find((c) => c.name === "decisions ollama version")!.severity, "warn");
  assert.equal(unreachable.find((c) => c.name === "decisions ollama version")!.ok, true);

  const notPulled = await systemOneOllamaDoctorChecks(enabled({ systemone: { provider: "ollama", ollama: { model: "tev1:0.8b" } } }), {
    version: async () => ({ ok: true, version: "0.35.0" }),
    tags: async () => ({ ok: true, models: ["nimble:latest"] }),
  });
  const notPulledCheck = notPulled.find((c) => c.name === "decisions ollama model")!;
  assert.equal(notPulledCheck.severity, "warn");
  assert.match(notPulledCheck.detail, /ollama pull tev1:0\.8b/);

  // disabled / non-ollama provider => no checks at all (same invisibility rule as decisionsDoctorChecks)
  assert.deepEqual(await systemOneOllamaDoctorChecks({ enabled: true, systemone: { provider: "typesafe" } }), []);
  assert.deepEqual(await systemOneOllamaDoctorChecks({ enabled: false, systemone: { provider: "ollama" } }), []);
});

test("decisions config: provider defaults to typesafe; cloudflare block defaults to spf's existing Cloudflare env var names", () => {
  const cfg = normalizeDecisionsConfig({});
  assert.equal(cfg.systemone.provider, "typesafe");
  assert.deepEqual(cfg.systemone.cloudflare, { account_id_env: "CLOUDFLARE_ACCOUNT_ID", api_token_env: "CLOUDFLARE_API_TOKEN", gateway: "", model: "@cf/cloudflare/clef" });
  assert.throws(() => v.parse(DecisionsConfigSchema, { systemone: { provider: "openai" } }));
});

// ── config ─────────────────────────────────────────────────────────────────

test("decisions config: defaults — off, shadow, jev-latest, 0.7, 2000ms, TYPESAFE_API_KEY, official endpoint", () => {
  const cfg = v.parse(SFConfigSchema, {});
  assert.deepEqual(cfg.decisions, {
    enabled: false,
    backend: "systemone",
    mode: "shadow",
    threshold: 0.7,
    timeout_ms: 2000,
    systemone: {
      provider: "typesafe",
      model: "jev-latest",
      api_key_env: "TYPESAFE_API_KEY",
      base_url: "",
      cloudflare: { account_id_env: "CLOUDFLARE_ACCOUNT_ID", api_token_env: "CLOUDFLARE_API_TOKEN", gateway: "", model: "@cf/cloudflare/clef" },
      ollama: { base_url: "http://localhost:11434/v1", model: "nimble" },
    },
    kinds: {},
  });
});

test("decisions config: rejects an unknown mode, a threshold outside 0-1, and a non-positive timeout", () => {
  assert.throws(() => v.parse(DecisionsConfigSchema, { mode: "yolo" }));
  assert.throws(() => v.parse(DecisionsConfigSchema, { threshold: 1.5 }));
  assert.throws(() => v.parse(DecisionsConfigSchema, { timeout_ms: 0 }));
  assert.throws(() => v.parse(DecisionsConfigSchema, { kinds: { risk_tier: { mode: "maybe" } } }));
});

test("decisions config: ollama.base_url rejects blank/whitespace-only values (never silently falls back to the TypeSafe cloud default) and trims a valid one", () => {
  assert.throws(() => v.parse(DecisionsConfigSchema, { systemone: { ollama: { base_url: "" } } }), /decisions\.systemone\.ollama\.base_url/);
  assert.throws(() => v.parse(DecisionsConfigSchema, { systemone: { ollama: { base_url: "   " } } }), /decisions\.systemone\.ollama\.base_url/);
  assert.throws(() => v.parse(DecisionsConfigSchema, { systemone: { ollama: { base_url: "\t\n" } } }), /decisions\.systemone\.ollama\.base_url/);
  const cfg = v.parse(DecisionsConfigSchema, { systemone: { ollama: { base_url: "  http://box:11434/v1  " } } });
  assert.equal(cfg.systemone.ollama.base_url, "http://box:11434/v1", "surrounding whitespace is trimmed, not just rejected");
});

test("decisions: a blank/whitespace ollama.base_url resolves to the Ollama default, never TypeSafe's cloud endpoint (defense in depth: `normalizeDecisionsConfig`/schema validation already rejects this — see the test above — but `systemOneResolvedEndpoint` and the client `resolveClient` builds must independently refuse to fall back to TypeSafe's cloud API for a hand-built DecisionsConfig that skips v.parse, e.g. from a future caller)", async () => {
  // `systemOneResolvedEndpoint` takes an already-typed DecisionsConfig and does NOT
  // re-validate it — exactly the seam a hand-built config (skipping
  // `normalizeDecisionsConfig`/`v.parse`) would reach doctor/diagnostics through.
  const blank = { ...normalizeDecisionsConfig({}), systemone: { ...normalizeDecisionsConfig({}).systemone, provider: "ollama" as const, ollama: { base_url: "", model: "nimble" } } };
  const whitespace = { ...normalizeDecisionsConfig({}), systemone: { ...normalizeDecisionsConfig({}).systemone, provider: "ollama" as const, ollama: { base_url: "   ", model: "nimble" } } };

  for (const cfg of [blank, whitespace]) {
    const endpoint = systemOneResolvedEndpoint(cfg, {});
    assert.equal(endpoint, `${SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL}/systemone`);
    assert.doesNotMatch(endpoint, /typesafe\.ai/, "must never resolve to TypeSafe's cloud endpoint");
  }

  // And the live call itself: `resolveClient` (private to decisions.ts, exercised
  // here through `HttpSystemOneClient` directly, exactly as `resolveClient`'s own
  // `ollama` branch constructs it: `baseUrl` from config, `defaultBaseUrl:
  // SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL`) must hit the Ollama default, never
  // TypeSafe's cloud endpoint, for the same blank `baseUrl`.
  let requestedUrl: string | null = null;
  const fetchImpl = (async (url: string) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ answers: { q0: { choice: "standard", confidence: 0.9 } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new HttpSystemOneClient({ apiKey: null, baseUrl: "   ", defaultBaseUrl: SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL, enforceOllamaLimits: true, fetchImpl });
  const response = await client.systemOne(
    { model: "nimble", state: "s", questions: { q0: { type: "choice", instructions: "pick", criteria: { standard: "ok", low: "also ok" } } } },
    { signal: new AbortController().signal },
  );
  assert.deepEqual(response.answers.q0, { choice: "standard", confidence: 0.9 });
  assert.equal(requestedUrl, `${SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL}/systemone`);
  assert.doesNotMatch(requestedUrl!, /typesafe\.ai/);
});

test("decisions: systemOneEndpoint's default fallback is TypeSafe's cloud endpoint unless a caller passes a different one (e.g. SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL)", () => {
  assert.equal(systemOneEndpoint(""), `${SYSTEM_ONE_DEFAULT_BASE_URL}/systemone`);
  assert.equal(systemOneEndpoint("   "), `${SYSTEM_ONE_DEFAULT_BASE_URL}/systemone`);
  assert.equal(systemOneEndpoint("", SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL), `${SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL}/systemone`);
  assert.equal(systemOneEndpoint("   ", SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL), `${SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL}/systemone`);
});

test("decisions config: per-kind entries keep feature extras, and resolveDecisionPolicy layers them over the globals", () => {
  const cfg = v.parse(DecisionsConfigSchema, { enabled: true, threshold: 0.6, kinds: { risk_tier: { mode: "act", timeout_ms: 500, include_diffstat: true } } });
  assert.deepEqual(resolveDecisionPolicy(cfg, "risk_tier"), {
    kind: "risk_tier",
    backend: "systemone",
    provider: "typesafe",
    mode: "act",
    threshold: 0.6,
    timeout_ms: 500,
    model: "jev-latest",
    extras: { include_diffstat: true },
  });
  assert.equal(resolveDecisionPolicy({ ...cfg, enabled: false }, "risk_tier").mode, "off", "global enabled:false beats any per-kind mode");
  const spec = defineDecisionKind({ kind: "risk_tier", summary: "s", question: "choice", extras: v.object({ include_diffstat: v.optional(v.boolean(), false) }) });
  assert.deepEqual(parseDecisionExtras(cfg, spec), { include_diffstat: true });
  assert.deepEqual(parseDecisionExtras({}, spec), { include_diffstat: false });
  assert.throws(() => parseDecisionExtras({ kinds: { risk_tier: { include_diffstat: "yes" } } }, spec), /decisions\.kinds\.risk_tier: include_diffstat/);
  assert.throws(() => defineDecisionKind({ kind: "Bad Kind", summary: "", question: "choice" }), /snake_case/);
});

test("decisions config: survives loadConfig and merges key-by-key across layered files; decisions is a whole-object replace", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-decisions-merge-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(base, "decisions:\n  threshold: 0.9\n  systemone:\n    model: jev-1.13\n  kinds:\n    a: {mode: act}\n    b: {mode: off}\n");
    writeFileSync(override, "decisions:\n  enabled: true\n  kinds:\n    c: {threshold: 0.5}\n");
    const cfg = loadConfig([base, override]);
    assert.equal(cfg.decisions.enabled, true);
    assert.equal(cfg.decisions.threshold, 0.9, "base's scalar survives an override that did not name it");
    assert.equal(cfg.decisions.systemone.model, "jev-1.13");
    assert.deepEqual(Object.keys(cfg.decisions.kinds), ["c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── doctor ─────────────────────────────────────────────────────────────────

test("decisions doctor: disabled is invisible; enabled without a key warns (never fails); bad base_url fails; unknown kind warns; bad extras fail", () => {
  assert.deepEqual(decisionsDoctorChecks({ kinds: { whatever: {} } }, {}), []);

  const noKey = decisionsDoctorChecks({ enabled: true }, {});
  const keyCheck = noKey.find((c) => c.name === "decisions api key")!;
  assert.equal(keyCheck.ok, true);
  assert.equal(keyCheck.severity, "warn");
  assert.match(keyCheck.detail, /TYPESAFE_API_KEY is not set/);
  assert.ok(noKey.every((c) => c.ok));

  const withKey = decisionsDoctorChecks({ enabled: true, systemone: { api_key_env: "MY_JEV_KEY" } }, { MY_JEV_KEY: "x" });
  assert.equal(withKey.find((c) => c.name === "decisions api key")!.severity, "info");

  const badUrl = decisionsDoctorChecks({ enabled: true, systemone: { base_url: "not a url" } }, {});
  assert.equal(badUrl.find((c) => c.name === "decisions base_url")?.ok, false);

  const unknown = decisionsDoctorChecks({ enabled: true, kinds: { risk_teir: {} } }, {}, {});
  const u = unknown.find((c) => c.name === 'decisions kind "risk_teir"')!;
  assert.equal(u.ok, true);
  assert.equal(u.severity, "warn");

  const kinds = { risk_tier: defineDecisionKind({ kind: "risk_tier", summary: "risk", question: "choice", extras: v.object({ n: v.optional(v.number(), 1) }) }) };
  const bad = decisionsDoctorChecks({ enabled: true, kinds: { risk_tier: { n: "x" } } }, {}, kinds);
  assert.equal(bad.find((c) => c.name === 'decisions kind "risk_tier"')!.ok, false);
  const good = decisionsDoctorChecks({ enabled: true, kinds: { risk_tier: { n: 2, mode: "act" } } }, {}, kinds);
  assert.match(good.find((c) => c.name === 'decisions kind "risk_tier"')!.detail, /mode=act/);
});

test("decisions doctor: provider ollama — a non-http(s) ollama.base_url fails doctor, same rule as provider: typesafe's base_url", () => {
  const badOllamaUrl = decisionsDoctorChecks({ enabled: true, systemone: { provider: "ollama", ollama: { base_url: "not a url", model: "nimble" } } }, {});
  const check = badOllamaUrl.find((c) => c.name === "decisions.systemone.ollama.base_url");
  assert.ok(check, "expected a decisions.systemone.ollama.base_url check for a malformed ollama base_url");
  assert.equal(check!.ok, false);
  assert.match(check!.detail, /not a url/);
  assert.match(check!.detail, /not an http\(s\) URL/);

  const goodOllamaUrl = decisionsDoctorChecks({ enabled: true, systemone: { provider: "ollama" } }, {});
  assert.equal(goodOllamaUrl.find((c) => c.name === "decisions.systemone.ollama.base_url"), undefined, "the default localhost:11434 url passes");

  // The top-level `decisions.systemone.base_url` (typesafe-only) is reported as IGNORED
  // under provider: ollama — it is never validated AS the ollama endpoint.
  const ignoredTopLevel = decisionsDoctorChecks({ enabled: true, systemone: { provider: "ollama", base_url: "https://example.com" } }, {});
  const ignoredCheck = ignoredTopLevel.find((c) => c.name === "decisions base_url")!;
  assert.equal(ignoredCheck.ok, true);
  assert.equal(ignoredCheck.severity, "warn");
  assert.match(ignoredCheck.detail, /ignored with provider: ollama/);
});

test("decisions doctor: spf doctor --json surfaces the api-key warning when decisions is enabled, and nothing decisions-related when it is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-decisions-doctor-"));
  const saved = process.env["SPF_JEV_DOCTOR_TEST_KEY"];
  delete process.env["SPF_JEV_DOCTOR_TEST_KEY"];
  const run = async (): Promise<{ checks: Array<{ name: string; ok: boolean; severity?: string }> }> => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    console.error = () => {};
    try {
      await doctorCommand(["--cwd", dir, "--json", "--no-probe"]);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    return JSON.parse(logs.join("\n"));
  };
  try {
    mkdirSync(join(dir, ".spf"), { recursive: true });
    writeFileSync(join(dir, ".spf", "spf.config.yaml"), "watch:\n  repo: acme/widgets\n");
    const off = await run();
    assert.equal(off.checks.filter((c) => c.name.startsWith("decisions")).length, 0);

    writeFileSync(join(dir, ".spf", "spf.config.yaml"), "watch:\n  repo: acme/widgets\ndecisions:\n  enabled: true\n  systemone:\n    api_key_env: SPF_JEV_DOCTOR_TEST_KEY\n");
    const on = await run();
    const key = on.checks.find((c) => c.name === "decisions api key");
    assert.ok(key);
    assert.equal(key!.ok, true);
    assert.equal(key!.severity, "warn");
  } finally {
    if (saved !== undefined) process.env["SPF_JEV_DOCTOR_TEST_KEY"] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── review follow-ups (#103): replay re-judged, off beats replay, edges ─────

/** A recorded act-mode `high @ 0.93` risk_tier decision, via the real recorder shape (payload round-trip). */
async function recordedHigh(extra: Partial<DecisionRequest<Risk>> = {}): Promise<Decision> {
  const mem = memoryRecorder();
  const decider = createDecider({ config: enabled({ mode: "act" }), client: FakeDecisionClient.choosing("high", 0.93), recorder: mem.recorder });
  await decider.decide(riskRequest({ key: "run", ...extra }));
  const [recorded] = decisionsFromEvents([{ type: "log", name: DECISION_EVENT, payload: JSON.parse(JSON.stringify(mem.decisions[0])) }]);
  assert.ok(recorded);
  return recorded!;
}

test("decisions replay: a recorded choice now outside `permitted` does NOT act — replay re-checks today's permitted (invariant 6)", async () => {
  const recorded = await recordedHigh({ permitted: ["low", "standard", "high"] });
  assert.equal(recorded.choice, "high");
  const fake = FakeDecisionClient.choosing("high", 0.99);
  const mem = memoryRecorder();
  const decider = createDecider({ config: enabled({ mode: "act" }), client: fake, recorder: mem.recorder });
  const d = await decider.decide(riskRequest({ key: "run", permitted: ["low", "standard"], replay: recorded }));
  assert.equal(d.choice, "standard");
  assert.equal(d.reason, "not_permitted");
  assert.equal(d.model_choice, "high");
  assert.equal(d.replayed, true);
  assert.equal(fake.calls.length, 0);
  assert.equal(mem.decisions.length, 1, "a replay is still recorded (with replayed: true)");
});

test("decisions replay: enabled:false and kind off beat a supplied replay — reason disabled/kind_off, fallback acts, nothing recorded", async () => {
  const recorded = await recordedHigh();
  const mem = memoryRecorder();
  const disabled = await createDecider({ recorder: mem.recorder }).decide(riskRequest({ key: "run", replay: recorded }));
  assert.equal(disabled.choice, "standard");
  assert.equal(disabled.reason, "disabled");
  assert.equal(disabled.replayed, false);
  const off = await createDecider({ config: enabled({ mode: "act", kinds: { risk_tier: { mode: "off" } } }), recorder: mem.recorder }).decide(
    riskRequest({ key: "run", replay: recorded }),
  );
  assert.equal(off.reason, "kind_off");
  assert.equal(off.choice, "standard");
  assert.equal(mem.decisions.length, 0, "off is a total no-op even for a replay");
  const nothing = await createDecider({ recorder: mem.recorder }).decide(riskRequest({ key: "run", replay: null }));
  assert.equal(nothing.reason, "disabled", "disabled also beats replay:null");
});

test("decisions replay: the recorded answer is re-judged under TODAY's mode/threshold; a recorded failure replays as that failure", async () => {
  const recorded = await recordedHigh();
  const shadow = await createDecider({ config: enabled({ mode: "shadow" }) }).decide(riskRequest({ key: "run", replay: recorded }));
  assert.equal(shadow.choice, "standard");
  assert.equal(shadow.reason, "shadow");
  assert.equal(shadow.mode, "shadow", "the replayed event carries the CURRENT policy");
  const strict = await createDecider({ config: enabled({ mode: "act", threshold: 0.95 }) }).decide(riskRequest({ key: "run", replay: recorded }));
  assert.equal(strict.reason, "low_confidence");
  assert.equal(strict.threshold, 0.95);
  const same = await createDecider({ config: enabled({ mode: "act" }) }).decide(riskRequest({ key: "run", replay: recorded }));
  assert.equal(same.choice, "high", "an unchanged policy reproduces the recorded effective choice");
  assert.equal(same.latency_ms, recorded.latency_ms);
  assert.deepEqual(same.usage, recorded.usage);

  const mem = memoryRecorder();
  await createDecider({ config: enabled({ mode: "act", timeout_ms: 20 }), client: FakeDecisionClient.hanging(), recorder: mem.recorder }).decide(riskRequest({ key: "run" }));
  const timedOut = mem.decisions[0]!;
  const replayedTimeout = await createDecider({ config: enabled({ mode: "act" }) }).decide(riskRequest({ key: "run", replay: timedOut }));
  assert.equal(replayedTimeout.reason, "timeout");
  assert.equal(replayedTimeout.choice, "standard");
  assert.equal(replayedTimeout.replayed, true);
});

test("decisions replay: input_sha256 is NOT part of replay identity — a changed state still replays; the digest records today's input", async () => {
  const recorded = await recordedHigh();
  const d = await createDecider({ config: enabled({ mode: "act" }) }).decide(riskRequest({ key: "run", state: "a totally different diff", replay: recorded }));
  assert.equal(d.choice, "high");
  assert.equal(d.replayed, true);
  assert.notEqual(d.input_sha256, recorded.input_sha256, "drift is visible offline by comparing digests");
  const mismatchedQuestion = await createDecider({ config: enabled({ mode: "act" }) }).decide(riskRequest({ key: "run", question: "score", replay: recorded }));
  assert.equal(mismatchedQuestion.reason, "replay_missing", "a choice recording is not a replay of a score question");
});

test("decisions: disabled/kind_off never hash `state`; a live decision hashes it exactly once", async () => {
  let hashed = 0;
  const state = { toJSON: () => (hashed++, "big state") } as unknown as Record<string, unknown>;
  const off = await createDecider().decide(riskRequest({ state }));
  assert.equal(off.input_sha256, "");
  await createDecider({ config: enabled({ kinds: { risk_tier: { mode: "off" } } }) }).decide(riskRequest({ state }));
  assert.equal(hashed, 0, "no O(state) work while the decision model is off");
  const fake = FakeDecisionClient.choosing("low", 0.9);
  const liveHashes = hashed;
  await createDecider({ config: enabled({ mode: "act" }), client: fake }).decide(riskRequest({ state }));
  // JSON.stringify(state) happens once for the digest (the fake does not serialize the request).
  assert.equal(hashed - liveHashes, 1);
});

test("decisions: confidence EQUAL to the threshold acts (the check is strictly `<`)", async () => {
  const d = await createDecider({ config: enabled({ mode: "act", threshold: 0.8 }), client: FakeDecisionClient.choosing("high", 0.8) }).decide(riskRequest());
  assert.equal(d.choice, "high");
  assert.equal(d.reason, null);
});

test("decisions: optionSetProblem / isValidOptionSet let a run-time-built set be checked BEFORE decide()", () => {
  assert.equal(optionSetProblem(RISK_OPTIONS, "standard"), null);
  assert.equal(isValidOptionSet(RISK_OPTIONS, "standard"), true);
  assert.equal(isValidOptionSet([], "standard" as Risk), false);
  assert.match(optionSetProblem([...RISK_OPTIONS, RISK_OPTIONS[0]!], "standard")!, /duplicate/);
  assert.match(optionSetProblem(RISK_OPTIONS, "nope" as Risk)!, /not one of the options/);
  assert.match(optionSetProblem(RISK_OPTIONS, "standard", { permitted: ["low"] })!, /permitted must include the fallback/);
  assert.match(optionSetProblem(RISK_OPTIONS.slice(0, 1), "low", { question: "score" })!, /2-10 levels/);
});

test("decisions: withRecorder keeps config + client and swaps only the recorder", async () => {
  const fake = FakeDecisionClient.choosing("low", 0.9);
  const first = memoryRecorder();
  const second = memoryRecorder();
  const decider = createDecider({ config: enabled({ mode: "act" }), client: fake, recorder: first.recorder });
  const rewired = decider.withRecorder(second.recorder);
  assert.deepEqual(rewired.config, decider.config);
  assert.equal((await rewired.decide(riskRequest())).choice, "low");
  assert.equal(fake.calls.length, 1, "the same injected client is reused");
  assert.equal(first.decisions.length, 0);
  assert.equal(second.decisions.length, 1);
  await decider.withRecorder(null).decide(riskRequest());
  assert.equal(first.decisions.length + second.decisions.length, 1, "withRecorder(null) records nowhere");
});

test("decisions decideBatch: replay and live items mix — replayed items never reach the wire, live ones share one call", async () => {
  const recorded = await recordedHigh();
  const fake = FakeDecisionClient.choosing("low", 0.9);
  const mem = memoryRecorder();
  const decider = createDecider({ config: enabled({ mode: "act" }), client: fake, recorder: mem.recorder });
  const { state: _state, ...item } = riskRequest();
  const results = await decider.decideBatch("the diff", [
    { ...item, key: "run", replay: recorded },
    { ...item, key: "live_a" },
    { ...item, key: "missing", replay: null },
    { ...item, key: "live_b" },
  ]);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(Object.keys(fake.calls[0]!.questions), ["q1", "q3"], "question names are the ITEM index, not the live index");
  assert.deepEqual(results.map((r) => [r.key, r.choice, r.reason, r.replayed]), [
    ["run", "high", null, true],
    ["live_a", "low", null, false],
    ["missing", "standard", "replay_missing", false],
    ["live_b", "low", null, false],
  ]);
  assert.deepEqual(mem.decisions.map((d) => d.key), ["run", "live_a", "missing", "live_b"]);
});

test("decisions decideBatch: the one call's deadline is the LARGEST live timeout_ms", async () => {
  const fake = FakeDecisionClient.delayed(80, "low", 0.9);
  const decider = createDecider({ config: enabled({ mode: "act", timeout_ms: 10, kinds: { slow_kind: { timeout_ms: 2_000 } } }), client: fake });
  const { state: _state, ...item } = riskRequest();
  const results = await decider.decideBatch("s", [item, { ...item, kind: "slow_kind" }]);
  assert.deepEqual(results.map((r) => r.reason), [null, null], "the 10ms item rides the 2000ms deadline: one request, one deadline");
  const tight = createDecider({ config: enabled({ mode: "act", timeout_ms: 10 }), client: FakeDecisionClient.delayed(80, "low", 0.9) });
  assert.equal((await tight.decide(riskRequest())).reason, "timeout");
});

test("decisions: FakeDecisionClient.hanging() observes the abort — its promise settles and the signal is aborted at the timeout", async () => {
  const fake = FakeDecisionClient.hanging();
  const d = await createDecider({ config: enabled({ mode: "act", timeout_ms: 15 }), client: fake }).decide(riskRequest());
  assert.equal(d.reason, "timeout");
  assert.equal(fake.signals.length, 1);
  assert.equal(fake.signals[0]!.aborted, true);
});

test("decisions: score probabilities keyed by neither index nor description => invalid_response (a wire-shape problem, not invalid_choice)", async () => {
  const decider = createDecider({
    config: enabled({ mode: "act" }),
    client: FakeDecisionClient.answering({ q0: { type: "score", score: 1, probabilities: { alpha: 0.1, beta: 0.9 }, confidence: 0.9 } }),
  });
  const d = await decider.decide(riskRequest({ question: "score" }));
  assert.equal(d.reason, "invalid_response");
  assert.match(d.detail, /neither level index nor description/);
  const byDescription = createDecider({
    config: enabled({ mode: "act" }),
    client: FakeDecisionClient.answering({ q0: { type: "score", probabilities: { "an ordinary change": 0.9, "a risky or broad change": 0.1 }, confidence: 0.9 } }),
  });
  assert.equal((await byDescription.decide(riskRequest({ question: "score" }))).choice, "standard");
});

test("decisions: HttpSystemOneClient — a non-JSON body, a body without `answers`, and a fetch AbortError all fall back (error/error/timeout)", async () => {
  const respond = (body: string) => new HttpSystemOneClient({ apiKey: "k", fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch });
  const notJson = await createDecider({ config: enabled({ mode: "act" }), client: respond("<html>gateway</html>") }).decide(riskRequest());
  assert.equal(notJson.reason, "error");
  assert.match(notJson.detail, /not JSON/);
  const noAnswers = await createDecider({ config: enabled({ mode: "act" }), client: respond(JSON.stringify({ model: "m" })) }).decide(riskRequest());
  assert.equal(noAnswers.reason, "error");
  assert.match(noAnswers.detail, /no `answers` object/);
  const aborting = new HttpSystemOneClient({
    apiKey: "k",
    fetchImpl: (async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch,
  });
  const aborted = await createDecider({ config: enabled({ mode: "act" }), client: aborting }).decide(riskRequest());
  assert.equal(aborted.reason, "timeout");
});

test("decisions kinds: indexKinds throws on a kind registered twice", () => {
  const a = defineDecisionKind({ kind: "dup_kind", summary: "a", question: "choice" });
  const b = defineDecisionKind({ kind: "dup_kind", summary: "b", question: "choice" });
  assert.throws(() => indexKinds([a, b]), /registered twice/);
  assert.deepEqual(Object.keys(indexKinds([a])), ["dup_kind"]);
});

test("decisions config: an override layer that omits `decisions` keeps the base's; an empty YAML `decisions:` (null) parses as {}", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-decisions-merge2-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(base, "decisions:\n  kinds:\n    a: {mode: act}\n");
    writeFileSync(override, "decisions:\n  enabled: true\n");
    assert.deepEqual(loadConfig([base, override]).decisions.kinds, { a: { mode: "act" } });

    const placeholder = join(dir, "placeholder.yaml");
    writeFileSync(placeholder, "decisions:\n  enabled: true\n  kinds:\n");
    assert.deepEqual(loadConfig([placeholder]).decisions.kinds, {});
    const emptyEntry = join(dir, "empty_entry.yaml");
    writeFileSync(emptyEntry, "decisions:\n  kinds:\n    risk_tier:\n");
    assert.deepEqual(loadConfig([emptyEntry]).decisions.kinds, { risk_tier: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the injection route features use: startRun -> run.decider ───────────────────

async function withStartedRun(yaml: string, adwId: string, body: (run: Awaited<ReturnType<typeof startRun>>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "spf-decisions-startrun-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, yaml);
    const run = await startRun(
      { prompt: "a short prompt", config_paths: [configPath], adw_id: adwId, cwd: dir, chain_name: "plan-build", unattended: true },
      [],
      [],
    );
    try {
      await body(run);
    } finally {
      await run.tracer.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function decisionRows(run: Awaited<ReturnType<typeof startRun>>, adwId: string): Promise<Array<{ phase_id: string; payload_json: string }>> {
  return (await run.tracer.db.query("SELECT phase_id, payload_json FROM events WHERE adw_id=? AND type='log' AND name=?").all(adwId, DECISION_EVENT)) as Array<{
    phase_id: string;
    payload_json: string;
  }>;
}

test("decisions startRun: setDecisionClientFactory reaches run.decider, and a decision lands in the run's trace as one decision row", async () => {
  const fake = FakeDecisionClient.choosing("low", 0.9);
  setDecisionClientFactory(() => fake);
  try {
    const adwId = "adw_jev_startrun_on";
    await withStartedRun("decisions:\n  enabled: true\n  mode: act\n", adwId, async (run) => {
      assert.equal(run.decider.enabled, true);
      assert.equal((await decisionRows(run, adwId)).length, 0, "startRun itself makes no decision");
      const d = await run.decider.decide(riskRequest({ phase_id: "ph_1" }));
      assert.equal(d.choice, "low");
      assert.equal(fake.calls.length, 1);
      const rows = await decisionRows(run, adwId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.phase_id, "ph_1");
      assert.equal(parseRecordedDecision(JSON.parse(rows[0]!.payload_json))?.choice, "low");
      assert.equal((await findRecordedDecision(run.tracer.db, adwId, "risk_tier"))?.choice, "low");
    });
  } finally {
    setDecisionClientFactory(null);
  }
});

test("decisions startRun: with NO decisions: block, run.decider is off — fallback acts, zero calls, zero decision rows (invariant 1)", async () => {
  const fake = FakeDecisionClient.choosing("low", 0.9);
  setDecisionClientFactory(() => fake);
  try {
    const adwId = "adw_jev_startrun_off";
    await withStartedRun("watch:\n  repo: acme/widgets\n", adwId, async (run) => {
      assert.equal(run.decider.enabled, false);
      const d = await run.decider.decide(riskRequest());
      assert.equal(d.choice, "standard");
      assert.equal(d.reason, "disabled");
      assert.equal(fake.calls.length, 0);
      assert.equal((await decisionRows(run, adwId)).length, 0);
    });
  } finally {
    setDecisionClientFactory(null);
  }
});
