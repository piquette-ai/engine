/**
 * gates.buildWellFormed (#6) — BuildOutput's own version of
 * refinementWellFormed's mutual-exclusivity rule: `questions` (material
 * ambiguity, see builder system.md's "Ask, don't guess") and
 * `changed_files`/`commit_message` (real, committable work) are the two ways
 * a build round can end, never both at once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWellFormed } from "../core/gates.js";
import type { RefineQuestion } from "../core/data_types.js";

function envelope(overrides: { changed_files?: string[]; commit_message?: string; questions?: RefineQuestion[] } = {}) {
  return {
    status: "success" as const,
    summary: "",
    artifacts: [],
    notes_for_next_agent: "",
    changed_files: overrides.changed_files ?? [],
    commit_message: overrides.commit_message ?? "",
    questions: overrides.questions ?? [],
  };
}

function question(overrides: Partial<RefineQuestion> & Pick<RefineQuestion, "id" | "question">): RefineQuestion {
  return { why_it_matters: "", options: [], recommendation: "", evidence: [], ...overrides };
}

const ctx = { repo_root: "/repo" };

test("buildWellFormed: no questions is the ordinary path — vacuously passes regardless of changed_files/commit_message", () => {
  assert.equal(buildWellFormed(envelope(), ctx).passed, true);
  assert.equal(buildWellFormed(envelope({ changed_files: ["src/a.ts"], commit_message: "fix: a" }), ctx).passed, true);
});

test("buildWellFormed: a well-formed question — no committed work — passes clean", () => {
  const report = buildWellFormed(envelope({ questions: [question({ id: "q1", question: "Which cache strategy?" })] }), ctx);
  assert.equal(report.passed, true);
});

test("buildWellFormed: changed_files alongside a question fails — escalating means committing nothing this round", () => {
  const report = buildWellFormed(envelope({ changed_files: ["src/a.ts"], questions: [question({ id: "q1", question: "Which cache strategy?" })] }), ctx);
  assert.equal(report.passed, false);
  assert.match(report.violations.join("\n"), /changed_files/);
});

test("buildWellFormed: commit_message alongside a question fails", () => {
  const report = buildWellFormed(envelope({ commit_message: "fix: a", questions: [question({ id: "q1", question: "Which cache strategy?" })] }), ctx);
  assert.equal(report.passed, false);
  assert.match(report.violations.join("\n"), /commit_message/);
});

test("buildWellFormed: a blank question id fails", () => {
  const report = buildWellFormed(envelope({ questions: [question({ id: "", question: "Which cache strategy?" })] }), ctx);
  assert.equal(report.passed, false);
  assert.match(report.violations.join("\n"), /question id is blank/);
});

test("buildWellFormed: a blank question text fails", () => {
  const report = buildWellFormed(envelope({ questions: [question({ id: "q1", question: "   " })] }), ctx);
  assert.equal(report.passed, false);
  assert.match(report.violations.join("\n"), /question text is blank/);
});

test("buildWellFormed: duplicate question ids within one round fail", () => {
  const report = buildWellFormed(
    envelope({ questions: [question({ id: "q1", question: "First?" }), question({ id: "q1", question: "Second?" })] }),
    ctx,
  );
  assert.equal(report.passed, false);
  assert.match(report.violations.join("\n"), /duplicate question id/);
});

test("buildWellFormed: multiple distinct, well-formed questions pass clean", () => {
  const report = buildWellFormed(
    envelope({ questions: [question({ id: "q1", question: "Which cache strategy?" }), question({ id: "q2", question: "Which auth provider?" })] }),
    ctx,
  );
  assert.equal(report.passed, true);
});
