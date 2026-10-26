/**
 * #150 Part 1 — the `jev` -> `decisions` rename's BACK-COMPAT surface. The
 * existing suites (`decisions.test.ts` and friends) pin the new shape; this
 * file pins everything that must keep working for an operator or a trace db
 * that predates the rename:
 *
 *   - a legacy `jev:` config block normalizes to EXACTLY the config the
 *     equivalent `decisions:` block produces (one shape downstream);
 *   - `jev:` and `decisions:` together is a config error naming both;
 *   - `piquette doctor` warns (never fails) when the legacy block was used;
 *   - an old `jev_decision` row carrying `jev_choice` still replays
 *     identically, is listed by `listRecordedDecisions`, and is returned by
 *     the dashboard's `SfDb.recordedDecisions` query;
 *   - new rows are written as `decision` / `model_choice` and carry
 *     `backend` / `provider` / `model`;
 *   - invariant 1 (#102): no block at all => the heuristic result and zero
 *     decision rows, whichever spelling an absent block would have used.
 *
 * No network: every decision goes through `FakeDecisionClient`. Nothing here
 * spawns git, but `hermetic_git` is imported first anyway (house rule).
 */
import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, usedLegacyJevBlock } from "../core/agents.js";
import { makeEventRecord, migrateLegacyJevBlock, type DecisionsConfigInput } from "../core/data_types.js";
import { Tracer } from "../core/tracer.js";
import { SfDb } from "../ui/server/db.js";
import { doctorCommand } from "../cli/commands/doctor.js";
import { misplacedLoopSettings } from "../chains/loop_control.js";
import { FINDING_TRIAGE_EVENT_NAMES, LEGACY_FINDING_TRIAGE_EVENT, FINDING_TRIAGE_EVENT } from "../chains/finding_triage.js";
import {
  DECISION_EVENT,
  DECISION_EVENT_NAMES,
  LEGACY_DECISION_EVENT,
  createDecider,
  decisionsFromEvents,
  findRecordedDecision,
  setDecisionClientFactory,
  listRecordedDecisions,
  parseRecordedDecision,
  traceDecisionRecorder,
  type Decision,
  type DecisionOption,
  type DecisionRequest,
} from "../core/decisions.js";
import { FakeDecisionClient } from "./fake_decisions.js";
import { decideRiskTier } from "../core/risk_tier.js";
import { estimateCommand, type EstimateReport } from "../cli/commands/estimate.js";
import { CHAIN_EDGE_KIND } from "../core/decision_kinds.js";

type Risk = "low" | "standard" | "high";
const RISK_OPTIONS: DecisionOption<Risk>[] = [
  { value: "low", description: "a trivial, well-scoped change" },
  { value: "standard", description: "an ordinary change" },
  { value: "high", description: "a risky or broad change" },
];

function riskRequest(overrides: Partial<DecisionRequest<Risk>> = {}): DecisionRequest<Risk> {
  return { kind: "risk_tier", options: RISK_OPTIONS, instructions: "How risky is this change?", state: "rename a variable", fallback: "standard", ...overrides };
}

function withTmp<T>(prefix: string, body: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return Promise.resolve(body(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A payload exactly as a pre-#150 build recorded it: `jev_choice`, no `backend`/`provider`. */
function legacyPayload(choice: Risk | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "risk_tier",
    key: "run",
    question: "choice",
    options: ["low", "standard", "high"],
    choice: choice ?? "standard",
    jev_choice: choice,
    confidence: choice === null ? null : 0.93,
    score: null,
    probabilities: null,
    fallback: "standard",
    used_fallback: choice === null,
    reason: choice === null ? "timeout" : null,
    detail: choice === null ? "jev: no answer within 2000 ms" : "",
    would_act: choice !== null,
    agrees: choice === null ? null : choice === "standard",
    latency_ms: 41,
    mode: "act",
    threshold: 0.7,
    model: "jev-latest",
    usage: { input_tokens: 12, output_tokens: 0 },
    input_sha256: "abc123",
    replayed: false,
    ...extra,
  };
}

// ── config: legacy `jev:` -> `decisions:` ────────────────────────────────────

const LEGACY_FULL = `jev:
  enabled: true
  mode: act
  threshold: 0.8
  timeout_ms: 4000
  provider: ollama
  model: jev-preview
  api_key_env: MY_TYPESAFE_KEY
  base_url: https://proxy.example.com/v1
  cloudflare:
    gateway: gw1
  ollama:
    base_url: http://box:11434/v1
    model: tev1
  decisions:
    risk_tier: { mode: shadow, max_risk: standard }
    chain_router: { mode: off }
`;

const MODERN_FULL = `decisions:
  enabled: true
  mode: act
  threshold: 0.8
  timeout_ms: 4000
  systemone:
    provider: ollama
    model: jev-preview
    api_key_env: MY_TYPESAFE_KEY
    base_url: https://proxy.example.com/v1
    cloudflare:
      gateway: gw1
    ollama:
      base_url: http://box:11434/v1
      model: tev1
  kinds:
    risk_tier: { mode: shadow, max_risk: standard }
    chain_router: { mode: off }
`;

test("config: a legacy `jev:` block loads to the SAME DecisionsConfig as the equivalent `decisions:` block", async () => {
  await withTmp("piquette-decisions-compat-cfg-", (dir) => {
    const legacy = join(dir, "legacy.yaml");
    const modern = join(dir, "modern.yaml");
    writeFileSync(legacy, LEGACY_FULL);
    writeFileSync(modern, MODERN_FULL);
    const fromLegacy = loadConfig([legacy]);
    const fromModern = loadConfig([modern]);
    assert.deepEqual(fromLegacy.decisions, fromModern.decisions);
    // Spot-check the mapping itself, so "both wrong the same way" cannot pass.
    assert.equal(fromLegacy.decisions.systemone.provider, "ollama");
    assert.equal(fromLegacy.decisions.systemone.model, "jev-preview");
    assert.equal(fromLegacy.decisions.systemone.ollama.model, "tev1");
    assert.equal(fromLegacy.decisions.systemone.cloudflare.gateway, "gw1");
    assert.equal(fromLegacy.decisions.backend, "systemone");
    assert.deepEqual(Object.keys(fromLegacy.decisions.kinds).sort(), ["chain_router", "risk_tier"]);
    assert.equal(fromLegacy.decisions.kinds["risk_tier"]!["max_risk"], "standard", "per-kind extras survive the migration");
    assert.ok(!("jev" in fromLegacy), "nothing downstream ever sees a `jev` key");
    assert.equal(usedLegacyJevBlock(fromLegacy), true);
    assert.equal(usedLegacyJevBlock(fromModern), false);
  });
});

test("config: a legacy `jev:` with only flat basics (enabled/mode) maps 1:1 and leaves systemone at its defaults", async () => {
  await withTmp("piquette-decisions-compat-basic-", (dir) => {
    const legacy = join(dir, "legacy.yaml");
    const modern = join(dir, "modern.yaml");
    writeFileSync(legacy, "jev:\n  enabled: true\n  mode: act\n");
    writeFileSync(modern, "decisions:\n  enabled: true\n  mode: act\n");
    assert.deepEqual(loadConfig([legacy]).decisions, loadConfig([modern]).decisions);
  });
});

test("config: an empty legacy `jev:` key (null) is an empty block, still flagged as legacy", async () => {
  await withTmp("piquette-decisions-compat-null-", (dir) => {
    const file = join(dir, "c.yaml");
    writeFileSync(file, "jev:\n");
    const cfg = loadConfig([file]);
    assert.equal(cfg.decisions.enabled, false);
    assert.equal(usedLegacyJevBlock(cfg), true);
  });
});

test("config: a `jev:` block renamed to `decisions:` in place (old flat keys) is refused by name, never silently stripped", async () => {
  await withTmp("piquette-decisions-compat-flat-", (dir) => {
    for (const [body, key, moved] of [
      ["decisions:\n  enabled: true\n  mode: act\n  provider: ollama\n", "decisions.provider", "decisions.systemone.provider"],
      ["decisions:\n  enabled: true\n  decisions:\n    chain_router: { mode: off }\n", "decisions.decisions", "decisions.kinds"],
      ["decisions:\n  ollama:\n    model: nimble\n", "decisions.ollama", "decisions.systemone.ollama"],
    ] as const) {
      const file = join(dir, "c.yaml");
      writeFileSync(file, body);
      assert.throws(
        () => loadConfig([file]),
        (error: unknown) => {
          const message = (error as Error).message;
          return message.includes(file) && message.includes(`\`${key}\``) && message.includes(`\`${moved}\``);
        },
        body,
      );
    }
  });
});

test("config: a non-object `jev:` (true, \"on\", a list) is still a config error — never a silent disabled no-op", async () => {
  await withTmp("piquette-decisions-compat-scalar-", (dir) => {
    for (const [body, shown] of [["jev: true\n", "true"], ["jev: on-ish\n", "on-ish"], ["jev: [1, 2]\n", "list"], ["decisions: true\n", "true"]] as const) {
      const file = join(dir, "c.yaml");
      writeFileSync(file, body);
      assert.throws(
        () => loadConfig([file]),
        (error: unknown) => {
          const message = (error as Error).message;
          return /must be a mapping/.test(message) && message.includes(file) && message.includes(body.split(":")[0]!) && message.includes(shown === "list" ? "a list" : shown);
        },
        body,
      );
    }
    // The pure migration passes a non-object through (so schema validation rejects it) rather than inventing `{}`.
    assert.deepEqual(migrateLegacyJevBlock({ jev: true }).raw, { decisions: true });
    assert.deepEqual(migrateLegacyJevBlock({ jev: null }).raw, { decisions: {} });
  });
});

test("config: `jev:` and `decisions:` in the same file is an error that names both", async () => {
  await withTmp("piquette-decisions-compat-both-", (dir) => {
    const file = join(dir, "c.yaml");
    writeFileSync(file, "jev:\n  enabled: true\ndecisions:\n  enabled: true\n");
    assert.throws(
      () => loadConfig([file]),
      (error: unknown) => {
        const message = (error as Error).message;
        return /jev:/.test(message) && /decisions:/.test(message) && message.includes(file);
      },
    );
  });
  assert.throws(() => migrateLegacyJevBlock({ jev: {}, decisions: {} }), /both `jev:` and `decisions:`/);
});

test("config: layers merge across spellings — a base `jev:` and an override `decisions:` combine like any two layers", async () => {
  await withTmp("piquette-decisions-compat-layers-", (dir) => {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(base, "jev:\n  threshold: 0.9\n  model: jev-1.13\n  decisions:\n    a: {mode: act}\n");
    writeFileSync(override, "decisions:\n  enabled: true\n  systemone:\n    provider: ollama\n");
    const cfg = loadConfig([base, override]);
    assert.equal(cfg.decisions.enabled, true);
    assert.equal(cfg.decisions.threshold, 0.9, "the legacy base's scalar survives");
    assert.equal(cfg.decisions.systemone.model, "jev-1.13", "systemone merges key-by-key across layers");
    assert.equal(cfg.decisions.systemone.provider, "ollama");
    assert.deepEqual(Object.keys(cfg.decisions.kinds), ["a"]);
    assert.equal(usedLegacyJevBlock(cfg), true);
  });
});

test("migrateLegacyJevBlock: pure — never mutates its input, passes a layer with no `jev:` through untouched", () => {
  const input = { jev: { enabled: true, provider: "cloudflare", decisions: { x: {} } }, watch: { repo: "a/b" } };
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = migrateLegacyJevBlock(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(out.raw, { watch: { repo: "a/b" }, decisions: { enabled: true, systemone: { provider: "cloudflare" }, kinds: { x: {} } } });
  const plain = { watch: { repo: "a/b" } };
  const same = migrateLegacyJevBlock(plain);
  assert.equal(same.legacy, false);
  assert.equal(same.raw, plain);
});

// ── doctor: deprecation warning ───────────────────────────────────────────────

async function doctorJson(dir: string): Promise<{ checks: Array<{ name: string; ok: boolean; detail: string; severity?: string }> }> {
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
}

test("doctor: a legacy `jev:` block WARNS (not fails) that it is deprecated; `decisions:` does not", async () => {
  await withTmp("piquette-decisions-compat-doctor-", async (dir) => {
    mkdirSync(join(dir, ".piquette"), { recursive: true });
    const configPath = join(dir, ".piquette", "piquette.config.yaml");

    writeFileSync(configPath, "watch:\n  repo: acme/widgets\njev:\n  enabled: true\n");
    const legacy = await doctorJson(dir);
    const warn = legacy.checks.find((c) => c.detail.startsWith("jev: is deprecated; move it to decisions:"));
    assert.ok(warn, "expected the deprecation check");
    assert.equal(warn!.ok, true, "a warning, not a failure");
    assert.equal(warn!.severity, "warn");
    assert.equal(legacy.checks.find((c) => c.name === "config parses")!.ok, true, "the legacy config still parses");
    assert.ok(legacy.checks.some((c) => c.name === "decisions api key"), "and the decision checks still run off the migrated block");

    writeFileSync(configPath, "watch:\n  repo: acme/widgets\ndecisions:\n  enabled: true\n");
    const modern = await doctorJson(dir);
    assert.equal(modern.checks.some((c) => /deprecated/.test(c.detail)), false);

    writeFileSync(configPath, "watch:\n  repo: acme/widgets\njev:\n  enabled: true\ndecisions:\n  enabled: true\n");
    const both = await doctorJson(dir);
    const parses = both.checks.find((c) => c.name === "config parses")!;
    assert.equal(parses.ok, false);
    assert.match(parses.detail, /jev:/);
    assert.match(parses.detail, /decisions:/);
  });
});

test("doctor: misplacedLoopSettings flags a `loop:` block under either spelling", () => {
  assert.match(misplacedLoopSettings({ decisions: { loop: { max_tier: "strong" } } })!, /^decisions\.loop is not a setting/);
  assert.match(misplacedLoopSettings({ jev: { loop: { max_tier: "strong" } } })!, /^jev\.loop is not a setting/);
  assert.equal(misplacedLoopSettings({ jev: { enabled: true } }), null);
});

// ── trace: old rows still read, new rows carry the new fields ─────────────────

test("an old `jev_decision` / `jev_choice` row parses, and replays to the same effective choice as its modern twin", async () => {
  const legacy = parseRecordedDecision(legacyPayload("high"));
  assert.ok(legacy, "the legacy payload parses");
  assert.equal(legacy!.model_choice, "high", "jev_choice is read as model_choice");
  assert.ok(!("jev_choice" in legacy!), "the legacy key does not leak into the Decision");
  assert.equal(legacy!.backend, null, "pre-#150 rows carry no backend");
  assert.equal(legacy!.provider, null);

  const modern = parseRecordedDecision({ ...legacyPayload("high"), jev_choice: undefined, model_choice: "high", backend: "systemone", provider: "typesafe" });
  assert.ok(modern);

  const replayWith = async (recorded: Decision): Promise<Decision> => {
    const fake = FakeDecisionClient.choosing("low", 0.99);
    const decider = createDecider({ config: { enabled: true, mode: "act" }, client: fake });
    const d = await decider.decide(riskRequest({ key: "run", replay: recorded }));
    assert.equal(fake.calls.length, 0, "a replay never calls the model");
    return d;
  };
  const fromLegacy = await replayWith(legacy!);
  const fromModern = await replayWith(modern!);
  assert.equal(fromLegacy.choice, "high");
  assert.equal(fromLegacy.replayed, true);
  assert.equal(fromLegacy.used_fallback, false);
  assert.deepEqual(
    { choice: fromLegacy.choice, model_choice: fromLegacy.model_choice, reason: fromLegacy.reason, confidence: fromLegacy.confidence, used_fallback: fromLegacy.used_fallback },
    { choice: fromModern.choice, model_choice: fromModern.model_choice, reason: fromModern.reason, confidence: fromModern.confidence, used_fallback: fromModern.used_fallback },
  );
});

test("when a payload carries BOTH `model_choice` and `jev_choice`, model_choice wins", () => {
  const both = parseRecordedDecision({ ...legacyPayload("high"), model_choice: "low", choice: "low" });
  assert.equal(both!.model_choice, "low");
});

test("a recorded legacy FAILURE (jev_choice: null) replays as that same failure", async () => {
  const recorded = parseRecordedDecision(legacyPayload(null))!;
  const decider = createDecider({ config: { enabled: true, mode: "act" }, client: FakeDecisionClient.choosing("high", 0.99) });
  const d = await decider.decide(riskRequest({ key: "run", replay: recorded }));
  assert.equal(d.reason, "timeout");
  assert.equal(d.choice, "standard");
  assert.equal(d.model_choice, null);
});

test("findRecordedDecision / listRecordedDecisions read old `jev_decision` rows from the trace db, mixed with new ones, oldest first", async () => {
  await withTmp("piquette-decisions-compat-trace-", async (dir) => {
    const tracer = await Tracer.open(join(dir, "trace.db"), join(dir, "events.jsonl"));
    try {
      await tracer.event(makeEventRecord({ adw_id: "adw_old", type: "log", name: LEGACY_DECISION_EVENT, payload: legacyPayload("high") }));
      // A second, NEWER answer for the same (kind, key), written by today's recorder.
      const decider = createDecider({
        config: { enabled: true, mode: "act" },
        client: FakeDecisionClient.choosing("low", 0.95),
        recorder: traceDecisionRecorder(tracer, "adw_old"),
      });
      await decider.decide(riskRequest({ key: "run" }));
      // A different run's legacy row must not leak in.
      await tracer.event(makeEventRecord({ adw_id: "adw_other", type: "log", name: LEGACY_DECISION_EVENT, payload: legacyPayload("low") }));

      const names = (await tracer.db.query("SELECT name FROM events WHERE adw_id=? ORDER BY rowid").all("adw_old")) as Array<{ name: string }>;
      assert.deepEqual(names.map((n) => n.name), [LEGACY_DECISION_EVENT, DECISION_EVENT]);

      const all = await listRecordedDecisions(tracer.db, "adw_old");
      assert.deepEqual(all.map((d) => d.model_choice), ["high", "low"], "both spellings, in recording order");
      const latest = await findRecordedDecision(tracer.db, "adw_old", "risk_tier", "run");
      assert.equal(latest!.model_choice, "low", "the NEWER row wins, whichever name it was written under");

      // With ONLY the legacy row present, it is what replays.
      const onlyOld = await findRecordedDecision(tracer.db, "adw_other", "risk_tier", "run");
      assert.equal(onlyOld!.model_choice, "low");
      assert.equal((await listRecordedDecisions(tracer.db, "adw_missing")).length, 0);
    } finally {
      await tracer.close();
    }
  });
});

test("the dashboard's SfDb.recordedDecisions returns an old `jev_decision` row", async () => {
  await withTmp("piquette-decisions-compat-ui-", async (dir) => {
    const dbPath = join(dir, "piquette.db");
    const tracer = await Tracer.open(dbPath, join(dir, "events.jsonl"));
    await tracer.event(makeEventRecord({ adw_id: "adw_ui", type: "log", name: LEGACY_DECISION_EVENT, payload: legacyPayload("high") }));
    await tracer.close();
    const sfdb = await SfDb.open(dbPath, join(dir, "sessions"));
    try {
      const rows = await sfdb.recordedDecisions("adw_ui", { kind: "risk_tier" });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.model_choice, "high");
      assert.equal(rows[0]!.choice, "high");
      assert.equal((await sfdb.recordedDecisions("adw_ui", { kind: "nope" })).length, 0);
    } finally {
      await sfdb.close();
    }
  });
});

test("decisionsFromEvents accepts both event names, and only `log` events", () => {
  const events = [
    { type: "log", name: LEGACY_DECISION_EVENT, payload: legacyPayload("low") },
    { type: "log", name: DECISION_EVENT, payload: { ...legacyPayload("high"), jev_choice: undefined, model_choice: "high" } },
    { type: "tool_call", name: DECISION_EVENT, payload: legacyPayload("high") },
    { type: "log", name: "something_else", payload: legacyPayload("high") },
  ];
  assert.deepEqual(decisionsFromEvents(events).map((d) => d.model_choice), ["low", "high"]);
  assert.deepEqual([...DECISION_EVENT_NAMES], [DECISION_EVENT, LEGACY_DECISION_EVENT]);
  assert.equal(DECISION_EVENT, "decision", "new rows are written under the neutral name");
});

test("finding-triage outcome rows: the new name is written, the old name stays in the readers' name list", () => {
  assert.equal(FINDING_TRIAGE_EVENT, "decision_triage");
  assert.equal(LEGACY_FINDING_TRIAGE_EVENT, "jev_triage");
  assert.deepEqual([...FINDING_TRIAGE_EVENT_NAMES], [FINDING_TRIAGE_EVENT, LEGACY_FINDING_TRIAGE_EVENT]);
});

test("new rows are written as `decision` with `model_choice`, `backend`, `provider` and `model` (and no `jev_choice`)", async () => {
  await withTmp("piquette-decisions-compat-new-", async (dir) => {
    const tracer = await Tracer.open(join(dir, "trace.db"), join(dir, "events.jsonl"));
    try {
      const cases: Array<{ adw: string; config: DecisionsConfigInput; provider: string }> = [
        { adw: "adw_ts", config: { enabled: true, mode: "act" }, provider: "typesafe" },
        { adw: "adw_ol", config: { enabled: true, mode: "act", systemone: { provider: "ollama" } }, provider: "ollama" },
        { adw: "adw_cf", config: { enabled: true, mode: "act", systemone: { provider: "cloudflare" } }, provider: "cloudflare" },
      ];
      for (const c of cases) {
        const decider = createDecider({ config: c.config, client: FakeDecisionClient.choosing("high", 0.95), recorder: traceDecisionRecorder(tracer, c.adw) });
        await decider.decide(riskRequest({ key: "run" }));
        const rows = (await tracer.db.query("SELECT type, name, payload_json FROM events WHERE adw_id=?").all(c.adw)) as Array<{ type: string; name: string; payload_json: string }>;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.type, "log");
        assert.equal(rows[0]!.name, "decision");
        const payload = JSON.parse(rows[0]!.payload_json) as Record<string, unknown>;
        assert.equal(payload["model_choice"], "high");
        assert.equal("jev_choice" in payload, false);
        assert.equal(payload["backend"], "systemone");
        assert.equal(payload["provider"], c.provider);
        assert.equal(typeof payload["model"], "string", "the model the call used is recorded");
        // And it reads back (round trip through the schema).
        assert.equal((await findRecordedDecision(tracer.db, c.adw, "risk_tier", "run"))!.provider, c.provider);
      }
    } finally {
      await tracer.close();
    }
  });
});

test("a decision made with the default config carries backend `systemone` / provider `typesafe` and the requested model id", async () => {
  const recorded: Decision[] = [];
  const decider = createDecider({
    config: { enabled: true, mode: "act" },
    client: FakeDecisionClient.choosing("high", 0.95),
    recorder: (d) => void recorded.push(d),
  });
  const d = await decider.decide(riskRequest());
  assert.equal(d.backend, "systemone");
  assert.equal(d.provider, "typesafe");
  assert.equal(d.model, "jev-latest");
  assert.equal(recorded.length, 1);
});

// ── invariant 1 (#102): off by default, in both spellings ─────────────────────

test("invariant 1: no `decisions:`/`jev:` block at all => the heuristic (fallback) result, zero calls, zero decision rows", async () => {
  await withTmp("piquette-decisions-compat-off-", async (dir) => {
    const file = join(dir, "c.yaml");
    writeFileSync(file, "watch:\n  repo: acme/widgets\n");
    const cfg = loadConfig([file]);
    assert.equal(cfg.decisions.enabled, false);
    assert.equal(usedLegacyJevBlock(cfg), false);

    const tracer = await Tracer.open(join(dir, "trace.db"), join(dir, "events.jsonl"));
    try {
      const fake = FakeDecisionClient.choosing("high", 0.99);
      const decider = createDecider({ config: cfg.decisions, client: fake, recorder: traceDecisionRecorder(tracer, "adw_off") });
      const d = await decider.decide(riskRequest());
      assert.equal(d.choice, "standard", "the caller's own heuristic answer");
      assert.equal(d.reason, "disabled");
      assert.equal(fake.calls.length, 0);
      const rows = (await tracer.db.query("SELECT COUNT(*) AS n FROM events WHERE name IN (?, ?)").get(DECISION_EVENT, LEGACY_DECISION_EVENT)) as { n: number };
      assert.equal(rows.n, 0);
    } finally {
      await tracer.close();
    }
  });
});

test("invariant 1: a legacy `jev:` block with enabled:false is just as inert as `decisions:` with enabled:false", async () => {
  await withTmp("piquette-decisions-compat-off2-", async (dir) => {
    const file = join(dir, "c.yaml");
    writeFileSync(file, "jev:\n  enabled: false\n  mode: act\n");
    const fake = FakeDecisionClient.choosing("high", 0.99);
    const decider = createDecider({ config: loadConfig([file]).decisions, client: fake });
    const d = await decider.decide(riskRequest());
    assert.equal(d.reason, "disabled");
    assert.equal(fake.calls.length, 0);
  });
});

test("invariant 1: with no block, NO client is ever constructed (a throwing factory is never invoked) and the decision is the fallback", async () => {
  await withTmp("piquette-decisions-compat-noclient-", async (dir) => {
    const file = join(dir, "c.yaml");
    writeFileSync(file, "watch:\n  repo: acme/widgets\n");
    const cfg = loadConfig([file]);
    const constructed: string[] = [];
    setDecisionClientFactory(() => {
      constructed.push("factory");
      throw new Error("constructed");
    });
    try {
      // No `client` option: a live decider would have to ask the factory for one.
      const decider = createDecider({ config: cfg.decisions });
      const d = await decider.decide(riskRequest());
      assert.equal(d.choice, "standard");
      assert.equal(d.used_fallback, true);
      assert.equal(d.reason, "disabled");
      assert.deepEqual(constructed, [], "the client factory was never called");

      // A legacy `jev:` block with enabled:false is the same: still no client.
      writeFileSync(file, "jev:\n  enabled: false\n");
      const legacy = await createDecider({ config: loadConfig([file]).decisions }).decide(riskRequest());
      assert.equal(legacy.reason, "disabled");
      assert.deepEqual(constructed, []);
    } finally {
      setDecisionClientFactory(null);
    }
  });
});

// ── every reader of a recorded decision accepts the pre-#150 row shape ───────
//
// Readers in this repo: `findRecordedDecision` (graph replay `chain_edge`,
// chain_router/loop_control replay), `listRecordedDecisions`/`SfDb.recordedDecisions`
// (dashboard, `piquette estimate --replay-risk`). The persisted `tiering` event's
// `risk_decision` summary (was `jev`) and the `chain_edge` event's `via`
// ("decisions", was "jev") have NO reader in this repo — they are display-only
// rows — so there is nothing to alias; the CHANGELOG records the old spellings.

/** Rewrite a stored `decision` row into the exact shape a pre-#150 build wrote: name `jev_decision`, `jev_choice`, no backend/provider. */
async function downgradeToLegacyRows(tracer: Tracer, adwId: string): Promise<number> {
  const rows = (await tracer.db.query("SELECT event_id, payload_json FROM events WHERE adw_id=? AND name=?").all(adwId, DECISION_EVENT)) as Array<{ event_id: string; payload_json: string }>;
  for (const row of rows) {
    const { model_choice, backend: _backend, provider: _provider, ...rest } = JSON.parse(row.payload_json) as Record<string, unknown>;
    await tracer.db.query("UPDATE events SET name=?, payload_json=? WHERE event_id=?").run(LEGACY_DECISION_EVENT, JSON.stringify({ ...rest, jev_choice: model_choice }), row.event_id);
  }
  return rows.length;
}

test("piquette estimate --replay-risk reads an old `jev_decision` row (jev_choice) and reuses its answer without calling the model", async () => {
  await withTmp("piquette-decisions-compat-estimate-", async (dir) => {
    const configPath = join(dir, "piquette.config.yaml");
    writeFileSync(
      configPath,
      "agents:\n  - name: scout\n    coding_agent: flue\n    model: openai/configured\n    prompt_engineering: {system: scout/system.md, user: scout/user.md}\n" +
        "tiering:\n  enabled: true\n  tiers:\n    - {name: cheap, coding_agent: flue, model: openai/small}\n    - {name: mid, coding_agent: flue, model: openai/mid}\n    - {name: strong, coding_agent: flue, model: openai/big}\n  roles: {scout: mid}\n" +
        "decisions:\n  enabled: true\n  mode: act\n",
    );
    const prompt = "look around"; // heuristic: low
    const tracer = await Tracer.open(join(dir, ".piquette", "data", "piquette.db"), join(dir, ".piquette", "data", "sessions", "events.jsonl"));
    await tracer.sessionStart("r1", "tester", "scout");
    const recorder = createDecider({ config: { enabled: true, mode: "act" }, client: FakeDecisionClient.choosing("standard", 0.9), recorder: traceDecisionRecorder(tracer, "r1") });
    assert.equal((await decideRiskTier(recorder, loadConfig([configPath]), { chainName: "scout", prompt }))?.choice, "standard");
    assert.equal(await downgradeToLegacyRows(tracer, "r1"), 1, "fixture: one row rewritten to the legacy shape");
    await tracer.sessionFinish("r1", true);
    await tracer.close();

    const fake = FakeDecisionClient.failing(new Error("estimate must never call the model"));
    setDecisionClientFactory(() => fake);
    const { log, error, warn } = console;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    console.error = () => {};
    console.warn = () => {};
    try {
      await estimateCommand(["scout", prompt, "--config", configPath, "--cwd", dir, "--no-probe", "--replay-risk", "r1", "--json"]);
    } finally {
      console.log = log;
      console.error = error;
      console.warn = warn;
      setDecisionClientFactory(null);
    }
    const report = JSON.parse(logs.join("\n")) as EstimateReport;
    assert.equal(report.risk, "standard", "the recorded (legacy-shaped) answer, not the heuristic's low");
    assert.equal(report.risk_source?.source, "recorded_decision");
    assert.equal(report.risk_source?.decision?.model_choice, "standard", "jev_choice surfaces as model_choice");
    assert.equal(report.risk_source?.decision?.replayed, true);
    assert.equal(fake.calls.length, 0);
  });
});

test("graph replay: an old `jev_decision` chain_edge row replays through findRecordedDecision with no model call", async () => {
  await withTmp("piquette-decisions-compat-edge-", async (dir) => {
    const tracer = await Tracer.open(join(dir, "trace.db"), join(dir, "events.jsonl"));
    try {
      const edgeOptions = [
        { value: "left", description: "go left" },
        { value: "right", description: "go right" },
      ];
      const fake = FakeDecisionClient.choosing("right", 0.99);
      const recorder = createDecider({ config: { enabled: true, mode: "act" }, client: fake, recorder: traceDecisionRecorder(tracer, "adw_edge") });
      const live = await recorder.decide({ kind: CHAIN_EDGE_KIND.kind, key: "check#1", options: edgeOptions, instructions: "which edge?", state: "s", fallback: "left" });
      assert.equal(live.choice, "right");
      assert.equal(await downgradeToLegacyRows(tracer, "adw_edge"), 1);

      const recorded = await findRecordedDecision(tracer.db, "adw_edge", CHAIN_EDGE_KIND.kind, "check#1");
      assert.ok(recorded, "the legacy row is found under the new reader");
      assert.equal(recorded!.model_choice, "right");

      const replayFake = FakeDecisionClient.choosing("left", 0.99);
      const replayer = createDecider({ config: { enabled: true, mode: "act" }, client: replayFake });
      const d = await replayer.decide({ kind: CHAIN_EDGE_KIND.kind, key: "check#1", options: edgeOptions, instructions: "which edge?", state: "s", fallback: "left", replay: recorded });
      assert.equal(d.choice, "right", "the recorded edge, not today's model answer");
      assert.equal(d.replayed, true);
      assert.equal(replayFake.calls.length, 0);
    } finally {
      await tracer.close();
    }
  });
});
