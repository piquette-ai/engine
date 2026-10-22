/**
 * #159 ticket D / #176: proveBase / proveHead / commit as chain steps,
 * against a REAL temporary git repo, real journeys, a real local receipt
 * store and real git commits — only the agent is faked (its "fix" rewrites
 * the app, or doesn't).
 *
 * The contract under test: verification INFORMS, it never blocks.
 *  - red before, green after → verified, and the committed tree matches;
 *  - a change that keeps failing stops after `max_failed_proofs` failed
 *    proofs (default 3: two fixes) → unverified, yet `accepted` stays true
 *    and the commit still lands;
 *  - CAN'T TELL stops at once (a fix can't supply missing evidence);
 *  - journeys that already pass before the change → unverified;
 *  - code changed after the proof → the commit is flagged as unproved;
 *  - without `receipts:`, nothing runs at all.
 */
import "./hermetic_git.js"; // MUST stay first: this file runs git in temp repos
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import * as steps from "../chains/steps.js";
import { SFConfigSchema, type EventRecord } from "../core/data_types.js";
import { makeGit } from "../core/git_helper.js";
import { treeOf } from "../core/receipt.js";
import type { VerificationOutcome } from "../core/verification.js";
import type { Run } from "../core/runner.js";

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

interface Harness {
  run: Run;
  state: steps.ChainState;
  repo: string;
  phases: string[];
  events: EventRecord[];
  notes: string[];
  verification: () => VerificationOutcome | undefined;
  cleanup: () => void;
}

function harness(opts: { receipts?: boolean; maxFailed?: number; journeys?: string; fixAt?: number | null; journeysFile?: boolean } = {}): Harness {
  const repo = mkdtempSync(join(tmpdir(), "spf-prove-steps-repo-"));
  const handoff = mkdtempSync(join(tmpdir(), "spf-prove-steps-handoff-"));
  const storeDir = mkdtempSync(join(tmpdir(), "spf-prove-steps-store-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=spf-test", "-c", "user.email=spf@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "spf-test");
  git("config", "user.email", "spf@test.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "app.sh"), OLD);
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  const journeysPath = join(handoff, "journeys.yaml");
  writeFileSync(journeysPath, opts.journeys ?? JOURNEYS);

  const cfg = v.parse(SFConfigSchema, {
    quality: { checks: [{ name: "t", operation: "build", argv: ["true"] }], suites: { test: ["t"] } },
    ...(opts.receipts === false
      ? {}
      : { receipts: { record: false, max_failed_proofs: opts.maxFailed ?? 3, store: { kind: "local", path: storeDir } } }),
  });
  const phases: string[] = [];
  const events: EventRecord[] = [];
  const notes: string[] = [];
  let fixes = 0;
  // Like a real Run, each phase is appended to run.phases as it starts —
  // quality.runSuite reads the current phase from there.
  const runPhases: Array<{ seq: number; phase_id: string; name: string }> = [];
  const run = {
    cfg,
    repo_root: repo,
    adw_id: "run-1",
    context_handoff_dir: handoff,
    phases: runPhases,
    git: makeGit(repo),
    tracer: { event: async (e: EventRecord) => (events.push(e), "id") },
    console: { note: async (m: string) => void notes.push(m) },
    phase: async (params: { name: string }, fn: (ph: unknown) => Promise<unknown>) => {
      phases.push(params.name);
      runPhases.push({ seq: runPhases.length + 1, phase_id: `ph-${params.name}`, name: params.name });
      const ph = {
        phase_id: `ph-${params.name}`,
        log: async () => {},
        // The fake builder: on its `fixAt`-th fix it actually repairs the app.
        call: async () => {
          fixes++;
          if (opts.fixAt !== undefined && opts.fixAt !== null && fixes >= opts.fixAt) writeFileSync(join(repo, "app.sh"), NEW);
          return { status: "success", summary: "fixed", artifacts: [], notes_for_next_agent: "", changed_files: ["app.sh"], commit_message: "Print the new greeting" };
        },
      };
      return fn(ph);
    },
  } as unknown as Run;
  const state: steps.ChainState = {
    prompt: "print the new greeting",
    options: {},
    previous: opts.journeysFile === false
      ? { status: "success", summary: "plan", artifacts: [], notes_for_next_agent: "" }
      : { status: "success", summary: "plan", artifacts: [journeysPath], notes_for_next_agent: "" },
    quality: null,
    review: null,
    changeset: null,
    baseline: "",
    issue_id: "179",
    accepted: true,
    reason: "",
  } as steps.ChainState;
  return {
    run,
    state,
    repo,
    phases,
    events,
    notes,
    verification: () => {
      const last = events.filter((e) => e.name === "verification").at(-1);
      return last?.payload as unknown as VerificationOutcome | undefined;
    },
    cleanup: () => [repo, handoff, storeDir].forEach((d) => rmSync(d, { recursive: true, force: true })),
  };
}

/** What the builder does in a real run: write the change into the worktree. */
const build = (h: Harness, content = NEW) => writeFileSync(join(h.repo, "app.sh"), content);
/** The previous agent step for commit(): the build's envelope. */
const buildEnvelope = (h: Harness) => {
  h.state.previous = { status: "success", summary: "build", artifacts: [], notes_for_next_agent: "", changed_files: ["app.sh"], commit_message: "Print the new greeting" } as never;
};

test("without receipts:, the prove steps do nothing at all", async () => {
  const h = harness({ receipts: false });
  try {
    await steps.proveBase()(h.run, h.state);
    build(h);
    await steps.proveHead({ suite: "test" })(h.run, h.state);
    assert.deepEqual(h.phases, []);
    assert.deepEqual(h.events, []);
    assert.equal(h.state.verification, undefined);
  } finally {
    h.cleanup();
  }
});

test("red before, green after → VERIFIED, and the commit lands the exact tree that was proved", async () => {
  const h = harness();
  try {
    await steps.proveBase()(h.run, h.state);
    assert.equal(h.state.verification?.base?.receipt.verdict, "FAIL", "the journeys fail on the code before the change");
    build(h);
    await steps.proveHead({ suite: "test" })(h.run, h.state);
    assert.deepEqual(h.phases, ["prove_base", "prove_1"]);
    assert.equal(h.verification()?.status, "verified", JSON.stringify(h.verification()?.reasons));

    buildEnvelope(h);
    await steps.commit({ onlyIfAccepted: true })(h.run, h.state);
    const final = h.verification()!;
    assert.equal(final.status, "verified", JSON.stringify(final.reasons));
    assert.equal(final.committed?.matches, true);
    assert.equal(final.committed?.tree, treeOf(h.repo, "HEAD"));
    assert.equal(h.state.accepted, true);
  } finally {
    h.cleanup();
  }
});

test("a fix that works on the second proof → verified after 1 failed proof, and the suite is re-run", async () => {
  const h = harness({ fixAt: 1 });
  try {
    await steps.proveBase()(h.run, h.state);
    build(h, OLD.replace("old", "still old")); // the first build misses
    await steps.proveHead({ suite: "test" })(h.run, h.state);
    assert.deepEqual(h.phases, ["prove_base", "prove_1", "prove_fix_1", "prove_2", "retest"]);
    const outcome = h.verification()!;
    assert.equal(outcome.status, "verified", JSON.stringify(outcome.reasons));
    assert.equal(outcome.failed_proofs, 1);
    assert.equal(h.state.accepted, true, "the re-run suite passed");
  } finally {
    h.cleanup();
  }
});

test("3 failed proofs → UNVERIFIED and escalated, but never blocking: accepted stays true and the commit still lands", async () => {
  const h = harness({ fixAt: null }); // the builder never manages it
  try {
    await steps.proveBase()(h.run, h.state);
    build(h, OLD.replace("old", "wrong")); // a real change, just not the right one
    await steps.proveHead({ suite: "test" })(h.run, h.state);
    assert.deepEqual(h.phases, ["prove_base", "prove_1", "prove_fix_1", "prove_2", "prove_fix_2", "prove_3", "retest"]);
    const outcome = h.verification()!;
    assert.equal(outcome.status, "unverified");
    assert.equal(outcome.failed_proofs, 3);
    assert.match(outcome.reasons.join("\n"), /still fails its own proof after 3 of 3/);
    assert.ok(h.notes.some((n) => /UNVERIFIED — the change will still land, flagged for a person/.test(n)));

    assert.equal(h.state.accepted, true, "a failed proof never fails the run");
    buildEnvelope(h);
    await steps.commit({ onlyIfAccepted: true })(h.run, h.state);
    assert.ok(h.phases.includes("commit"), "the commit still lands, so watch still opens the PR");
    assert.equal(h.verification()?.status, "unverified");
  } finally {
    h.cleanup();
  }
});

test("max_failed_proofs is configurable — 1 means no fix at all", async () => {
  const h = harness({ maxFailed: 1, fixAt: 1 });
  try {
    await steps.proveBase()(h.run, h.state);
    build(h, OLD);
    await steps.proveHead({ suite: "test" })(h.run, h.state);
    assert.deepEqual(h.phases, ["prove_base", "prove_1"]);
    assert.match(h.verification()!.reasons.join("\n"), /after 1 of 1 attempt/);
  } finally {
    h.cleanup();
  }
});

test("CAN'T TELL stops at once — a fix can't supply missing evidence", async () => {
  const h = harness({
    fixAt: 1,
    journeys: JOURNEYS + "  - id: P03\n    criterion: c\n    run: spf-definitely-not-installed-xyz\n    expect: { exit_nonzero: true }\n",
  });
  try {
    build(h);
    await steps.proveHead({ suite: "test" })(h.run, h.state);
    assert.deepEqual(h.phases, ["prove_1"]);
    const outcome = h.verification()!;
    assert.equal(outcome.status, "unverified");
    assert.match(outcome.reasons.join("\n"), /couldn't tell/);
  } finally {
    h.cleanup();
  }
});

test("journeys that already pass before the change → unverified: they don't show this work did anything", async () => {
  const h = harness({ journeys: JOURNEYS.replace('["new greeting"]', '["greeting"]') });
  try {
    await steps.proveBase()(h.run, h.state);
    assert.equal(h.state.verification?.base?.receipt.verdict, "PASS");
    build(h);
    await steps.proveHead({ suite: "test" })(h.run, h.state);
    const outcome = h.verification()!;
    assert.equal(outcome.status, "unverified");
    assert.match(outcome.reasons.join("\n"), /already pass on the code before the change/);
  } finally {
    h.cleanup();
  }
});

test("code changed after the last proof → the commit is flagged as not the code that was proved", async () => {
  const h = harness();
  try {
    await steps.proveBase()(h.run, h.state);
    build(h);
    await steps.proveHead({ suite: "test" })(h.run, h.state);
    assert.equal(h.verification()?.status, "verified");
    writeFileSync(join(h.repo, "app.sh"), NEW + "# a late edit\n");
    buildEnvelope(h);
    await steps.commit({ onlyIfAccepted: true })(h.run, h.state);
    const final = h.verification()!;
    assert.equal(final.status, "unverified");
    assert.equal(final.committed?.matches, false);
    assert.match(final.reasons.join("\n"), /isn't the code that was proved/);
  } finally {
    h.cleanup();
  }
});

test("a plan with no journeys file → unverified with that reason, and no proof phases run", async () => {
  const h = harness({ journeysFile: false });
  try {
    await steps.proveBase()(h.run, h.state);
    build(h);
    await steps.proveHead({ suite: "test" })(h.run, h.state);
    assert.deepEqual(h.phases, []);
    assert.match(h.verification()!.reasons.join("\n"), /plan has no journeys/);
  } finally {
    h.cleanup();
  }
});
