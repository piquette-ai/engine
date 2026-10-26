import "./hermetic_git.ts";

/**
 * Review-accountability thread: an AI reviewer's `approved` flag is a
 * PROPOSAL; `decideSignoff` (chains/simple_sdlc.ts) is where a human DISPOSES
 * of it. These tests drive that function directly — running the whole
 * imperative `simple-sdlc` chain (real agents, a real config, a real
 * session) is far too heavy just to exercise one decision — plus the
 * lighter-weight pieces it depends on: `commitEnvelope`'s trailer handling
 * (chains/steps.ts) and `committerIdentity` (core/git_helper.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AI_ONLY_SIGNOFF_WARNING, decideSignoff, trailerFor } from "../chains/simple_sdlc.ts";
import { commitEnvelope, startRun } from "../chains/steps.ts";
import { committerIdentity, makeGit } from "../core/git_helper.ts";
import { stagingSnapshot } from "../core/permissions.ts";
import { loadOrRecordBaselineTree } from "../core/runner.ts";
import { excludePiquetteDataFromGit } from "../core/worktree_data.ts";
import type { Asker, SelectChoice } from "../cli/ask.ts";
import type { ReviewOutputT } from "../core/data_types.ts";
import type { PhaseHandle, Run } from "../core/runner.ts";

/** A minimal, schema-shaped ReviewOutputT — only the fields decideSignoff reads. */
function reviewOutput(overrides: Partial<ReviewOutputT> = {}): ReviewOutputT {
  return {
    status: "success",
    summary: "",
    artifacts: [],
    notes_for_next_agent: "",
    approved: false,
    findings: [],
    blocking: [],
    ...overrides,
  };
}

/** Records every `confirm()` call — label, the default it was offered, and any timeout — then answers `answer` every time. */
function scriptedAsker(answer: boolean): {
  asker: Asker;
  calls: Array<{ label: string; dflt: boolean; timeoutMs?: number }>;
} {
  const calls: Array<{ label: string; dflt: boolean; timeoutMs?: number }> = [];
  const asker: Asker = {
    async text(_label, opts) {
      return opts?.default ?? "";
    },
    async select<T extends string>(_label: string, _choices: SelectChoice<T>[], dflt: T): Promise<T> {
      return dflt;
    },
    async confirm(label, dflt, opts) {
      calls.push({ label, dflt, timeoutMs: opts?.timeoutMs });
      return answer;
    },
    async secret() {
      return "";
    },
    note() {},
    heading() {},
    close() {},
  };
  return { asker, calls };
}

// ── decideSignoff ────────────────────────────────────────────────────────

test("decideSignoff: human yes -> accepted, recordedYes true, decision logged against the findings", async () => {
  const { asker, calls } = scriptedAsker(true);
  const logs: Record<string, unknown>[] = [];
  const outcome = await decideSignoff({
    review: reviewOutput({ approved: true, blocking: [], findings: [{ requirement: "does X", met: true, evidence: "src/x.ts" }] }),
    canPrompt: true,
    requireHumanSignoff: false,
    signoffTimeoutSeconds: 300,
    asker,
    identity: { name: "Ada Lovelace", email: "ada@example.com" },
    log: async (p) => { logs.push(p); },
    warn: () => {},
  });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.recordedYes, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dflt, false, "the prompt's own default must be false, never review.approved (no auto-approval bias)");
  assert.equal(calls[0].timeoutMs, 300_000, "signoffTimeoutSeconds must reach confirm() as milliseconds");
  assert.ok(logs.some((l) => l.decision === "approved" && l.human === true && Array.isArray(l.findings)), "the decision, engineer identity, and findings basis must land in the trace via ph.log");
});

test("decideSignoff: human no -> not accepted, never a recorded yes", async () => {
  const { asker } = scriptedAsker(false);
  const logs: Record<string, unknown>[] = [];
  const outcome = await decideSignoff({
    review: reviewOutput({ approved: true, blocking: ["still missing a test"] }),
    canPrompt: true,
    requireHumanSignoff: false,
    signoffTimeoutSeconds: 300,
    asker,
    identity: { name: "Ada Lovelace", email: "ada@example.com" },
    log: async (p) => { logs.push(p); },
    warn: () => {},
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.recordedYes, false);
  assert.ok(logs.some((l) => l.decision === "declined"));
});

test("decideSignoff: an expired prompt resolves to confirm()'s own default (false) -> not accepted, not a recorded yes", async () => {
  // cli/ask.ts's real confirm() collapses an expired timer into `dflt` — a
  // fake whose confirm mimics that exact collapse is the faithful stand-in
  // for "the timeout fired" without actually waiting out a real clock here.
  const asker: Asker = {
    async text(_l, opts) {
      return opts?.default ?? "";
    },
    async select<T extends string>(_l: string, _c: SelectChoice<T>[], dflt: T): Promise<T> {
      return dflt;
    },
    async confirm(_label, dflt) {
      return dflt;
    },
    async secret() {
      return "";
    },
    note() {},
    heading() {},
    close() {},
  };
  const outcome = await decideSignoff({
    review: reviewOutput({ approved: true }),
    canPrompt: true,
    requireHumanSignoff: false,
    signoffTimeoutSeconds: 1,
    asker,
    identity: undefined,
    log: async () => {},
    warn: () => {},
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.recordedYes, false);
});

test("decideSignoff: unattended, require_human_signoff false -> proceeds on the AI verdict alone, with a loud warning printed and logged", async () => {
  const warns: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const outcome = await decideSignoff({
    review: reviewOutput({ approved: true }),
    canPrompt: false,
    requireHumanSignoff: false,
    signoffTimeoutSeconds: 300,
    asker: null,
    identity: undefined,
    log: async (p) => { logs.push(p); },
    warn: (l) => warns.push(l),
  });
  assert.equal(outcome.accepted, true, "review.approved alone gates the commit on this default-false, unattended path");
  assert.equal(outcome.recordedYes, false, "never a recorded human yes when nobody was asked");
  assert.ok(warns.some((w) => w.includes(AI_ONLY_SIGNOFF_WARNING)), "the warning must be loud (printed), not just traced");
  assert.ok(
    logs.some((l) => l.decision === "ai_only" && l.warning === AI_ONLY_SIGNOFF_WARNING),
    "the warning text itself must also land in the traced payload, not just stdout",
  );
});

test("decideSignoff: unattended, require_human_signoff true -> fails the phase closed instead of auto-approving", async () => {
  await assert.rejects(
    () =>
      decideSignoff({
        review: reviewOutput({ approved: true }),
        canPrompt: false,
        requireHumanSignoff: true,
        signoffTimeoutSeconds: 300,
        asker: null,
        identity: undefined,
        log: async () => {},
        warn: () => {},
      }),
    /unattended/,
  );
});

test("decideSignoff: no TTY behaves the same as unattended, even if ctx.unattended alone said otherwise — canPrompt is the conjunction", async () => {
  // This is `isInteractive() && !ctx.unattended` already folded down to a
  // single boolean by the caller (simple_sdlc.ts) — decideSignoff itself
  // just trusts `canPrompt`, so this pins that "false" here means the
  // AI-only/fail-closed branch regardless of which half made it false.
  await assert.rejects(
    () =>
      decideSignoff({
        review: reviewOutput({ approved: true }),
        canPrompt: false,
        requireHumanSignoff: true,
        signoffTimeoutSeconds: 300,
        asker: null,
        identity: undefined,
        log: async () => {},
        warn: () => {},
      }),
    /unattended/,
  );
});

test("decideSignoff: no git committer identity -> the decision is still logged; the trailer is the caller's problem to skip", async () => {
  const { asker } = scriptedAsker(true);
  const logs: Record<string, unknown>[] = [];
  const warns: string[] = [];
  const outcome = await decideSignoff({
    review: reviewOutput({ approved: true }),
    canPrompt: true,
    requireHumanSignoff: false,
    signoffTimeoutSeconds: 300,
    asker,
    identity: undefined,
    log: async (p) => { logs.push(p); },
    warn: (l) => warns.push(l),
  });
  assert.equal(outcome.recordedYes, true, "the human said yes — a missing identity affects the trailer, never the decision itself");
  assert.ok(logs.some((l) => typeof l.note === "string" && l.note.includes("without a git committer identity")));
});

// ── trailerFor: the join between decideSignoff and commitEnvelope ────────

test("trailerFor: the AI-only path's recordedYes:false reaches commitEnvelope as null, even when accepted is true and an identity exists", () => {
  // The exact join this test guards: a refactor that swapped `recordedYes`
  // for `accepted` (or `verified`) at the commit_build call site would keep
  // every other test in this suite green while minting trailers for
  // AI-only commits.
  const identity = { name: "Ada Lovelace", email: "ada@example.com" };
  assert.equal(trailerFor({ accepted: true, recordedYes: false }, identity), null);
});

test("trailerFor: a recorded human yes with an identity reaches commitEnvelope as that identity", () => {
  const identity = { name: "Ada Lovelace", email: "ada@example.com" };
  assert.deepEqual(trailerFor({ accepted: true, recordedYes: true }, identity), identity);
});

test("trailerFor: a recorded human yes with no git identity configured still yields null, not a fabricated one", () => {
  assert.equal(trailerFor({ accepted: true, recordedYes: true }, undefined), null);
});

// ── commitEnvelope's trailer ─────────────────────────────────────────────

/**
 * `isDirty`/`diffFiles` default to the "there is something to stage" shape
 * every existing test here assumes — a plain `commitAll` call, unaffected by
 * `commitEnvelope`'s already-committed short-circuit. Pass overrides to
 * exercise that short-circuit instead (see the "already committed by a
 * preceding phase" tests below).
 */
function fakeCommitRun(overrides: { isDirty?: () => boolean; diffFiles?: (base: string) => string[] } = {}): {
  run: Run;
  committed: string[];
} {
  const committed: string[] = [];
  const run = {
    adw_id: "abcd1234",
    cfg: { watch: { base_branch: "main" }, git: { protected_branches: ["main", "master"] } },
    git: {
      isRepo: () => true,
      currentBranch: () => "feature/x",
      commitAll: (message: string) => {
        committed.push(message);
        return "abc1234";
      },
      isDirty: overrides.isDirty ?? (() => true),
      diffFiles: overrides.diffFiles ?? (() => []),
      shortSha: () => "abc1234",
    },
  } as unknown as Run;
  return { run, committed };
}

function fakePh(): PhaseHandle {
  return {
    log: async () => {},
    call: async () => {
      throw new Error("not used by these tests");
    },
  } as unknown as PhaseHandle;
}

test("commitEnvelope: a recorded human sign-off appends a real Signed-off-by trailer", async () => {
  const { run, committed } = fakeCommitRun();
  await commitEnvelope(
    run,
    fakePh(),
    { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "", commit_message: "Implement the thing" },
    { name: "Ada Lovelace", email: "ada@example.com" },
  );
  assert.equal(committed.length, 1);
  assert.equal(committed[0], "Implement the thing\n\nSigned-off-by: Ada Lovelace <ada@example.com>");
});

test("commitEnvelope: no signoff argument -> no trailer, ever", async () => {
  const { run, committed } = fakeCommitRun();
  await commitEnvelope(run, fakePh(), {
    status: "success",
    summary: "did it",
    artifacts: [],
    notes_for_next_agent: "",
    commit_message: "Implement the thing",
  });
  assert.equal(committed[0], "Implement the thing");
  assert.doesNotMatch(committed[0], /Signed-off-by/);
});

test("commitEnvelope: an explicit null signoff (identity was unset) -> no trailer, same as omitted", async () => {
  const { run, committed } = fakeCommitRun();
  await commitEnvelope(
    run,
    fakePh(),
    { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "", commit_message: "Fixed it" },
    null,
  );
  assert.doesNotMatch(committed[0], /Signed-off-by/);
});

test("commitEnvelope: a lone conventional-commit subject is never mistaken for a trailer block", async () => {
  // Regression: `feat: add X` matches TRAILER_LINE's `Key: value` shape, but
  // a single paragraph is the SUBJECT, never an existing trailer block — the
  // trailer must land after a blank line, not glued onto the subject with no
  // separator (which git would not recognize as a trailer at all).
  const { run, committed } = fakeCommitRun();
  await commitEnvelope(
    run,
    fakePh(),
    { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "", commit_message: "feat: add the signoff gate" },
    { name: "Ada Lovelace", email: "ada@example.com" },
  );
  assert.equal(committed[0], "feat: add the signoff gate\n\nSigned-off-by: Ada Lovelace <ada@example.com>");
});

test("commitEnvelope: a real body ending in a Key: value block still joins rather than growing a blank-line-separated second block", async () => {
  const { run, committed } = fakeCommitRun();
  await commitEnvelope(
    run,
    fakePh(),
    { status: "success", summary: "", artifacts: [], notes_for_next_agent: "", commit_message: "wip\n\nNote: I did stuff" },
    { name: "Ada Lovelace", email: "ada@example.com" },
  );
  assert.equal(committed[0], "wip\n\nNote: I did stuff\nSigned-off-by: Ada Lovelace <ada@example.com>");
});

test("commitEnvelope: an agent-authored message that already carries this exact Signed-off-by line is not duplicated", async () => {
  const { run, committed } = fakeCommitRun();
  await commitEnvelope(
    run,
    fakePh(),
    {
      status: "success",
      summary: "",
      artifacts: [],
      notes_for_next_agent: "",
      commit_message: "feat: add the signoff gate\n\nSigned-off-by: Ada Lovelace <ada@example.com>",
    },
    { name: "Ada Lovelace", email: "ada@example.com" },
  );
  assert.equal(committed[0], "feat: add the signoff gate\n\nSigned-off-by: Ada Lovelace <ada@example.com>");
  assert.equal(committed[0].match(/Signed-off-by/g)?.length, 1);
});

test("commitEnvelope: joins an already-trailered message's block instead of starting a second one", async () => {
  const { run, committed } = fakeCommitRun();
  await commitEnvelope(
    run,
    fakePh(),
    {
      status: "success",
      summary: "",
      artifacts: [],
      notes_for_next_agent: "",
      commit_message: "Implement the thing\n\nCo-authored-by: Bot <bot@example.com>",
    },
    { name: "Ada Lovelace", email: "ada@example.com" },
  );
  assert.equal(committed[0], "Implement the thing\n\nCo-authored-by: Bot <bot@example.com>\nSigned-off-by: Ada Lovelace <ada@example.com>");
});

// ── commitEnvelope: already committed by a preceding phase (MOB-11/12/13 regression) ──

test("commitEnvelope: a clean tree with real commits already ahead of base is treated as done, not a failure", async () => {
  // Regression: a plan's own "Commit convention" instructed the builder to
  // `git commit` its own work directly. The working tree is clean by the
  // time this phase runs, but real, tested commits already sit ahead of
  // base — `commitAll`'s "nothing to commit" throw was wrongly turning
  // already-finished work into a chain failure.
  const { run, committed } = fakeCommitRun({
    isDirty: () => false,
    diffFiles: () => [".github/dependabot.yml"],
  });
  await commitEnvelope(run, fakePh(), {
    status: "success",
    summary: "did it",
    artifacts: [],
    notes_for_next_agent: "",
    commit_message: "Implement the thing",
  });
  assert.equal(committed.length, 0, "commitAll must not be called — nothing new to stage");
});

test("commitEnvelope: a clean tree with NO commits ahead of base still calls commitAll (genuine no-op, not silently swallowed)", async () => {
  const { run, committed } = fakeCommitRun({
    isDirty: () => false,
    diffFiles: () => [],
  });
  await commitEnvelope(run, fakePh(), {
    status: "success",
    summary: "did it",
    artifacts: [],
    notes_for_next_agent: "",
    commit_message: "Implement the thing",
  });
  assert.equal(committed.length, 1, "a genuinely empty change must still surface commitAll's own error, not be mistaken for already-committed work");
});

// ── commitEnvelope: explicit staging against the run's baseline tree ──────

/**
 * A real repo on `main` with three tracked files and a human's uncommitted
 * edit to `human.ts` — the tree as it stood when the run started. The
 * returned Run-shaped object carries the baseline `startRun` would have
 * recorded, so `commitEnvelope` takes the explicit-staging path.
 */
function stagingRepo(): { dir: string; run: Run; logs: Record<string, unknown>[]; ph: PhaseHandle } {
  const dir = mkdtempSync(path.join(tmpdir(), "piquette-staging-"));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  sh("init", "-b", "main");
  sh("config", "user.email", "t@example.com");
  sh("config", "user.name", "t");
  writeFileSync(path.join(dir, "agent.ts"), "one\n");
  writeFileSync(path.join(dir, "human.ts"), "mine\n");
  writeFileSync(path.join(dir, "shared.ts"), "shared\n");
  sh("add", "-A");
  sh("commit", "-m", "init");
  sh("switch", "-q", "-c", "work"); // commit phases refuse protected branches (#97)
  writeFileSync(path.join(dir, "human.ts"), "mine, edited\n");
  const cfg = { watch: { base_branch: "main" }, git: { protected_branches: ["main", "master"] } };
  const run = { adw_id: "abcd1234", cfg, repo_root: dir, git: makeGit(dir) } as unknown as Run & { baseline_tree: Record<string, string> };
  run.baseline_tree = stagingSnapshot(run as never);
  const logs: Record<string, unknown>[] = [];
  const ph = {
    log: async (payload: Record<string, unknown>) => {
      logs.push(payload);
    },
  } as unknown as PhaseHandle;
  return { dir, run, logs, ph };
}

const gitOut = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trimEnd();

const envelope = { status: "success" as const, summary: "did it", artifacts: [], notes_for_next_agent: "", commit_message: "agent work" };

test("commitEnvelope in a tree with a pre-existing dirty file commits only run-changed paths and logs left_unstaged", async () => {
  const { dir, run, logs, ph } = stagingRepo();
  try {
    writeFileSync(path.join(dir, "agent.ts"), "two\n");
    writeFileSync(path.join(dir, "added.ts"), "new\n");
    await commitEnvelope(run, ph, envelope);
    assert.deepEqual(gitOut(dir, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["added.ts", "agent.ts"]);
    assert.equal(gitOut(dir, "status", "--porcelain"), " M human.ts");
    const logged = logs.find((l) => "sha" in l);
    assert.deepEqual(logged?.left_unstaged, ["human.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitEnvelope with agent work already committed and a human dirty file present does not throw", async () => {
  const { dir, run, logs, ph } = stagingRepo();
  try {
    // The builder committed its own work (a plan's "Commit convention"),
    // leaving only the human's edit dirty — `isDirty()` alone would say
    // there is still something to stage and fall through to "nothing to commit".
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir });
    writeFileSync(path.join(dir, "agent.ts"), "two\n");
    execFileSync("git", ["commit", "-q", "-m", "builder's own commit", "--", "agent.ts"], { cwd: dir });
    const head = gitOut(dir, "rev-parse", "HEAD");
    await commitEnvelope(run, ph, envelope);
    assert.equal(gitOut(dir, "rev-parse", "HEAD"), head, "no new commit");
    assert.equal(gitOut(dir, "status", "--porcelain"), " M human.ts");
    assert.ok(logs.some((l) => /already committed/.test(String(l.message))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitEnvelope refuses a path the human had dirty AND the run edited: stages nothing, names the mixed path", async () => {
  const { dir, run, logs, ph } = stagingRepo();
  try {
    writeFileSync(path.join(dir, "agent.ts"), "two\n");
    writeFileSync(path.join(dir, "human.ts"), "mine, edited\nand the agent's line too\n");
    const head = gitOut(dir, "rev-parse", "HEAD");
    await assert.rejects(commitEnvelope(run, ph, envelope), /human\.ts/);
    assert.equal(gitOut(dir, "rev-parse", "HEAD"), head, "nothing committed");
    assert.equal(gitOut(dir, "diff", "--cached", "--name-only"), "", "nothing staged");
    assert.ok(logs.some((l) => JSON.stringify(l.mixed) === JSON.stringify(["human.ts"])));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitEnvelope: a baseline path the human committed mid-run is vanished, not mixed: it does not block the run's own commit", async () => {
  const { dir, run, logs, ph } = stagingRepo();
  try {
    // The human commits their dirty file while the run is going.
    execFileSync("git", ["add", "human.ts"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "human"], { cwd: dir });
    writeFileSync(path.join(dir, "agent.ts"), "two\n");
    await commitEnvelope(run, ph, envelope);
    assert.equal(gitOut(dir, "show", "--name-only", "--format=", "HEAD"), "agent.ts");
    assert.ok(logs.some((l) => JSON.stringify(l.vanished) === JSON.stringify(["human.ts"])));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startRun with an empty baseline (watch): a tracked file `watch.setup` dirtied and the run edited too is committed as the run's", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "piquette-staging-setup-"));
  try {
    const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    sh("init", "-b", "main");
    sh("config", "user.email", "t@example.com");
    sh("config", "user.name", "t");
    writeFileSync(path.join(root, "package-lock.json"), "{}\n");
    writeFileSync(path.join(root, "a.ts"), "one\n");
    sh("add", "-A");
    sh("commit", "-m", "init");
    sh("switch", "-q", "-c", "piquette-watch/1-x"); // watch runs on its own worktree branch
    // The setup step (install) rewrites the lockfile before the chain starts.
    writeFileSync(path.join(root, "package-lock.json"), "{\"setup\":1}\n");
    const configPath = path.join(root, "..", `${path.basename(root)}.config.yaml`);
    writeFileSync(configPath, "");
    const run = await startRun({ prompt: "p", config_paths: [configPath], adw_id: "adw_watch_setup", cwd: root, chain_name: "build", unattended: true, baseline_tree: {} }, [], []);
    writeFileSync(path.join(root, "a.ts"), "two\n");
    writeFileSync(path.join(root, "package-lock.json"), "{\"setup\":1,\"builder\":1}\n");
    await commitEnvelope(run, { log: async () => {} } as unknown as PhaseHandle, envelope);
    assert.deepEqual(gitOut(root, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["a.ts", "package-lock.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitEnvelope stages a run-created or run-edited file whose name git would C-quote", async () => {
  const { dir, run, ph } = stagingRepo();
  try {
    // numstat/ls-files print these as "docs/caf\303\251.md" by default — a
    // pathspec that names no file, so `git add` would exit 128.
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs", "café.md"), "new\n");
    writeFileSync(path.join(dir, "日本語.json"), "{}\n");
    await commitEnvelope(run, ph, envelope);
    assert.deepEqual(
      execFileSync("git", ["-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD"], { cwd: dir, encoding: "utf-8" }).trimEnd().split("\n").sort(),
      ["docs/café.md", "日本語.json"].sort(),
    );
    assert.equal(gitOut(dir, "status", "--porcelain"), " M human.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitEnvelope refuses a human's UNTRACKED file the run appended to (its fingerprint is content, not just 'untracked')", async () => {
  const { dir, run, logs, ph } = stagingRepo();
  try {
    writeFileSync(path.join(dir, "scratch.ts"), "export const a = 1;\n");
    run.baseline_tree = stagingSnapshot(run as never);
    writeFileSync(path.join(dir, "agent.ts"), "import { b } from './scratch';\n");
    writeFileSync(path.join(dir, "scratch.ts"), "export const a = 1;\nexport const b = 2;\n");
    const head = gitOut(dir, "rev-parse", "HEAD");
    await assert.rejects(commitEnvelope(run, ph, envelope), /scratch\.ts/);
    assert.equal(gitOut(dir, "rev-parse", "HEAD"), head, "nothing committed");
    assert.ok(logs.some((l) => JSON.stringify(l.mixed) === JSON.stringify(["scratch.ts"])));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitEnvelope refuses a human-dirty tracked file the run rewrote with the SAME numstat counts", async () => {
  const { dir, run, logs, ph } = stagingRepo();
  try {
    // human.ts is "mine, edited" against "mine" (1,1); the run rewrites that
    // same line again — still 1,1, but not the human's content any more.
    writeFileSync(path.join(dir, "agent.ts"), "two\n");
    writeFileSync(path.join(dir, "human.ts"), "the agent's version\n");
    await assert.rejects(commitEnvelope(run, ph, envelope), /human\.ts/);
    assert.ok(logs.some((l) => JSON.stringify(l.mixed) === JSON.stringify(["human.ts"])));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startRun in a fresh `piquette watch`-style worktree: the baseline is empty, and the commit carries the run's work, never the .piquette/data symlink", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "piquette-staging-wt-"));
  const main = path.join(root, "main");
  const wt = path.join(root, "wt");
  try {
    mkdirSync(main);
    const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    sh(main, "init", "-b", "main");
    sh(main, "config", "user.email", "t@example.com");
    sh(main, "config", "user.name", "t");
    writeFileSync(path.join(main, "agent.ts"), "one\n");
    writeFileSync(path.join(main, ".gitignore"), ".piquette/data/\n");
    sh(main, "add", "-A");
    sh(main, "commit", "-m", "init");
    // The human keeps working in the main checkout; the worktree never sees it.
    writeFileSync(path.join(main, "agent.ts"), "the human's own edit\n");
    mkdirSync(path.join(main, ".piquette", "data"), { recursive: true });
    // What `piquette watch` does per issue: a worktree off base, its data dir a symlink to the main one.
    sh(main, "worktree", "add", "-q", "-b", "piquette/issue-1", wt, "main");
    mkdirSync(path.join(wt, ".piquette"));
    symlinkSync(path.join(main, ".piquette", "data"), path.join(wt, ".piquette", "data"), "dir");
    excludePiquetteDataFromGit(wt);
    const configPath = path.join(root, "piquette.config.yaml");
    writeFileSync(configPath, "");

    const run = await startRun({ prompt: "p", config_paths: [configPath], adw_id: "adw_watch_wt", cwd: wt, chain_name: "build", unattended: true }, [], []);
    assert.deepEqual(run.baseline_tree, {}, "a fresh worktree has nothing of anyone else's in it");

    writeFileSync(path.join(wt, "agent.ts"), "two\n");
    writeFileSync(path.join(wt, "added.ts"), "new\n");
    await commitEnvelope(run, { log: async () => {} } as unknown as PhaseHandle, envelope);
    assert.deepEqual(gitOut(wt, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["added.ts", "agent.ts"]);
    assert.equal(gitOut(wt, "status", "--porcelain"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadOrRecordBaselineTree: records once, and a resumed run reuses the first run's baseline", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piquette-baseline-"));
  try {
    const first = loadOrRecordBaselineTree(dir, () => ({ "human.ts": "1,0" }));
    assert.deepEqual(first, { "human.ts": "1,0" });
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "baseline_tree.json"), "utf-8")), { "human.ts": "1,0" });
    // `--adw-id` resume: the tree now also holds the run's own earlier
    // uncommitted work, which must NOT be re-baselined as the human's.
    let retaken = false;
    const resumed = loadOrRecordBaselineTree(dir, () => {
      retaken = true;
      return { "human.ts": "1,0", "agent.ts": "3,1" };
    });
    assert.deepEqual(resumed, { "human.ts": "1,0" });
    assert.equal(retaken, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── committerIdentity ────────────────────────────────────────────────────

test("committerIdentity: reads the repo-local user.name/user.email", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piquette-signoff-identity-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Ada Lovelace"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "ada@example.com"], { cwd: dir, stdio: "ignore" });
    assert.deepEqual(committerIdentity(dir), { name: "Ada Lovelace", email: "ada@example.com" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("committerIdentity: undefined (never a fallback literal) when no config carries a name/email", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piquette-signoff-identity-unset-"));
  const fakeHome = mkdtempSync(path.join(tmpdir(), "piquette-signoff-fakehome-"));
  const saved = {
    HOME: process.env.HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    // Isolate from whatever global/system gitconfig the host running this
    // suite happens to have — otherwise "unset" is only true by accident.
    process.env.HOME = fakeHome;
    process.env.GIT_CONFIG_GLOBAL = path.join(fakeHome, "does-not-exist");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    assert.equal(committerIdentity(dir), undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
