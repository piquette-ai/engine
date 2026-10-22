import "./hermetic_git.ts";

/**
 * `route_when` — the router-facing "when to pick this chain" text (#150
 * follow-up; operator docs in `docs/decisions.md` under "`chain_router`").
 *
 * Layers, none touching the network (FakeDecisionClient) or a real agent:
 *  1. the schema/loader: a repo chain file's optional `route_when` and the
 *     `watch.route_when` config map;
 *  2. the built-ins: every routable one has one, three of them verbatim;
 *  3. precedence (config > chain > describe) and how the router words its
 *     options (what the decision model actually sees, as `criteria`);
 *  4. `spf doctor`'s missing/unknown warnings, `spf watch`'s unknown-name
 *     helper, and invariant 1 (no `decisions:` block => the router is never
 *     called, whatever route_when says).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import type { RepoAnchor } from "../core/paths.js";
import * as paths from "../core/paths.js";
import * as agents from "../core/agents.js";
import { loadRepoChains, RepoChainFileSchema } from "../chains/repo_chains.js";
import { CHAINS, findChain, registerRepoChains, type ChainDefinition } from "../chains/index.js";
import { chainRouteOptions, chainRouteReplay, resolveRouteWhen, routeChain, type RoutableChain } from "../core/chain_router.js";
import { createDecider } from "../core/decisions.js";
import { MAX_ROUTE_WHEN_CHARS, RouteWhenSchema, WatchConfigSchema, type SFConfig } from "../core/data_types.js";
import { makeWatchChainRouter, routableChain, unknownRouteWhenChains } from "../cli/commands/watch.js";
import { doctorCommand } from "../cli/commands/doctor.js";
import { FakeDecisionClient } from "./fake_decisions.js";

function withTmpSync<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-route-when-test-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTmp(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-route-when-test-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function loadRepoChain(yaml: string) {
  return withTmpSync((root) => {
    const spfDir = path.join(root, ".spf");
    mkdirSync(path.join(spfDir, "chains"), { recursive: true });
    writeFileSync(path.join(spfDir, "chains", "custom.yaml"), yaml);
    const anchor: RepoAnchor = { cwd: root, repo_root: root, spf_dir: spfDir };
    return loadRepoChains(anchor);
  });
}

const CHAIN_YAML = (extra: string): string => ["name: ship-it", "describe: our own build-test chain", extra, "steps:", "  - step: request", "  - step: fixLoop", "    suite: test", ""].join("\n");

// ── 1. schema / loader ─────────────────────────────────────────────────────

test("repo chain file: route_when is optional, trimmed, and carried onto the ChainDefinition", () => {
  const without = loadRepoChain(CHAIN_YAML(""));
  assert.deepEqual(without.problems, []);
  assert.equal(without.chains[0]!.route_when, undefined);
  assert.equal("route_when" in without.chains[0]!, false, "no key at all when the file has none");

  const withIt = loadRepoChain(CHAIN_YAML("route_when:   Use for small fixes with an existing suite.   "));
  assert.deepEqual(withIt.problems, []);
  assert.equal(withIt.chains[0]!.route_when, "Use for small fixes with an existing suite.");
  assert.equal(withIt.chains[0]!.describe, "our own build-test chain", "describe is untouched");
});

test("repo chain file: an empty, whitespace-only, over-long or non-string route_when is a load problem naming the file; the file never throws", () => {
  for (const extra of ['route_when: ""', 'route_when: "   "', `route_when: ${"x".repeat(MAX_ROUTE_WHEN_CHARS + 1)}`, "route_when: 7", "route_when: [a, b]"]) {
    const { chains, problems } = loadRepoChain(CHAIN_YAML(extra));
    assert.equal(chains.length, 0, `expected rejection for: ${extra.slice(0, 40)}`);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.message, /route_when/);
  }
  // exactly at the cap is fine
  assert.deepEqual(loadRepoChain(CHAIN_YAML(`route_when: ${"x".repeat(MAX_ROUTE_WHEN_CHARS)}`)).problems, []);
  // the file schema is still strict about every other key
  assert.equal(v.safeParse(RepoChainFileSchema, { name: "a", describe: "b", routewhen: "c", steps: [{ step: "request" }] }).success, false);
});

test("RouteWhenSchema: trims, requires non-empty, caps at 500", () => {
  assert.equal(v.parse(RouteWhenSchema, "  hi  "), "hi");
  assert.equal(v.safeParse(RouteWhenSchema, "").success, false);
  assert.equal(v.safeParse(RouteWhenSchema, "  \n ").success, false);
  assert.equal(v.safeParse(RouteWhenSchema, "x".repeat(501)).success, false);
  assert.equal(MAX_ROUTE_WHEN_CHARS, 500);
});

test("WatchConfigSchema: route_when defaults to {} and accepts/rejects like the chain field", () => {
  assert.deepEqual(v.parse(WatchConfigSchema, {}).route_when, {});
  assert.deepEqual(v.parse(WatchConfigSchema, { route_when: { "plan-build": "  Use for copy. " } }).route_when, { "plan-build": "Use for copy." });
  assert.equal(v.safeParse(WatchConfigSchema, { route_when: { "plan-build": "" } }).success, false);
  assert.equal(v.safeParse(WatchConfigSchema, { route_when: { "plan-build": "x".repeat(501) } }).success, false);
  assert.equal(v.safeParse(WatchConfigSchema, { route_when: { "plan-build": 3 } }).success, false);
});

test("watch.route_when survives loadConfig and is a WHOLE-MAP replace across layers (mergeRawConfig spreads watch whole)", () => {
  withTmpSync((dir) => {
    const base = path.join(dir, "base.yaml");
    const override = path.join(dir, "override.yaml");
    writeFileSync(base, "watch:\n  route_when:\n    plan-build: base one\n    build-review: base two\n");
    writeFileSync(override, "watch:\n  route_when:\n    plan-build: override one\n");
    assert.deepEqual(agents.loadConfig([base]).watch.route_when, { "plan-build": "base one", "build-review": "base two" });
    assert.deepEqual(agents.loadConfig([base, override]).watch.route_when, { "plan-build": "override one" }, "the base's build-review entry does not survive alongside the override's map");
    // an override that does not mention route_when leaves the base's map alone
    const plain = path.join(dir, "plain.yaml");
    writeFileSync(plain, "watch:\n  chain: plan-build\n");
    assert.deepEqual(agents.loadConfig([base, plain]).watch.route_when, { "plan-build": "base one", "build-review": "base two" });
  });
});

test("watch.route_when: an invalid entry is a config error, not a silent drop", () => {
  withTmpSync((dir) => {
    const bad = path.join(dir, "bad.yaml");
    writeFileSync(bad, 'watch:\n  route_when:\n    plan-build: ""\n');
    assert.throws(() => agents.loadConfig([bad]), /route_when/);
  });
});

// ── 2. built-ins ───────────────────────────────────────────────────────────

test("built-ins: every chain but refine has a valid route_when; the three tested ones are verbatim", () => {
  for (const chain of CHAINS) {
    if (chain.name === "refine") {
      assert.equal(chain.route_when, undefined, "refine is the spec-ready lane's chain, never a routing target");
      continue;
    }
    assert.ok(chain.route_when, `${chain.name} needs a route_when`);
    assert.equal(v.safeParse(RouteWhenSchema, chain.route_when).success, true, `${chain.name}'s route_when must satisfy RouteWhenSchema`);
    assert.equal(chain.route_when, chain.route_when!.trim());
    assert.notEqual(chain.route_when, chain.describe, `${chain.name}: route_when must say WHEN, not repeat describe`);
  }
  assert.equal(findChain("plan-build")!.route_when, "Use for trivial, low-risk changes with no logic to test: copy or label text, docs, comments, config values, renames. Not for anything that changes behavior.");
  assert.equal(findChain("plan-build-test")!.route_when, "Use for ordinary feature or bug-fix work that changes behavior and should be covered by the test suite.");
  assert.equal(findChain("build-review")!.route_when, "Use when the issue asks for an independent review, or the change touches security, auth, sessions or permissions where a second pair of eyes matters more than tests.");
  const texts = CHAINS.map((c) => c.route_when).filter((t): t is string => t !== undefined);
  assert.equal(new Set(texts).size, texts.length, "mutually distinguishing: no two chains share a route_when");
});

// ── 3. precedence and the router's option text ─────────────────────────────

test("resolveRouteWhen: watch.route_when[name] > the chain's own > undefined; blanks count as absent; inherited keys are ignored", () => {
  const chain = { name: "plan-build", route_when: "from the chain" };
  assert.equal(resolveRouteWhen(chain, { "plan-build": "from config" }), "from config");
  assert.equal(resolveRouteWhen(chain, { "other-chain": "x" }), "from the chain");
  assert.equal(resolveRouteWhen(chain), "from the chain");
  assert.equal(resolveRouteWhen({ name: "plan-build" }, {}), undefined);
  assert.equal(resolveRouteWhen(chain, { "plan-build": "   " }), "from the chain");
  assert.equal(resolveRouteWhen({ name: "constructor" }, {}), undefined, "Object.prototype members are not overrides");
  assert.equal(resolveRouteWhen({ name: "toString", route_when: "own" }, {}), "own");
});

test("routableChain: config override > chain's route_when > absent (the router then uses describe)", () => {
  const def = findChain("plan-build")!;
  assert.equal(routableChain(def).route_when, def.route_when);
  assert.equal(routableChain(def, { "plan-build": "operator wording" }).route_when, "operator wording");
  assert.equal(routableChain(def, { "build-review": "somebody else's" }).route_when, def.route_when);
  const bare: ChainDefinition = { ...def, route_when: undefined };
  assert.equal("route_when" in routableChain(bare), false);
  assert.equal(routableChain(bare, { "plan-build": "operator wording" }).route_when, "operator wording");
  // describe/phases/commits are untouched
  assert.equal(routableChain(def).describe, def.describe);
  assert.equal(routableChain(def).commits, true);
});

const WITH: RoutableChain = { name: "plan-build", describe: "small work", route_when: "Use for label renames.", phases: "plan -> build -> git(commit)", commits: true };
const WITHOUT: RoutableChain = { name: "plan-build-test", describe: "the standard chain", phases: "plan -> build -> test", commits: true };

test("chainRouteOptions: description is route_when, else describe, then (phases: ...)", () => {
  assert.deepEqual(chainRouteOptions([WITH, WITHOUT]), [
    { value: "plan-build", description: "Use for label renames. (phases: plan -> build -> git(commit))" },
    { value: "plan-build-test", description: "the standard chain (phases: plan -> build -> test)" },
  ]);
});

test("routeChain: the decision model sees route_when (not describe) in the option criteria, and the instructions say descriptions state when to use a chain", async () => {
  const fake = FakeDecisionClient.choosing("plan-build", 0.9);
  const decider = createDecider({ config: { enabled: true, mode: "act" }, client: fake });
  await routeChain(decider, { fallback: WITHOUT, allowlist: [WITH], requireCommit: false, issue: { id: "7", title: "Rename a label", body: "x" } });
  const question = fake.calls[0]!.questions["q0"]!;
  assert.equal(question.type, "choice");
  const criteria = (question.type === "choice" ? question.criteria : {}) as Record<string, string>;
  assert.match(criteria["plan-build"]!, /^Use for label renames\. \(phases:/);
  assert.doesNotMatch(criteria["plan-build"]!, /small work/);
  assert.match(criteria["plan-build-test"]!, /^the standard chain \(phases:/);
  assert.match(question.instructions, /description says when to use it/);
  assert.match(question.instructions, /Prefer state\.default_chain/, "default-chain fallback semantics are unchanged");
});

test("chainRouteReplay: a changed route_when does NOT invalidate a recorded route for the same menu (descriptions are not recorded)", async () => {
  const live = createDecider({ config: { enabled: true, mode: "act" }, client: FakeDecisionClient.choosing("plan-build", 0.9) });
  const input = { fallback: WITHOUT, allowlist: [WITH], requireCommit: false, issue: { id: "7", title: "t", body: "b" } };
  const first = await routeChain(live, input);
  const reworded = { ...input, allowlist: [{ ...WITH, route_when: "Completely different wording." }] };
  assert.equal(chainRouteReplay(first.decision, reworded), first.decision, "same names in the same order -> still the recorded answer");
  // ...while a changed menu still asks live
  assert.equal(chainRouteReplay(first.decision, { ...input, allowlist: [] }), undefined);
});

// ── 4. watch / doctor / invariant 1 ────────────────────────────────────────

function loadCfg(dir: string, yaml: string): SFConfig {
  const configPath = path.join(dir, "spf.config.yaml");
  writeFileSync(configPath, yaml);
  return agents.loadConfig([configPath]);
}

function dataPathsFor(dir: string, cfg: SFConfig): paths.DataPaths {
  return paths.resolveDataPaths(paths.resolveAnchor(dir), cfg.defaults.data_dir, cfg.observability.db);
}

const ISSUE_42 = { id: "42", title: "Rename the Save label", body: "Save -> Store", labels: [] };

test("makeWatchChainRouter: the options the decision model sees use watch.route_when over the chain's text over describe", async () => {
  await withTmp(async (dir) => {
    const cfg = loadCfg(
      dir,
      [
        "watch:",
        "  repo: acme/widgets",
        "  chain: plan-build-test",
        "  chains: [plan-build, scout]",
        "  route_when:",
        "    plan-build: Operator says use this for copy only.",
        "decisions:",
        "  enabled: true",
        "  mode: shadow",
        "",
      ].join("\n"),
    );
    const fake = FakeDecisionClient.choosing("plan-build", 0.9);
    const router = makeWatchChainRouter(cfg, dataPathsFor(dir, cfg), () => {}, { client: fake })!;
    const route = await router(ISSUE_42, { adwId: "issue-42", requireCommit: false });
    assert.equal(route.chain, "plan-build-test", "shadow: the configured chain still acts");
    const question = fake.calls[0]!.questions["q0"]!;
    const criteria = (question.type === "choice" ? question.criteria : {}) as Record<string, string>;
    assert.match(criteria["plan-build"]!, /^Operator says use this for copy only\. \(phases:/);
    assert.ok(criteria["plan-build-test"]!.startsWith(findChain("plan-build-test")!.route_when!), "the chain's own route_when when no override");
    assert.ok(criteria["scout"]!.startsWith(findChain("scout")!.route_when!));
  });
});

test("invariant 1: watch.route_when and watch.chains but NO decisions: block -> the router never calls the decision model", async () => {
  await withTmp(async (dir) => {
    const cfg = loadCfg(dir, "watch:\n  repo: acme/widgets\n  chain: plan-build-test\n  chains: [plan-build]\n  route_when:\n    plan-build: anything\n");
    const fake = FakeDecisionClient.choosing("plan-build", 0.99);
    const router = makeWatchChainRouter(cfg, dataPathsFor(dir, cfg), () => {}, { client: fake })!;
    const route = await router(ISSUE_42, { adwId: "issue-42", requireCommit: false });
    assert.deepEqual(route, { chain: "plan-build-test", note: null });
    assert.equal(fake.calls.length, 0);
  });
});

test("unknownRouteWhenChains: names every watch.route_when key findChain cannot resolve, in config order", async () => {
  await withTmp(async (dir) => {
    const cfg = loadCfg(dir, "watch:\n  route_when:\n    plan-build: ok\n    no-such-chain: nope\n    also-missing: nope\n");
    assert.deepEqual(unknownRouteWhenChains(cfg), ["no-such-chain", "also-missing"]);
    assert.deepEqual(unknownRouteWhenChains(loadCfg(dir, "watch:\n  chain: plan-build\n")), []);
  });
});

interface DoctorReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string; severity?: "info" | "warn" }>;
}

async function runDoctor(dir: string, yaml: string, chainFiles: Record<string, string> = {}): Promise<DoctorReport> {
  mkdirSync(path.join(dir, ".spf", "chains"), { recursive: true });
  writeFileSync(path.join(dir, ".spf", "spf.config.yaml"), yaml);
  for (const [name, content] of Object.entries(chainFiles)) writeFileSync(path.join(dir, ".spf", "chains", name), content);
  // `cli/index.ts` registers `.spf/chains/` at startup; doctorCommand does not,
  // so do what the entry point does, and put the registry back afterwards.
  const loaded = loadRepoChains(paths.resolveAnchor(dir));
  registerRepoChains(loaded.chains, loaded.problems);
  const logs: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = () => {};
  console.warn = () => {};
  try {
    await doctorCommand(["--cwd", dir, "--json", "--no-probe"]);
  } finally {
    Object.assign(console, original);
    registerRepoChains([], []);
  }
  return JSON.parse(logs.join("\n")) as DoctorReport;
}

const missingWarnings = (report: DoctorReport) => report.checks.filter((c) => c.name.startsWith("chain router route_when"));

test("doctor: with the router live and a >=2 chain menu, warns once per menu chain that has no route_when (a repo chain without one); warnings never fail doctor", async () => {
  await withTmp(async (dir) => {
    const report = await runDoctor(
      dir,
      "watch:\n  repo: acme/widgets\n  chain: plan-build-test\n  chains: [plan-build, mine]\ndecisions:\n  enabled: true\n  mode: shadow\n",
      { "mine.yaml": ["name: mine", "describe: my own chain", "steps:", "  - step: request", "  - step: plan", ""].join("\n") },
    );
    const warns = missingWarnings(report);
    assert.deepEqual(warns.map((w) => w.name), ['chain router route_when "mine"']);
    assert.equal(warns[0]!.severity, "warn");
    assert.equal(warns[0]!.ok, true, "a warn is ok:true — it never flips report.ok by itself");
    assert.match(warns[0]!.detail, /falls back to its describe line/);
    assert.match(warns[0]!.detail, /\.spf[\\/]chains[\\/]mine\.yaml/);
    assert.match(warns[0]!.detail, /watch\.route_when/);
  });
});

test("doctor: watch.route_when satisfies the warning; a chain's own route_when does too", async () => {
  await withTmp(async (dir) => {
    const report = await runDoctor(
      dir,
      "watch:\n  repo: acme/widgets\n  chain: plan-build-test\n  chains: [mine, other]\n  route_when:\n    mine: Operator wording for mine.\ndecisions:\n  enabled: true\n  mode: act\n",
      {
        "mine.yaml": ["name: mine", "describe: my own chain", "steps:", "  - step: request", "  - step: plan", ""].join("\n"),
        "other.yaml": ["name: other", "describe: another", "route_when: Use for other things.", "steps:", "  - step: request", "  - step: plan", ""].join("\n"),
      },
    );
    assert.deepEqual(missingWarnings(report), []);
  });
});

test("doctor: no missing-route_when warnings when decisions are off, chain_router is off, or the menu has fewer than two chains", async () => {
  await withTmp(async (dir) => {
    const mine = { "mine.yaml": ["name: mine", "describe: my own chain", "steps:", "  - step: request", "  - step: plan", ""].join("\n") };
    // decisions off (the default)
    assert.deepEqual(missingWarnings(await runDoctor(dir, "watch:\n  repo: acme/widgets\n  chain: mine\n  chains: [scout]\n", mine)), []);
    // chain_router kind off
    assert.deepEqual(
      missingWarnings(await runDoctor(dir, "watch:\n  repo: acme/widgets\n  chain: mine\n  chains: [scout]\ndecisions:\n  enabled: true\n  kinds:\n    chain_router:\n      mode: off\n", mine)),
      [],
    );
    // a menu of one (watch.chain only; no watch.chains)
    assert.deepEqual(missingWarnings(await runDoctor(dir, "watch:\n  repo: acme/widgets\n  chain: mine\ndecisions:\n  enabled: true\n  mode: shadow\n", mine)), []);
    // best-of-N filters non-commit chains out of the menu: [plan-build-test, scout] is one chain under n: 2
    assert.deepEqual(
      missingWarnings(await runDoctor(dir, "watch:\n  repo: acme/widgets\n  chain: plan-build-test\n  chains: [mine]\n  fanout:\n    n: 2\ndecisions:\n  enabled: true\n  mode: shadow\n", mine)),
      [],
      "mine has no commit step, so under best-of-N the menu is one chain and the router would not ask",
    );
  });
});

test("doctor: a watch.route_when key naming no registered chain warns (and does not fail), with or without routing configured", async () => {
  await withTmp(async (dir) => {
    const report = await runDoctor(dir, "watch:\n  repo: acme/widgets\n  chain: plan-build-test\n  route_when:\n    plan-build: fine\n    no-such-chain: typo\n");
    const c = report.checks.find((x) => x.name === "watch.route_when");
    assert.ok(c);
    assert.equal(c!.severity, "warn");
    assert.equal(c!.ok, true);
    assert.match(c!.detail, /"no-such-chain"/);
    assert.doesNotMatch(c!.detail, /"plan-build"/);
    const clean = await runDoctor(dir, "watch:\n  repo: acme/widgets\n  chain: plan-build-test\n  route_when:\n    plan-build: fine\n");
    assert.equal(clean.checks.some((x) => x.name === "watch.route_when"), false);
  });
});
