import "./hermetic_git.js";

/**
 * `spf decisions calibrate` (#151).
 *
 * Fixture rows only: no decider is constructed, no `DecisionClient` exists, so
 * no model (and no network) is reachable from here. The pure report logic is
 * driven with hand-built rows + run facts; the reader and the command are
 * driven end to end against a REAL temp SQLite written through the real
 * `Tracer`, with decision rows written in BOTH shapes (the current `decision`
 * event and the pre-#150 `jev_decision` event with `jev_choice`).
 *
 * `hermetic_git.js` is imported first because the command resolves its repo
 * anchor with a read-only `git rev-parse`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer } from "../core/tracer.js";
import { makeEventRecord, makePhaseParams, RUN_KILLED_EVENT } from "../core/data_types.js";
import { DECISION_KINDS } from "../core/decision_kinds.js";
import type { Decision } from "../core/decisions.js";
import {
  buildCalibrationReport,
  formatCalibrationReport,
  NO_OUTCOME_SIGNAL,
  OUTCOME_RULES,
  suggestThreshold,
  wilsonInterval,
  type CalibrationReport,
  type RecordedDecisionRow,
  type RunFacts,
} from "../core/decision_calibration.js";
import { decisionsCommand } from "../cli/commands/decisions.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const DECIDED_AT = "2026-01-01T00:00:00.000+00:00";
const LATER = "2026-01-01T01:00:00.000+00:00";
const OPTS = { target_precision: 0.9, min_samples: 30 };

function decision(over: Partial<Decision> = {}): Decision {
  return {
    kind: "chain_router",
    key: "7",
    question: "choice",
    options: ["a", "b"],
    choice: "a",
    model_choice: "a",
    backend: "systemone",
    provider: "ollama",
    confidence: 0.9,
    score: null,
    probabilities: null,
    fallback: "a",
    used_fallback: true,
    reason: "shadow",
    detail: "",
    would_act: true,
    agrees: true,
    latency_ms: 10,
    mode: "shadow",
    threshold: 0.7,
    model: "nimble",
    usage: null,
    input_sha256: "x",
    replayed: false,
    ...over,
  } as Decision;
}

function row(adw: string, over: Partial<Decision> = {}, extra: Partial<RecordedDecisionRow> = {}): RecordedDecisionRow {
  return { adw_id: adw, phase_id: "", started_at: DECIDED_AT, decision: decision(over), ...extra };
}

/** Own run starts 5 s after a pre-run decision is recorded (chain_router / intake_readiness). */
const RUN_STARTED = "2026-01-01T00:00:05.000+00:00";
/** A revision / re-claim of the same adw_id, after the first run. */
const RERUN_STARTED = "2026-01-01T00:30:00.000+00:00";
/** Before any decision: a run that was already going when a mid-run decision (risk_tier, loop_control) was recorded. */
const RUN_STARTED_BEFORE = "2025-12-31T23:59:00.000+00:00";

function runFacts(adw: string, status: string | null, extra: Partial<RunFacts> = {}): RunFacts {
  return { adw_id: adw, session: status === null ? null : { status, ended_at: LATER }, run_starts: [], open_phases: [], kills: [], failed_gates: [], phases: [], ...extra };
}

function factsOf(...all: RunFacts[]): Map<string, RunFacts> {
  return new Map(all.map((f) => [f.adw_id, f]));
}

function only(report: CalibrationReport) {
  assert.equal(report.groups.length, 1);
  return report.groups[0]!;
}

// ── statistics ───────────────────────────────────────────────────────────────

test("wilsonInterval: known values, and no interval for n = 0", () => {
  assert.equal(wilsonInterval(0, 0), null);
  const nine = wilsonInterval(9, 10)!;
  assert.ok(Math.abs(nine.lo - 0.5958) < 0.001 && Math.abs(nine.hi - 0.9821) < 0.001, JSON.stringify(nine));
  const all = wilsonInterval(30, 30)!;
  assert.ok(Math.abs(all.lo - 0.8865) < 0.001 && all.hi === 1, JSON.stringify(all));
  const none = wilsonInterval(0, 20)!;
  assert.equal(none.lo, 0);
});

test("suggestThreshold: the lowest threshold that reaches the target with enough rows behind it", () => {
  const labeled = [
    ...Array.from({ length: 20 }, (_, i) => ({ confidence: (50 + i) / 100, correct: false })), // 0.50-0.69, all wrong
    ...Array.from({ length: 20 }, (_, i) => ({ confidence: (900 + i * 5) / 1000, correct: true })), // 0.90-0.995, all right
  ];
  const { suggested, note } = suggestThreshold(labeled, 0.9, 15);
  assert.equal(note, null);
  // At >= 0.68 the tail is 2 wrong + 20 right = 90.9%; at >= 0.67 it is 3 + 20 = 87%.
  assert.equal(suggested!.threshold, 0.68);
  assert.equal(suggested!.n, 22);
  assert.ok(suggested!.precision! >= 0.9);
  assert.ok(suggested!.wilson!.lo < suggested!.precision! && suggested!.wilson!.hi > suggested!.precision!);

  // A tiny perfect tail is never suggested: 5 right rows is below the 15-row floor.
  const thin = suggestThreshold([...labeled.slice(0, 20), ...labeled.slice(35)], 0.9, 15);
  assert.equal(thin.suggested, null);
  assert.match(thin.note!, /no threshold with at least 15 labelled rows reaches 90% precision/);
});

// ── the report ───────────────────────────────────────────────────────────────

test("a calibrated group: agree/would_act rates, a reliability table, a suggested threshold from the DISSENT tail with a Wilson interval", () => {
  const rows: RecordedDecisionRow[] = [];
  const facts: RunFacts[] = [];
  // 20 high-confidence agreements (runs succeed -> right).
  for (let i = 0; i < 20; i++) {
    rows.push(row(`agree-${i}`, { confidence: (900 + i * 5) / 1000 }));
    facts.push(runFacts(`agree-${i}`, "success"));
  }
  // 10 low-confidence dissents on runs that succeeded (the fallback was enough -> wrong, would not act),
  // 20 high-confidence dissents on runs that failed (-> right, would act).
  for (let i = 0; i < 10; i++) {
    rows.push(row(`lo-${i}`, { model_choice: "b", agrees: false, confidence: (50 + i) / 100, would_act: false }));
    facts.push(runFacts(`lo-${i}`, "success"));
  }
  for (let i = 0; i < 20; i++) {
    rows.push(row(`hi-${i}`, { model_choice: "b", agrees: false, confidence: (900 + i * 5) / 1000, would_act: true }));
    facts.push(runFacts(`hi-${i}`, "fail"));
  }
  const report = buildCalibrationReport(rows, factsOf(...facts), OPTS);
  const g = only(report);
  assert.equal(g.mode, "shadow");
  assert.equal(g.n, 50);
  assert.equal(g.answered, 50);
  assert.equal(g.agree_rate, 0.4);
  assert.equal(g.would_act_rate, 0.8);
  assert.equal(g.outcome.status, "ok");
  assert.equal(g.outcome.labeled, 50);
  assert.equal(g.outcome.correct, 40);
  assert.equal(g.outcome.threshold_in_use, 0.7);
  assert.equal(g.outcome.buckets.length, 5);
  const top = g.outcome.buckets[4]!;
  assert.equal(top.n, 40);
  assert.equal(top.precision, 1);
  assert.ok(top.wilson!.lo > 0.8);
  assert.equal(g.outcome.buckets[2]!.precision, 0);
  // Dissent-only figures: the only rows act mode changes behaviour on.
  const d = g.outcome.dissent!;
  assert.equal(d.labeled, 30);
  assert.equal(d.correct, 20);
  assert.ok(Math.abs(d.precision! - 2 / 3) < 1e-9);
  assert.ok(d.wilson!.lo < d.precision! && d.wilson!.hi > d.precision!);
  assert.equal(d.buckets[4]!.n, 20);
  // At >= 0.59 the dissent tail is 1 wrong + 20 right = 95.2%; at >= 0.58 it is 2 + 20 = 90.9%; at >= 0.57 it is 3 + 20 = 87%.
  assert.equal(g.outcome.suggested!.threshold, 0.58);
  assert.equal(g.outcome.suggested!.n, 22);
  assert.equal(g.outcome.at_threshold_in_use!.threshold, 0.7);
  assert.equal(g.outcome.at_threshold_in_use!.n, 40);
  assert.equal(d.at_threshold_in_use!.n, 20);
  assert.equal(d.at_threshold_in_use!.precision, 1);

  const text = formatCalibrationReport(report);
  assert.match(text, /chain_router  backend=systemone provider=ollama model=nimble mode=shadow/);
  assert.match(text, /dissents only .*: labelled=30 correct=20, precision 66\.7%  95% CI/);
  assert.match(text, /suggested threshold \(from dissents\) 0\.58: n=22, precision 90\.9%  95% CI/);
  assert.match(text, /Read-only: nothing is written/);
});

test("agreements carrying the pooled precision do not earn a threshold when every dissent in the tail is wrong", () => {
  const rows: RecordedDecisionRow[] = [];
  const facts: RunFacts[] = [];
  // 200 shadow agreements at 0.90-0.99 and 20 dissents at 0.95, all on successful runs: every
  // agreement is right, every dissent wrong. Pooled, the tail is 200/220 = 90.9%.
  for (let i = 0; i < 200; i++) {
    rows.push(row(`a-${i}`, { confidence: 0.9 + (i % 10) / 100 }));
    facts.push(runFacts(`a-${i}`, "success"));
  }
  for (let i = 0; i < 20; i++) {
    rows.push(row(`d-${i}`, { model_choice: "b", agrees: false, confidence: 0.95 }));
    facts.push(runFacts(`d-${i}`, "success"));
  }
  const g = only(buildCalibrationReport(rows, factsOf(...facts), OPTS));
  assert.equal(g.outcome.status, "ok");
  assert.equal(g.outcome.dissent!.labeled, 20);
  assert.equal(g.outcome.dissent!.correct, 0);
  assert.equal(g.outcome.dissent!.precision, 0);
  assert.equal(g.outcome.suggested, null, "flipping to act at any threshold would act on dissents that were all wrong");
  assert.match(g.outcome.suggestion_note!, /no threshold with at least 15 labelled dissenting rows reaches 90% precision/);
  // The pooled arithmetic the old suggestion used WOULD have suggested one.
  const pooled = [
    ...Array.from({ length: 200 }, (_, i) => ({ confidence: 0.9 + (i % 10) / 100, correct: true })),
    ...Array.from({ length: 20 }, () => ({ confidence: 0.95, correct: false })),
  ];
  assert.ok(suggestThreshold(pooled, 0.9, 15).suggested !== null);
  assert.match(formatCalibrationReport(buildCalibrationReport(rows, factsOf(...facts), OPTS)), /no suggested threshold: no threshold with at least 15 labelled dissenting rows/);
});

test("too few dissents: no threshold is suggested however many agreements there are", () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(`a-${i}`, { confidence: 0.95 }));
  const g = only(buildCalibrationReport(rows, factsOf(...rows.map((r) => runFacts(r.adw_id, "success"))), OPTS));
  assert.equal(g.outcome.status, "ok");
  assert.equal(g.outcome.dissent!.labeled, 0);
  assert.equal(g.outcome.suggested, null);
  assert.ok(g.outcome.suggestion_note);
});

test("shadow and act rows are separate groups; an act group says it is a biased sample", () => {
  const rows = [row("s", { mode: "shadow" }), row("a", { mode: "act" })];
  const report = buildCalibrationReport(rows, factsOf(runFacts("s", "success"), runFacts("a", "success")), { ...OPTS, min_samples: 1 });
  assert.deepEqual(report.groups.map((g) => g.mode), ["act", "shadow"]);
  const text = formatCalibrationReport(report);
  assert.match(text, /mode=act/);
  assert.match(text, /mode=shadow/);
  assert.match(text, /act-mode rows are a biased sample/);
});

test("below --min-samples a group is 'insufficient': counts shown, no table, no suggestion", () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(`r${i}`));
  const report = buildCalibrationReport(rows, factsOf(...rows.map((r) => runFacts(r.adw_id, "success"))), OPTS);
  const g = only(report);
  assert.equal(g.outcome.status, "insufficient");
  assert.equal(g.outcome.labeled, 5);
  assert.deepEqual(g.outcome.buckets, []);
  assert.equal(g.outcome.suggested, null);
  assert.match(formatCalibrationReport(report), /insufficient: 5 labelled row\(s\) < --min-samples 30/);
  // Lowering the bar turns the same rows into a real report.
  assert.equal(only(buildCalibrationReport(rows, factsOf(...rows.map((r) => runFacts(r.adw_id, "success"))), { ...OPTS, min_samples: 5 })).outcome.status, "ok");
});

test("a kind with no observable outcome reports 'no outcome signal' — and still its agree/would_act rates", () => {
  const rows = [
    row("a", { kind: "finding_triage", key: "revise_1:abc", options: ["real", "noise", "style"], choice: "real", fallback: "real", model_choice: "noise", agrees: false }),
    row("a", { kind: "finding_triage", key: "revise_1:def", options: ["real", "noise", "style"], choice: "real", fallback: "real", model_choice: "real" }),
  ];
  const report = buildCalibrationReport(rows, factsOf(runFacts("a", "success")), OPTS);
  const g = only(report);
  assert.equal(g.outcome.status, "no_outcome_signal");
  assert.equal(g.outcome.labeled, 0);
  assert.equal(g.agree_rate, 0.5);
  assert.equal(g.would_act_rate, 1);
  assert.match(formatCalibrationReport(report), /no outcome signal: whether a finding was real is never recorded/);
});

test("every registered kind either has an outcome rule or a stated reason it has none", () => {
  for (const kind of Object.keys(DECISION_KINDS)) {
    const rule = kind in OUTCOME_RULES;
    const none = kind in NO_OUTCOME_SIGNAL;
    assert.ok(rule !== none, `${kind}: must be in exactly one of OUTCOME_RULES / NO_OUTCOME_SIGNAL (rule=${rule}, no-signal=${none})`);
  }
  // And nothing there names a kind that does not exist.
  for (const kind of [...Object.keys(OUTCOME_RULES), ...Object.keys(NO_OUTCOME_SIGNAL)]) assert.ok(kind in DECISION_KINDS, `${kind} is not a registered kind`);
});

test("exclusions: acted, replayed, superseded, unresolved, no-confidence and unanswered rows are never labelled", () => {
  const rows: RecordedDecisionRow[] = [
    row("ok", {}), // labelled
    row("acted", { choice: "b", model_choice: "b", fallback: "a", used_fallback: false, mode: "act", agrees: false }), // the model's answer acted
    row("replay", { replayed: true }),
    row("again", { confidence: 0.8 }), // superseded by the next row (same run, kind, key)
    row("again", { confidence: 0.85 }),
    row("running", {}), // session still running
    row("nosession", {}),
    row("noconf", { confidence: null }),
    row("np", { model_choice: "b", agrees: false, reason: "not_permitted", would_act: false }), // can never act at any threshold
    row("failed", { model_choice: null, confidence: null, agrees: null, would_act: false, reason: "timeout" }),
  ];
  const facts = factsOf(
    runFacts("ok", "success"),
    runFacts("acted", "success"),
    runFacts("replay", "success"),
    runFacts("again", "success"),
    runFacts("running", "running"),
    runFacts("noconf", "success"),
    runFacts("np", "fail"),
    runFacts("failed", "success"),
  );
  const report = buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 });
  assert.equal(report.replayed_skipped, 1);
  // The act-mode row is its own group (act rows are a biased sample); everything else is shadow.
  assert.deepEqual(report.groups.map((x) => x.mode), ["act", "shadow"]);
  assert.equal(report.groups[0]!.outcome.excluded.acted, 1);
  const g = report.groups[1]!;
  assert.equal(g.n, 8, "the replayed row is not a sample");
  assert.equal(g.answered, 7);
  assert.equal(g.outcome.labeled, 2, "ok + the LATEST of the repeated decisions");
  assert.deepEqual(g.outcome.excluded, { acted: 0, superseded: 1, unresolved: 2, ambiguous: 0, no_confidence: 1, not_permitted: 1 });
});

test("a status left over from an earlier run of the same adw_id is not this decision's outcome", () => {
  const stale = runFacts("issue-1", "success");
  stale.session!.ended_at = "2025-12-01T00:00:00.000+00:00"; // finished BEFORE the decision was recorded
  const g = only(buildCalibrationReport([row("issue-1")], factsOf(stale), { ...OPTS, min_samples: 1 }));
  assert.equal(g.outcome.labeled, 0);
  assert.equal(g.outcome.excluded.unresolved, 1);
});

test("a later run of the same adw_id (a :feedback revision, a blocked->ready re-claim) overwrote the session status: not this decision's outcome", () => {
  const one = { min_samples: 1 };
  // chain_router: the decision precedes its own run, so ONE run start after it is its own — labelled.
  const own = runFacts("issue-1", "success", { run_starts: [RUN_STARTED] });
  assert.equal(only(buildCalibrationReport([row("issue-1")], factsOf(own), { ...OPTS, ...one })).outcome.labeled, 1);
  // A plain claim built a PR (success), then a revision under the SAME adw_id failed and left status=fail with a later ended_at.
  const revised = runFacts("issue-2", "fail", { run_starts: [RUN_STARTED, RERUN_STARTED] });
  const g = only(buildCalibrationReport([row("issue-2")], factsOf(revised), { ...OPTS, ...one }));
  assert.equal(g.outcome.labeled, 0, "a later run's failure must not label the original agreement wrong");
  assert.equal(g.outcome.excluded.unresolved, 1);
  // intake_readiness: same shape.
  const intake = { kind: "intake_readiness", key: "", options: ["build", "refine", "needs_human"], fallback: "build", choice: "build", model_choice: "needs_human", agrees: false };
  const relabelled = runFacts("issue-3", "success", { run_starts: [RUN_STARTED, RERUN_STARTED] }); // failed once, human relabelled ready, re-run succeeded
  const gi = only(buildCalibrationReport([row("issue-3", intake)], factsOf(relabelled), { ...OPTS, ...one }));
  assert.equal(gi.outcome.labeled, 0);
  assert.equal(gi.outcome.excluded.unresolved, 1);
  // risk_tier / loop_control are recorded INSIDE the run: any run start after the decision is another run.
  const tier = { kind: "risk_tier", key: "build", options: ["low", "standard", "high"], fallback: "standard", choice: "standard", model_choice: "high" };
  const inside = runFacts("t-ok", "success", { run_starts: [RUN_STARTED_BEFORE] });
  assert.equal(only(buildCalibrationReport([row("t-ok", tier)], factsOf(inside), { ...OPTS, ...one })).outcome.labeled, 1);
  const insideRerun = runFacts("t-re", "fail", { run_starts: [RUN_STARTED_BEFORE, RERUN_STARTED] });
  assert.equal(only(buildCalibrationReport([row("t-re", tier)], factsOf(insideRerun), { ...OPTS, ...one })).outcome.excluded.unresolved, 1);
  const loop = { kind: "loop_control", key: "fix:test_1", options: ["continue", "escalate_tier", "stop_blocked"], fallback: "continue", choice: "continue", model_choice: "continue" };
  const phases = [
    { phase_id: "ph-1", seq: 1, name: "test_1", started_at: LATER, verdict: false },
    { phase_id: "ph-3", seq: 3, name: "test_2", started_at: LATER, verdict: true },
  ];
  const loopRerun = runFacts("l-re", "success", { run_starts: [RUN_STARTED_BEFORE, RERUN_STARTED], phases });
  const gl = only(buildCalibrationReport([row("l-re", loop, { phase_id: "ph-1" })], factsOf(loopRerun), { ...OPTS, ...one }));
  assert.equal(gl.outcome.labeled, 0);
  assert.equal(gl.outcome.excluded.unresolved, 1);
  // A fan-out base adw_id has no session of its own: unresolved, never labelled.
  assert.equal(only(buildCalibrationReport([row("issue-4")], factsOf(runFacts("issue-4", null)), { ...OPTS, ...one })).outcome.excluded.unresolved, 1);
});

test("loop_control: a later decision in the same loop that ACTED makes the earlier round unresolved", () => {
  const base = { kind: "loop_control", options: ["continue", "escalate_tier", "stop_blocked"], fallback: "continue" };
  const phases = [
    { phase_id: "ph-1", seq: 1, name: "test_1", started_at: LATER, verdict: false },
    { phase_id: "ph-3", seq: 3, name: "test_2", started_at: LATER, verdict: false },
  ];
  const facts = factsOf(runFacts("loop", "fail", { run_starts: [RUN_STARTED_BEFORE], phases }));
  const rows = [
    row("loop", { ...base, key: "fix:test_1", choice: "continue", model_choice: "continue" }, { phase_id: "ph-1" }),
    // Round 2, act mode: the model's stop_blocked acted, so round 1's "did a later round recover" was shaped by it.
    row("loop", { ...base, key: "fix:test_2", choice: "stop_blocked", model_choice: "stop_blocked", mode: "act", agrees: false }, { phase_id: "ph-3" }),
  ];
  const report = buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 });
  const shadow = report.groups.find((g) => g.mode === "shadow")!;
  assert.equal(shadow.outcome.labeled, 0);
  assert.equal(shadow.outcome.excluded.unresolved, 1);
  // Without the acted later row the same round is labelled.
  const alone = only(buildCalibrationReport([rows[0]!], facts, { ...OPTS, min_samples: 1 }));
  assert.equal(alone.outcome.labeled, 1);
});

test("intake_readiness: build is right iff the build run succeeded; needs_human iff it failed", () => {
  const base = { kind: "intake_readiness", key: "", options: ["build", "refine", "needs_human"], fallback: "build", choice: "build" };
  const rows = [
    row("ok-agree", { ...base, model_choice: "build" }),
    row("ok-dissent", { ...base, model_choice: "needs_human", agrees: false }),
    row("bad-agree", { ...base, model_choice: "build" }),
    row("bad-dissent", { ...base, model_choice: "needs_human", agrees: false }),
  ];
  const facts = factsOf(runFacts("ok-agree", "success"), runFacts("ok-dissent", "success"), runFacts("bad-agree", "fail"), runFacts("bad-dissent", "fail"));
  const g = only(buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 }));
  assert.equal(g.outcome.labeled, 4);
  assert.equal(g.outcome.correct, 2, "agree+success and dissent+fail are right");
});

test("risk_tier: high is right iff troubled, low iff clean-but-unfalsifiable (ambiguous); standard is ambiguous", () => {
  const base = { kind: "risk_tier", key: "build", options: ["low", "standard", "high"], fallback: "standard", choice: "standard" };
  const rows = [
    row("clean-low", { ...base, model_choice: "low" }),
    row("clean-high", { ...base, model_choice: "high" }),
    row("gate-high", { ...base, model_choice: "high" }),
    row("gate-low", { ...base, model_choice: "low" }),
    row("repair-high", { ...base, model_choice: "high" }),
    row("failed-high", { ...base, model_choice: "high" }),
    row("std", { ...base, model_choice: "standard" }),
  ];
  const phase = (name: string) => ({ phase_id: `p-${name}`, seq: 1, name, started_at: LATER, verdict: null });
  const facts = factsOf(
    runFacts("clean-low", "success"),
    runFacts("clean-high", "success"),
    runFacts("gate-high", "success", { failed_gates: [{ created_at: LATER }] }),
    runFacts("gate-low", "success", { failed_gates: [{ created_at: LATER }] }),
    runFacts("repair-high", "success", { phases: [phase("fix_1")] }),
    runFacts("failed-high", "fail"),
    runFacts("std", "success"),
  );
  const g = only(buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 }));
  assert.equal(g.outcome.excluded.ambiguous, 2, "`standard`, and clean-low (a downgrade on a clean run: the standard tier ran)");
  assert.equal(g.outcome.labeled, 5);
  assert.equal(g.outcome.correct, 3, "gate-high, repair-high, failed-high; clean-high and gate-low are wrong");
});

test("risk_tier: agreement with the fallback tier is not scored — a clean run on a `high` fallback is partly the strong tier's doing", () => {
  const base = { kind: "risk_tier", key: "build", options: ["low", "standard", "high"] };
  const rows = [
    row("agree-high", { ...base, fallback: "high", choice: "high", model_choice: "high" }),
    row("agree-low", { ...base, fallback: "low", choice: "low", model_choice: "low" }),
    row("dissent-low", { ...base, fallback: "high", choice: "high", model_choice: "low" }),
  ];
  const facts = factsOf(runFacts("agree-high", "success"), runFacts("agree-low", "success"), runFacts("dissent-low", "success"));
  const g = only(buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 }));
  assert.equal(g.outcome.excluded.ambiguous, 3, "both agreements, and the downgrade whose stronger-tier run came out clean");
  assert.equal(g.outcome.labeled, 0);
});

test("risk_tier: a downgrade is scored only when the run was troubled (wrong); `high` against a lower fallback is scored either way", () => {
  const base = { kind: "risk_tier", key: "build", options: ["low", "standard", "high"], fallback: "high", choice: "high" };
  const rows = [
    row("down-troubled", { ...base, model_choice: "low" }),
    row("down-clean", { ...base, model_choice: "low" }),
    row("up-clean", { ...base, fallback: "standard", choice: "standard", model_choice: "high" }),
    row("up-troubled", { ...base, fallback: "standard", choice: "standard", model_choice: "high" }),
  ];
  const facts = factsOf(
    runFacts("down-troubled", "success", { failed_gates: [{ created_at: LATER }] }),
    runFacts("down-clean", "success"),
    runFacts("up-clean", "success"),
    runFacts("up-troubled", "success", { failed_gates: [{ created_at: LATER }] }),
  );
  const g = only(buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 }));
  assert.equal(g.outcome.excluded.ambiguous, 1, "down-clean");
  assert.equal(g.outcome.labeled, 3);
  assert.equal(g.outcome.correct, 1, "down-troubled wrong, up-clean wrong, up-troubled right");
});

test("a SIGTERM-shaped run (session fail, in-flight phase never closed) is not a quality failure", () => {
  const killed = { phase_id: "p", seq: 1, name: "build", started_at: DECIDED_AT, verdict: null };
  const rows = [
    row("killed-router", { kind: "chain_router", model_choice: "a" }, { started_at: DECIDED_AT }),
    row("killed-risk", { kind: "risk_tier", key: "build", options: ["low", "standard", "high"], fallback: "standard", choice: "standard", model_choice: "high" }),
    row("failed-router", { kind: "chain_router", model_choice: "a" }),
  ];
  const facts = factsOf(
    runFacts("killed-router", "fail", { run_starts: [RUN_STARTED], open_phases: [RUN_STARTED] }),
    runFacts("killed-risk", "fail", { phases: [killed], open_phases: [DECIDED_AT] }),
    runFacts("failed-router", "fail", { run_starts: [RUN_STARTED] }), // every phase closed: a genuine failure
  );
  const report = buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 });
  const router = report.groups.find((g) => g.kind === "chain_router")!;
  assert.equal(router.outcome.excluded.unresolved, 1, "the killed run is unresolved");
  assert.equal(router.outcome.labeled, 1, "the genuinely failed run is still labelled (agreement wrong)");
  assert.equal(router.outcome.correct, 0);
  const risk = report.groups.find((g) => g.kind === "risk_tier")!;
  assert.equal(risk.outcome.excluded.unresolved, 1);
  assert.equal(risk.outcome.labeled, 0, "a kill must not make a `high` dissent look right");
});

/** Run 1 of an adw_id was killed (its phase never closed); run 2 reused the adw_id. */
const RUN1_PHASE_STARTED = "2025-12-31T23:50:00.000+00:00";
const RUN1_STARTED = "2025-12-31T23:49:00.000+00:00";
const RUN1_KILLED_AT = "2025-12-31T23:55:00.000+00:00";

test("per-run scoping: an earlier killed run's open phase does not censor a later run's clean failure", () => {
  const risk = { kind: "risk_tier", key: "build", options: ["low", "standard", "high"], fallback: "standard", choice: "standard" };
  const rows = [
    row("rerun-fail-router", { kind: "chain_router", model_choice: "a" }), // pre-claim: its run is the one starting after it
    row("rerun-fail-risk", { ...risk, model_choice: "high" }), // in-run: its run is the latest start at/before it
    row("rerun-ok-router", { kind: "chain_router", model_choice: "a" }),
    row("rerun-ok-risk", { ...risk, model_choice: "high" }),
  ];
  const killedRun1 = { run_starts: [RUN1_STARTED], open_phases: [RUN1_PHASE_STARTED] };
  const facts = factsOf(
    runFacts("rerun-fail-router", "fail", { ...killedRun1, run_starts: [RUN1_STARTED, RUN_STARTED] }),
    runFacts("rerun-fail-risk", "fail", { ...killedRun1, run_starts: [RUN1_STARTED, RUN_STARTED_BEFORE] }),
    runFacts("rerun-ok-router", "success", { ...killedRun1, run_starts: [RUN1_STARTED, RUN_STARTED] }),
    runFacts("rerun-ok-risk", "success", { ...killedRun1, run_starts: [RUN1_STARTED, RUN_STARTED_BEFORE] }),
  );
  const report = buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 });
  const router = report.groups.find((g) => g.kind === "chain_router")!;
  assert.equal(router.outcome.excluded.unresolved, 0, "run 1's open phase is not run 2's");
  assert.equal(router.outcome.labeled, 2, "run 2's clean fail (agreement wrong) and success (agreement right) are both labelled");
  assert.equal(router.outcome.correct, 1);
  const tier = report.groups.find((g) => g.kind === "risk_tier")!;
  assert.equal(tier.outcome.excluded.unresolved, 0);
  assert.equal(tier.outcome.labeled, 2, "run 2's troubled and clean outcomes are both labelled");
  assert.equal(tier.outcome.correct, 1, "high on a failed run is right, high on a clean run is wrong");
});

test("per-run scoping: a phase left open by the decision's OWN run still makes it unresolved, and so does one that starts inside it", () => {
  const rows = [row("own-open", { kind: "chain_router", model_choice: "a" }), row("own-null", { kind: "chain_router", model_choice: "a" })];
  const facts = factsOf(
    runFacts("own-open", "fail", { run_starts: [RUN1_STARTED, RUN_STARTED], open_phases: [RUN_STARTED] }),
    runFacts("own-null", "fail", { run_starts: [RUN_STARTED], open_phases: [null] }), // unknown start: never excluded
  );
  const g = only(buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 }));
  assert.equal(g.outcome.labeled, 0);
  assert.equal(g.outcome.excluded.unresolved, 2);
});

test("kill marker: a fail run with every phase closed but a run_killed marker is unresolved, for every rule", () => {
  const risk = { kind: "risk_tier", key: "build", options: ["low", "standard", "high"], fallback: "standard", choice: "standard", model_choice: "high" };
  const loop = { kind: "loop_control", options: ["continue", "escalate_tier", "stop_blocked"], fallback: "continue", choice: "continue", key: "fix:test_1", model_choice: "stop_blocked", agrees: false, confidence: 0.95 };
  const phases = [
    { phase_id: "ph-1", seq: 1, name: "test_1", started_at: LATER, verdict: false },
    { phase_id: "ph-2", seq: 2, name: "fix_1", started_at: LATER, verdict: null },
  ];
  const rows = [
    row("killed-router", { kind: "chain_router", model_choice: "a" }),
    row("killed-risk", risk),
    row("killed-loop", loop, { phase_id: "ph-1" }),
    row("killed-loop-ok", { ...loop, key: "fix:test_1" }, { phase_id: "ph-1" }),
  ];
  const facts = factsOf(
    runFacts("killed-router", "fail", { run_starts: [RUN_STARTED], kills: [LATER] }),
    runFacts("killed-risk", "fail", { kills: [LATER] }),
    runFacts("killed-loop", "fail", { phases, kills: [LATER] }),
    // The loop recovered before the kill: still never good/bad, a killed run carries no outcome.
    runFacts("killed-loop-ok", "fail", { phases: [...phases, { phase_id: "ph-3", seq: 3, name: "test_2", started_at: LATER, verdict: true }], kills: [LATER] }),
  );
  const report = buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 });
  for (const g of report.groups) {
    assert.equal(g.outcome.labeled, 0, `${g.kind}: a killed run is never labelled`);
    assert.ok(g.outcome.excluded.unresolved >= 1, g.kind);
  }
});

test("kill marker: run 1 killed with a marker, run 2 of the same adw_id fails cleanly => labelled bad, not unresolved", () => {
  const rows = [row("rerun", { kind: "chain_router", model_choice: "a" })];
  const facts = factsOf(runFacts("rerun", "fail", { run_starts: [RUN1_STARTED, RUN_STARTED], kills: [RUN1_KILLED_AT] }));
  const g = only(buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 }));
  assert.equal(g.outcome.labeled, 1, "the marker belongs to run 1");
  assert.equal(g.outcome.correct, 0, "agreeing with a fallback whose run failed is wrong");
  // And a marker inside the decision's own run is still a kill.
  const own = factsOf(runFacts("rerun", "fail", { run_starts: [RUN1_STARTED, RUN_STARTED], kills: [LATER] }));
  const k = only(buildCalibrationReport(rows, own, { ...OPTS, min_samples: 1 }));
  assert.equal(k.outcome.labeled, 0);
  assert.equal(k.outcome.excluded.unresolved, 1);
});

test("loop_control: a killed run is unresolved, not stop_blocked-was-right", () => {
  const base = { kind: "loop_control", options: ["continue", "escalate_tier", "stop_blocked"], fallback: "continue", choice: "continue" };
  const phases = [
    { phase_id: "ph-1", seq: 1, name: "test_1", started_at: LATER, verdict: false },
    { phase_id: "ph-2", seq: 2, name: "fix_1", started_at: LATER, verdict: null },
  ];
  const facts = factsOf(runFacts("k", "fail", { phases, open_phases: [LATER] }));
  const rows = [row("k", { ...base, key: "fix:test_1", model_choice: "stop_blocked", agrees: false, confidence: 0.95 }, { phase_id: "ph-1" })];
  const g = only(buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 }));
  assert.equal(g.outcome.labeled, 0);
  assert.equal(g.outcome.excluded.unresolved, 1);
});

test("act-mode groups never get a suggested threshold; the same rows in shadow do", () => {
  const build = (mode: "shadow" | "act") => {
    const rows: RecordedDecisionRow[] = [];
    const facts: RunFacts[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(row(`${mode}-${i}`, { mode, model_choice: "b", agrees: false, confidence: (900 + i) / 1000, would_act: true, choice: "a" }));
      facts.push(runFacts(`${mode}-${i}`, "fail"));
    }
    return only(buildCalibrationReport(rows, factsOf(...facts), OPTS));
  };
  const shadow = build("shadow");
  assert.ok(shadow.outcome.suggested);
  const act = build("act");
  assert.equal(act.outcome.status, "ok");
  assert.equal(act.outcome.suggested, null);
  assert.match(act.outcome.suggestion_note!, /act-mode rows cannot calibrate/);
});

test("loop_control: two loops over one suite are distinct loops (ordinal kept), so loop 2 acting does not unresolve loop 1", () => {
  const base = { kind: "loop_control", options: ["continue", "escalate_tier", "stop_blocked"], fallback: "continue" };
  const phases = [
    { phase_id: "ph-1", seq: 1, name: "test_1", started_at: LATER, verdict: false },
    { phase_id: "ph-2", seq: 2, name: "fix_1", started_at: LATER, verdict: null },
    { phase_id: "ph-3", seq: 3, name: "test_2", started_at: LATER, verdict: true },
    { phase_id: "ph-4", seq: 4, name: "test_1", started_at: LATER, verdict: false },
  ];
  const facts = factsOf(runFacts("two", "success", { run_starts: [RUN_STARTED_BEFORE], phases }));
  const rows = [
    row("two", { ...base, key: "fix:test_1", choice: "continue", model_choice: "continue" }, { phase_id: "ph-1" }),
    row("two", { ...base, key: "fix#2:test_1", choice: "stop_blocked", model_choice: "stop_blocked", mode: "act", agrees: false }, { phase_id: "ph-4" }),
  ];
  const shadow = buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 }).groups.find((g) => g.mode === "shadow")!;
  assert.equal(shadow.outcome.labeled, 1, "loop 1 recovered; loop 2's acted row is a different loop");
  assert.equal(shadow.outcome.correct, 1);
});

test("risk_tier: a gate failure from an EARLIER run of the same adw_id is not this decision's trouble", () => {
  const rows = [row("issue-9", { kind: "risk_tier", key: "build", options: ["low", "standard", "high"], fallback: "standard", choice: "standard", model_choice: "high" })];
  const facts = factsOf(runFacts("issue-9", "success", { failed_gates: [{ created_at: "2025-12-01T00:00:00.000+00:00" }] }));
  const g = only(buildCalibrationReport(rows, facts, { ...OPTS, min_samples: 1 }));
  assert.equal(g.outcome.labeled, 1);
  assert.equal(g.outcome.correct, 0, "the old failure predates the decision, so the run was clean and `high` was wrong (had it counted, `high` would be right)");
});

test("loop_control: continue is right iff a later round passed; stop_blocked iff none did", () => {
  const base = { kind: "loop_control", options: ["continue", "escalate_tier", "stop_blocked"], fallback: "continue", choice: "continue" };
  const phases = (...items: Array<[string, boolean | null]>) => items.map(([name, verdict], i) => ({ phase_id: `ph-${name}`, seq: i + 1, name, started_at: LATER, verdict }));
  const recovered = runFacts("rec", "success", { phases: phases(["test_1", false], ["fix_1", null], ["test_2", true]) });
  const stuck = runFacts("stuck", "fail", { phases: phases(["test_1", false], ["fix_1", null], ["test_2", false], ["fix_2", null], ["test_3", false]) });
  const rows = [
    row("rec", { ...base, key: "fix:test_1", model_choice: "continue" }, { phase_id: "ph-test_1" }),
    row("rec", { ...base, key: "fix:test_1", model_choice: "stop_blocked", agrees: false, confidence: 0.95 }, { phase_id: "ph-test_1" }),
    row("stuck", { ...base, key: "fix:test_1", model_choice: "stop_blocked", agrees: false }, { phase_id: "ph-test_1" }),
    row("stuck", { ...base, key: "fix:test_1#x", model_choice: "continue" }, { phase_id: "ph-test_1" }),
  ];
  // The second row of "rec" repeats its (run, kind, key) so only it is labelled; the key of the last row is unparseable -> unresolved.
  const g = only(buildCalibrationReport(rows, factsOf(recovered, stuck), { ...OPTS, min_samples: 1 }));
  assert.equal(g.outcome.excluded.superseded, 1);
  assert.equal(g.outcome.excluded.unresolved, 1);
  assert.equal(g.outcome.labeled, 2);
  assert.equal(g.outcome.correct, 1, "stop_blocked on a loop that went on to recover is wrong; stop_blocked on one that never did is right");
});

test("loop_control revise: a later approved review recovers the loop; a restarted numbering does not leak across loops", () => {
  const base = { kind: "loop_control", options: ["continue", "escalate_tier", "stop_blocked"], fallback: "continue", choice: "continue", model_choice: "continue" };
  const ph = (name: string, seq: number, verdict: boolean | null) => ({ phase_id: `ph-${name}-${seq}`, seq, name, started_at: LATER, verdict });
  // Loop 1: review_1 rejected, review_2 rejected (never recovered). Loop 2 (same names): review_1 rejected, review_2 approved.
  const facts = runFacts("two-loops", "success", {
    phases: [ph("review_1", 1, false), ph("revise_1", 2, null), ph("review_2", 3, false), ph("review_1", 4, false), ph("revise_1", 5, null), ph("review_2", 6, true)],
  });
  const rows = [row("two-loops", { ...base, key: "revise:review_1" }, { phase_id: "ph-review_1-1" })];
  const g = only(buildCalibrationReport(rows, factsOf(facts), { ...OPTS, min_samples: 1 }));
  assert.equal(g.outcome.labeled, 1);
  assert.equal(g.outcome.correct, 0, "loop 1 never recovered, so `continue` was wrong — loop 2's approved review_2 must not count");
});

test("groups: legacy and modern rows stay separate; null backend/provider render as '-'", () => {
  const rows = [
    row("m1", { backend: "systemone", provider: "typesafe", model: "jev-latest" }),
    row("m2", { backend: "systemone", provider: "ollama", model: "tev1:0.8b" }),
    row("l1", { backend: null, provider: null, model: "jev-latest" }),
  ];
  const report = buildCalibrationReport(rows, factsOf(), { ...OPTS, min_samples: 1 });
  assert.deepEqual(
    report.groups.map((g) => [g.backend, g.provider, g.model]),
    [
      ["systemone", "ollama", "tev1:0.8b"],
      ["systemone", "typesafe", "jev-latest"],
      [null, null, "jev-latest"],
    ],
  );
  assert.match(formatCalibrationReport(report), /backend=- provider=- model=jev-latest/);
});

test("an empty db yields an empty report that says why", () => {
  const report = buildCalibrationReport([], new Map(), OPTS);
  assert.deepEqual(report.groups, []);
  assert.match(formatCalibrationReport(report), /no recorded decisions/);
});

// ── the reader and the command, against a real temp trace db ─────────────────

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "spf-calibrate-"));
}

const dbPathFor = (dir: string): string => join(dir, ".spf", "data", "spf.db");

function writeConfig(dir: string): string {
  const configPath = join(dir, "spf.config.yaml");
  writeFileSync(
    configPath,
    `agents:\n  - name: scout\n    coding_agent: flue\n    model: test/model-a\n    prompt_engineering:\n      system: scout/system.md\n      user: scout/user.md\n`,
  );
  return configPath;
}

async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  console.warn = () => {};
  try {
    return { result: await fn(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

/** A modern `decision` row, or — `legacy: true` — the same decision as a pre-#150 `jev_decision` row. */
async function writeDecision(tracer: Tracer, adw: string, d: Decision, opts: { legacy?: boolean; phaseId?: string; startedAt?: string } = {}): Promise<void> {
  let payload: Record<string, unknown> = { ...d };
  if (opts.legacy) {
    const { model_choice, backend: _b, provider: _p, ...rest } = payload;
    payload = { ...rest, jev_choice: model_choice };
  }
  await tracer.event(
    makeEventRecord({ adw_id: adw, phase_id: opts.phaseId ?? "", type: "log", name: opts.legacy ? "jev_decision" : "decision", payload, started_at: opts.startedAt ?? DECIDED_AT }),
  );
}

async function session(tracer: Tracer, adw: string, ok: boolean | "running"): Promise<void> {
  await tracer.sessionStart(adw, "tester", "scout");
  if (ok !== "running") await tracer.sessionFinish(adw, ok);
}

test("end to end: both row shapes are read, joined to session outcomes, and nothing is written", async () => {
  const dir = tmpRepo();
  try {
    const configPath = writeConfig(dir);
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    // Modern rows: nimble@ollama, 3 runs. Legacy rows: jev-latest with no backend/provider, 3 runs.
    for (const [i, ok] of [true, true, false].entries()) {
      await session(tracer, `m-${i}`, ok);
      await writeDecision(tracer, `m-${i}`, decision({ key: `m${i}`, confidence: 0.8 + i * 0.05 }));
      await session(tracer, `l-${i}`, ok);
      await writeDecision(tracer, `l-${i}`, decision({ key: `l${i}`, model: "jev-latest", confidence: 0.8 + i * 0.05 }), { legacy: true });
    }
    // Plus a row for a kind with no outcome signal, and a still-running run.
    await session(tracer, "tri", true);
    await writeDecision(tracer, "tri", decision({ kind: "finding_triage", key: "revise_1:a", options: ["real", "noise"], fallback: "real", choice: "real", model_choice: "real" }));
    await session(tracer, "live", "running");
    await writeDecision(tracer, "live", decision({ key: "live" }));
    // A phase and a gate row too, so a regression that writes to them would show.
    await tracer.phaseUpsert({
      phase_id: "m-0_01_x",
      adw_id: "m-0",
      seq: 1,
      params: makePhaseParams({ name: "x", kind: "code", owner: "q", description: "fixture" }),
      status: "success",
      attempt: 0,
      error: null,
      started_at: null,
      ended_at: null,
    });
    const before = (await tracer.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get())!.n;
    await tracer.close();
    const configBefore = readFileSync(configPath, "utf8");

    const { result: code, logs, errors } = await captureConsole(() =>
      decisionsCommand(["calibrate", "--cwd", dir, "--config", configPath, "--json", "--min-samples", "2"]),
    );
    assert.equal(code, 0, errors.join("\n"));
    const report = JSON.parse(logs.join("\n")) as CalibrationReport;
    assert.equal(report.rows, 8);
    const byKey = (kind: string, backend: string | null) => report.groups.find((g) => g.kind === kind && g.backend === backend)!;

    const modern = byKey("chain_router", "systemone");
    assert.equal(modern.provider, "ollama");
    assert.equal(modern.model, "nimble");
    // 3 finished runs + the running one: 4 rows, 3 labelled (success, success, fail -> agree right, right, wrong).
    assert.equal(modern.n, 4);
    assert.equal(modern.outcome.status, "ok");
    assert.equal(modern.outcome.labeled, 3);
    assert.equal(modern.outcome.correct, 2);
    assert.equal(modern.outcome.excluded.unresolved, 1);

    const legacy = byKey("chain_router", null);
    assert.equal(legacy.provider, null);
    assert.equal(legacy.model, "jev-latest");
    assert.equal(legacy.n, 3, "the jev_decision rows are read, with jev_choice as the model's answer");
    assert.equal(legacy.answered, 3);
    assert.equal(legacy.outcome.labeled, 3);
    assert.equal(legacy.outcome.correct, 2);

    assert.equal(byKey("finding_triage", "systemone").outcome.status, "no_outcome_signal");

    // Read-only: no event, phase or config change, and the human table prints too.
    const reopened = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    assert.equal((await reopened.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get())!.n, before);
    await reopened.close();
    assert.equal(readFileSync(configPath, "utf8"), configBefore);
    const text = await captureConsole(() => decisionsCommand(["calibrate", "--cwd", dir, "--config", configPath, "--min-samples", "2"]));
    assert.equal(text.result, 0);
    assert.match(text.logs.join("\n"), /backend=- provider=- model=jev-latest/);
    assert.match(text.logs.join("\n"), /no outcome signal/);
    assert.match(text.logs.join("\n"), /reliability, all labelled rows/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end: the reader joins `adw` process rows, so a revision run's status is not credited to the first decision", async () => {
  const dir = tmpRepo();
  try {
    const configPath = writeConfig(dir);
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    // `once`: one run. `revised`: the same adw_id ran twice (a :feedback revision) and the second run failed.
    await session(tracer, "once", true);
    await tracer.processStart("once", "adw", "", 1, "spf run");
    await writeDecision(tracer, "once", decision({ key: "once" }));
    await tracer.sessionStart("revised", "tester", "scout");
    await tracer.processStart("revised", "adw", "", 2, "spf run");
    await writeDecision(tracer, "revised", decision({ key: "revised" }));
    await tracer.sessionFinish("revised", true);
    await tracer.sessionStart("revised", "tester", "scout"); // re-entry: status back to running, no new session row
    await tracer.processStart("revised", "adw", "", 3, "spf run");
    await tracer.sessionFinish("revised", false);
    await tracer.close();

    const { logs } = await captureConsole(() => decisionsCommand(["calibrate", "--cwd", dir, "--config", configPath, "--json", "--min-samples", "1"]));
    const g = (JSON.parse(logs.join("\n")) as CalibrationReport).groups[0]!;
    assert.equal(g.n, 2);
    assert.equal(g.outcome.labeled, 1, "only the single-run adw_id is labelled");
    assert.equal(g.outcome.correct, 1);
    assert.equal(g.outcome.excluded.unresolved, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end: the reader joins the run_killed marker and the per-run window against a real trace db", async () => {
  const dir = tmpRepo();
  try {
    const configPath = writeConfig(dir);
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    // `killed`: every phase closed (the drain let the phase catch run) but the signal handler's marker is there.
    await tracer.sessionStart("killed", "tester", "scout");
    await tracer.processStart("killed", "adw", "", 1, "spf run");
    await new Promise((r) => setTimeout(r, 5));
    await writeDecision(tracer, "killed", decision({ key: "killed", kind: "risk_tier", options: ["low", "standard", "high"], fallback: "standard", choice: "standard", model_choice: "high" }), { startedAt: new Date().toISOString() });
    await tracer.event(makeEventRecord({ adw_id: "killed", type: "log", name: RUN_KILLED_EVENT, payload: { signal: "SIGINT" } }));
    await new Promise((r) => setTimeout(r, 5));
    await tracer.sessionFinish("killed", false);
    // `second`: run 1 was killed (marker, open phase), run 2 reused the adw_id and failed cleanly.
    await tracer.sessionStart("second", "tester", "scout");
    await tracer.processStart("second", "adw", "", 2, "spf run");
    await tracer.event(makeEventRecord({ adw_id: "second", type: "log", name: RUN_KILLED_EVENT, payload: { signal: "SIGINT" } }));
    await tracer.phaseUpsert({
      phase_id: "second_01_x",
      adw_id: "second",
      seq: 1,
      params: makePhaseParams({ name: "x", kind: "code", owner: "q", description: "fixture" }),
      status: "running",
      attempt: 0,
      error: null,
      started_at: "2000-01-01T00:00:00.000+00:00",
      ended_at: null,
    });
    await tracer.sessionFinish("second", false);
    await new Promise((r) => setTimeout(r, 5));
    await tracer.sessionStart("second", "tester", "scout");
    await tracer.processStart("second", "adw", "", 3, "spf run");
    await new Promise((r) => setTimeout(r, 5));
    await writeDecision(tracer, "second", decision({ key: "second", kind: "risk_tier", options: ["low", "standard", "high"], fallback: "standard", choice: "standard", model_choice: "high" }), { startedAt: new Date().toISOString() });
    await tracer.sessionFinish("second", false);
    await tracer.close();

    const { logs } = await captureConsole(() => decisionsCommand(["calibrate", "--cwd", dir, "--config", configPath, "--json", "--min-samples", "1"]));
    const g = (JSON.parse(logs.join("\n")) as CalibrationReport).groups[0]!;
    assert.equal(g.n, 2);
    assert.equal(g.outcome.excluded.unresolved, 1, "the killed run");
    assert.equal(g.outcome.labeled, 1, "run 2 of `second` failed cleanly");
    assert.equal(g.outcome.correct, 1, "`high` on a failed run is right");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end: loop_control joins to a recovered loop through the phases table, quality log and review envelope", async () => {
  const dir = tmpRepo();
  try {
    const configPath = writeConfig(dir);
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    const adw = "loop-run";
    await session(tracer, adw, true);
    const phase = (seq: number, name: string) => ({
      phase_id: `${adw}_${String(seq).padStart(2, "0")}_${name}`,
      adw_id: adw,
      seq,
      params: makePhaseParams({ name, kind: "code", owner: "quality", description: "fixture" }),
      status: "success" as const,
      attempt: 0,
      error: null,
      started_at: null,
      ended_at: null,
    });
    const [t1, f1, t2] = [phase(1, "test_1"), phase(2, "fix_1"), phase(3, "test_2")];
    for (const p of [t1, f1, t2]) await tracer.phaseUpsert(p);
    await tracer.event(makeEventRecord({ adw_id: adw, phase_id: t1.phase_id, type: "log", name: "test_1", payload: { passed: false } }));
    await tracer.event(makeEventRecord({ adw_id: adw, phase_id: t2.phase_id, type: "log", name: "test_2", payload: { passed: true } }));
    await writeDecision(
      tracer,
      adw,
      decision({ kind: "loop_control", key: "fix:test_1", options: ["continue", "escalate_tier", "stop_blocked"], fallback: "continue", choice: "continue", model_choice: "stop_blocked", agrees: false }),
      { phaseId: t1.phase_id },
    );
    // A revise loop whose review envelope approves.
    const rv = phase(4, "review_1");
    const rv2 = phase(5, "review_2");
    for (const p of [rv, rv2]) await tracer.phaseUpsert(p);
    await tracer.envelopeRow(rv, "reviewer", "ReviewOutput", JSON.stringify({ approved: false }), true, 1);
    await tracer.envelopeRow(rv2, "reviewer", "ReviewOutput", JSON.stringify({ approved: true }), true, 1);
    await writeDecision(
      tracer,
      adw,
      decision({ kind: "loop_control", key: "revise:review_1", options: ["continue", "escalate_tier", "stop_blocked"], fallback: "continue", choice: "continue", model_choice: "continue" }),
      { phaseId: rv.phase_id },
    );
    await tracer.close();

    const { logs } = await captureConsole(() => decisionsCommand(["calibrate", "--cwd", dir, "--config", configPath, "--json", "--min-samples", "1", "--kind", "loop_control"]));
    const g = (JSON.parse(logs.join("\n")) as CalibrationReport).groups[0]!;
    assert.equal(g.kind, "loop_control");
    assert.equal(g.outcome.labeled, 2);
    assert.equal(g.outcome.correct, 1, "stop_blocked on a fix loop that recovered is wrong; continue on a revise loop that was approved is right");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command: no trace db is an empty report, and bad flags are refused", async () => {
  const dir = tmpRepo();
  try {
    const configPath = writeConfig(dir);
    const empty = await captureConsole(() => decisionsCommand(["calibrate", "--cwd", dir, "--config", configPath]));
    assert.equal(empty.result, 0);
    assert.match(empty.logs.join("\n"), /no recorded decisions/);

    const known = await captureConsole(() => decisionsCommand(["calibrate", "--cwd", dir, "--config", configPath, "--kind", "risk_tier"]));
    assert.equal(known.result, 0);
    assert.match(known.logs.join("\n"), /no recorded decisions for kind risk_tier/);
    const typo = await captureConsole(() => decisionsCommand(["calibrate", "--cwd", dir, "--config", configPath, "--kind", "risk-tier"]));
    assert.equal(typo.result, 1);
    assert.match(typo.errors.join("\n"), /unknown decision kind "risk-tier".*known kinds: .*risk_tier/);

    for (const argv of [
      ["calibrate", "--target-precision", "0"],
      ["calibrate", "--target-precision", "1.5"],
      ["calibrate", "--target-precision", "high"],
      ["calibrate", "--min-samples", "0"],
      ["calibrate", "--min-samples", "2.5"],
      ["calibrate", "--since", "yesterday-ish"],
      ["calibrate", "stray-positional"],
      ["nope"],
      [],
    ]) {
      const { result, errors } = await captureConsole(() => decisionsCommand(argv));
      assert.equal(result, 1, JSON.stringify(argv));
      assert.ok(errors.length > 0, JSON.stringify(argv));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--since drops older rows, --kind filters, and --target-precision / --min-samples are honoured", async () => {
  const dir = tmpRepo();
  try {
    const configPath = writeConfig(dir);
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    for (const adw of ["a", "b"]) await session(tracer, adw, true);
    await writeDecision(tracer, "a", decision({ key: "1" }));
    await writeDecision(tracer, "b", decision({ key: "2", kind: "intake_readiness", options: ["build", "refine", "needs_human"], fallback: "build", choice: "build", model_choice: "build" }));
    await tracer.close();
    const run = async (...extra: string[]) =>
      JSON.parse((await captureConsole(() => decisionsCommand(["calibrate", "--cwd", dir, "--config", configPath, "--json", ...extra]))).logs.join("\n")) as CalibrationReport;

    assert.equal((await run()).groups.length, 2);
    assert.deepEqual((await run("--kind", "intake_readiness")).groups.map((g) => g.kind), ["intake_readiness"]);
    assert.equal((await run("--since", "2026-06-01")).groups.length, 0, "both rows were recorded 2026-01-01");
    assert.equal((await run("--since", "2025-06-01")).groups.length, 2);
    const tuned = await run("--target-precision", "0.8", "--min-samples", "7");
    assert.equal(tuned.target_precision, 0.8);
    assert.equal(tuned.min_samples, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
