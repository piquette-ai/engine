/**
 * #187: `simple_sdlc` runs the receipts prove steps (#159) the way the
 * step-list chains do. Drives the REAL `simple_sdlc.main` (real startRun,
 * phases, git, suite, prover and local receipt store) with only the agents
 * scripted.
 *
 * The contract: with `receipts:` the chain proves before the change (after
 * commit_plan), proves the change (after the tests), and checks the committed
 * tree (after commit_build), emitting the `verification` event; a proof that
 * never passes is UNVERIFIED but never blocks the commit. Without `receipts:`
 * no prove phase runs at all.
 */
import "./hermetic_git.js";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EnvelopeBase } from "../core/data_types.js";
import { Run, type PhaseHandle } from "../core/runner.js";
import type { VerificationOutcome } from "../core/verification.js";
import * as simpleSdlc from "../chains/simple_sdlc.js";

const OLD = 'if [ "$1" = "--bad" ]; then echo "bad argument: $1" >&2; exit 2; fi\necho "the old greeting"\n';
const NEW = 'if [ "$1" = "--bad" ]; then echo "bad argument: $1" >&2; exit 2; fi\necho "the new greeting"\n';
const JOURNEYS = `journeys:
  - id: P01
    criterion: "the app prints the new greeting"
    run: bash app.sh
    expect: { exit: 0, output_contains: ["new greeting"] }
  - id: P02
    kind: unhappy
    criterion: "a bad argument is refused cleanly"
    run: bash app.sh --bad
    expect: { exit_nonzero: true, first_line_matches: "^bad argument" }
`;

function repoWithConfig(extraYaml: string): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "spf-sdlc-prove-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(dir, "app.sh"), OLD);
  writeFileSync(join(dir, ".gitignore"), ".spf/\n");
  writeFileSync(join(dir, "s.md"), "system\n");
  writeFileSync(join(dir, "u.md"), "user\n");
  const configPath = join(dir, "spf.config.yaml");
  const agents = simpleSdlc.REQUIRED_AGENTS.map((name) => `  - {name: ${name}, prompt_engineering: {system: s.md, user: u.md}}\n`).join("");
  writeFileSync(configPath, `agents:\n${agents}quality:\n  checks:\n    - {name: test, operation: build, argv: ["true"]}\n  suites:\n    test: [test]\n${extraYaml}`);
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("switch", "-q", "-c", "work"); // commit phases refuse protected branches (#97)
  return { dir, configPath };
}

/** `repairOnCall`: the builder call (build, then prove fixes) that finally repairs the app; null = never. */
async function drive(opts: { receipts: boolean; repairOnCall: number | null; rejectFirstReview?: boolean; reviseBreaksApp?: boolean }): Promise<{ code: number; phases: string[]; dir: string; store: string; outcomes: VerificationOutcome[]; head: string }> {
  const store = mkdtempSync(join(tmpdir(), "spf-sdlc-prove-store-"));
  const receipts = opts.receipts ? `receipts:\n  record: false\n  store: { kind: local, path: ${store} }\n` : "";
  const { dir, configPath } = repoWithConfig(receipts);
  const phases: string[] = [];
  let builderCalls = 0;
  const env = (extra: Record<string, unknown> = {}): EnvelopeBase => ({ status: "success", summary: "ok", artifacts: [], notes_for_next_agent: "", ...extra }) as EnvelopeBase;
  const respond = (phase: string): EnvelopeBase => {
    if (phase === "plan") {
      writeFileSync(join(dir, "plan.md"), "the plan\n");
      writeFileSync(join(dir, "journeys.yaml"), JOURNEYS);
      return env({ artifacts: ["plan.md", "journeys.yaml"], commit_message: "plan" });
    }
    if (phase === "review_1" && opts.rejectFirstReview) return env({ approved: false, findings: ["tighten it"], blocking: ["tighten it"] });
    if (phase.startsWith("review_")) return env({ approved: true, findings: [], blocking: [] });
    if (phase === "revise_1" && opts.reviseBreaksApp) {
      writeFileSync(join(dir, "app.sh"), OLD); // the suite stays green; only the journeys notice
      return env({ changed_files: ["app.sh"], commit_message: "revise" });
    }
    if (phase === "document") {
      writeFileSync(join(dir, "docs.md"), "docs\n");
      return env({ commit_message: "docs" });
    }
    builderCalls++;
    writeFileSync(join(dir, "work.txt"), `attempt ${builderCalls}\n`); // a builder that never repairs the app still changes something to commit
    if (opts.repairOnCall !== null && builderCalls >= opts.repairOnCall) writeFileSync(join(dir, "app.sh"), NEW);
    return env({ changed_files: ["app.sh"], commit_message: "greet" });
  };
  const realPhase = Run.prototype.phase;
  const wrapped = mock.method(Run.prototype, "phase", function (this: Run, params: { name: string }, fn: (ph: PhaseHandle) => Promise<unknown>) {
    phases.push(params.name);
    return realPhase.call(this, params as Parameters<typeof realPhase>[0], (ph) => fn({ phase_id: ph.phase_id, log: (p: Record<string, unknown>) => ph.log(p), call: (async () => respond(params.name)) as PhaseHandle["call"] }));
  });
  try {
    const code = await simpleSdlc.main({ prompt: "print the new greeting", config_paths: [configPath], adw_id: "adw_sdlc_prove", cwd: dir, chain_name: "simple-sdlc", unattended: true });
    const db = new DatabaseSync(join(dir, ".spf", "data", "spf.db"));
    let outcomes: VerificationOutcome[];
    try {
      const rows = db.prepare("SELECT payload_json FROM events WHERE adw_id=? AND name='verification'").all("adw_sdlc_prove") as Array<{ payload_json: string }>;
      outcomes = rows.map((r) => JSON.parse(r.payload_json) as VerificationOutcome);
    } finally {
      db.close();
    }
    const head = execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf-8" });
    return { code, phases, dir, store, outcomes, head };
  } finally {
    wrapped.mock.restore();
  }
}

const cleanup = (r: { dir: string; store: string }) => [r.dir, r.store].forEach((d) => rmSync(d, { recursive: true, force: true }));

test("simple_sdlc with receipts: proves before and after the change, checks the committed tree, VERIFIED", async () => {
  const r = await drive({ receipts: true, repairOnCall: 1 });
  try {
    assert.equal(r.code, 0);
    assert.deepEqual(r.phases.filter((p) => /^(commit|prove|test|review)/.test(p)), ["commit_plan", "prove_base", "test_1", "prove_1", "review_1", "commit_build", "commit_docs"]);
    assert.ok(r.phases.indexOf("commit_plan") < r.phases.indexOf("prove_base"));
    const last = r.outcomes.at(-1)!;
    assert.equal(last.status, "verified", JSON.stringify(last.reasons));
    assert.equal(last.committed?.matches, true, "the committed-tree check ran after commit_build");
    assert.ok(r.outcomes.length >= 2, "settled once after the proof, again after the commit");
  } finally {
    cleanup(r);
  }
});

test("simple_sdlc with receipts: a change that never passes its proof stops at 3 failed proofs, is UNVERIFIED, and still commits", async () => {
  const r = await drive({ receipts: true, repairOnCall: null });
  try {
    assert.equal(r.code, 0, "verification never blocks");
    assert.equal(r.phases.filter((p) => /^prove_\d+$/.test(p)).length, 3);
    assert.equal(r.phases.filter((p) => /^prove_fix_/.test(p)).length, 2);
    assert.ok(r.phases.includes("commit_build"), "the commit still lands");
    assert.equal(r.outcomes.at(-1)!.status, "unverified");
  } finally {
    cleanup(r);
  }
});

test("simple_sdlc without receipts: no prove phase and no verification event", async () => {
  const r = await drive({ receipts: false, repairOnCall: 1 });
  try {
    assert.equal(r.code, 0);
    assert.deepEqual(r.phases.filter((p) => p.startsWith("prove")), []);
    assert.equal(r.outcomes.length, 0);
  } finally {
    cleanup(r);
  }
});

const AGENT_PHASES = /^(plan|build|fix_\d+|revise_\d+|prove_fix_\d+|review_\d+|document)$/;

test("simple_sdlc with receipts: a revised-then-approved change is re-proved without fixes and numbered on", async () => {
  const r = await drive({ receipts: true, repairOnCall: 1, rejectFirstReview: true });
  try {
    assert.equal(r.code, 0);
    assert.deepEqual(r.phases.filter((p) => /^(commit_build|prove|review|revise|retest)/.test(p)), ["prove_base", "prove_1", "review_1", "revise_1", "review_2", "retest", "prove_2", "commit_build"]);
    const between = r.phases.slice(r.phases.indexOf("review_2") + 1, r.phases.indexOf("commit_build"));
    assert.deepEqual(between.filter((p) => AGENT_PHASES.test(p)), [], "no agent writes code after the last review");
    assert.equal(r.outcomes.at(-1)!.status, "verified");
  } finally {
    cleanup(r);
  }
});

test("simple_sdlc with receipts: a red re-proof after revision is UNVERIFIED, never fixed unreviewed, and the commit still lands", async () => {
  const r = await drive({ receipts: true, repairOnCall: 1, rejectFirstReview: true, reviseBreaksApp: true });
  try {
    assert.equal(r.code, 0);
    assert.deepEqual(r.phases.filter((p) => /^prove_(fix_)?\d+$/.test(p)), ["prove_1", "prove_2"], "one re-proof, no fix");
    const between = r.phases.slice(r.phases.indexOf("review_2") + 1, r.phases.indexOf("commit_build"));
    assert.deepEqual(between.filter((p) => AGENT_PHASES.test(p)), []);
    assert.ok(r.phases.includes("commit_build"));
    assert.equal(r.outcomes.at(-1)!.status, "unverified");
  } finally {
    cleanup(r);
  }
});
