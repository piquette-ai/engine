/**
 * Repo-local chains (`.piquette/chains/*.yaml`) — the loader's contract.
 *
 * Two things are under test here, and they pull in opposite directions:
 *
 *  1. A yaml chain must be INDISTINGUISHABLE from a hand-written one. It is
 *     built with the same `stepChain()` from the same step factories, so its
 *     derived `phases`/`requiredAgents`/`requiredSuites` must come out
 *     byte-identical to the equivalent built-in composition. If that ever
 *     stops being true, a repo chain has become a second run path — the
 *     thing `repo_chains.ts` exists to avoid.
 *  2. A BAD yaml file must never throw. `loadRepoChains()` runs at CLI
 *     startup for every command; one malformed file in a repo cannot be
 *     allowed to break `piquette sessions` or `piquette doctor`. Every failure mode
 *     below asserts `problems`, and asserts the loader RETURNED.
 *
 * Nothing here shells out to git: `RepoAnchor` is a plain data object, so
 * the tests construct one pointing at a temp directory rather than
 * initializing a repo to be discovered.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RepoAnchor } from "../core/paths.js";
import { loadRepoChains } from "../chains/repo_chains.js";
import {
  CHAINS,
  allChains,
  findChain,
  registerRepoChains,
  repoChainProblems,
  resolveRequiredAgents,
  resolveRequiredSuites,
  stepChain,
} from "../chains/index.js";
import * as steps from "../chains/steps.js";
import * as gates from "../core/gates.js";
import type { Run } from "../core/runner.js";

/** A temp `.piquette/chains/` holding the given files, plus the anchor pointing at it. */
function withChains(files: Record<string, string>): { anchor: RepoAnchor; dir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "piquette-repo-chains-"));
  const piquetteDir = path.join(root, ".piquette");
  const dir = path.join(piquetteDir, "chains");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return {
    anchor: { cwd: root, repo_root: root, piquette_dir: piquetteDir },
    dir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Load one file's worth of yaml and hand back whatever came out. */
function load(yaml: string, filename = "custom.yaml") {
  const { anchor, dir, cleanup } = withChains({ [filename]: yaml });
  try {
    return { ...loadRepoChains(anchor), file: path.join(dir, filename) };
  } finally {
    cleanup();
  }
}

// ── the happy path ───────────────────────────────────────────────────────

test("a two-step yaml chain derives exactly what the equivalent hand-written stepChain does", () => {
  const { chains, problems, file } = load(
    [
      "name: ship-it",
      "describe: our own build-test chain",
      "steps:",
      "  - step: request",
      "  - step: fixLoop",
      "    suite: test",
      "",
    ].join("\n"),
  );

  assert.deepEqual(problems, [], "a valid file must produce no problems");
  assert.equal(chains.length, 1);
  const loaded = chains[0];

  const handWritten = stepChain("ship-it", "our own build-test chain", [steps.request(), steps.fixLoop({ suite: "test" })]);

  assert.equal(loaded.name, handWritten.name);
  assert.equal(loaded.describe, handWritten.describe);
  assert.equal(loaded.phases, handWritten.phases, "derived phases must be byte-identical to the hand-written composition");
  assert.deepEqual(resolveRequiredAgents(loaded, {}), resolveRequiredAgents(handWritten, {}));
  assert.deepEqual(resolveRequiredSuites(loaded, {}), resolveRequiredSuites(handWritten, {}));
  assert.deepEqual(resolveRequiredSuites(loaded, { suite: "smoke" }), ["smoke"], "--suite still overrides, exactly as in a built-in");
  assert.equal(loaded.steps?.length, 2, "a repo chain is a plain steps list on the same runSteps driver");
  assert.equal(loaded.run, undefined, "a repo chain never gets the imperative escape hatch");
  assert.equal(loaded.source, file, "source is the absolute yaml path, for ChainContext.chain_source");
});

test("owner overrides are visible in the derived requiredAgents and phases — no second sync point", () => {
  const { chains, problems } = load(
    ["name: ours", "describe: plan with our own architect", "steps:", "  - step: request", "  - step: plan", "    owner: architect", ""].join("\n"),
  );

  assert.deepEqual(problems, []);
  const chain = chains[0];
  assert.deepEqual(resolveRequiredAgents(chain, {}), ["architect"], "the owner param must reach deriveRequiredAgents");
  assert.equal(chain.phases, "engineer(request) -> architect", "and the derived display string too");
});

test("extraGates adds a gate by name; the built-in gates stay in place (additive only)", () => {
  const { chains, problems } = load(
    ["name: strict-build", "describe: build with an extra gate", "steps:", "  - step: build", "    extraGates: [jsonParses, filesNonEmpty]", ""].join("\n"),
  );
  assert.deepEqual(problems, []);
  assert.equal(chains.length, 1, "a known gate name resolves through the allowlist");
  // There is no `gates:` param to assert the absence of a built-in gate with —
  // that is the point of the policy. The type-level guarantee is in
  // steps.ts (withExtraGates always prepends the built-ins).
});

// ── gate composition, driven directly (Amendment 1's actual invariant) ────
//
// The test above only proves the chain LOADS with a known gate name; its own
// comment concedes there is no `gates:` param to assert a built-in's absence
// with, and defers to "the type-level guarantee in steps.ts" — there isn't
// one. `withExtraGates` is a plain function; a future `gates: opts.gates ??
// builtIn` would pass every test above while silently making a built-in gate
// removable. These drive the step directly and inspect the actual
// `AgentCall` handed to `ph.call(...)`, which is where the built-in and any
// `extraGates` are actually composed.

function stateStub(): steps.ChainState {
  return {
    prompt: "do it",
    options: {},
    previous: null,
    quality: null,
    review: null,
    changeset: null,
    baseline: "",
    issue_id: null,
    accepted: true,
    reason: "",
  };
}

/** A stub `Run` whose `phase()` just runs the callback and records every `ph.call(...)`'s gates. */
function captureCalls(): { run: Run; calls: { phase: string; gates: unknown[] }[] } {
  const calls: { phase: string; gates: unknown[] }[] = [];
  const run = {
    phase: async (params: { name: string }, fn: (ph: unknown) => Promise<unknown>) => {
      const ph = {
        log: () => {},
        call: async (call: { gates?: unknown[] }) => {
          calls.push({ phase: params.name, gates: call.gates ?? [] });
          return { status: "success", summary: "", artifacts: [], approved: false, blocking: [], findings: [] };
        },
      };
      return fn(ph);
    },
  } as unknown as Run;
  return { run, calls };
}

test("build()'s built-in gate is always first, and extraGates is additive — driven directly, not just loaded", async () => {
  const { run, calls } = captureCalls();
  await steps.build({ extraGates: ["jsonParses"] })(run, stateStub());
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].gates, [gates.diffMatchesClaims, gates.jsonParses], "diffMatchesClaims must stay first and present; jsonParses is appended, not substituted");
});

test("plan()'s built-in gates stay in front of an added one", async () => {
  const { run, calls } = captureCalls();
  await steps.plan({ extraGates: ["jsonParses"] })(run, stateStub());
  assert.equal(calls.length, 1);
  // journeysCover (#159 ticket C) is a built-in too; it reports nothing unless `receipts:` is configured.
  assert.deepEqual(calls[0].gates, [gates.artifactsExist, gates.filesNonEmpty, gates.journeysCover, gates.jsonParses]);
});

test("reviseLoop()'s review phase keeps verdictConsistent as a built-in", async () => {
  const { run, calls } = captureCalls();
  await steps.reviseLoop({ max: 1 })(run, stateStub()); // max: 1 -> exactly one review, no revise
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].gates, [gates.artifactsExist, gates.verdictConsistent]);
});

test("reviseLoop()'s revise phase keeps diffMatchesClaims as a built-in — a different envelope, a different built-in", async () => {
  const { run, calls } = captureCalls();
  await steps.reviseLoop({ max: 2 })(run, stateStub()); // review never approves in this stub, so a revise must run
  const revise = calls.find((c) => c.phase.startsWith("revise_"));
  assert.ok(revise, "expected a revise phase to have run");
  assert.deepEqual(revise!.gates, [gates.diffMatchesClaims]);
});

test("fixLoop()'s fix phase keeps diffMatchesClaims as a built-in", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "piquette-fixloop-gates-"));
  try {
    const calls: { phase: string; gates: unknown[] }[] = [];
    const phases: { phase_id: string; seq: number }[] = [];
    const run = {
      cfg: {
        quality: {
          // Always fails (`node -e process.exit(1)`) so the loop is forced
          // into its fix phase — this test is about that phase's gates, not
          // about quality.ts's own command-running, which has its own tests.
          checks: [{ name: "test", area: "backend", operation: "typecheck", argv: ["node", "-e", "process.exit(1)"], timeout_seconds: 5 }],
          suites: { test: ["test"] },
        },
      },
      phases,
      context_handoff_dir: scratch,
      repo_root: scratch,
      console: { note: () => {} },
      tracer: { event: () => "evt" },
      adw_id: "test-adw",
      phase: async (params: { name: string }, fn: (ph: unknown) => Promise<unknown>) => {
        const phase = { phase_id: `p_${phases.length}`, seq: phases.length };
        phases.push(phase);
        const ph = {
          log: () => {},
          call: async (call: { gates?: unknown[] }) => {
            calls.push({ phase: params.name, gates: call.gates ?? [] });
            return { status: "success", summary: "", artifacts: [], changed_files: [] };
          },
        };
        return fn(ph);
      },
    } as unknown as Run;

    await steps.fixLoop({ suite: "test", max: 2 })(run, stateStub());
    const fix = calls.find((c) => c.phase === "fix_1");
    assert.ok(fix, "expected a fix_1 phase to have run — the stubbed suite always fails");
    assert.deepEqual(fix!.gates, [gates.diffMatchesClaims]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ── per-gate acceptance and retest (re-cut from #128) ──────────────────────

test("reviseLoop's retestSuite loads from yaml and derives the same phases and requiredSuites as the hand-written step", () => {
  const { chains, problems } = load(["name: ship-it-retest", "describe: revise then retest", "steps:", "  - step: reviseLoop", "    retestSuite: smoke", ""].join("\n"));
  assert.deepEqual(problems, [], "a valid file must produce no problems");
  const loaded = chains[0]!;
  const handWritten = stepChain("ship-it-retest", "revise then retest", [steps.reviseLoop({ retestSuite: "smoke" })]);
  assert.equal(loaded.phases, handWritten.phases);
  assert.deepEqual(resolveRequiredSuites(loaded, {}), ["smoke"]);
  assert.deepEqual(resolveRequiredSuites(loaded, {}), resolveRequiredSuites(handWritten, {}));
});

test("reviseLoop with no retestSuite loads clean and requires no suite: the verifiedSuite fallback is runtime-only", () => {
  const { chains, problems } = load(["name: ship-it-no-retest", "describe: revise, no suite", "steps:", "  - step: reviseLoop", ""].join("\n"));
  assert.deepEqual(problems, []);
  assert.deepEqual(resolveRequiredSuites(chains[0]!, {}), []);
});

test("an empty retestSuite is a load problem, not a silent no-retest", () => {
  const { chains, problems } = load(["name: bad-retest", "describe: x", "steps:", "  - step: reviseLoop", '    retestSuite: ""', ""].join("\n"));
  assert.equal(chains.length, 0);
  assert.equal(problems.length, 1);
  // The Suite validator's own message, not `unknown param "retestSuite"`
  // (which is what main reported before the key existed).
  assert.match(problems[0]!.message, /suite must name a suite from quality\.suites/);
  assert.doesNotMatch(problems[0]!.message, /unknown param/);
});

test("fixLoop(red) -> reviseLoop -> commit(onlyIfAccepted) loaded from yaml: no review, no commit, fixLoop's reason survives", async () => {
  const { chains, problems } = load(
    [
      "name: gauntlet",
      "describe: fix then revise then commit, onlyIfAccepted",
      "steps:",
      "  - step: fixLoop",
      "    suite: test",
      "    max: 1",
      "  - step: reviseLoop",
      "    max: 2",
      "  - step: commit",
      "    onlyIfAccepted: true",
      "",
    ].join("\n"),
  );
  assert.deepEqual(problems, []);
  const [fixStep, reviseStep, commitStep] = chains[0]!.steps!;

  const scratch = mkdtempSync(path.join(tmpdir(), "piquette-gauntlet-yaml-"));
  const state = stateStub();
  const ran: string[] = [];
  const phases: { phase_id: string; seq: number }[] = [];
  try {
    const run = {
      cfg: {
        quality: {
          checks: [{ name: "test", area: "backend", operation: "typecheck", argv: ["node", "-e", "process.exit(1)"], timeout_seconds: 5 }],
          suites: { test: ["test"] },
        },
      },
      phases,
      context_handoff_dir: scratch,
      repo_root: scratch,
      console: { note: async () => {} },
      tracer: { event: async () => "evt" },
      adw_id: "test-adw",
      phase: async (params: { name: string }, fn: (ph: unknown) => Promise<unknown>) => {
        ran.push(params.name);
        phases.push({ phase_id: `p_${phases.length}`, seq: phases.length });
        const ph = {
          phase_id: `p_${ran.length}`,
          log: async () => {},
          call: async () =>
            params.name.startsWith("review_")
              ? { status: "success", summary: "", artifacts: [], approved: true, blocking: [], findings: [] }
              : { status: "success", summary: "", artifacts: [], changed_files: [] },
        };
        return fn(ph);
      },
    } as unknown as Run;

    await fixStep!(run, state);
    const reason = state.reason;
    assert.match(reason, /suite still failed/);
    await reviseStep!(run, state);
    await commitStep!(run, state);

    assert.deepEqual(ran, ["test_1"], "the review is skipped and the commit never opens");
    assert.equal(state.accepted, false);
    assert.equal(state.reason, reason);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("no .piquette/ and no chains/ directory are both quietly empty, not errors", () => {
  const noPiquette: RepoAnchor = { cwd: "/nonexistent", repo_root: "/nonexistent", piquette_dir: null };
  assert.deepEqual(loadRepoChains(noPiquette), { chains: [], problems: [] });

  const root = mkdtempSync(path.join(tmpdir(), "piquette-repo-chains-"));
  try {
    mkdirSync(path.join(root, ".piquette"));
    const anchor: RepoAnchor = { cwd: root, repo_root: root, piquette_dir: path.join(root, ".piquette") };
    assert.deepEqual(loadRepoChains(anchor), { chains: [], problems: [] }, "a .piquette/ with no chains/ is the normal case");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── every failure is a problem, never a throw ────────────────────────────

test("an unknown step name is a problem naming the steps that do exist", () => {
  const { chains, problems, file } = load(["name: bad-step", "describe: nope", "steps:", "  - step: deploy", ""].join("\n"));
  assert.deepEqual(chains, []);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, file);
  assert.match(problems[0].message, /unknown step "deploy"/);
  assert.match(problems[0].message, /available steps: .*fixLoop/, "the message must list what can be used instead");
});

test("a param of the wrong type is a problem, not a runtime surprise", () => {
  const { chains, problems } = load(["name: bad-param", "describe: nope", "steps:", "  - step: build", "    retries: two", ""].join("\n"));
  assert.deepEqual(chains, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /steps\[0\] \(build\)/, "the message must point at which step in the list");
  assert.match(problems[0].message, /retries/);
});

test("an unknown param is rejected, never silently ignored", () => {
  const { chains, problems } = load(["name: typo", "describe: nope", "steps:", "  - step: build", "    retires: 2", ""].join("\n"));
  assert.deepEqual(chains, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /unknown param\(s\) "retires"/);
  assert.match(problems[0].message, /build accepts: .*retries/);
});

test("a description that only echoes the phase name is a problem — makePhaseParams' rule, enforced at load time", () => {
  const { chains, problems } = load(["name: echo", "describe: nope", "steps:", "  - step: plan", '    description: "plan"', ""].join("\n"));
  assert.deepEqual(chains, [], "the chain must not load");
  assert.equal(problems.length, 1, "and the throw from the factory must have become a problem");
  assert.match(problems[0].message, /steps\[0\] \(plan\)/);
  assert.match(problems[0].message, /restates the phase name/);
});

test("an unknown gate name is a problem listing the allowlist — testsPass is deliberately not on it", () => {
  const { chains, problems } = load(
    ["name: sneaky", "describe: nope", "steps:", "  - step: build", "    extraGates: [testsPass]", ""].join("\n"),
  );
  assert.deepEqual(chains, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /unknown gate/);
  assert.match(problems[0].message, /diffMatchesClaims/, "the message names the gates that ARE allowed");
});

test("verdictConsistent on build is rejected — that gate only means something on a review envelope", () => {
  const { chains, problems } = load(
    ["name: build-with-review-gate", "describe: nope", "steps:", "  - step: build", "    extraGates: [verdictConsistent]", ""].join("\n"),
  );
  assert.deepEqual(chains, [], "a per-step envelope mismatch must be a load problem, not a chain that is guaranteed to fail its gate on every run");
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /unknown gate/);
  assert.match(problems[0].message, /diffMatchesClaims/, "build's allowlist should still name the gate that DOES apply");
  assert.doesNotMatch(problems[0].message, /verdictConsistent/, "verdictConsistent must not be offered as an allowed alternative for build");
});

test("diffMatchesClaims on reviseLoop's review phase (extraGates) is rejected — verdictConsistent is the one that fits a ReviewOutput", () => {
  const { chains, problems } = load(
    ["name: review-with-build-gate", "describe: nope", "steps:", "  - step: reviseLoop", "    extraGates: [diffMatchesClaims]", ""].join("\n"),
  );
  assert.deepEqual(chains, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /unknown gate/);
  assert.match(problems[0].message, /verdictConsistent/);
});

test("retries above the bound is a problem — an unattended chain must not be able to loop unboundedly from a typo", () => {
  const { chains, problems } = load(["name: too-many-retries", "describe: nope", "steps:", "  - step: build", "    retries: 9999", ""].join("\n"));
  assert.deepEqual(chains, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /retries/);
  assert.match(problems[0].message, /raise this bound deliberately/);
});

test("max above the bound is a problem, for the same reason", () => {
  const { chains, problems } = load(["name: too-many-loops", "describe: nope", "steps:", "  - step: fixLoop", "    max: 100000", ""].join("\n"));
  assert.deepEqual(chains, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /max/);
  assert.match(problems[0].message, /raise this bound deliberately/);
});

test("a whitespace-only owner is rejected, not loaded as an invisible agent name", () => {
  const { chains, problems } = load(["name: blank-owner", "describe: nope", "steps:", "  - step: plan", '    owner: "   "', ""].join("\n"));
  assert.deepEqual(chains, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /owner/);
});

test("malformed YAML is a problem and the loader still returns", () => {
  const { chains, problems, file } = load("name: broken\ndescribe: [unclosed\nsteps:\n  - step: request\n");
  assert.deepEqual(chains, []);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, file);
  assert.match(problems[0].message, /not valid YAML/);
});

test("a missing/empty required field is a problem naming the field", () => {
  const noSteps = load(["name: thin", "describe: has no steps", "steps: []", ""].join("\n"));
  assert.deepEqual(noSteps.chains, []);
  assert.match(noSteps.problems[0].message, /at least one step/);

  const noName = load(["describe: nameless", "steps:", "  - step: request", ""].join("\n"));
  assert.deepEqual(noName.chains, []);
  assert.match(noName.problems[0].message, /name/);

  // A bare scalar/list document declared SOMETHING, just not a chain — "is
  // empty" still fits. An actually-empty document (below) does not: see the
  // next test.
  const notAnObject = load("just a string\n");
  assert.deepEqual(notAnObject.chains, []);
  assert.match(notAnObject.problems[0].message, /is empty/);
});

test("a document that parses to null (blank, or fully commented out) declares no chain — skipped silently, not a problem", () => {
  // This is exactly what `piquette init`'s scaffolded, not-yet-uncommented
  // example.yaml looks like: every line a `#` comment, so `parseYaml`
  // returns `undefined`. It must never be reported as a broken chain file —
  // that would put a red `piquette doctor` line and a `piquette list` warning into
  // every freshly-initialized repo, caused solely by piquette's own scaffold.
  const blank = load("\n");
  assert.deepEqual(blank.chains, [], "a blank file is the absence of a chain, not a malformed one");
  assert.deepEqual(blank.problems, []);

  const allComments = load(["# name: example", "# describe: not registered", "# steps:", "#   - step: request", ""].join("\n"));
  assert.deepEqual(allComments.chains, []);
  assert.deepEqual(allComments.problems, []);
});

test("a name that is not command-line safe is a problem", () => {
  const { chains, problems } = load(["name: My Chain", "describe: spaces", "steps:", "  - step: request", ""].join("\n"));
  assert.deepEqual(chains, []);
  assert.match(problems[0].message, /name/);
});

// ── collisions are problems, never shadows ───────────────────────────────

test("a repo chain may not take a built-in's name", () => {
  const { chains, problems } = load(["name: plan-build", "describe: our version", "steps:", "  - step: request", ""].join("\n"));
  assert.deepEqual(chains, [], "shadowing a built-in must not load");
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /built-in chain/);
});

test("a repo chain may not take an piquette subcommand's name", () => {
  const { chains, problems } = load(["name: watch", "describe: not reachable as `piquette watch`", "steps:", "  - step: request", ""].join("\n"));
  assert.deepEqual(chains, []);
  assert.match(problems[0].message, /subcommand/);
});

test("two files claiming one name: the first (sorted) wins and the second is a problem", () => {
  const yaml = (describe: string) => ["name: dup", `describe: ${describe}`, "steps:", "  - step: request", ""].join("\n");
  const { anchor, cleanup } = withChains({ "a-first.yaml": yaml("first"), "b-second.yaml": yaml("second") });
  try {
    const { chains, problems } = loadRepoChains(anchor);
    assert.equal(chains.length, 1, "exactly one definition may answer to a name");
    assert.equal(chains[0].describe, "first", "load order is sorted by filename, so a collision reproduces identically everywhere");
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /already defined by a-first\.yaml/);
  } finally {
    cleanup();
  }
});

test("one broken file does not stop the others from loading", () => {
  const { anchor, cleanup } = withChains({
    "good.yaml": ["name: good-one", "describe: fine", "steps:", "  - step: request", ""].join("\n"),
    "bad.yaml": ["name: bad-one", "describe: fine", "steps:", "  - step: nope", ""].join("\n"),
  });
  try {
    const { chains, problems } = loadRepoChains(anchor);
    assert.deepEqual(
      chains.map((c) => c.name),
      ["good-one"],
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0].file, /bad\.yaml$/);
  } finally {
    cleanup();
  }
});

// ── the registry: two tiers, built-ins untouchable ───────────────────────

test("registerRepoChains never mutates CHAINS — built-ins stay built-in-only", () => {
  const builtInNames = CHAINS.map((c) => c.name);
  const extra = stepChain("registry-probe", "a repo chain", [steps.request()]);

  registerRepoChains([extra], [{ file: "/tmp/x.yaml", message: "boom" }]);
  try {
    assert.deepEqual(CHAINS.map((c) => c.name), builtInNames, "CHAINS is the immutable built-in-only const");
    assert.equal(
      allChains().length,
      CHAINS.length + 1,
      "allChains() is the merged view: built-ins first, then repo chains",
    );
    assert.deepEqual(allChains().slice(0, CHAINS.length).map((c) => c.name), builtInNames, "built-ins come first");
    assert.equal(allChains()[CHAINS.length].name, "registry-probe");
    assert.equal(findChain("registry-probe")?.name, "registry-probe", "findChain consults repo chains after built-ins");
    assert.deepEqual(repoChainProblems(), [{ file: "/tmp/x.yaml", message: "boom" }]);
  } finally {
    registerRepoChains([], []);
  }
});

test("registerRepoChains is idempotent — a second call replaces, it never duplicates", () => {
  const extra = stepChain("registry-probe", "a repo chain", [steps.request()]);
  const problem = { file: "/tmp/x.yaml", message: "boom" };

  registerRepoChains([extra], [problem]);
  registerRepoChains([extra], [problem]);
  try {
    assert.equal(allChains().filter((c) => c.name === "registry-probe").length, 1, "re-registering the same chain must not double it");
    assert.equal(repoChainProblems().length, 1, "nor its problems");

    // A second, different registration REPLACES: a stale definition left
    // behind would keep running after the yaml that defined it was deleted.
    registerRepoChains([stepChain("other-probe", "another", [steps.request()])], []);
    assert.equal(findChain("registry-probe"), undefined, "the previous registration is gone, not merged");
    assert.equal(findChain("other-probe")?.name, "other-probe");
    assert.deepEqual(repoChainProblems(), []);
  } finally {
    registerRepoChains([], []);
  }
});

test("a built-in name always resolves to the built-in, even if a repo chain is registered under it", () => {
  // loadRepoChains() refuses this file, so it takes a hand-built definition
  // to reach findChain's own ordering — the second line of defence.
  const impostor = stepChain("plan-build", "not the real one", [steps.request()]);
  registerRepoChains([impostor], []);
  try {
    assert.equal(findChain("plan-build")?.describe, CHAINS.find((c) => c.name === "plan-build")!.describe);
  } finally {
    registerRepoChains([], []);
  }
});
