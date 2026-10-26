/**
 * Regression test for `clearStaleRefineOutputFiles` — extracted specifically
 * so this is testable without constructing a full `Run`/chain harness (no
 * existing test does; `Run` needs a Tracer, Console, Notifier, GitHandle,
 * ...). See `publishIssues()`'s own call site and this function's doc
 * comment in `chains/steps.ts` for the real-world bug this closes: a resumed
 * spec reruns the whole `refine` chain into the SAME deterministic
 * `context_handoff_dir` a prior escalation round already wrote into, and
 * without this, a stale `refine_questions.json` from that earlier round
 * survived a LATER round's successful publish — `cli/commands/watch.ts`'s
 * `runRefine()` read it back and reported those old questions as raised
 * again, so the spec got re-escalated over issues that had already been
 * created on the tracker seconds earlier.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as steps from "../chains/steps.js";
import { clearStaleRefineOutputFiles, type ChainState } from "../chains/steps.js";
import type { Run } from "../core/runner.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "piquette-steps-test-"));
}

test("clearStaleRefineOutputFiles: removes a stale refine_questions.json left over from an earlier escalation round", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, "refine_questions.json"), "[]");
    clearStaleRefineOutputFiles(dir);
    assert.equal(existsSync(join(dir, "refine_questions.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearStaleRefineOutputFiles: removes a stale refine_publish.json too", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, "refine_publish.json"), "[]");
    clearStaleRefineOutputFiles(dir);
    assert.equal(existsSync(join(dir, "refine_publish.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearStaleRefineOutputFiles: clears both at once — the actual failure mode was one stale file surviving alongside a fresh other one", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, "refine_questions.json"), "[]");
    writeFileSync(join(dir, "refine_publish.json"), "[]");
    clearStaleRefineOutputFiles(dir);
    assert.equal(existsSync(join(dir, "refine_questions.json")), false);
    assert.equal(existsSync(join(dir, "refine_publish.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearStaleRefineOutputFiles: a first-ever run with neither file present is a no-op, not an error", () => {
  const dir = makeDir();
  try {
    assert.doesNotThrow(() => clearStaleRefineOutputFiles(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Step.gate: every writer of state.accepted declares itself (#109) ──────

test("Step.gate: every step factory that writes state.accepted carries gate: true, and the ones that don't, don't", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const steps = await import("../chains/steps.js");
  // Read the SOURCE (tests run from dist/test/, the source sits at src/chains/)
  // so a future factory that starts writing state.accepted is caught here
  // even if nobody remembers the graph loader derives commit gating from it.
  // A writer either assigns it directly or conjoins its result in through
  // `accept(state, ...)`; either shape counts. Every top-level function starts
  // a block, exported or not, so the private `accept` helper's body is never
  // read as part of the export above it.
  const source = readFileSync(fileURLToPath(new URL("../../src/chains/steps.ts", import.meta.url)), "utf8");
  const starts = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)];
  const writers: string[] = [];
  for (const [i, m] of starts.entries()) {
    if (m[1] === "accept") continue;
    const block = source.slice(m.index, starts[i + 1]?.index ?? source.length);
    if (!/state\.accepted\s*=(?!=)/.test(block) && !/\baccept\(\s*state,/.test(block)) continue;
    writers.push(m[1]!);
    assert.match(block, /gate: true/, `${m[1]} writes state.accepted but does not declare gate: true`);
  }
  // proveHead (#159) writes accepted only by re-running the suite after a
  // proof-driven fix; its proof verdict itself never touches accepted.
  assert.deepEqual(writers.sort(), ["fixLoop", "proveHead", "qualityCheck", "reviseLoop"]);

  assert.equal(steps.qualityCheck({ suite: "test" }).gate, true);
  assert.equal(steps.fixLoop({ suite: "test" }).gate, true);
  assert.equal(steps.reviseLoop().gate, true);
  assert.equal(steps.proveHead({ suite: "test" }).gate, true);
  for (const s of [steps.request(), steps.plan(), steps.build(), steps.commit(), steps.commit({ onlyIfAccepted: true }), steps.document(), steps.proveBase()]) {
    assert.equal(s.gate, undefined);
  }
});

// ── per-gate acceptance (re-cut from #128) ───────────────────────────────

/**
 * A fake Run that drives the real `quality.runSuite`: the suite's exit code is
 * popped off `exits`, one per suite invocation (shared by `fixLoop`'s suite
 * phase, `qualityCheck`, and `reviseLoop`'s `retest`, through a file a real
 * subprocess reads and rewrites). `ph.call` answers by phase name:
 * `reviews[i-1]` is `review_i`'s verdict; anything else is a builder envelope.
 */
function fakeRun(exits: (0 | 1)[], reviews: boolean[] = []): { run: Run; ran: string[]; events: string[]; cleanup: () => void } {
  const scratch = makeDir();
  const exitsFile = join(scratch, "exits.json");
  writeFileSync(exitsFile, JSON.stringify(exits));
  const pop = `const fs=require('fs');const f=${JSON.stringify(exitsFile)};const c=JSON.parse(fs.readFileSync(f,'utf8'));const code=c.shift();fs.writeFileSync(f,JSON.stringify(c));process.exit(code===undefined?3:code);`;
  const ran: string[] = [];
  const events: string[] = [];
  let reviewCall = 0;
  const phases: { phase_id: string; seq: number }[] = [];
  const run = {
    cfg: {
      quality: {
        checks: [{ name: "test", area: "backend", operation: "typecheck", argv: ["node", "-e", pop], timeout_seconds: 5 }],
        suites: { test: ["test"], smoke: ["test"] },
      },
    },
    phases,
    context_handoff_dir: scratch,
    repo_root: scratch,
    console: { note: async () => {} },
    tracer: { event: async (rec: { name: string }) => (events.push(rec.name), "evt") },
    adw_id: "test-adw",
    phase: async (params: { name: string }, fn: (ph: unknown) => Promise<unknown>) => {
      ran.push(params.name);
      if (params.name === "commit") throw new Error("commit must not run on an unaccepted run");
      phases.push({ phase_id: `p_${phases.length}`, seq: phases.length });
      const ph = {
        phase_id: `p_${ran.length}`,
        log: async () => {},
        call: async () => {
          if (params.name.startsWith("review_")) {
            const approved = reviews[reviewCall++] ?? false;
            return { status: "success", summary: "review", artifacts: [], approved, blocking: approved ? [] : ["fix it"], findings: [] };
          }
          return { status: "success", summary: "built", artifacts: [], changed_files: ["a.ts"], commit_message: "change" };
        },
      };
      return fn(ph);
    },
  } as unknown as Run;
  return { run, ran, events, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

async function withRun(exits: (0 | 1)[], reviews: boolean[], body: (h: ReturnType<typeof fakeRun>) => Promise<void>): Promise<void> {
  const h = fakeRun(exits, reviews);
  try {
    await body(h);
  } finally {
    h.cleanup();
  }
}

test("fixLoop(red) -> reviseLoop(approve) -> commit(onlyIfAccepted) does not commit, and fixLoop's reason survives", async () => {
  // The review would approve if asked: an overwriting reviseLoop turned that
  // approval into acceptance and the commit landed untested work.
  await withRun([1], [true], async ({ run, ran }) => {
    const state: ChainState = steps.makeState("do it", {}, null);
    state.previous = { status: "success", summary: "built", artifacts: [] } as unknown as ChainState["previous"];
    await steps.fixLoop({ suite: "test", max: 1 })(run, state);
    assert.equal(state.accepted, false);
    const reason = state.reason;
    assert.match(reason, /suite still failed/);

    await steps.reviseLoop({ max: 2 })(run, state);
    await steps.commit({ onlyIfAccepted: true })(run, state);

    assert.equal(state.accepted, false, "an approval must not cancel a red suite");
    assert.equal(state.reason, reason, "the reason run.finish() gets is fixLoop's");
    assert.ok(!ran.includes("commit"), "the commit phase never opened");
  });
});

test("accept(): a green result from a DIFFERENT suite never clears a red one; the failing suite's reason stands", async () => {
  await withRun([1, 0], [], async ({ run }) => {
    const state = steps.makeState("do it", {}, null);
    await steps.qualityCheck({ suite: "test" })(run, state);
    const reason = state.reason;
    assert.match(reason, /quality failed/);
    await steps.qualityCheck({ suite: "smoke" })(run, state);
    assert.equal(state.accepted, false, "suite B passing must not turn acceptance back on for suite A");
    assert.equal(state.reason, reason);
  });
});

test("accept(): a later result for the SAME suite replaces its earlier one, and clears its reason", async () => {
  await withRun([1, 0], [], async ({ run }) => {
    const state = steps.makeState("do it", {}, null);
    await steps.fixLoop({ suite: "test", max: 1 })(run, state);
    assert.equal(state.accepted, false);
    await steps.qualityCheck({ suite: "test" })(run, state);
    assert.equal(state.accepted, true);
    assert.equal(state.reason, "");
  });
});

test("reviseLoop: skips entirely (no review/revise phases) when the run is already unaccepted, and logs why", async () => {
  await withRun([], [true], async ({ run, ran, events }) => {
    const state = steps.makeState("do it", {}, null);
    state.accepted = false;
    state.reason = "quality failed: boom";
    await steps.reviseLoop({ max: 2 })(run, state);
    assert.deepEqual(ran, [], "no phase ran");
    assert.equal(state.accepted, false);
    assert.equal(state.reason, "quality failed: boom");
    assert.ok(events.includes("revise_loop_skipped"));
  });
});

test("reviseLoop: a skipped review stays a failing gate, so a later green retest of the red suite can't accept unreviewed work", async () => {
  await withRun([1, 0], [], async ({ run, ran }) => {
    const state = steps.makeState("do it", {}, null);
    await steps.fixLoop({ suite: "test", max: 1 })(run, state);
    const reason = state.reason;
    await steps.reviseLoop({ max: 2 })(run, state);
    await steps.qualityCheck({ suite: "test" })(run, state);
    await steps.commit({ onlyIfAccepted: true })(run, state);
    assert.equal(state.accepted, false, "the suite went green, but no review ever ran");
    assert.equal(state.reason, reason);
    assert.ok(!ran.includes("commit"), "the commit phase never opened");
  });
});

// ── retest after revision ────────────────────────────────────────────────

test("fixLoop(green) -> reviseLoop(revise, then approve) runs `retest`, and a red retest leaves the run unaccepted", async () => {
  await withRun([0, 1], [false, true], async ({ run, ran }) => {
    const state = steps.makeState("do it", {}, null);
    await steps.fixLoop({ suite: "test", max: 1 })(run, state);
    assert.equal(state.accepted, true);
    assert.equal(state.verifiedSuite, "test", "fixLoop records the suite it ran");

    await steps.reviseLoop({ max: 2 })(run, state);

    assert.deepEqual(ran, ["test_1", "review_1", "revise_1", "review_2", "retest"]);
    assert.equal(state.accepted, false, "a red retest unaccepts a run the review approved");
    assert.match(state.reason, /retest failed after revision/);
  });
});

test("reviseLoop: a green retest keeps the run accepted", async () => {
  await withRun([0, 0], [false, true], async ({ run, ran }) => {
    const state = steps.makeState("do it", {}, null);
    await steps.fixLoop({ suite: "test", max: 1 })(run, state);
    await steps.reviseLoop({ max: 2 })(run, state);
    assert.ok(ran.includes("retest"));
    assert.equal(state.accepted, true);
  });
});

test("reviseLoop: no revision landed -> no retest, even though fixLoop verified a suite", async () => {
  await withRun([0], [true], async ({ run, ran }) => {
    const state = steps.makeState("do it", {}, null);
    await steps.fixLoop({ suite: "test", max: 1 })(run, state);
    await steps.reviseLoop({ max: 2 })(run, state);
    assert.deepEqual(ran, ["test_1", "review_1"]);
    assert.equal(state.accepted, true);
  });
});

test("reviseLoop: no suite step and no retestSuite -> no retest (build-review is unchanged)", async () => {
  await withRun([], [false, true], async ({ run, ran }) => {
    const state = steps.makeState("do it", {}, null);
    await steps.reviseLoop({ max: 2 })(run, state);
    assert.deepEqual(ran, ["review_1", "revise_1", "review_2"]);
    assert.equal(state.accepted, true);
  });
});

test("reviseLoop: an explicit retestSuite is retested with no earlier suite step", async () => {
  await withRun([1], [false, true], async ({ run, ran }) => {
    const state = steps.makeState("do it", {}, null);
    await steps.reviseLoop({ max: 2, retestSuite: "test" })(run, state);
    assert.equal(ran.at(-1), "retest");
    assert.equal(state.accepted, false);
    assert.equal(state.verifiedSuite, "test");
  });
});

test("reviseLoop: only an explicit retestSuite widens requiredSuites and the phase label", () => {
  assert.deepEqual(steps.reviseLoop().requiredSuites, []);
  assert.doesNotMatch(steps.reviseLoop().label!, /retest/);
  assert.deepEqual(steps.reviseLoop({ retestSuite: "smoke" }).requiredSuites, ["smoke"]);
  assert.match(steps.reviseLoop({ retestSuite: "smoke" }).label!, /code\(retest\)$/);
});
