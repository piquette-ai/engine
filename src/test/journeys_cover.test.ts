/**
 * #159 ticket C / #175: the definition of done moves upstream.
 *
 *  - `journeysCover`: the plan's journeys.yaml exists, parses, has an
 *    unhappy path and doesn't restate non-negotiables — and is a no-op
 *    without `receipts:`.
 *  - `refinementWellFormed`: every leaf has an "Observable check:" line and
 *    every bug a "Repro today:" line — only with `receipts:`.
 *  - `verificationInstructions`: the planner's `{{verification}}` text is
 *    empty without `receipts:`, so the planner prompt is unchanged.
 */
import "./hermetic_git.js"; // house rule; nothing here spawns git, but keep the habit
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { journeysCover, refinementWellFormed } from "../core/gates.js";
import { verificationInstructions } from "../core/agents.js";
import { resolvePromptRef, ASSETS_DIR } from "../core/paths.js";
import { SFConfigSchema, type EnvelopeBase, type RefinedIssue, type RunContext } from "../core/data_types.js";

const withReceipts = v.parse(SFConfigSchema, { receipts: {} });
const withoutReceipts = v.parse(SFConfigSchema, {});

function planEnvelope(artifacts: string[]): EnvelopeBase {
  return { status: "success", summary: "", artifacts, notes_for_next_agent: "" } as EnvelopeBase;
}

function withRepo(fn: (repo: string, run: RunContext) => void, cfg = withReceipts): void {
  const repo = mkdtempSync(join(tmpdir(), "piquette-journeys-cover-"));
  try {
    fn(repo, { repo_root: repo, cfg });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const GOOD = `journeys:
  - id: P01
    criterion: "an unknown chain says so on its first line"
    kind: unhappy
    run: piquette nope probe
    expect: { exit_nonzero: true, first_line_matches: "unknown chain" }
  - id: P02
    criterion: "help still lists the chains"
    run: piquette --help
    expect: { exit: 0, output_contains: ["piquette list"] }
`;

// ── journeysCover ───────────────────────────────────────────────────────────

test("journeysCover is a no-op without receipts: — no checks at all, so existing chains are unchanged", () => {
  withRepo((_repo, run) => {
    const report = journeysCover(planEnvelope([]), run);
    assert.deepEqual(report.checks, []);
    assert.equal(report.passed, true);
  }, withoutReceipts);
});

test("journeysCover: a plan that declares no journeys.yaml is sent back with what to write", () => {
  withRepo((_repo, run) => {
    const report = journeysCover(planEnvelope(["plan.md"]), run);
    assert.equal(report.passed, false);
    assert.match(report.violations[0], /no journeys\.yaml in artifacts/);
  });
});

test("journeysCover: a declared file that doesn't exist, or doesn't parse, fails", () => {
  withRepo((repo, run) => {
    assert.match(journeysCover(planEnvelope(["journeys.yaml"]), run).violations.join("\n"), /does not exist/);
    writeFileSync(join(repo, "journeys.yaml"), "journeys:\n  - id: P01\n    run: true\n    expect: {}\n");
    const report = journeysCover(planEnvelope(["journeys.yaml"]), run);
    assert.equal(report.passed, false);
    assert.match(report.violations.join("\n"), /criterion/);
  });
});

test("journeysCover: only happy paths are refused — the builder only tries the path it built", () => {
  withRepo((repo, run) => {
    writeFileSync(join(repo, "journeys.yaml"), GOOD.replace("kind: unhappy", "kind: happy"));
    const report = journeysCover(planEnvelope(["journeys.yaml"]), run);
    assert.equal(report.passed, false);
    assert.match(report.violations.join("\n"), /has an unhappy journey: every journey is a happy path/);
  });
});

test("journeysCover: restated non-negotiables are refused (they're merged into every proof)", () => {
  withRepo((repo, run) => {
    writeFileSync(join(repo, "journeys.yaml"), GOOD + "  - { id: NN-version, criterion: c, run: 'true', expect: { exit: 0 } }\n");
    const report = journeysCover(planEnvelope(["journeys.yaml"]), run);
    assert.equal(report.passed, false);
    assert.match(report.violations.join("\n"), /NN-version look like non-negotiables/);
  });
});

test("journeysCover: a good journeys file passes and says what it found", () => {
  withRepo((repo, run) => {
    writeFileSync(join(repo, "journeys.yaml"), GOOD);
    const report = journeysCover(planEnvelope(["plan.md", join(repo, "journeys.yaml")]), run);
    assert.equal(report.passed, true, report.violations.join("\n"));
    assert.ok(report.checks.some((c) => c.note === "2 journey(s): 1 happy, 1 unhappy"));
  });
});

// ── refinementWellFormed: observable checks ─────────────────────────────────

const outcome = "After this lands, an operator can see which chain they mistyped.";
function leaf(over: Partial<RefinedIssue> & Pick<RefinedIssue, "key" | "kind">): RefinedIssue {
  return { title: `Leaf ${over.key}`, user_outcome: outcome, body: "## What to build\n\nx\n\n## Acceptance criteria\n\n- [ ] x", parent: "", blocked_by: [], priority: "p2", ...over };
}
function refineEnvelope(issues: RefinedIssue[]) {
  return { status: "success" as const, summary: "", artifacts: [], notes_for_next_agent: "", issues };
}
const OBSERVABLE = "\n- [ ] Observable check: an operator runs `piquette nope` and sees `unknown chain: nope` first";
const REPRO = "\n- [ ] Repro today: run `piquette nope` → 28 lines of usage bury the error";

test("refinementWellFormed: without receipts: a leaf with no Observable check is fine (behavior unchanged)", () => {
  const report = refinementWellFormed(refineEnvelope([leaf({ key: "S1", kind: "story" })]), { repo_root: "/repo", cfg: withoutReceipts });
  assert.equal(report.passed, true, report.violations.join("\n"));
  assert.ok(!report.checks.some((c) => c.item.endsWith(".observable_check")));
});

test("refinementWellFormed: with receipts: every leaf needs an Observable check, and every bug a Repro today line", () => {
  const run = { repo_root: "/repo", cfg: withReceipts };
  const missing = refinementWellFormed(refineEnvelope([leaf({ key: "S1", kind: "story" }), leaf({ key: "B1", kind: "bug", body: leaf({ key: "x", kind: "bug" }).body + OBSERVABLE })]), run);
  assert.equal(missing.passed, false);
  assert.match(missing.violations.join("\n"), /S1\.observable_check: no "- \[ \] Observable check/);
  assert.match(missing.violations.join("\n"), /B1\.repro_today: bug has no "- \[ \] Repro today/);

  const good = refinementWellFormed(
    refineEnvelope([leaf({ key: "S1", kind: "story", body: leaf({ key: "x", kind: "story" }).body + OBSERVABLE }), leaf({ key: "B1", kind: "bug", body: leaf({ key: "x", kind: "bug" }).body + REPRO + OBSERVABLE })]),
    run,
  );
  assert.equal(good.passed, true, good.violations.join("\n"));
});

test("refinementWellFormed: containers are exempt — only leaves are built and proved", () => {
  const report = refinementWellFormed(
    refineEnvelope([
      { ...leaf({ key: "F1", kind: "feature" }), user_outcome: "" },
      leaf({ key: "S1", kind: "story", parent: "F1", body: leaf({ key: "x", kind: "story" }).body + OBSERVABLE }),
      leaf({ key: "S2", kind: "story", parent: "F1", body: leaf({ key: "x", kind: "story" }).body + OBSERVABLE }),
    ]),
    { repo_root: "/repo", cfg: withReceipts },
  );
  assert.equal(report.passed, true, report.violations.join("\n"));
  assert.ok(!report.checks.some((c) => c.item === "F1.observable_check"));
});

// ── the planner's {{verification}} ──────────────────────────────────────────

test("verificationInstructions: empty without receipts:, the journeys instructions with it", () => {
  const anchor = { repo_root: tmpdir(), piquette_dir: null };
  assert.equal(verificationInstructions({ ...anchor, cfg: withoutReceipts }, "/h"), "");
  const text = verificationInstructions({ ...anchor, cfg: withReceipts }, "/handoff/dir");
  assert.match(text, /\/handoff\/dir\/journeys\.yaml/);
  assert.match(text, /kind: unhappy/);
  assert.match(text, /Red before green/);
  assert.match(text, /UI-shaped work needs a UI-capable check/, "the planner is told to look for an existing UI-verification proof script before falling back to a text-match");
  assert.match(text, /never authoring one/, "finding and using an existing script, not writing a new one into protected proof infrastructure");
});

test("the packaged planner prompt has the {{verification}} slot, and the refiner asks for Observable check / Repro today", () => {
  const anchor = { repo_root: tmpdir(), piquette_dir: null };
  assert.match(readFileSync(resolvePromptRef(anchor, "planner/user.md"), "utf-8"), /\{\{verification\}\}/);
  const refiner = readFileSync(resolvePromptRef(anchor, "refiner/system.md"), "utf-8");
  assert.match(refiner, /Observable check:/);
  assert.match(refiner, /Repro today:/);
  assert.doesNotMatch(refiner, /Manual check/i);
});

test("the gap-flagging note names a real cookbook: authoring_proof_scripts.md exists, ships in the skill, and is routed to from SKILL.md", () => {
  const anchor = { repo_root: tmpdir(), piquette_dir: null };
  const verification = readFileSync(resolvePromptRef(anchor, "planner/verification.md"), "utf-8");
  assert.match(verification, /cookbooks\/authoring_proof_scripts\.md/, "the planner's note should point at a real cookbook, not a dangling reference");

  const cookbookPath = join(ASSETS_DIR, "skill", "cookbooks", "authoring_proof_scripts.md");
  assert.ok(existsSync(cookbookPath), `${cookbookPath} should exist — it's what the planner's note above points readers to`);
  const cookbook = readFileSync(cookbookPath, "utf-8");
  assert.match(cookbook, /protected_files/, "should explain why this is a human task, not an agent one");
  assert.match(cookbook, /agent-browser/, "should give a worked pattern, not just the contract");

  const skillMd = readFileSync(join(ASSETS_DIR, "skill", "SKILL.md"), "utf-8");
  assert.match(skillMd, /cookbooks\/authoring_proof_scripts\.md/, "SKILL.md's routing table should list the new cookbook");
});
