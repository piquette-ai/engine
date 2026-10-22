/**
 * the decision model watch intake (#108): the `intake_feedback` classifier (inside
 * `claimFeedback` -> `runIssueSingle`) and the `intake_readiness` router
 * (inside `claimNewWork`), both driven through their REAL call sites in
 * `core/watch.ts` with a `FakeDecisionClient` — never the network. The provider,
 * code host and git fakes are deliberately small local copies rather than
 * imports from `watch.test.ts` (which exports none, and stays unmodified).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFeedback, claimNewWork, createWatchState, type ChainRunResult, type RefineRunResult, type WatchDeps } from "../core/watch.js";
import type { CodeHostProvider, Issue, IssueComment, IssueProvider, PrComment, PrRef, PrStatus, WatchMarker, WatchState } from "../core/issues/provider.js";
import type { GitHandle } from "../core/git_helper.js";
import { createDecider, listRecordedDecisions, normalizeDecisionsConfig, setDecisionClientFactory, traceDecisionRecorder, type Decision, type Decider } from "../core/decisions.js";
import type { DecisionsConfigInput } from "../core/data_types.js";
import { loadConfig } from "../core/agents.js";
import { Tracer } from "../core/tracer.js";
import { DECISION_KINDS } from "../core/decision_kinds.js";
import { openWatchIntakeDecider } from "../cli/commands/watch.js";
import { FakeDecisionClient } from "./fake_decisions.js";

// ── fakes ───────────────────────────────────────────────────────────────────

interface Entry {
  issue: Issue;
  state: WatchState;
  marker: WatchMarker | null;
  comments: IssueComment[];
}

class Provider implements IssueProvider {
  entries = new Map<string, Entry>();
  transitions: Array<{ id: string; to: WatchState; detail?: string }> = [];
  claimCalls: string[] = [];
  markerReads = 0;
  add(id: string, state: WatchState, marker: WatchMarker | null = null, body = "Do the thing. Acceptance: it works."): void {
    this.entries.set(id, { issue: { id, title: `Issue ${id}`, body, labels: [`spf:${state}`] }, state, marker, comments: [] });
  }
  async ensureLabels() {
    return { created: [], updated: [], unchanged: [] };
  }
  async listEligible(): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === "ready").map((e) => e.issue);
  }
  async listInState(state: WatchState): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === state).map((e) => e.issue);
  }
  async getIssue(id: string): Promise<Issue | null> {
    return this.entries.get(id)?.issue ?? null;
  }
  async claim(issue: Issue, opts?: { from?: WatchState; to?: WatchState }): Promise<boolean> {
    this.claimCalls.push(issue.id);
    const e = this.entries.get(issue.id)!;
    if (e.state !== (opts?.from ?? "ready")) return false;
    e.state = opts?.to ?? "working";
    return true;
  }
  async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    const e = this.entries.get(issue.id)!;
    e.state = to;
    this.transitions.push({ id: issue.id, to, detail });
    if (detail) e.comments.push({ id: String(e.comments.length + 1), author: "spf", created_at: new Date().toISOString(), body: detail });
  }
  async comment(issue: Issue, body: string): Promise<void> {
    const e = this.entries.get(issue.id)!;
    e.comments.push({ id: String(e.comments.length + 1), author: "spf", created_at: new Date().toISOString(), body });
  }
  async readMarker(issue: Issue): Promise<WatchMarker | null> {
    this.markerReads++;
    return this.entries.get(issue.id)?.marker ?? null;
  }
  async writeMarker(issue: Issue, marker: WatchMarker): Promise<void> {
    this.entries.get(issue.id)!.marker = marker;
  }
  async listComments(issue: Issue): Promise<IssueComment[]> {
    return this.entries.get(issue.id)?.comments ?? [];
  }
}

class CodeHost implements CodeHostProvider {
  prs = new Map<number, PrStatus>();
  prComments = new Map<number, PrComment[]>();
  openedPrs: string[] = [];
  async openPr(opts: { branch: string }): Promise<PrRef> {
    this.openedPrs.push(opts.branch);
    return { number: 1000 + this.openedPrs.length, branch: opts.branch, url: "https://example.invalid/pr" };
  }
  async prStatus(pr: PrRef): Promise<PrStatus> {
    return this.prs.get(pr.number) ?? { merged: false, state: "open", ciStatus: "pending" };
  }
  async listPrComments(pr: PrRef): Promise<PrComment[]> {
    return this.prComments.get(pr.number) ?? [];
  }
}

function git(): GitHandle {
  return {
    currentBranch: () => "main",
    createBranch: (n) => n,
    isRepo: () => true,
    commitAll: () => "abc123",
    changedFiles: () => [],
    refExists: () => true,
    rev: () => "abc123",
    shortSha: () => "abc123",
    mergeBase: () => "abc123",
    isAncestor: () => true,
    isDirty: () => false,
    untrackedFiles: () => [],
    diffFiles: () => ["src/index.ts"],
    diffStat: () => "",
    diffCounts: () => [0, 0],
    diffText: () => "",
    fetch: () => {},
    worktreeAdd: () => {},
    worktreeRemove: () => {},
    deleteLocalBranch: () => {},
    push: () => {},
  };
}

interface Harness {
  provider: Provider;
  codeHost: CodeHost;
  deps: WatchDeps;
  chainRuns: string[];
  logs: string[];
}

/** Private per-process root: `issueLockPath`'s `locks/` sits beside `worktreesDir`, so a fixed path under the shared tmpdir collides across concurrent runs (#118). */
const scratchRoot = mkdtempSync(join(tmpdir(), "spf-watch-decisions-intake-"));
after(() => rmSync(scratchRoot, { recursive: true, force: true }));

function harness(overrides: Partial<WatchDeps> = {}): Harness {
  const provider = new Provider();
  const codeHost = new CodeHost();
  const chainRuns: string[] = [];
  const logs: string[] = [];
  const deps: WatchDeps = {
    provider,
    codeHost,
    git: git(),
    worktreeGit: () => git(),
    labelPrefix: "spf",
    chain: "plan-build-test",
    baseBranch: "main",
    concurrency: 2,
    allowedAuthors: [],
    chainOptions: {},
    refineEnabled: false,
    refineConcurrency: 1,
    refineChain: "refine",
    runRefine: async (opts): Promise<RefineRunResult> => ({ accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [], split: [] }),
    worktreesDir: join(scratchRoot, "worktrees"),
    linkDataDir: () => {},
    dryRun: false,
    runChain: async (opts): Promise<ChainRunResult> => {
      chainRuns.push(opts.adwId);
      return { accepted: true, adwId: opts.adwId, detail: "" };
    },
    log: (m) => logs.push(m),
    notify: () => {},
    ...overrides,
  };
  return { provider, codeHost, deps, chainRuns, logs };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** `deps.intakeDecider` over a fake client and an in-memory recorder — the recorder sees exactly what the CLI's trace recorder would. */
function fakeIntake(config: DecisionsConfigInput, client: FakeDecisionClient): { intakeDecider: (adwId: string) => Decider; recorded: Array<{ adwId: string; d: Decision }> } {
  const recorded: Array<{ adwId: string; d: Decision }> = [];
  const base = createDecider({ config, client, env: {} });
  return { recorded, intakeDecider: (adwId) => base.withRecorder((d) => void recorded.push({ adwId, d })) };
}

const ON_ACT: DecisionsConfigInput = { enabled: true, mode: "act" };
const ON_SHADOW: DecisionsConfigInput = { enabled: true, mode: "shadow" };

function prComment(id: string, body: string, created_at = "2020-01-02T00:00:00.000Z"): PrComment {
  return { id, author: "alice", created_at, body };
}

/** One `feedback` issue with an open (or closed) PR #900 and one new PR comment. */
function feedbackIssue(h: Harness, prState: "open" | "closed" = "open", marker: WatchMarker = { pr: 900, branch: "spf-watch/70-issue-70", attempt: 0 }): void {
  h.provider.add("70", "feedback", marker);
  h.codeHost.prs.set(900, { merged: false, state: prState, ciStatus: "pending" });
  h.codeHost.prComments.set(900, [prComment("c1", "Why did you pick sqlite here?")]);
}

async function runFeedback(h: Harness): Promise<void> {
  const state = createWatchState();
  await claimFeedback(h.deps, state);
  await waitUntil(() => state.inflight.size === 0);
}

async function runReady(h: Harness): Promise<void> {
  const state = createWatchState();
  await claimNewWork(h.deps, state);
  await waitUntil(() => state.inflight.size === 0);
}

// ── registry ────────────────────────────────────────────────────────────────

test("intake kinds: both are registered, choice-shaped, with the documented closed option sets", () => {
  assert.deepEqual(DECISION_KINDS["intake_feedback"]?.options, ["revise", "question", "approve", "out_of_scope"]);
  assert.deepEqual(DECISION_KINDS["intake_readiness"]?.options, ["build", "refine", "needs_human"]);
  assert.equal(DECISION_KINDS["intake_feedback"]?.question, "choice");
  assert.equal(DECISION_KINDS["intake_readiness"]?.question, "choice");
});

// ── R8: no `decisions:` block, through the real call sites ────────────────────────

test("intake R8: with NO decisions: block, feedback revises, ready builds, zero decision-model calls, zero decision rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-watch-decisions-intake-"));
  const fake = FakeDecisionClient.choosing("approve", 0.99);
  setDecisionClientFactory(() => fake);
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, "watch:\n  repo: acme/widgets\n");
    const cfg = loadConfig([configPath]);
    const dataPaths = { data_dir: join(dir, "data"), db: { kind: "sqlite" as const, path: join(dir, "trace.db") } };
    // The CLI's own wiring: nothing opened, no intakeDecider at all.
    assert.equal(await openWatchIntakeDecider(cfg.decisions, dataPaths), undefined);

    // Belt and braces: even a daemon handed a decision model built from that same
    // (disabled) config, recording into a real trace db, changes nothing.
    const tracer = await Tracer.open(dataPaths.db, join(dir, "events.jsonl"));
    try {
      const intakeDecider = (adwId: string) => createDecider({ config: cfg.decisions, recorder: traceDecisionRecorder(tracer, adwId) });
      for (const deps of [{}, { intakeDecider }] as Array<Partial<WatchDeps>>) {
        const h = harness(deps);
        feedbackIssue(h);
        h.provider.add("71", "ready");
        await runFeedback(h);
        await runReady(h);
        assert.deepEqual(h.chainRuns.sort(), ["issue-70", "issue-71"], "the revision ran and the ready issue was built — today's behavior");
        assert.equal(h.provider.entries.get("70")!.state, "review");
        assert.equal(h.provider.entries.get("71")!.state, "review");
      }
      assert.equal(fake.calls.length, 0);
      assert.equal((await listRecordedDecisions(tracer.db, "issue-70")).length, 0);
      assert.equal((await listRecordedDecisions(tracer.db, "issue-71")).length, 0);
      const rows = (await tracer.db.query("SELECT COUNT(*) AS n FROM events WHERE name='decision'").get()) as { n: number };
      assert.equal(rows.n, 0);
    } finally {
      await tracer.close();
    }
  } finally {
    setDecisionClientFactory(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── openWatchIntakeDecider (the CLI wiring) ─────────────────────────────────────

test("openWatchIntakeDecider: off when disabled or when both intake kinds are off; on, it records into the trace db under the issue's adw_id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-watch-decisions-intake-"));
  const fake = FakeDecisionClient.choosing("question", 0.95);
  setDecisionClientFactory(() => fake);
  try {
    const dataPaths = { data_dir: join(dir, "data"), db: { kind: "sqlite" as const, path: join(dir, "trace.db") } };
    assert.equal(await openWatchIntakeDecider(normalizeDecisionsConfig({ enabled: false, mode: "act" }), dataPaths), undefined);
    const bothOff = normalizeDecisionsConfig({ enabled: true, kinds: { intake_feedback: { mode: "off" }, intake_readiness: { mode: "off" } } });
    assert.equal(await openWatchIntakeDecider(bothOff, dataPaths), undefined);

    const intake = await openWatchIntakeDecider(normalizeDecisionsConfig({ enabled: true, mode: "act", kinds: { intake_readiness: { mode: "off" } } }), dataPaths);
    assert.ok(intake);
    try {
      const h = harness({ intakeDecider: intake.intakeDecider });
      feedbackIssue(h);
      await runFeedback(h);
      assert.deepEqual(h.chainRuns, [], "question — no revision run");
      const tracer = await Tracer.open(dataPaths.db, join(dir, "read.jsonl"));
      try {
        const rows = await listRecordedDecisions(tracer.db, "issue-70", { kind: "intake_feedback" });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.choice, "question");
        assert.equal(rows[0]!.key, "pr900:r1:c1");
      } finally {
        await tracer.close();
      }
    } finally {
      await intake.close();
    }
  } finally {
    setDecisionClientFactory(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── intake_feedback ─────────────────────────────────────────────────────────

test("intake_feedback act: question -> acknowledgement comment, no revision run, back to review; PR untouched, marker only gains the answered key", async () => {
  const fake = FakeDecisionClient.choosing("question", 0.95);
  const { intakeDecider, recorded } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeDecider });
  feedbackIssue(h);
  await runFeedback(h);
  assert.deepEqual(h.chainRuns, []);
  assert.equal(h.codeHost.openedPrs.length, 0);
  const entry = h.provider.entries.get("70")!;
  assert.equal(entry.state, "review");
  assert.match(entry.comments.at(-1)!.body, /as a question rather than a requested change/);
  assert.match(entry.comments.at(-1)!.body, /`spf:feedback` again/);
  const { intake_feedback, ...rest } = entry.marker!;
  assert.deepEqual(rest, { pr: 900, branch: "spf-watch/70-issue-70", attempt: 0 }, "every prior marker field unchanged");
  assert.equal(intake_feedback?.key, "pr900:r1:c1");
  assert.equal(intake_feedback?.intent, "question");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.adwId, "issue-70");
  assert.equal(recorded[0]!.d.kind, "intake_feedback");
  assert.equal(recorded[0]!.d.reason, null, "the decision model's answer acted");
  // The closed option set the decision model was offered, verbatim.
  const q = fake.calls[0]!.questions["q0"]!;
  assert.equal(q.type, "choice");
  assert.deepEqual(Object.keys((q as { criteria: Record<string, string> }).criteria), ["revise", "question", "approve", "out_of_scope"]);
});

test("intake_feedback act: approve / out_of_scope on an open PR are logged only — no comment, no run, back to review", async () => {
  for (const choice of ["approve", "out_of_scope"] as const) {
    const { intakeDecider } = fakeIntake(ON_ACT, FakeDecisionClient.choosing(choice, 0.95));
    const h = harness({ intakeDecider });
    feedbackIssue(h, "open");
    await runFeedback(h);
    assert.deepEqual(h.chainRuns, [], choice);
    assert.equal(h.codeHost.openedPrs.length, 0);
    const entry = h.provider.entries.get("70")!;
    assert.equal(entry.state, "review");
    assert.equal(entry.comments.length, 0, "logged, not commented");
    assert.equal(h.provider.transitions.at(-1)!.detail, undefined);
    assert.ok(h.logs.some((l) => l.includes(`classified ${choice}`)), h.logs.join("\n"));
  }
});

test("intake_feedback act: approve / out_of_scope on a CLOSED PR land on blocked WITH an explanation — never a silent dead end", async () => {
  for (const [choice, read] of [
    ["approve", "an approval"],
    ["out_of_scope", "a request for work outside this issue"],
  ] as const) {
    const { intakeDecider } = fakeIntake(ON_ACT, FakeDecisionClient.choosing(choice, 0.95));
    const h = harness({ intakeDecider });
    feedbackIssue(h, "closed");
    await runFeedback(h);
    assert.deepEqual(h.chainRuns, [], choice);
    const entry = h.provider.entries.get("70")!;
    assert.equal(entry.state, "blocked");
    assert.equal(entry.comments.length, 1, choice);
    assert.match(entry.comments[0]!.body, new RegExp(`closed PR #900 as ${read} rather than a requested change`));
    assert.match(entry.comments[0]!.body, /add `spf:feedback` again — with no new PR comment/);
  }
});

test("intake_feedback act: the human override — re-adding feedback with the SAME comments revises with no second decision-model call", async () => {
  const fake = FakeDecisionClient.choosing("question", 0.99);
  const { intakeDecider, recorded } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeDecider });
  feedbackIssue(h);
  await runFeedback(h);
  assert.deepEqual(h.chainRuns, [], "first claim: question, no run");
  assert.equal(h.provider.entries.get("70")!.state, "review");
  const acks = () => h.provider.entries.get("70")!.comments.filter((c) => /as a question rather than a requested change/.test(c.body)).length;
  assert.equal(acks(), 1);

  // The human disagrees: relabel `feedback`, no new PR comment.
  h.provider.entries.get("70")!.state = "feedback";
  await runFeedback(h);
  assert.equal(fake.calls.length, 1, "the decision model is not asked again about the same batch");
  assert.equal(recorded.length, 1);
  assert.deepEqual(h.chainRuns, ["issue-70"], "the relabel revised");
  const entry = h.provider.entries.get("70")!;
  assert.equal(entry.state, "review");
  assert.equal(entry.marker?.revision?.rounds, 1);
  assert.equal(entry.marker?.intake_feedback, undefined, "the revision's own marker write drops the answered key");
  assert.equal(acks(), 1, "no duplicate acknowledgement");
  assert.ok(h.logs.some((l) => l.includes("a human override, revising with no decision-model call")), h.logs.join("\n"));

  // A NEW comment after the revision is a new batch: Decider reads it.
  h.codeHost.prComments.set(900, [prComment("c1", "Why did you pick sqlite here?"), prComment("c2", "Thanks, looks good", "2099-01-01T00:00:00.000Z")]);
  h.provider.entries.get("70")!.state = "feedback";
  await runFeedback(h);
  assert.equal(fake.calls.length, 2);
  assert.equal(recorded[1]!.d.key, "pr900:r2:c2");
});

test("intake_feedback act: a NEW comment after a non-revise answer is a new batch — the decision model is asked again", async () => {
  const fake = FakeDecisionClient.choosing("approve", 0.99);
  const { intakeDecider, recorded } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeDecider });
  feedbackIssue(h);
  await runFeedback(h);
  h.codeHost.prComments.set(900, [prComment("c1", "Why did you pick sqlite here?"), prComment("c2", "LGTM")]);
  h.provider.entries.get("70")!.state = "feedback";
  await runFeedback(h);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(recorded.map((r) => r.d.key), ["pr900:r1:c1", "pr900:r1:c2"]);
  assert.deepEqual(h.chainRuns, []);
  assert.equal(h.provider.entries.get("70")!.marker?.intake_feedback?.key, "pr900:r1:c2");
});

test("intake_feedback act: an answer outside the closed set (\"merge\") is invalid_choice and revises", async () => {
  for (const bogus of ["merge", "done"]) {
    const { intakeDecider, recorded } = fakeIntake(ON_ACT, FakeDecisionClient.choosing(bogus, 0.99));
    const h = harness({ intakeDecider });
    feedbackIssue(h);
    await runFeedback(h);
    assert.deepEqual(h.chainRuns, ["issue-70"], bogus);
    assert.equal(recorded[0]!.d.reason, "invalid_choice", bogus);
    assert.equal(recorded[0]!.d.choice, "revise", bogus);
    assert.equal(recorded[0]!.d.model_choice, null, bogus);
  }
});

test("intake_feedback: what the decision model reads is capped — the last 20 comments, each body at 2000 chars", async () => {
  const fake = FakeDecisionClient.choosing("revise", 0.95);
  const { intakeDecider } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeDecider });
  feedbackIssue(h);
  h.codeHost.prComments.set(
    900,
    Array.from({ length: 25 }, (_, i) => prComment(`c${i}`, i === 24 ? "x".repeat(5_000) : `comment ${i}`)),
  );
  await runFeedback(h);
  const state = fake.calls[0]!.state as { comments: Array<{ body: string }> };
  assert.equal(state.comments.length, 20);
  assert.equal(state.comments[0]!.body, "comment 5", "the OLDEST are dropped");
  assert.equal(state.comments.at(-1)!.body.length, 2_000);
});

test("intake_feedback act: revise runs the revision exactly as today", async () => {
  const { intakeDecider, recorded } = fakeIntake(ON_ACT, FakeDecisionClient.choosing("revise", 0.95));
  const h = harness({ intakeDecider });
  feedbackIssue(h);
  await runFeedback(h);
  assert.deepEqual(h.chainRuns, ["issue-70"]);
  assert.equal(h.provider.entries.get("70")!.state, "review");
  assert.equal(h.provider.entries.get("70")!.marker?.revision?.rounds, 1);
  assert.equal(recorded[0]!.d.choice, "revise");
});

test("intake_feedback shadow: Decider is asked and recorded, but the fallback (revise) acts", async () => {
  const fake = FakeDecisionClient.choosing("approve", 0.99);
  const { intakeDecider, recorded } = fakeIntake(ON_SHADOW, fake);
  const h = harness({ intakeDecider });
  feedbackIssue(h);
  await runFeedback(h);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(h.chainRuns, ["issue-70"], "revision ran");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.d.reason, "shadow");
  assert.equal(recorded[0]!.d.model_choice, "approve");
  assert.equal(recorded[0]!.d.choice, "revise");
});

test("intake_feedback fallbacks: low confidence, error, timeout, no API key, kind off — all revise", async () => {
  const cases: Array<{ name: string; client: FakeDecisionClient | null; config: DecisionsConfigInput; reason: string | null }> = [
    { name: "low_confidence", client: FakeDecisionClient.choosing("approve", 0.3), config: ON_ACT, reason: "low_confidence" },
    { name: "error", client: FakeDecisionClient.failing(new Error("boom")), config: ON_ACT, reason: "error" },
    { name: "timeout", client: FakeDecisionClient.hanging(), config: { ...ON_ACT, timeout_ms: 20 }, reason: "timeout" },
    { name: "no_api_key", client: null, config: ON_ACT, reason: "no_api_key" },
    { name: "kind_off", client: FakeDecisionClient.choosing("approve", 0.99), config: { ...ON_ACT, kinds: { intake_feedback: { mode: "off" } } }, reason: null },
  ];
  for (const c of cases) {
    const recorded: Decision[] = [];
    const base = createDecider({ config: c.config, client: c.client ?? undefined, env: {} });
    const h = harness({ intakeDecider: () => base.withRecorder((d) => void recorded.push(d)) });
    feedbackIssue(h);
    await runFeedback(h);
    assert.deepEqual(h.chainRuns, ["issue-70"], `${c.name}: revision ran`);
    if (c.reason === null) {
      assert.equal(recorded.length, 0, `${c.name}: kind off is never recorded`);
    } else {
      assert.equal(recorded.length, 1, c.name);
      assert.equal(recorded[0]!.reason, c.reason, c.name);
      assert.equal(recorded[0]!.choice, "revise", c.name);
    }
  }
});

test("intake_feedback: no comments since the last push -> nothing to classify, no decision-model call, revise", async () => {
  const fake = FakeDecisionClient.choosing("approve", 0.99);
  const { intakeDecider, recorded } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeDecider });
  feedbackIssue(h, "open", { pr: 900, branch: "spf-watch/70-issue-70", attempt: 0, revision: { rounds: 1, since: "2030-01-01T00:00:00.000Z" } });
  await runFeedback(h);
  assert.equal(fake.calls.length, 0);
  assert.equal(recorded.length, 0);
  assert.deepEqual(h.chainRuns, ["issue-70"]);
});

test("intake_feedback: only comments since the watermark reach the decision model, and the key names the PR, round and last comment", async () => {
  const fake = FakeDecisionClient.choosing("revise", 0.95);
  const { intakeDecider, recorded } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeDecider });
  feedbackIssue(h, "open", { pr: 900, branch: "spf-watch/70-issue-70", attempt: 0, revision: { rounds: 2, since: "2020-06-01T00:00:00.000Z" } });
  h.codeHost.prComments.set(900, [prComment("old", "stale discussion", "2020-01-01T00:00:00.000Z"), prComment("new", "rename the flag", "2020-07-01T00:00:00.000Z")]);
  await runFeedback(h);
  const state = fake.calls[0]!.state as { comments: Array<{ body: string }>; round: number };
  assert.deepEqual(state.comments.map((c) => c.body), ["rename the flag"]);
  assert.equal(state.round, 3);
  assert.equal(recorded[0]!.d.key, "pr900:r3:new");
});

// ── intake_readiness ────────────────────────────────────────────────────────

test("intake_readiness act: needs_human -> blocked with a needs-info comment + marker, never claimed, no chain", async () => {
  const fake = FakeDecisionClient.choosing("needs_human", 0.95);
  const { intakeDecider, recorded } = fakeIntake(ON_ACT, fake);
  const notified: string[] = [];
  const h = harness({ intakeDecider, concurrency: 2, notify: (e) => void notified.push(`${e.kind}:${e.title}`) });
  h.provider.add("80", "ready");
  h.provider.add("81", "ready");
  await runReady(h);
  for (const id of ["80", "81"]) {
    const entry = h.provider.entries.get(id)!;
    assert.equal(entry.state, "blocked", id);
    assert.match(entry.comments.at(-1)!.body, /needs more information from a human/);
    assert.equal(entry.marker?.intake?.routed, "needs_human");
  }
  assert.deepEqual(h.provider.claimCalls, [], "routed before the tracker-side claim");
  assert.deepEqual(h.chainRuns, []);
  assert.deepEqual(notified, ["issue_blocked:issue 80 needs info", "issue_blocked:issue 81 needs info"]);
  assert.deepEqual(recorded.map((r) => [r.adwId, r.d.kind, r.d.choice]), [
    ["issue-80", "intake_readiness", "needs_human"],
    ["issue-81", "intake_readiness", "needs_human"],
  ]);
});

test("intake_readiness: a human's relabel wins — an issue with any watch marker builds with no decision-model call", async () => {
  const fake = FakeDecisionClient.choosing("needs_human", 0.99);
  const { intakeDecider } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeDecider });
  h.provider.add("82", "ready", { intake: { routed: "needs_human", at: "2020-01-01T00:00:00.000Z" } });
  await runReady(h);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(h.chainRuns, ["issue-82"]);
  assert.equal(h.provider.entries.get("82")!.state, "review");
});

test("intake_readiness act: refine -> spec-ready only while watch.refine.enabled; otherwise not_permitted and it builds", async () => {
  {
    const { intakeDecider, recorded } = fakeIntake(ON_ACT, FakeDecisionClient.choosing("refine", 0.95));
    const h = harness({ intakeDecider, refineEnabled: false });
    h.provider.add("83", "ready");
    await runReady(h);
    assert.deepEqual(h.chainRuns, ["issue-83"]);
    assert.equal(recorded[0]!.d.reason, "not_permitted");
    assert.equal(recorded[0]!.d.choice, "build");
  }
  {
    const { intakeDecider, recorded } = fakeIntake(ON_ACT, FakeDecisionClient.choosing("refine", 0.95));
    const h = harness({ intakeDecider, refineEnabled: true });
    h.provider.add("84", "ready");
    await runReady(h);
    assert.deepEqual(h.chainRuns, []);
    assert.deepEqual(h.provider.claimCalls, []);
    const entry = h.provider.entries.get("84")!;
    assert.equal(entry.state, "spec-ready");
    assert.match(entry.comments.at(-1)!.body, /handed to the refine lane/);
    assert.equal(entry.marker?.intake?.routed, "refine");
    assert.equal(recorded[0]!.d.reason, null);
  }
});

test("intake_readiness: a refine-lane-created issue is never routed back to refine (no loop)", async () => {
  const { intakeDecider, recorded } = fakeIntake(ON_ACT, FakeDecisionClient.choosing("refine", 0.95));
  const h = harness({ intakeDecider, refineEnabled: true });
  h.provider.add("85", "ready", null, `Build it.\n\n<!-- spf-refine: ${JSON.stringify({ parent: "10", blocked_by: [], priority: "p2" })} -->`);
  await runReady(h);
  assert.deepEqual(h.chainRuns, ["issue-85"]);
  assert.equal(recorded[0]!.d.reason, "not_permitted");
});

test("intake_readiness shadow: recorded, but the issue is claimed and built as today", async () => {
  const fake = FakeDecisionClient.choosing("needs_human", 0.99);
  const { intakeDecider, recorded } = fakeIntake(ON_SHADOW, fake);
  const h = harness({ intakeDecider });
  h.provider.add("86", "ready");
  await runReady(h);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(h.chainRuns, ["issue-86"]);
  assert.equal(h.provider.entries.get("86")!.marker?.intake, undefined);
  assert.equal(recorded[0]!.d.reason, "shadow");
  assert.equal(recorded[0]!.d.model_choice, "needs_human");
});

test("intake_readiness fallbacks: timeout and low confidence build; kind off skips even the marker read", async () => {
  for (const [client, config, reason] of [
    [FakeDecisionClient.hanging(), { ...ON_ACT, timeout_ms: 20 }, "timeout"],
    [FakeDecisionClient.choosing("needs_human", 0.2), ON_ACT, "low_confidence"],
  ] as const) {
    const { intakeDecider, recorded } = fakeIntake(config, client);
    const h = harness({ intakeDecider });
    h.provider.add("87", "ready");
    await runReady(h);
    assert.deepEqual(h.chainRuns, ["issue-87"], reason);
    assert.equal(recorded[0]!.d.reason, reason);
  }
  const fake = FakeDecisionClient.choosing("needs_human", 0.99);
  const { intakeDecider, recorded } = fakeIntake({ ...ON_ACT, kinds: { intake_readiness: { mode: "off" } } }, fake);
  const h = harness({ intakeDecider });
  h.provider.add("88", "ready");
  await runReady(h);
  assert.deepEqual(h.chainRuns, ["issue-88"]);
  assert.equal(fake.calls.length, 0);
  assert.equal(recorded.length, 0);
  // runIssueSingle reads the marker once itself; the router added none.
  assert.equal(h.provider.markerReads, 1);
});

test("intake_readiness: a routed-away issue spends no concurrency budget — a buildable one behind it is still claimed", async () => {
  const fake = new FakeDecisionClient((req) => {
    const id = (req.state as { id: string }).id;
    return { model: req.model, answers: { q0: { type: "choice", choice: id === "90" ? "needs_human" : "build", confidence: 0.95 } } };
  });
  const { intakeDecider } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeDecider, concurrency: 2 });
  for (const id of ["90", "91", "92"]) h.provider.add(id, "ready");
  await runReady(h);
  assert.equal(h.provider.entries.get("90")!.state, "blocked");
  assert.deepEqual(h.provider.claimCalls, ["91", "92"], "both builds fit in a budget of 2 — the routing took none of it");
  assert.deepEqual(h.chainRuns.sort(), ["issue-91", "issue-92"]);
});

test("intake_readiness: routings away are capped at `concurrency` per tick; the rest stay ready for the next tick", async () => {
  const fake = FakeDecisionClient.choosing("needs_human", 0.95);
  const { intakeDecider } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeDecider, concurrency: 1 });
  for (const id of ["92", "93", "94"]) h.provider.add(id, "ready");
  await runReady(h);
  assert.equal(fake.calls.length, 1, "one decision-model call this tick, not three");
  assert.deepEqual(["92", "93", "94"].map((id) => h.provider.entries.get(id)!.state), ["blocked", "ready", "ready"]);
  assert.ok(h.logs.some((l) => l.includes("the per-tick cap")), h.logs.join("\n"));
  await runReady(h);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(["92", "93", "94"].map((id) => h.provider.entries.get(id)!.state), ["blocked", "blocked", "ready"]);
});

test("intake_readiness act: an answer outside the closed set (\"done\") is invalid_choice and builds", async () => {
  for (const bogus of ["done", "merge"]) {
    const { intakeDecider, recorded } = fakeIntake(ON_ACT, FakeDecisionClient.choosing(bogus, 0.99));
    const h = harness({ intakeDecider });
    h.provider.add("95", "ready");
    await runReady(h);
    assert.deepEqual(h.chainRuns, ["issue-95"], bogus);
    assert.equal(recorded[0]!.d.reason, "invalid_choice", bogus);
    assert.equal(recorded[0]!.d.choice, "build", bogus);
  }
});

test("intake_readiness: the issue body the decision model reads is capped at 8000 chars", async () => {
  const fake = FakeDecisionClient.choosing("build", 0.95);
  const { intakeDecider } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeDecider });
  h.provider.add("96", "ready", null, "y".repeat(20_000));
  await runReady(h);
  const state = fake.calls[0]!.state as { id: string; body: string };
  assert.equal(state.id, "96");
  assert.equal(state.body.length, 8_000);
});

test("intake_readiness shadow: a disagreement is visible in the daemon's own log line, not only in the trace", async () => {
  const { intakeDecider } = fakeIntake(ON_SHADOW, FakeDecisionClient.choosing("needs_human", 0.99));
  const h = harness({ intakeDecider });
  h.provider.add("97", "ready");
  await runReady(h);
  assert.ok(
    h.logs.includes("watch: 97: readiness intake — decision intake_readiness shadow: build (fallback: shadow, model said needs_human @ 0.99)"),
    h.logs.join("\n"),
  );
});

test("intake_readiness: a readMarker error skips the issue this tick with no decision-model call (still ready), never claims it", async () => {
  const fake = FakeDecisionClient.choosing("needs_human", 0.95);
  const { intakeDecider } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeDecider });
  h.provider.add("98", "ready");
  h.provider.readMarker = async () => {
    throw new Error("tracker read failed");
  };
  await runReady(h);
  assert.equal(fake.calls.length, 0);
  assert.equal(h.provider.entries.get("98")!.state, "ready");
  assert.deepEqual(h.provider.claimCalls, []);
  assert.ok(h.logs.some((l) => l.includes("readiness intake error: tracker read failed")));
});

test("intake_readiness: a transition error after the decision leaves the issue ready, unmarked and un-notified — the next tick routes it again", async () => {
  const fake = FakeDecisionClient.choosing("needs_human", 0.95);
  const { intakeDecider } = fakeIntake(ON_ACT, fake);
  const notified: string[] = [];
  const h = harness({ intakeDecider, notify: (e) => void notified.push(e.kind) });
  h.provider.add("99", "ready");
  const realTransition = h.provider.transition.bind(h.provider);
  h.provider.transition = async () => {
    throw new Error("tracker down");
  };
  await runReady(h);
  const entry = h.provider.entries.get("99")!;
  assert.equal(entry.state, "ready");
  assert.equal(entry.marker, null, "no marker for a routing that never happened");
  assert.deepEqual(notified, [], "the channel was not told 'needs info'");
  assert.deepEqual(h.provider.claimCalls, []);
  assert.deepEqual(h.chainRuns, [], "never silently built");

  h.provider.transition = realTransition;
  await runReady(h);
  assert.equal(fake.calls.length, 2, "routed afresh");
  const after = h.provider.entries.get("99")!;
  assert.equal(after.state, "blocked");
  assert.equal(after.marker?.intake?.routed, "needs_human");
  assert.deepEqual(notified, ["issue_blocked"]);
  assert.deepEqual(h.chainRuns, []);
});

test("intake_readiness: a marker-write error after the transition leaves the issue routed (blocked, commented) — never built", async () => {
  const { intakeDecider } = fakeIntake(ON_ACT, FakeDecisionClient.choosing("needs_human", 0.95));
  const h = harness({ intakeDecider });
  h.provider.add("89", "ready");
  h.provider.writeMarker = async () => {
    throw new Error("tracker down");
  };
  await runReady(h);
  assert.equal(h.provider.entries.get("89")!.state, "blocked");
  assert.match(h.provider.entries.get("89")!.comments.at(-1)!.body, /needs more information from a human/);
  assert.deepEqual(h.provider.claimCalls, []);
  assert.deepEqual(h.chainRuns, []);
  assert.ok(h.logs.some((l) => l.includes("readiness intake error: tracker down")));
});
