import "./hermetic_git.js"; // MUST stay first: the push-failure tests run git in temp repos
import { after, test } from "node:test";
import { SignoffRequiredError } from "../core/diff_risk.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  branchNameFor,
  buildIssuePrompt,
  buildSpecPrompt,
  claimFeedback,
  claimNewWork,
  claimSpecs,
  createWatchState,
  finishReviews,
  finishTrackedSpecs,
  issueLockPath,
  keptBranchName,
  MAX_LANDING_TRIES,
  orderEligible,
  reconcileOrphans,
  reconcileRefining,
  refineBranchNameFor,
  spliceGeneratedBody,
  closingReference,
  tick,
} from "../core/watch.js";
import { parseRefineMarker } from "../core/refine.js";
import { acquirePidLock, releasePidLock } from "../core/utils.js";
import { makeGit, type GitHandle } from "../core/git_helper.js";
import type { ChainRunResult, RefineRunResult, WatchDeps } from "../core/watch.js";
import type { VerificationOutcome } from "../core/verification.js";
import type { NotifyEvent } from "../core/notify/channel.js";
import type {
  CodeHostProvider,
  EnsureLabelsResult,
  Issue,
  IssueComment,
  IssueProvider,
  PrComment,
  PrRef,
  PrStatus,
  WatchMarker,
  WatchState,
} from "../core/issues/provider.js";
import { HttpError, isTransientError } from "../core/retry.js";
import { GitHubProvider } from "../core/issues/github_provider.js";
import { closingRefsFromConfig, escapeForMarkup, formatBuildDigest, formatReviewDigest, truncateDigest } from "../cli/commands/watch.js";
import type { BuildOutputT, ReviewOutputT } from "../core/data_types.js";

/** A minimal, schema-shaped ReviewOutputT — only the fields formatReviewDigest reads. */
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

/** A minimal, schema-shaped BuildOutputT — only the fields formatBuildDigest reads. */
function buildOutput(overrides: Partial<BuildOutputT> = {}): BuildOutputT {
  return {
    status: "success",
    summary: "",
    artifacts: [],
    notes_for_next_agent: "",
    changed_files: [],
    commit_message: "",
    ...overrides,
  };
}

interface FakeEntry {
  issue: Issue;
  state: WatchState;
  marker: WatchMarker | null;
  comments: IssueComment[];
}

/** Every `<prefix>:<state>` label `transition()`/`claim()` strip before adding one — mirrors `github_provider.ts`'s own `STATES` (not exported, so duplicated here; a self-contained test fixture already hardcodes the "piquette" prefix throughout this file). */
const FAKE_STATE_LABELS = new Set(
  (
    [
      "ready",
      "working",
      "review",
      "done",
      "blocked",
      "feedback",
      "spec-ready",
      "refining",
      "refined",
      "needs-feedback",
      "continue-refinement",
      "spec-in-progress",
      "split-proposed",
      "split-approved",
    ] as const
  ).map((s) => `piquette:${s}`),
);

/** In-memory fake — exactly the seam `provider.ts` exists for. */
class FakeProvider implements IssueProvider {
  entries = new Map<string, FakeEntry>();
  ensureLabelsCalls = 0;
  transitions: Array<{ id: string; to: WatchState; detail?: string }> = [];
  claimCalls: string[] = [];
  closedIssues: string[] = [];
  /** Set to make `closeIssue` reject — for asserting a failed close never blocks `finishSpec`/`finishReviews`/`rollUp`. */
  closeIssueError: Error | null = null;
  private nextCommentSeq = 1;

  /**
   * `opts.body` lets a test embed a hidden `piquette-refine:` marker (parent,
   * blocked_by, priority) the same way `core/refine.ts`'s `renderBody()`
   * would — see this file's `markerBody()` helper. `opts.extraLabels` lets a
   * test add a `piquette:priority:pN` (or any other) label alongside the state
   * label `addIssue` always sets. `opts.author` defaults to `"test-author"`
   * rather than leaving it unset, so an ordinary test never has to think
   * about `watch.allowed_authors` — only the tests that exercise it (see
   * `authorBlocked`'s own suite) set this explicitly.
   */
  addIssue(
    id: string,
    title: string,
    state: WatchState = "ready",
    marker: WatchMarker | null = null,
    opts: { body?: string; extraLabels?: string[]; author?: string } = {},
  ): void {
    this.entries.set(id, {
      issue: { id, title, body: opts.body ?? "", labels: [`piquette:${state}`, ...(opts.extraLabels ?? [])], author: opts.author ?? "test-author" },
      state,
      marker,
      comments: [],
    });
  }

  /**
   * Seed a comment directly onto an issue's thread — the fake's equivalent of
   * a human (or a prior `piquette watch` run) posting on the tracker, for tests
   * that need a resumed run's `listComments` to see it. `createdAt` defaults
   * to a synthetic, strictly-increasing timestamp (not the real clock) so
   * ordering across several `addComment` calls in one test is deterministic.
   */
  addComment(issueId: string, author: string, body: string, createdAt?: string): void {
    const entry = this.entries.get(issueId)!;
    const created_at = createdAt ?? new Date(this.nextCommentSeq * 1000).toISOString();
    entry.comments.push({ id: String(this.nextCommentSeq++), author, created_at, body });
  }

  async ensureLabels(): Promise<EnsureLabelsResult> {
    this.ensureLabelsCalls++;
    return { created: [], updated: [], unchanged: [] };
  }
  async listEligible(): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === "ready").map((e) => e.issue);
  }
  async listInState(state: WatchState): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === state).map((e) => e.issue);
  }
  /** Relabels on a successful claim, like the real providers do — the frontier check (`getIssue`) and `orderEligible` both read labels, not `entry.state`, so a fake that only moved `entry.state` would silently pass a blocker check it shouldn't. */
  private relabel(entry: FakeEntry, to: WatchState): void {
    entry.issue = { ...entry.issue, labels: [...entry.issue.labels.filter((l) => !FAKE_STATE_LABELS.has(l)), `piquette:${to}`] };
  }
  async claim(issue: Issue, opts?: { from?: WatchState; to?: WatchState }): Promise<boolean> {
    this.claimCalls.push(issue.id);
    const entry = this.entries.get(issue.id)!;
    const from = opts?.from ?? "ready";
    const to = opts?.to ?? "working";
    if (entry.state !== from) return false;
    entry.state = to;
    this.relabel(entry, to);
    return true;
  }
  async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    const entry = this.entries.get(issue.id)!;
    entry.state = to;
    this.relabel(entry, to);
    this.transitions.push({ id: issue.id, to, detail });
  }
  async comment(issue: Issue, body: string): Promise<void> {
    this.addComment(issue.id, "piquette", body);
  }
  async readMarker(issue: Issue): Promise<WatchMarker | null> {
    return this.entries.get(issue.id)?.marker ?? null;
  }
  async writeMarker(issue: Issue, marker: WatchMarker): Promise<void> {
    this.entries.get(issue.id)!.marker = marker;
  }
  async listComments(issue: Issue): Promise<IssueComment[]> {
    return this.entries.get(issue.id)?.comments ?? [];
  }
  async closeIssue(issue: Issue): Promise<void> {
    if (this.closeIssueError) throw this.closeIssueError;
    this.closedIssues.push(issue.id);
  }
  async getIssue(id: string): Promise<Issue | null> {
    return this.entries.get(id)?.issue ?? null;
  }
  /**
   * Not part of `IssueProvider` — `listChildren` lives on
   * `IssueAuthoringProvider` instead (GitHub and Jira both implement it in
   * production; see `provider.ts`'s doc comment), so this is a plain
   * convenience a roll-up test wires directly into `WatchDeps.listChildren`
   * (`{ listChildren: (parent) => provider.listChildren(parent) }`), mirroring
   * how `cli/commands/watch.ts` wires whichever real provider is
   * authoring-capable. Reads the same hidden `piquette-refine:` marker
   * `getIssue`/`orderEligible` do.
   */
  async listChildren(parent: Issue): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => parseRefineMarker(e.issue.body).parent === parent.id).map((e) => e.issue);
  }
}

/**
 * In-memory fake `CodeHostProvider` — separate from `FakeProvider`, mirroring
 * the real split. Implements the OPTIONAL `listPrComments` by default (most
 * tests want it present); a test asserting the "host can't list PR comments"
 * degrade builds its own bare object literal instead of this class — see
 * the `feedback` revision tests below.
 */
class FakeCodeHost implements CodeHostProvider {
  prs = new Map<number, PrStatus>();
  openedPrs: Array<{ title: string; branch: string; body: string }> = [];
  prComments = new Map<number, PrComment[]>();
  nextPrNumber = 1000;
  /** Errors thrown by successive `openPr` calls, one per call; once drained `openPr` succeeds. */
  openPrErrors: Error[] = [];
  /** When set, EVERY `openPr` call throws this (a persistent outage). */
  openPrAlwaysError: Error | null = null;
  openPrCalls = 0;
  /** What `findOpenPr` reports — set to simulate a PR that already exists for the branch. */
  existingOpenPr: PrRef | null = null;
  /** The live body `updatePrBody` reads/writes, keyed by PR number — seeded by `openPr` (and directly by a test, to simulate a PR this fake never itself opened). */
  prBodies = new Map<number, string>();
  /** Every `updatePrBody` call's PR number, in order — for asserting it fired (or didn't) without caring about the resulting body text. */
  updatePrBodyCalls: number[] = [];
  /** Set to make `updatePrBody` reject — for asserting a failed body refresh degrades to a log, never blocking the landing it's decorating. */
  updatePrBodyError: Error | null = null;

  async findOpenPr(): Promise<PrRef | null> {
    return this.existingOpenPr;
  }
  async openPr(opts: { branch: string; title: string; body: string }): Promise<PrRef> {
    this.openPrCalls++;
    if (this.openPrAlwaysError) throw this.openPrAlwaysError;
    const queued = this.openPrErrors.shift();
    if (queued) throw queued;
    const number = this.nextPrNumber++;
    this.openedPrs.push({ title: opts.title, branch: opts.branch, body: opts.body });
    this.prs.set(number, { merged: false, state: "open", ciStatus: "pending" });
    this.prBodies.set(number, opts.body);
    return { number, branch: opts.branch, url: `https://example.invalid/pr/${number}` };
  }
  async prStatus(pr: PrRef): Promise<PrStatus> {
    return this.prs.get(pr.number) ?? { merged: false, state: "open", ciStatus: "pending" };
  }
  async listPrComments(pr: PrRef): Promise<PrComment[]> {
    return this.prComments.get(pr.number) ?? [];
  }
  async updatePrBody(pr: PrRef, rewrite: (current: string) => string): Promise<void> {
    this.updatePrBodyCalls.push(pr.number);
    if (this.updatePrBodyError) throw this.updatePrBodyError;
    this.prBodies.set(pr.number, rewrite(this.prBodies.get(pr.number) ?? ""));
  }
}

function fakeGit(overrides: Partial<GitHandle> = {}): GitHandle {
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
    diffFiles: () => [],
    diffStat: () => "",
    diffCounts: () => [0, 0],
    diffText: () => "",
    fetch: () => {},
    worktreeAdd: () => {},
    worktreeRemove: () => {},
    branchAt: () => {},
    deleteLocalBranch: () => {},
    push: () => {},
    ...overrides,
  };
}

/**
 * One private root per test process: `issueLockPath`'s `locks/` is a sibling
 * of `worktreesDir`, so a fixed `worktreesDir` under the shared tmpdir would
 * put every lock in a machine-wide `locks/` that concurrent runs collide on
 * (#118).
 */
const scratchRoot = mkdtempSync(path.join(tmpdir(), "piquette-watch-test-"));
after(() => rmSync(scratchRoot, { recursive: true, force: true }));

function makeDeps(provider: FakeProvider, codeHost: CodeHostProvider, overrides: Partial<WatchDeps> = {}): WatchDeps {
  return {
    provider,
    codeHost,
    git: fakeGit(),
    worktreeGit: () => fakeGit({ diffFiles: () => ["src/index.ts"] }), // a real commit landed, by default
    labelPrefix: "piquette",
    chain: "plan-build-test",
    baseBranch: "main",
    concurrency: 2,
    // `[]` by default, like WatchConfigSchema's own default — a test that
    // doesn't override this never exercises watch.allowed_authors at all.
    allowedAuthors: [],
    // `{}` by default, like WatchConfigSchema's own default — a test that
    // doesn't override this never sees a chainOptions field at all in what
    // runChain/runRefine receive.
    chainOptions: {},
    // Off by default, like WatchRefineConfigSchema itself — a test that
    // doesn't override these never touches the refine lane at all.
    refineEnabled: false,
    refineConcurrency: 1,
    refineChain: "refine",
    runRefine: async (opts): Promise<RefineRunResult> => ({ accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [], split: [] }),
    worktreesDir: path.join(scratchRoot, "worktrees"),
    linkDataDir: () => {},
    dryRun: false,
    runChain: async (): Promise<ChainRunResult> => ({ accepted: true, adwId: "issue-1", detail: "" }),
    log: () => {},
    notify: () => {},
    // No real backoff by default: a test whose fakes throw a transient error before the chain would otherwise sleep 1+3+9s.
    retry: { sleep: async () => {} },
    ...overrides,
  };
}

/** Collects every `deps.notify(...)` call, for asserting kinds/levels without a real channel. */
function collectNotifications(): { events: NotifyEvent[]; notify: (event: NotifyEvent) => void } {
  const events: NotifyEvent[] = [];
  return { events, notify: (event) => events.push(event) };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The exact hidden-block shape `core/refine.ts`'s `renderBody()` writes and `parseRefineMarker` reads back — see `refine.test.ts`'s own round-trip coverage of that encoding. A test-only shortcut for embedding one directly in a fake issue's `body`, without going through `publish()`. */
function markerBody(marker: { parent?: string | null; blocked_by?: string[]; priority?: string } = {}): string {
  return `<!-- piquette-refine: ${JSON.stringify({ parent: marker.parent ?? null, blocked_by: marker.blocked_by ?? [], priority: marker.priority ?? "p2" })} -->`;
}

test("branchNameFor: sanitizes a title into a safe branch name", () => {
  assert.equal(branchNameFor({ id: "42", title: "Add a /health endpoint!!", body: "", labels: [] }), "piquette-watch/42-add-a-health-endpoint");
  assert.equal(branchNameFor({ id: "7", title: "", body: "", labels: [] }), "piquette-watch/7-issue");
  assert.equal(branchNameFor({ id: "PROJ-123", title: "Fix the thing", body: "", labels: [] }), "piquette-watch/PROJ-123-fix-the-thing");
});

test("claimNewWork: clears a stale worktree/branch from a killed prior attempt before creating a fresh one", async () => {
  const provider = new FakeProvider();
  provider.addIssue("2", "Retry me");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const calls: string[] = [];
  // Simulates a `piquette watch` process killed mid-run for this exact issue: a
  // real `git.worktreeAdd` would refuse outright with "fatal: a branch
  // named '...' already exists" until the leftover branch is cleared.
  let branchExists = true;
  const deps = makeDeps(provider, codeHost, {
    git: fakeGit({
      worktreeRemove: (p) => calls.push(`remove:${p}`),
      deleteLocalBranch: (n) => {
        calls.push(`delete-branch:${n}`);
        branchExists = false;
      },
      worktreeAdd: (p, b) => {
        if (branchExists) throw new Error(`fatal: a branch named '${b}' already exists`);
        calls.push(`add:${p}`);
      },
    }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  const branchIdx = calls.findIndex((c) => c.startsWith("delete-branch:"));
  const addIdx = calls.findIndex((c) => c.startsWith("add:"));
  assert.ok(branchIdx !== -1 && addIdx !== -1 && branchIdx < addIdx, `expected the stale branch cleared before worktreeAdd, got: ${calls.join(", ")}`);
  // The retry then succeeds normally, same as any other claim.
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
});

test("claimNewWork: claims a ready issue, runs the chain, opens a PR, and moves to review", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const linkedWorktrees: string[] = [];
  const deps = makeDeps(provider, codeHost, { linkDataDir: (worktreePath) => linkedWorktrees.push(worktreePath) });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.claimCalls, ["1"]);
  assert.equal(codeHost.openedPrs.length, 1);
  assert.match(codeHost.openedPrs[0]!.title, /^Add a \/health endpoint \(1\)/);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  assert.equal(provider.entries.get("1")!.marker?.pr, 1000);
  // linkDataDir must run before the chain does — otherwise the run's own
  // session/trace data resolves into the worktree's throwaway .piquette/data
  // instead of the main repo's persistent one (invisible in piquette ui, and
  // deleted along with the worktree on cleanup).
  assert.deepEqual(linkedWorktrees, [path.join(deps.worktreesDir, "issue-1")]);
});

test("claimNewWork: a rejected chain run blocks the issue with the failure detail", async () => {
  const provider = new FakeProvider();
  provider.addIssue("2", "Flaky feature");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    runChain: async () => ({ accepted: false, adwId: "issue-2", detail: "build-test failed at phase build" }),
    worktreeGit: () => fakeGit({ diffFiles: () => [] }), // nothing committed, so nothing to preserve
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.transitions, [{ id: "2", to: "blocked", detail: "build-test failed at phase build" }]);
  assert.equal(codeHost.openedPrs.length, 0);
});

test("claimNewWork: an accepted run with nothing committed also blocks, without opening a PR", async () => {
  const provider = new FakeProvider();
  provider.addIssue("3", "No-op request");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, { worktreeGit: () => fakeGit({ diffFiles: () => [] }) });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.equal(provider.transitions[0]?.to, "blocked");
  assert.match(provider.transitions[0]?.detail ?? "", /no committed changes/);
  assert.equal(codeHost.openedPrs.length, 0);
});

test("claimNewWork: never claims more than the concurrency budget in one tick", async () => {
  const provider = new FakeProvider();
  provider.addIssue("10", "one");
  provider.addIssue("11", "two");
  provider.addIssue("12", "three");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  // A runChain that never resolves keeps every claimed issue "inflight" for this assertion.
  const deps = makeDeps(provider, codeHost, { concurrency: 2, runChain: () => new Promise(() => {}) });

  await claimNewWork(deps, state);
  assert.equal(state.inflight.size, 2);
  assert.equal(provider.claimCalls.length, 2);
});

test("claimNewWork: dry-run claims nothing and calls neither claim() nor runChain", async () => {
  const provider = new FakeProvider();
  provider.addIssue("20", "dry run me");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let runChainCalled = false;
  const deps = makeDeps(provider, codeHost, {
    dryRun: true,
    runChain: async () => {
      runChainCalled = true;
      return { accepted: true, adwId: "x", detail: "" };
    },
  });

  await claimNewWork(deps, state);
  assert.equal(provider.claimCalls.length, 0);
  assert.equal(runChainCalled, false);
  assert.equal(provider.entries.get("20")!.state, "ready");
});

test("claimNewWork: an issue already locked by a live process is skipped before ever calling provider.claim()", async () => {
  const provider = new FakeProvider();
  provider.addIssue("21", "already being worked elsewhere");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost);
  const lockPath = issueLockPath(deps, "issue-21");
  // Simulates a second `piquette watch` process racing this one: something else
  // (this same test process's own pid always reads as alive) already holds
  // the per-issue lock claimNewWork must check before ever touching the
  // tracker — see core/watch.ts's issueLockPath doc comment.
  assert.equal(acquirePidLock(lockPath).ok, true);
  try {
    await claimNewWork(deps, state);
    assert.equal(provider.claimCalls.length, 0, "provider.claim() must never be reached while the lock is held");
    assert.equal(provider.entries.get("21")!.state, "ready");
  } finally {
    releasePidLock(lockPath);
  }

  // Once released, an ordinary tick claims it exactly like any other issue.
  await claimNewWork(deps, state);
  assert.deepEqual(provider.claimCalls, ["21"]);
});

// ── orderEligible: priority, sibling affinity, created-asc ──────────────

function issue(id: string, opts: { labels?: string[]; body?: string } = {}): Issue {
  return { id, title: `issue ${id}`, body: opts.body ?? "", labels: opts.labels ?? [] };
}

test("orderEligible: p0 sorts ahead of p2 regardless of creation order", () => {
  const older = issue("1", { labels: ["piquette:priority:p2"] });
  const newer = issue("2", { labels: ["piquette:priority:p0"] });
  const ordered = orderEligible([older, newer], new Map(), "piquette");
  assert.deepEqual(ordered.map((i) => i.id), ["2", "1"]);
});

test("orderEligible: sibling affinity breaks a tie within the same priority band, but never crosses bands", () => {
  const inflightParents = new Map([["100", "parent-A"]]); // issue 100 is in flight, its parent is parent-A
  const siblingOfInflight = issue("2", { labels: ["piquette:priority:p2"], body: markerBody({ parent: "parent-A" }) });
  const unrelated = issue("1", { labels: ["piquette:priority:p2"], body: markerBody({ parent: "parent-B" }) });
  const urgentUnrelated = issue("3", { labels: ["piquette:priority:p0"], body: markerBody({ parent: "parent-B" }) });

  const ordered = orderEligible([unrelated, siblingOfInflight, urgentUnrelated], inflightParents, "piquette");

  // p0 still wins outright, even though it has no affinity...
  assert.equal(ordered[0]!.id, "3");
  // ...but among the two p2 issues, the sibling of in-flight work goes first.
  assert.deepEqual(ordered.slice(1).map((i) => i.id), ["2", "1"]);
});

test("orderEligible: falls back to created (array) order as the final, stable tiebreaker", () => {
  const a = issue("1", { labels: ["piquette:priority:p2"] });
  const b = issue("2", { labels: ["piquette:priority:p2"] });
  const c = issue("3", { labels: ["piquette:priority:p2"] });
  const ordered = orderEligible([a, b, c], new Map(), "piquette");
  assert.deepEqual(ordered.map((i) => i.id), ["1", "2", "3"]);
});

test("orderEligible: a missing or corrupt marker sorts as p2 with no affinity, same as before this feature existed", () => {
  const noMarker = issue("1"); // no labels, no body at all
  const corrupt = issue("2", { body: "<!-- piquette-refine: {not json -->" });
  const explicitP2 = issue("3", { labels: ["piquette:priority:p2"] });
  const ordered = orderEligible([noMarker, corrupt, explicitP2], new Map(), "piquette");
  assert.deepEqual(ordered.map((i) => i.id), ["1", "2", "3"], "all p2, so creation order alone decides");
});

test("orderEligible: the label wins over the marker when they disagree — a human relabel is the override mechanism", () => {
  // Published as p0 (what the marker still says), but a human relabeled it down to p3.
  const relabeled = issue("1", { labels: ["piquette:priority:p3"], body: markerBody({ priority: "p0" }) });
  const stillP0 = issue("2", { labels: ["piquette:priority:p0"], body: markerBody({ priority: "p0" }) });
  const ordered = orderEligible([relabeled, stillP0], new Map(), "piquette");
  assert.deepEqual(ordered.map((i) => i.id), ["2", "1"], "the label, not the stale marker, decides");
});

// ── claimNewWork: the frontier — a blocker not yet piquette:done is skipped ───

test("claimNewWork: an issue with an unfinished blocker is not claimed", async () => {
  const provider = new FakeProvider();
  provider.addIssue("11", "the blocker", "working"); // not done yet
  provider.addIssue("10", "blocked leaf", "ready", null, { body: markerBody({ blocked_by: ["11"] }) });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await claimNewWork(makeDeps(provider, codeHost), state);

  assert.equal(provider.claimCalls.length, 0, "the blocker is not piquette:done yet, so nothing is claimed at all");
  assert.equal(provider.entries.get("10")!.state, "ready");
});

test("claimNewWork: the same issue claims once its blocker carries piquette:done", async () => {
  const provider = new FakeProvider();
  provider.addIssue("21", "the blocker", "done");
  provider.addIssue("20", "unblocked leaf", "ready", null, { body: markerBody({ blocked_by: ["21"] }) });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await claimNewWork(makeDeps(provider, codeHost), state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.claimCalls, ["20"]);
});

test("claimNewWork: a blocker that no longer exists (404) is treated as satisfied, not a permanent wedge", async () => {
  const provider = new FakeProvider();
  provider.addIssue("30", "leaf with a deleted blocker", "ready", null, { body: markerBody({ blocked_by: ["nonexistent"] }) });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await claimNewWork(makeDeps(provider, codeHost), state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.claimCalls, ["30"]);
});

// ── claimNewWork: watch.allowed_authors ──────────────────────────────────

test("claimNewWork: an empty allowed_authors (the default) never blocks anything, regardless of author", async () => {
  const provider = new FakeProvider();
  provider.addIssue("50", "anyone's issue", "ready", null, { author: "a-random-public-account" });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await claimNewWork(makeDeps(provider, codeHost, { allowedAuthors: [] }), state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.claimCalls, ["50"]);
});

test("claimNewWork: an issue authored by someone outside allowed_authors is refused — blocked, never claimed", async () => {
  const provider = new FakeProvider();
  provider.addIssue("51", "a public issue a collaborator mislabeled", "ready", null, { author: "someone-else" });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await claimNewWork(makeDeps(provider, codeHost, { allowedAuthors: ["iamfiscus"] }), state);

  assert.equal(provider.claimCalls.length, 0, "must never reach provider.claim() — refused before the lock/claim step");
  assert.deepEqual(provider.transitions.map((t) => t.to), ["blocked"]);
  assert.match(provider.transitions[0]!.detail ?? "", /someone-else/);
  assert.match(provider.transitions[0]!.detail ?? "", /allowed_authors/);
});

test("claimNewWork: an issue authored by an allowed_authors entry claims normally", async () => {
  const provider = new FakeProvider();
  provider.addIssue("52", "my own issue", "ready", null, { author: "iamfiscus" });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await claimNewWork(makeDeps(provider, codeHost, { allowedAuthors: ["iamfiscus"] }), state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.claimCalls, ["52"]);
});

test("claimNewWork: an issue with no author on record is refused once allowed_authors is non-empty — unknown is not trusted", async () => {
  const provider = new FakeProvider();
  provider.addIssue("53", "authorless fixture", "ready");
  provider.entries.get("53")!.issue.author = undefined; // simulates an Issue built before this field existed
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await claimNewWork(makeDeps(provider, codeHost, { allowedAuthors: ["iamfiscus"] }), state);

  assert.equal(provider.claimCalls.length, 0);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["blocked"]);
});

test("claimNewWork: dry-run logs what would be blocked but transitions nothing", async () => {
  const provider = new FakeProvider();
  provider.addIssue("54", "a public issue", "ready", null, { author: "someone-else" });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const logs: string[] = [];

  await claimNewWork(makeDeps(provider, codeHost, { allowedAuthors: ["iamfiscus"], dryRun: true, log: (m) => logs.push(m) }), state);

  assert.equal(provider.transitions.length, 0, "dry-run must never mutate the tracker");
  assert.ok(logs.some((l) => l.includes("[dry-run] would block")));
});

test("claimNewWork: a blocker shared by two leaves is fetched at most once per tick", async () => {
  const provider = new FakeProvider();
  provider.addIssue("41", "the shared blocker", "done");
  provider.addIssue("40", "leaf one", "ready", null, { body: markerBody({ blocked_by: ["41"] }) });
  provider.addIssue("42", "leaf two", "ready", null, { body: markerBody({ blocked_by: ["41"] }) });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let getIssueCalls = 0;
  const realGetIssue = provider.getIssue.bind(provider);
  provider.getIssue = async (id) => {
    if (id === "41") getIssueCalls++;
    return realGetIssue(id);
  };

  await claimNewWork(makeDeps(provider, codeHost, { concurrency: 2 }), state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.claimCalls.sort(), ["40", "42"]);
  assert.equal(getIssueCalls, 1, "the shared blocker is looked up once, not once per dependent");
});

// ── finishReviews: closes the leaf, and rolls a container up once every child is done ──

test("finishReviews: closes the issue when its PR merges", async () => {
  const provider = new FakeProvider();
  provider.addIssue("60", "shipped", "review", { pr: 610, branch: "piquette-watch/60-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(610, { merged: true, state: "closed", ciStatus: "success" });

  await finishReviews(makeDeps(provider, codeHost));

  assert.deepEqual(provider.closedIssues, ["60"]);
});

test("finishReviews: a closeIssue rejection leaves the issue done and open, without blocking the tick", async () => {
  const provider = new FakeProvider();
  provider.addIssue("61", "shipped but close fails", "review", { pr: 611, branch: "piquette-watch/61-x" });
  provider.closeIssueError = new Error("tracker unavailable");
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(611, { merged: true, state: "closed", ciStatus: "success" });

  await finishReviews(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("61")!.state, "done");
  assert.deepEqual(provider.closedIssues, [], "the failed close never reverted the transition");
});

test("finishReviews: rolls a container up to done + closed once every child is done", async () => {
  const provider = new FakeProvider();
  provider.addIssue("71", "child one", "done", null, { body: markerBody({ parent: "70" }) });
  provider.addIssue("72", "child two", "review", { pr: 620, branch: "piquette-watch/72-x" }, { body: markerBody({ parent: "70" }) });
  provider.addIssue("70", "the feature", "working"); // containers never carry a build-lane state in production, but rollUp only reads its own labels
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(620, { merged: true, state: "closed", ciStatus: "success" });
  const { events, notify } = collectNotifications();

  await finishReviews(makeDeps(provider, codeHost, { notify, listChildren: (parent) => provider.listChildren(parent) }));

  assert.equal(provider.entries.get("72")!.state, "done", "the child that just landed");
  assert.equal(provider.entries.get("70")!.state, "done", "the container rolls up once its last child lands");
  assert.deepEqual(provider.closedIssues.sort(), ["70", "72"]);
  assert.ok(events.some((e) => e.kind === "feature_done" && e.title.includes("70")));
});

test("finishReviews: a container with one unfinished child does not roll up", async () => {
  const provider = new FakeProvider();
  provider.addIssue("81", "child one — still working", "working", null, { body: markerBody({ parent: "80" }) });
  provider.addIssue("82", "child two", "review", { pr: 621, branch: "piquette-watch/82-x" }, { body: markerBody({ parent: "80" }) });
  provider.addIssue("80", "the feature");
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(621, { merged: true, state: "closed", ciStatus: "success" });

  await finishReviews(makeDeps(provider, codeHost, { listChildren: (parent) => provider.listChildren(parent) }));

  assert.equal(provider.entries.get("82")!.state, "done");
  assert.notEqual(provider.entries.get("80")!.state, "done", "child one is still working, so the container must not roll up yet");
  assert.deepEqual(provider.closedIssues, ["82"]);
});

test("finishReviews: a nested epic rolls up once its feature rolls up", async () => {
  const provider = new FakeProvider();
  provider.addIssue("91", "the only story", "review", { pr: 622, branch: "piquette-watch/91-x" }, { body: markerBody({ parent: "90" }) });
  provider.addIssue("90", "the feature", "working", null, { body: markerBody({ parent: "9" }) });
  provider.addIssue("9", "the epic");
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(622, { merged: true, state: "closed", ciStatus: "success" });

  await finishReviews(makeDeps(provider, codeHost, { listChildren: (parent) => provider.listChildren(parent) }));

  assert.equal(provider.entries.get("90")!.state, "done", "the feature rolls up once its one story lands");
  assert.equal(provider.entries.get("9")!.state, "done", "the epic then rolls up too, once its feature is done");
  assert.deepEqual(provider.closedIssues.sort(), ["9", "90", "91"]);
});

test("finishReviews: a container already done is never re-processed", async () => {
  const provider = new FakeProvider();
  provider.addIssue("101", "child", "review", { pr: 623, branch: "piquette-watch/101-x" }, { body: markerBody({ parent: "100" }) });
  provider.addIssue("100", "already-done feature", "done");
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(623, { merged: true, state: "closed", ciStatus: "success" });
  let listChildrenCalls = 0;
  const deps = makeDeps(provider, codeHost, {
    listChildren: (parent) => {
      listChildrenCalls++;
      return provider.listChildren(parent);
    },
  });

  await finishReviews(deps);

  assert.equal(listChildrenCalls, 0, "getIssue already saw piquette:done on the container and returned before ever listing its children");
});

test("finishReviews: with no listChildren wired, roll-up is a logged no-op, not a failure", async () => {
  const provider = new FakeProvider();
  provider.addIssue("111", "child", "review", { pr: 624, branch: "piquette-watch/111-x" }, { body: markerBody({ parent: "110" }) });
  provider.addIssue("110", "the feature");
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(624, { merged: true, state: "closed", ciStatus: "success" });

  // makeDeps's default has no listChildren wired — any tracker without
  // authoring support (or a caller that simply didn't wire it) behaves
  // this way; GitHub and Jira both DO implement it in production.
  await finishReviews(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("111")!.state, "done", "the leaf itself still finishes normally");
  assert.notEqual(provider.entries.get("110")!.state, "done", "no listChildren means no roll-up is even attempted");
});

test("reconcileOrphans: a working issue with an open PR in its marker resumes as review", async () => {
  const provider = new FakeProvider();
  provider.addIssue("30", "orphaned mid-review", "working", { pr: 500, branch: "piquette-watch/30-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(500, { merged: false, state: "open", ciStatus: "pending" });
  const state = createWatchState();

  await reconcileOrphans(makeDeps(provider, codeHost), state);

  assert.deepEqual(provider.transitions, [{ id: "30", to: "review", detail: undefined }]);
});

test("reconcileOrphans: a working issue with a real (but PR-less) marker retries up to the cap, then blocks", async () => {
  const provider = new FakeProvider();
  // A marker piquette itself wrote (worktree/branch/attempt:0, no `pr` yet) — a
  // genuine crash between claiming and opening a PR, unlike the null-marker
  // case below.
  provider.addIssue("31", "orphaned mid-build", "working", { worktree: "/tmp/31", branch: "piquette-watch/31-x", attempt: 0 });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost);

  await reconcileOrphans(deps, state); // attempt 1 -> ready
  assert.equal(provider.entries.get("31")!.state, "ready");
  assert.equal(provider.entries.get("31")!.marker?.attempt, 1);

  provider.entries.get("31")!.state = "working"; // simulate it getting re-claimed and orphaned again
  await reconcileOrphans(deps, state); // attempt 2 -> ready
  assert.equal(provider.entries.get("31")!.state, "ready");

  provider.entries.get("31")!.state = "working";
  await reconcileOrphans(deps, state); // attempt 3 exceeds MAX_ORPHAN_ATTEMPTS (2) -> blocked
  assert.equal(provider.entries.get("31")!.state, "blocked");
  assert.match(provider.transitions.at(-1)?.detail ?? "", /Gave up after 2 orphaned attempts/);
});

test("reconcileOrphans: a working issue with NO marker at all was never piquette's — left alone, not reset to ready", async () => {
  const provider = new FakeProvider();
  // Nothing ever wrote a `piquette-watch:` marker on this issue — e.g. a GitHub
  // Projects workflow (not piquette) moved it into the same Status option
  // `status_map.working` maps to, say by linking a PR to it. See issue
  // #104/PR #103 vs. piquette's own #105 in a consumer repo: the old
  // behavior treated this as an orphan, reset it to `ready`, and
  // `claimNewWork` re-claimed and rebuilt a fix someone else already had
  // in flight.
  provider.addIssue("33", "a human is already on this", "working", null);
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await reconcileOrphans(makeDeps(provider, codeHost), state);

  assert.equal(provider.entries.get("33")!.state, "working", "must stay exactly where it was");
  assert.equal(provider.transitions.length, 0, "no transition — piquette never claimed this issue, so it's not piquette's to reclaim");
});

test("reconcileOrphans: skips issues this process is already tracking as in-flight", async () => {
  const provider = new FakeProvider();
  provider.addIssue("32", "actually still running", "working", null);
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  state.inflight.add("32");

  await reconcileOrphans(makeDeps(provider, codeHost), state);

  assert.equal(provider.transitions.length, 0, "an in-flight issue must not be treated as orphaned");
});

test("finishReviews: a merged PR moves the issue to done", async () => {
  const provider = new FakeProvider();
  provider.addIssue("40", "shipped", "review", { pr: 600, branch: "piquette-watch/40-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(600, { merged: true, state: "closed", ciStatus: "success" });

  await finishReviews(makeDeps(provider, codeHost));

  assert.deepEqual(provider.transitions, [{ id: "40", to: "done", detail: undefined }]);
});

test("finishReviews: a closed-without-merging PR blocks the issue", async () => {
  const provider = new FakeProvider();
  provider.addIssue("41", "rejected", "review", { pr: 601, branch: "piquette-watch/41-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(601, { merged: false, state: "closed", ciStatus: "failure" });

  await finishReviews(makeDeps(provider, codeHost));

  assert.equal(provider.transitions[0]?.to, "blocked");
  assert.match(provider.transitions[0]?.detail ?? "", /closed without merging/);
});

test("finishReviews: a still-open PR leaves the issue in review", async () => {
  const provider = new FakeProvider();
  provider.addIssue("42", "still cooking", "review", { pr: 602, branch: "piquette-watch/42-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(602, { merged: false, state: "open", ciStatus: "pending" });

  await finishReviews(makeDeps(provider, codeHost));

  assert.equal(provider.transitions.length, 0);
  assert.equal(provider.entries.get("42")!.state, "review");
});

// ── notifications ────────────────────────────────────────────────────────────

test("claim -> PR opened -> merged fires issue_claimed (info), pr_opened (notice), then issue_done (notice)", async () => {
  const provider = new FakeProvider();
  provider.addIssue("50", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, { notify });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);
  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "pr_opened"]);
  // pr_opened is a standing ask for a human reviewer — same "needs a human"
  // bucket as issue_blocked's "notice", not a routine "info" milestone.
  assert.deepEqual(
    events.map((e) => e.level),
    ["info", "notice"],
  );

  codeHost.prs.set(1000, { merged: true, state: "closed", ciStatus: "success" });
  await finishReviews(deps);
  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "pr_opened", "issue_done"]);
  assert.equal(events.at(-1)!.level, "notice");
});

test("a rejected chain run fires issue_blocked at notice level", async () => {
  const provider = new FakeProvider();
  provider.addIssue("51", "Flaky feature");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    notify,
    runChain: async () => ({ accepted: false, adwId: "issue-51", detail: "build-test failed" }),
    worktreeGit: () => fakeGit({ diffFiles: () => [] }), // nothing committed, so nothing to preserve
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  const blocked = events.filter((e) => e.kind === "issue_blocked");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.level, "notice");
  assert.equal(blocked[0]!.detail, "build-test failed");
});

test("an accepted run with nothing committed fires issue_blocked", async () => {
  const provider = new FakeProvider();
  provider.addIssue("52", "No-op request");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, { notify, worktreeGit: () => fakeGit({ diffFiles: () => [] }) });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "issue_blocked"]);
  assert.match(events[1]!.detail ?? "", /no committed changes/);
});

test("an exception mid-runIssue fires watch_error at error level", async () => {
  const provider = new FakeProvider();
  provider.addIssue("53", "Explodes");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    notify,
    runChain: async () => {
      throw new Error("kaboom");
    },
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  const errors = events.filter((e) => e.kind === "watch_error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.level, "error");
  assert.match(errors[0]!.detail ?? "", /kaboom/);
});

test("finishReviews: a closed-without-merging PR fires issue_blocked", async () => {
  const provider = new FakeProvider();
  provider.addIssue("54", "rejected", "review", { pr: 700, branch: "piquette-watch/54-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(700, { merged: false, state: "closed", ciStatus: "failure" });
  const { events, notify } = collectNotifications();

  await finishReviews(makeDeps(provider, codeHost, { notify }));

  assert.deepEqual(events.map((e) => e.kind), ["issue_blocked"]);
  assert.equal(events[0]!.level, "notice");
});

test("reconcileOrphans: giving up past the retry cap fires issue_blocked", async () => {
  const provider = new FakeProvider();
  provider.addIssue("55", "orphaned, no marker", "working", { attempt: 2 }); // one more push exceeds MAX_ORPHAN_ATTEMPTS (2)
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();

  await reconcileOrphans(makeDeps(provider, codeHost, { notify }), state);

  assert.deepEqual(events.map((e) => e.kind), ["issue_blocked"]);
  assert.match(events[0]!.detail ?? "", /Gave up after 2 orphaned attempts/);
});

test("reconcileOrphans: a routine orphan resume/retry notifies nothing — only the terminal give-up does", async () => {
  const provider = new FakeProvider();
  provider.addIssue("56", "orphaned, resumable", "working", { pr: 800, branch: "piquette-watch/56-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(800, { merged: false, state: "open", ciStatus: "pending" });
  const state = createWatchState();
  const { events, notify } = collectNotifications();

  await reconcileOrphans(makeDeps(provider, codeHost, { notify }), state);

  assert.deepEqual(events, []);
});

// ── the review digest threaded into the PR + pr_opened notification ────────

test("claimNewWork: a reviewSummary from runChain lands in the PR body and the pr_opened event's detail/fields", async () => {
  const provider = new FakeProvider();
  provider.addIssue("60", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    notify,
    runChain: async (opts) => ({
      accepted: true,
      adwId: opts.adwId,
      detail: "",
      reviewRequired: true,
      reviewSummary: "Reviewer verdict: changes requested.\nBlocking:\n- add a test",
    }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.match(codeHost.openedPrs[0]!.body, /Automated by `piquette watch`/);
  assert.match(codeHost.openedPrs[0]!.body, /Reviewer verdict: changes requested\.\nBlocking:\n- add a test/);
  const prOpened = events.find((e) => e.kind === "pr_opened")!;
  assert.equal(prOpened.detail, "Reviewer verdict: changes requested.\nBlocking:\n- add a test");
  assert.deepEqual(prOpened.fields.find(([k]) => k === "review"), ["review", "reviewed"]);
});

test("claimNewWork: a reviewer-required chain with no readable verdict says so, distinctly from no reviewer at all", async () => {
  const provider = new FakeProvider();
  provider.addIssue("61", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    notify,
    runChain: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", reviewRequired: true }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.match(codeHost.openedPrs[0]!.body, /no verdict could be read back/);
  const prOpened = events.find((e) => e.kind === "pr_opened")!;
  assert.deepEqual(prOpened.fields.find(([k]) => k === "review"), ["review", "reviewer ran, no verdict"]);
});

test("claimNewWork: a chain with no reviewer step says nothing reviewed this change", async () => {
  const provider = new FakeProvider();
  provider.addIssue("62", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  // makeDeps' default runChain returns neither reviewRequired nor reviewSummary.
  const deps = makeDeps(provider, codeHost, { notify });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.match(codeHost.openedPrs[0]!.body, /Nothing reviewed this change — chain `plan-build-test` has no reviewer step\./);
  const prOpened = events.find((e) => e.kind === "pr_opened")!;
  assert.deepEqual(prOpened.fields.find(([k]) => k === "review"), ["review", "not reviewed"]);
});

// ── "What I did" (buildSummary): PR body section + ticket handoff comment ──

test("claimNewWork: a buildSummary from runChain lands as a '## What I did' section in the PR body, wrapped in markers", async () => {
  const provider = new FakeProvider();
  provider.addIssue("80", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    runChain: async (opts) => ({
      accepted: true,
      adwId: opts.adwId,
      detail: "",
      buildSummary: "Added a /health endpoint returning uptime.\n\nFiles changed (1):\n- `src/health.ts`",
    }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  const body = codeHost.openedPrs[0]!.body;
  assert.match(body, /## What I did\n\nAdded a \/health endpoint returning uptime\./);
  assert.match(body, /^<!-- piquette:pr-body -->/);
  assert.match(body, /<!-- \/piquette:pr-body -->$/);
});

test("claimNewWork: no buildSummary (DB read/parse failed, or no BuildOutput at all) omits the section without blocking the PR", async () => {
  const provider = new FakeProvider();
  provider.addIssue("81", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  // makeDeps' default runChain returns no buildSummary.
  const deps = makeDeps(provider, codeHost, {});

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.doesNotMatch(codeHost.openedPrs[0]!.body, /## What I did/);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
});

test("claimNewWork: the buildSummary also lands as the ticket's review-transition comment", async () => {
  const provider = new FakeProvider();
  provider.addIssue("82", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    runChain: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", buildSummary: "Added a /health endpoint." }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.equal(provider.transitions.length, 1);
  assert.equal(provider.transitions[0]!.to, "review");
  assert.match(provider.transitions[0]!.detail ?? "", /\*\*What I did:\*\* Added a \/health endpoint\./);
  assert.match(provider.transitions[0]!.detail ?? "", /PR #1000 is open for review\./);
});

test("claimNewWork: no buildSummary means no review-transition comment — a bare label flip, same as before this feature", async () => {
  const provider = new FakeProvider();
  provider.addIssue("83", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {});

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.equal(provider.transitions.length, 1);
  assert.equal(provider.transitions[0]!.detail, undefined);
});

test("landing: an adopted PR's body is refreshed with this run's buildSummary, not silently discarded", async () => {
  const provider = new FakeProvider();
  provider.addIssue("84", "Adopt me");
  const codeHost = new FakeCodeHost();
  codeHost.existingOpenPr = { number: 77, branch: "piquette-watch/84-adopt-me", url: "https://example.invalid/pr/77" };
  codeHost.prBodies.set(77, "some prior body a human may have edited");
  const deps = makeDeps(provider, codeHost, {
    retry: noSleep,
    runChain: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", buildSummary: "Added a /health endpoint." }),
  });

  await runOne(deps);

  assert.equal(codeHost.openPrCalls, 0, "adopted, not opened");
  assert.deepEqual(codeHost.updatePrBodyCalls, [77]);
  assert.match(codeHost.prBodies.get(77)!, /## What I did\n\nAdded a \/health endpoint\./);
});

// ── branchNameFor's round suffix ────────────────────────────────────────

test("branchNameFor: round 0 (default) is byte-identical to before the feedback lane existed", () => {
  assert.equal(branchNameFor({ id: "42", title: "Add a /health endpoint!!", body: "", labels: [] }, 0), "piquette-watch/42-add-a-health-endpoint");
});

test("branchNameFor: round > 0 appends an -rN suffix, without exceeding the un-suffixed name's own length budget", () => {
  const issue = { id: "42", title: "Add a /health endpoint!!", body: "", labels: [] };
  assert.equal(branchNameFor(issue, 1), "piquette-watch/42-add-a-health-endpoint-r1");
  assert.equal(branchNameFor(issue, 2), "piquette-watch/42-add-a-health-endpoint-r2");
});

// ── the feedback revision loop ──────────────────────────────────────────

function prComment(author: string, created_at: string, body: string, extra: Partial<PrComment> = {}): PrComment {
  return { id: `${author}-${created_at}`, author, created_at, body, ...extra };
}

test("claimFeedback: an open PR gets rebuilt from its own branch head and updated in place — no new PR, corrections folded into the prompt", async () => {
  const provider = new FakeProvider();
  provider.addIssue("70", "Add auth", "feedback", { pr: 900, branch: "piquette-watch/70-add-auth", attempt: 0 });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(900, { merged: false, state: "open", ciStatus: "pending" });
  codeHost.prComments.set(900, [prComment("alice", "2020-01-02T00:00:00.000Z", "Please add a test for the 401 case.")]);
  const state = createWatchState();
  const fetchCalls: string[] = [];
  const worktreeAddCalls: Array<{ path: string; branch: string; startPoint: string }> = [];
  let seenPrompt = "";
  const deps = makeDeps(provider, codeHost, {
    git: fakeGit({
      fetch: (remote, ref) => fetchCalls.push(`${remote}/${ref}`),
      worktreeAdd: (path, branch, startPoint) => worktreeAddCalls.push({ path, branch, startPoint }),
    }),
    runChain: async (opts) => {
      seenPrompt = opts.prompt;
      return { accepted: true, adwId: opts.adwId, detail: "" };
    },
  });

  await claimFeedback(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.equal(codeHost.openedPrs.length, 0, "must not open a second PR");
  assert.deepEqual(fetchCalls, ["origin/piquette-watch/70-add-auth"], "fetches the PR's OWN branch, not origin/base");
  assert.deepEqual(worktreeAddCalls, [
    { path: path.join(deps.worktreesDir, "issue-70"), branch: "piquette-watch/70-add-auth", startPoint: "origin/piquette-watch/70-add-auth" },
  ]);
  assert.match(seenPrompt, /Corrections to address \(round 1\)/);
  assert.match(seenPrompt, /Please add a test for the 401 case\./);
  assert.equal(provider.entries.get("70")!.marker?.pr, 900, "same PR number — never replaced");
  assert.equal(provider.entries.get("70")!.marker?.revision?.rounds, 1);
  assert.equal(provider.entries.get("70")!.state, "review");
  // The summary comment lands on the ISSUE (not a new PR body) — the PR
  // itself already exists and is already open.
  assert.match(provider.entries.get("70")!.comments.at(-1)!.body, /pushed a revision/);
});

test("claimFeedback: a revision rewrites the PR body with the new round's buildSummary, preserving anything a human appended below it — and posts exactly one comment, not two", async () => {
  const provider = new FakeProvider();
  provider.addIssue("85", "Add auth", "feedback", { pr: 910, branch: "piquette-watch/85-add-auth", attempt: 0 });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(910, { merged: false, state: "open", ciStatus: "pending" });
  codeHost.prComments.set(910, [prComment("alice", "2020-01-02T00:00:00.000Z", "Please add a test for the 401 case.")]);
  codeHost.prBodies.set(910, "<!-- piquette:pr-body -->\nround 1 content\n<!-- /piquette:pr-body -->\n\n@alice: still waiting on the test.");
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    runChain: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", buildSummary: "Added the 401 test case." }),
  });

  await claimFeedback(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(codeHost.updatePrBodyCalls, [910]);
  const body = codeHost.prBodies.get(910)!;
  assert.match(body, /## What I did\n\nAdded the 401 test case\./);
  assert.match(body, /@alice: still waiting on the test\./);
  assert.ok(!body.includes("round 1 content"));
  // Exactly one comment on the issue (the revision note) — no SECOND,
  // ticket-side "What I did" comment duplicating what the PR body now says.
  assert.equal(provider.entries.get("85")!.comments.length, 1);
  assert.match(provider.entries.get("85")!.comments[0]!.body, /pushed a revision/);
});

test("claimFeedback: a code host with no updatePrBody degrades cleanly — the revision still lands, just without refreshing the PR body", async () => {
  const provider = new FakeProvider();
  provider.addIssue("86", "Add auth", "feedback", { pr: 911, branch: "piquette-watch/86-add-auth", attempt: 0 });
  // A bare object literal, deliberately with no `updatePrBody` — the
  // OPTIONAL-method degrade this test exists to cover.
  const codeHost: CodeHostProvider = {
    openPr: async () => {
      throw new Error("must not be called");
    },
    prStatus: async () => ({ merged: false, state: "open", ciStatus: "pending" }),
    listPrComments: async () => [prComment("alice", "2020-01-02T00:00:00.000Z", "Please add a test for the 401 case.")],
  };
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    runChain: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", buildSummary: "Added the 401 test case." }),
  });

  await claimFeedback(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.equal(provider.entries.get("86")!.state, "review");
  assert.match(provider.entries.get("86")!.comments.at(-1)!.body, /pushed a revision/);
});

test("claimFeedback: a closed/declined PR gets a fresh -rN branch and a new PR that supersedes the old one", async () => {
  const provider = new FakeProvider();
  provider.addIssue("71", "Add auth", "feedback", { pr: 901, branch: "piquette-watch/71-add-auth" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(901, { merged: false, state: "closed", ciStatus: "failure" });
  codeHost.prComments.set(901, [prComment("bob", "2020-01-02T00:00:00.000Z", "Wrong approach — use middleware instead.")]);
  const state = createWatchState();
  const fetchCalls: string[] = [];
  const deps = makeDeps(provider, codeHost, {
    git: fakeGit({ fetch: (remote, ref) => fetchCalls.push(`${remote}/${ref}`) }),
  });

  await claimFeedback(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(fetchCalls, ["origin/main"], "no branch head to build on — fetches the base instead");
  assert.equal(codeHost.openedPrs.length, 1);
  assert.equal(codeHost.openedPrs[0]!.branch, "piquette-watch/71-add-auth-r1");
  assert.match(codeHost.openedPrs[0]!.body, /Supersedes PR #901/);
  assert.equal(provider.entries.get("71")!.marker?.pr, 1000, "a genuinely new PR number");
  assert.equal(provider.entries.get("71")!.marker?.revision?.rounds, 1);
  assert.equal(provider.entries.get("71")!.state, "review");
});

test("claimFeedback: no recorded PR blocks immediately — nothing to revise, the chain never runs", async () => {
  const provider = new FakeProvider();
  provider.addIssue("72", "Never pushed", "feedback", null);
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let ranChain = false;
  const deps = makeDeps(provider, codeHost, {
    runChain: async () => {
      ranChain = true;
      return { accepted: true, adwId: "x", detail: "" };
    },
  });

  await claimFeedback(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.equal(ranChain, false);
  assert.equal(provider.transitions[0]?.to, "blocked");
  assert.match(provider.transitions[0]?.detail ?? "", /no recorded PR/);
});

test("claimFeedback: a code host that can't list PR comments blocks with an explanation instead of running with no corrections", async () => {
  const provider = new FakeProvider();
  provider.addIssue("73", "Add auth", "feedback", { pr: 902, branch: "piquette-watch/73-add-auth" });
  // A bare object literal, deliberately with no `listPrComments` — the
  // OPTIONAL-method degrade this test exists to cover (see
  // `CodeHostProvider.listPrComments`'s own doc comment).
  const codeHost: CodeHostProvider = {
    openPr: async () => {
      throw new Error("must not be called");
    },
    prStatus: async () => ({ merged: false, state: "open", ciStatus: "pending" }),
  };
  const state = createWatchState();
  let ranChain = false;
  const deps = makeDeps(provider, codeHost, {
    runChain: async () => {
      ranChain = true;
      return { accepted: true, adwId: "x", detail: "" };
    },
  });

  await claimFeedback(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.equal(ranChain, false);
  assert.equal(provider.transitions[0]?.to, "blocked");
  assert.match(provider.transitions[0]?.detail ?? "", /can't list PR comments/);
});

test("claimFeedback: dry-run claims nothing and calls neither claim() nor runChain", async () => {
  const provider = new FakeProvider();
  provider.addIssue("74", "Add auth", "feedback", { pr: 903, branch: "piquette-watch/74-add-auth" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(903, { merged: false, state: "open", ciStatus: "pending" });
  const state = createWatchState();
  let ranChain = false;
  const deps = makeDeps(provider, codeHost, {
    dryRun: true,
    runChain: async () => {
      ranChain = true;
      return { accepted: true, adwId: "x", detail: "" };
    },
  });

  await claimFeedback(deps, state);
  assert.equal(provider.claimCalls.length, 0);
  assert.equal(ranChain, false);
  assert.equal(provider.entries.get("74")!.state, "feedback");
});

test("finishReviews: a closed-without-merging PR's invite comment names the feedback label and the PR — and leaves marker.pr intact for a later revision", async () => {
  const provider = new FakeProvider();
  provider.addIssue("75", "rejected", "review", { pr: 904, branch: "piquette-watch/75-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(904, { merged: false, state: "closed", ciStatus: "failure" });

  await finishReviews(makeDeps(provider, codeHost));

  assert.equal(provider.transitions[0]?.to, "blocked");
  assert.match(provider.transitions[0]?.detail ?? "", /piquette:feedback/);
  assert.match(provider.transitions[0]?.detail ?? "", /PR #904/);
  assert.equal(provider.entries.get("75")!.marker?.pr, 904, "the closed PR's number must survive for a later feedback claim to read");
});

test("claimNewWork: a ready re-claim of an issue that already pushed once uses a fresh round-suffixed branch, avoiding the BT-1967 non-fast-forward push rejection", async () => {
  const provider = new FakeProvider();
  // Simulates a human manually relabeling `blocked` (a declined PR) back to
  // `ready`, WITHOUT going through the `feedback` lane at all — the marker
  // still records the earlier push's `pr`/`revision`, exactly as
  // `openPrForWinner` leaves it, and `finishReviews`'s own blocked path
  // never clears it either.
  provider.addIssue("76", "Add x", "ready", { pr: 905, branch: "piquette-watch/76-add-x", revision: { rounds: 0, since: "2020-01-01T00:00:00.000Z" } });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const worktreeAddCalls: Array<{ branch: string; startPoint: string }> = [];
  const deps = makeDeps(provider, codeHost, {
    git: fakeGit({ worktreeAdd: (_path, branch, startPoint) => worktreeAddCalls.push({ branch, startPoint }) }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(worktreeAddCalls, [{ branch: "piquette-watch/76-add-x-r1", startPoint: "origin/main" }]);
  assert.equal(codeHost.openedPrs[0]!.branch, "piquette-watch/76-add-x-r1");
  assert.equal(provider.entries.get("76")!.marker?.revision?.rounds, 1);
});

// ── the refine lane ──────────────────────────────────────────────────────

test("refineBranchNameFor: same sanitizer as branchNameFor, different prefix", () => {
  assert.equal(refineBranchNameFor({ id: "9", title: "Team invitations spec", body: "", labels: [] }), "piquette-refine/9-team-invitations-spec");
});

test("claimSpecs: a disabled refine lane never lists spec-ready issues or claims anything", async () => {
  const provider = new FakeProvider();
  provider.addIssue("100", "A spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  provider.listInState = async () => {
    throw new Error("listInState should never be called when refineEnabled is false");
  };

  await claimSpecs(makeDeps(provider, codeHost, { refineEnabled: false }), state);

  assert.equal(provider.claimCalls.length, 0);
});

// ── claimSpecs: watch.allowed_authors ────────────────────────────────────

test("claimSpecs: a spec authored by someone outside allowed_authors is refused — blocked, never refined", async () => {
  const provider = new FakeProvider();
  provider.addIssue("102", "a public spec", "spec-ready", null, { author: "someone-else" });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    allowedAuthors: ["iamfiscus"],
    runRefine: async () => {
      throw new Error("runRefine should never be called for a disallowed author");
    },
  });

  await claimSpecs(deps, state);

  assert.equal(provider.claimCalls.length, 0);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["blocked"]);
  assert.match(provider.transitions[0]!.detail ?? "", /someone-else/);
});

test("claimSpecs: a spec authored by an allowed_authors entry refines normally", async () => {
  const provider = new FakeProvider();
  provider.addIssue("103", "my own spec", "spec-ready", null, { author: "iamfiscus" });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, { refineEnabled: true, allowedAuthors: ["iamfiscus"] });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(provider.claimCalls, ["103"]);
});

test("claimSpecs: claims a spec-ready spec, publishes, and moves it to spec-in-progress with a summary comment — NOT done yet", async () => {
  const provider = new FakeProvider();
  provider.addIssue("101", "Team invitations", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const comments: Array<{ id: string; body: string }> = [];
  provider.comment = async (issue, body) => {
    comments.push({ id: issue.id, body });
  };
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => ({
      accepted: true,
      adwId: opts.adwId,
      detail: "",
      created: [
        { id: "200", title: "Owner invites by email", kind: "story", isLeaf: true },
        { id: "199", title: "Invitations feature", kind: "feature", isLeaf: false },
      ],
      questions: [], split: [],
    }),
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(provider.claimCalls, ["101"]);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["spec-in-progress"], "published, but not done — nothing it produced has landed yet");
  assert.equal(comments.length, 1);
  assert.match(comments[0]!.body, /#200 \(story\): Owner invites by email/);
  assert.match(comments[0]!.body, /moves to `piquette:done` once every one of them does/);
  assert.deepEqual(provider.closedIssues, [], "not closed — a PM watching this spec must not see it as finished yet");
  assert.deepEqual(provider.entries.get("101")!.marker?.refined, ["200", "199"]);
});

test("claimSpecs: never claims more than refineConcurrency in one tick, independent of the build lane's own budget", async () => {
  const provider = new FakeProvider();
  provider.addIssue("110", "one spec", "spec-ready");
  provider.addIssue("111", "two spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    refineConcurrency: 1,
    runRefine: () => new Promise(() => {}), // never resolves — keeps the claim "in flight" for this assertion
  });

  await claimSpecs(deps, state);
  assert.equal(state.refining.size, 1);
  assert.equal(provider.claimCalls.length, 1);
});

test("claimSpecs: dry-run claims no spec and never calls runRefine", async () => {
  const provider = new FakeProvider();
  provider.addIssue("120", "dry run spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let called = false;
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    dryRun: true,
    runRefine: async (opts) => {
      called = true;
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [], split: [] };
    },
  });

  await claimSpecs(deps, state);
  assert.equal(provider.claimCalls.length, 0);
  assert.equal(called, false);
  assert.equal(provider.entries.get("120")!.state, "spec-ready");
});

test("claimSpecs: a spec already locked by a live process is skipped before ever calling provider.claim() — the restart-overlap race", async () => {
  const provider = new FakeProvider();
  provider.addIssue("121", "a prior attempt is still running", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, { refineEnabled: true });
  const lockPath = issueLockPath(deps, "spec-121");
  // Simulates exactly what caused BT-1789's "declared artifact does not
  // exist" failure: `piquette watch` restarted while an OLD process's runSpec for
  // this SAME spec (same deterministic worktree/context_handoff_dir — see
  // chains/steps.ts's clearStaleRefineOutputFiles doc comment) was still in
  // flight. Without this lock, both processes' claim() calls would succeed
  // and both would write into the same directory.
  assert.equal(acquirePidLock(lockPath).ok, true);
  try {
    await claimSpecs(deps, state);
    assert.equal(provider.claimCalls.length, 0, "provider.claim() must never be reached while the lock is held");
    assert.equal(provider.entries.get("121")!.state, "spec-ready");
  } finally {
    releasePidLock(lockPath);
  }

  await claimSpecs(deps, state);
  assert.deepEqual(provider.claimCalls, ["121"]);
});

test("claimSpecs: a rejected refine chain blocks the spec with the failure detail, without publishing anything", async () => {
  const provider = new FakeProvider();
  provider.addIssue("130", "unrefinable spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => ({ accepted: false, adwId: opts.adwId, detail: "refiner failed gates", created: [], questions: [], split: [] }),
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(provider.transitions, [{ id: "130", to: "blocked", detail: "refiner failed gates" }]);
});

test("claimSpecs: a re-claimed spec whose marker already lists published issues skips runRefine entirely", async () => {
  const provider = new FakeProvider();
  provider.addIssue("140", "already published", "spec-ready", { refined: ["300", "301"] });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let called = false;
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => {
      called = true;
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [], split: [] };
    },
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.equal(called, false, "to-tickets itself has no idempotency guard — this is the one this lane adds");
  assert.deepEqual(provider.transitions.map((t) => t.to), ["spec-in-progress"]);
});

test("reconcileRefining: a refining spec whose marker already lists published issues moves to spec-in-progress without re-running the refiner", async () => {
  const provider = new FakeProvider();
  provider.addIssue("150", "orphaned after publish", "refining", { refined: ["400"] });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await reconcileRefining(makeDeps(provider, codeHost, { refineEnabled: true }), state);

  assert.deepEqual(provider.transitions, [{ id: "150", to: "spec-in-progress", detail: undefined }]);
});

test("reconcileRefining: a refining spec with no marker retries up to the cap, then blocks", async () => {
  const provider = new FakeProvider();
  provider.addIssue("151", "orphaned, no marker", "refining", null);
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, { refineEnabled: true });

  await reconcileRefining(deps, state); // attempt 1 -> spec-ready
  assert.equal(provider.entries.get("151")!.state, "spec-ready");

  provider.entries.get("151")!.state = "refining";
  await reconcileRefining(deps, state); // attempt 2 -> spec-ready
  assert.equal(provider.entries.get("151")!.state, "spec-ready");

  provider.entries.get("151")!.state = "refining";
  await reconcileRefining(deps, state); // attempt 3 exceeds MAX_ORPHAN_ATTEMPTS (2) -> blocked
  assert.equal(provider.entries.get("151")!.state, "blocked");
  assert.match(provider.transitions.at(-1)?.detail ?? "", /Gave up after 2 orphaned refine attempts/);
});

test("reconcileRefining: a refining spec whose marker already has feedback finishes the transition to needs-feedback, without re-asking", async () => {
  const provider = new FakeProvider();
  // Simulates a crash between escalateSpec's writeMarker and its own
  // transition() call: the marker's feedback was written (and the question
  // comment posted) but the spec is still labeled "refining".
  provider.addIssue("153", "crashed mid-escalation", "refining", { feedback: { rounds: 1, asked_at: new Date(1000).toISOString() } });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();

  await reconcileRefining(makeDeps(provider, codeHost, { refineEnabled: true, notify }), state);

  assert.deepEqual(provider.transitions, [{ id: "153", to: "needs-feedback", detail: undefined }]);
  assert.deepEqual(events.map((e) => e.kind), ["spec_needs_feedback"]);
  assert.equal(events[0]!.level, "notice");
});

test("reconcileRefining: a disabled refine lane is a complete no-op", async () => {
  const provider = new FakeProvider();
  provider.addIssue("152", "should be ignored", "refining", null);
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  provider.listInState = async () => {
    throw new Error("listInState should never be called when refineEnabled is false");
  };

  await reconcileRefining(makeDeps(provider, codeHost, { refineEnabled: false }), state);

  assert.equal(provider.transitions.length, 0);
});

test("claim -> refine -> published fires issue_claimed then spec_refined, both info-level", async () => {
  const provider = new FakeProvider();
  provider.addIssue("160", "A spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    notify,
    runRefine: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", created: [{ id: "500", title: "A story", kind: "story", isLeaf: true }], questions: [], split: [] }),
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "spec_refined"]);
  assert.ok(events.every((e) => e.level === "info"));
});

// ── human-in-the-loop escalation ─────────────────────────────────────────

function sampleQuestion(overrides: Partial<{ id: string; question: string }> = {}) {
  return {
    id: "Q1",
    question: "Should invitations expire?",
    why_it_matters: "Changes the schema and the cleanup job.",
    options: ["7-day expiry", "never expire"],
    recommendation: "7-day expiry, matching the existing session TTL",
    evidence: ["src/core/session.ts"],
    ...overrides,
  };
}

test("claimSpecs: a refiner that raises questions escalates instead of publishing — needs-feedback, one notify, marker.feedback set, nothing created", async () => {
  const provider = new FakeProvider();
  provider.addIssue("200", "Ambiguous spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    notify,
    runRefine: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [sampleQuestion()], split: [] }),
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.equal(provider.entries.get("200")!.state, "needs-feedback");
  assert.deepEqual(provider.transitions.map((t) => t.to), ["needs-feedback"]);
  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "spec_needs_feedback"]);
  assert.equal(events[1]!.level, "notice", "spec_needs_feedback is the same class of event as issue_blocked — must reach an attention-scope channel");
  const marker = provider.entries.get("200")!.marker;
  assert.equal(marker?.feedback?.rounds, 1);
  assert.ok(marker?.feedback?.asked_at);
  assert.equal(marker?.refined, undefined, "an escalating round must not also record a publish");
  const comment = provider.entries.get("200")!.comments.at(-1)!;
  assert.match(comment.body, /Should invitations expire\?/);
  assert.match(comment.body, /Why it matters.*Changes the schema/s);
  assert.match(comment.body, /7-day expiry, matching the existing session TTL/);
  assert.match(comment.body, /piquette:continue-refinement/, "must tell the human which label resumes refinement");
});

test("claimSpecs: continue-refinement resumes the SAME adw_id as the original run, and leaves spec-ready specs untouched", async () => {
  const provider = new FakeProvider();
  provider.addIssue("201", "Escalated spec", "continue-refinement", { feedback: { rounds: 1, asked_at: new Date(1000).toISOString() } });
  provider.addIssue("202", "Untouched fresh spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const seenAdwIds: string[] = [];
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => {
      seenAdwIds.push(opts.adwId);
      return { accepted: true, adwId: opts.adwId, detail: "", created: [{ id: "600", title: "Resolved story", kind: "story", isLeaf: true }], questions: [], split: [] };
    },
  });

  await claimSpecs(deps, state, "continue-refinement");
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(provider.claimCalls, ["201"], "must not touch the spec-ready spec when claiming continue-refinement");
  assert.deepEqual(seenAdwIds, ["spec-201"], "the adw_id is deterministic from the issue id — a resume is the SAME id, not a new one");
  assert.equal(provider.entries.get("202")!.state, "spec-ready", "untouched");
});

test("claimSpecs: a second escalation round increments marker.feedback.rounds, re-enters needs-feedback, and threads the human's answer into the resumed prompt", async () => {
  const provider = new FakeProvider();
  provider.addIssue("203", "Still ambiguous after round 1", "continue-refinement", { feedback: { rounds: 1, asked_at: new Date(1000).toISOString() } });
  provider.addComment("203", "alice", "Let's go with 7-day expiry.");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const seenPrompts: string[] = [];
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => {
      seenPrompts.push(opts.prompt);
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [sampleQuestion({ id: "Q2", question: "And what about invitations already sent?" })], split: [] };
    },
  });

  await claimSpecs(deps, state, "continue-refinement");
  await waitUntil(() => state.refining.size === 0);

  assert.equal(provider.entries.get("203")!.state, "needs-feedback");
  assert.equal(provider.entries.get("203")!.marker?.feedback?.rounds, 2);
  assert.match(seenPrompts[0]!, /Let's go with 7-day expiry\./, "the human's answer must reach the resumed prompt");
});

test("tick: continue-refinement and spec-ready specs share the same refine.concurrency budget, resumed spec claimed first", async () => {
  const provider = new FakeProvider();
  provider.addIssue("210", "waiting for an answer", "continue-refinement", { feedback: { rounds: 1, asked_at: new Date(1000).toISOString() } });
  provider.addIssue("211", "brand new spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    refineConcurrency: 1,
    runRefine: () => new Promise(() => {}), // never resolves — keeps the claim "in flight" for this assertion
  });

  await tick(deps, state);

  assert.equal(state.refining.size, 1);
  assert.deepEqual(provider.claimCalls, ["210"], "the resumed spec must be claimed first, using up the shared budget");
  assert.equal(provider.entries.get("211")!.state, "spec-ready", "no budget left for the fresh spec this tick");
});

test("claimSpecs: dry-run never claims or runs an escalating spec either", async () => {
  const provider = new FakeProvider();
  provider.addIssue("212", "dry run escalation", "continue-refinement", { feedback: { rounds: 1, asked_at: new Date(1000).toISOString() } });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let called = false;
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    dryRun: true,
    runRefine: async (opts) => {
      called = true;
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [sampleQuestion()], split: [] };
    },
  });

  await claimSpecs(deps, state, "continue-refinement");

  assert.equal(called, false);
  assert.equal(provider.entries.get("212")!.state, "continue-refinement");
});

test("announceRefined: a decomposition that produced zero issues has nothing to wait on, so it goes straight to done and closes", async () => {
  const provider = new FakeProvider();
  provider.addIssue("220", "Nothing came out of this", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [], split: [] }),
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.equal(provider.entries.get("220")!.state, "done");
  assert.deepEqual(provider.closedIssues, ["220"]);
});

// ── finishTrackedSpecs: the spec itself isn't done until every issue it produced is ──

test("finishTrackedSpecs: a spec-in-progress spec with an unfinished refined issue is left alone — not done, not closed", async () => {
  const provider = new FakeProvider();
  provider.addIssue("230", "the work is still open", "spec-in-progress", { refined: ["700"] });
  provider.addIssue("700", "the only story", "ready"); // not piquette:done yet
  const codeHost = new FakeCodeHost();

  await finishTrackedSpecs(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("230")!.state, "spec-in-progress", "a PM must still see this as in progress, not done");
  assert.deepEqual(provider.closedIssues, []);
});

test("finishTrackedSpecs: closes the spec once every refined issue reaches piquette:done", async () => {
  const provider = new FakeProvider();
  provider.addIssue("231", "Ready to close", "spec-in-progress", { refined: ["701"] });
  provider.addIssue("701", "A story", "done");
  const codeHost = new FakeCodeHost();
  const { events, notify } = collectNotifications();

  await finishTrackedSpecs(makeDeps(provider, codeHost, { notify }));

  assert.equal(provider.entries.get("231")!.state, "done");
  assert.deepEqual(provider.closedIssues, ["231"]);
  assert.deepEqual(events.map((e) => e.kind), ["spec_done"]);
  assert.equal(events[0]!.level, "info");
});

test("finishTrackedSpecs: with several refined issues, ALL must be done — one still open holds the spec back", async () => {
  const provider = new FakeProvider();
  provider.addIssue("232", "partially done", "spec-in-progress", { refined: ["710", "711"] });
  provider.addIssue("710", "finished story", "done");
  provider.addIssue("711", "still working", "working");
  const codeHost = new FakeCodeHost();

  await finishTrackedSpecs(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("232")!.state, "spec-in-progress");
  assert.deepEqual(provider.closedIssues, []);
});

test("finishTrackedSpecs: a closeIssue that rejects still leaves the spec transitioned to done — a failed close never un-does completed work", async () => {
  const provider = new FakeProvider();
  provider.addIssue("233", "Close fails", "spec-in-progress", { refined: ["712"] });
  provider.addIssue("712", "A story", "done");
  provider.closeIssueError = new Error("tracker rejected the close");
  const codeHost = new FakeCodeHost();

  await finishTrackedSpecs(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("233")!.state, "done");
  assert.deepEqual(provider.closedIssues, []);
});

test("finishTrackedSpecs: a refined issue that no longer exists (404) is treated as done, not a permanent wedge", async () => {
  const provider = new FakeProvider();
  provider.addIssue("234", "one story was deleted", "spec-in-progress", { refined: ["deleted-id", "713"] });
  provider.addIssue("713", "the surviving story", "done");
  const codeHost = new FakeCodeHost();

  await finishTrackedSpecs(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("234")!.state, "done");
  assert.deepEqual(provider.closedIssues, ["234"]);
});

test("finishTrackedSpecs: a spec with no refined ids recorded is left alone, never assumed done", async () => {
  const provider = new FakeProvider();
  provider.addIssue("235", "no marker at all", "spec-in-progress", null);
  const codeHost = new FakeCodeHost();

  await finishTrackedSpecs(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("235")!.state, "spec-in-progress");
  assert.deepEqual(provider.closedIssues, []);
});

test("finishTrackedSpecs: a container among the refined ids counts as done only once rollUp already marked it so", async () => {
  // Mirrors a real tree: publish() created a feature (F1) and one story
  // under it (S1) — both ids land in WatchMarker.refined. The feature is
  // only piquette:done once finishReviews' rollUp already rolled it up (tested
  // separately); finishTrackedSpecs itself just reads the label, same as
  // for a leaf.
  const provider = new FakeProvider();
  provider.addIssue("236", "tree with a container", "spec-in-progress", { refined: ["240", "241"] });
  provider.addIssue("240", "the feature", "working"); // not yet rolled up
  provider.addIssue("241", "the story", "done");
  const codeHost = new FakeCodeHost();

  await finishTrackedSpecs(makeDeps(provider, codeHost));
  assert.equal(provider.entries.get("236")!.state, "spec-in-progress", "the feature container hasn't rolled up to done yet");

  await provider.transition(provider.entries.get("240")!.issue, "done"); // simulates rollUp() finishing the container
  await finishTrackedSpecs(makeDeps(provider, codeHost));
  assert.equal(provider.entries.get("236")!.state, "done", "now that the container is done too, the spec can close");
});

// ── buildSpecPrompt ──────────────────────────────────────────────────────

function specIssue(overrides: Partial<Issue> = {}): Issue {
  return { id: "1", title: "A spec", body: "Some body text.", labels: [], ...overrides };
}

function specComment(author: string, created_at: string, body: string): IssueComment {
  return { id: `${author}-${created_at}`, author, created_at, body };
}

test("buildSpecPrompt: no comments falls back to the plain title/body", () => {
  assert.equal(buildSpecPrompt(specIssue(), []), "A spec\n\nSome body text.");
});

test("buildSpecPrompt: omits the Priority section entirely when no priority is given — byte-identical to before this feature existed", () => {
  assert.equal(buildSpecPrompt(specIssue(), [], undefined, null), "A spec\n\nSome body text.");
  assert.equal(buildSpecPrompt(specIssue(), []), "A spec\n\nSome body text.", "and the same when the 4th arg is omitted entirely");
});

test("buildSpecPrompt: renders a ## Priority section, ahead of the discussion, when given one", () => {
  const prompt = buildSpecPrompt(specIssue(), [specComment("bob", "2020-01-01T00:00:00.000Z", "Some context.")], undefined, "p1");
  assert.match(prompt, /## Priority\n\nThis spec is labeled p1\./);
  assert.ok(prompt.indexOf("## Priority") < prompt.indexOf("## Discussion on the spec issue"));
});

test("buildSpecPrompt: with no prior escalation, every comment is 'earlier discussion'", () => {
  const prompt = buildSpecPrompt(specIssue(), [specComment("bob", "2020-01-01T00:00:00.000Z", "Some early context.")]);
  assert.match(prompt, /## Discussion on the spec issue/);
  assert.match(prompt, /### Earlier discussion\n\n\*\*@bob\*\* \(2020-01-01T00:00:00\.000Z\):\nSome early context\./);
  assert.ok(!prompt.includes("Answers to your open questions"));
});

test("buildSpecPrompt: comments at/after feedback.asked_at are the answers section; earlier ones stay 'earlier discussion', answers rendered first", () => {
  const comments = [
    specComment("bob", "2020-01-01T00:00:00.000Z", "Pre-escalation context."),
    specComment("alice", "2020-01-02T00:00:00.000Z", "Go with 7-day expiry."),
  ];
  const prompt = buildSpecPrompt(specIssue(), comments, { rounds: 1, asked_at: "2020-01-01T12:00:00.000Z" });

  assert.match(prompt, /### Answers to your open questions \(round 1\)\n\n\*\*@alice\*\*/);
  assert.match(prompt, /### Earlier discussion\n\n\*\*@bob\*\*/);
  assert.ok(prompt.indexOf("Answers to your open questions") < prompt.indexOf("Earlier discussion"), "answers must be surfaced before earlier discussion");
});

test("buildSpecPrompt: an oversized thread drops the oldest comments first and says so explicitly, never silently", () => {
  const comments = Array.from({ length: 5 }, (_, i) => specComment(`user${i}`, `2020-01-0${i + 1}T00:00:00.000Z`, "x".repeat(6000)));
  const prompt = buildSpecPrompt(specIssue(), comments);

  assert.match(prompt, /_\.\.\. \d+ earlier comment\(s\) omitted for length\._/);
  assert.ok(!prompt.includes("user0"), "the oldest comment must be the one dropped");
  assert.ok(prompt.includes("user4"), "the newest comment must survive");
});

// ── buildIssuePrompt ─────────────────────────────────────────────────────

test("buildIssuePrompt: no PR comments is byte-identical to the plain title/body prompt from before this feature existed", () => {
  assert.equal(buildIssuePrompt(specIssue()), "A spec\n\nSome body text.");
  assert.equal(buildIssuePrompt(specIssue(), []), "A spec\n\nSome body text.", "and the same for an explicitly empty list");
});

test("buildIssuePrompt: with no revision watermark, every PR comment is a correction — there's no earlier state to separate it from", () => {
  const prompt = buildIssuePrompt(specIssue(), [prComment("alice", "2020-01-01T00:00:00.000Z", "Please add a test.")]);
  assert.match(prompt, /## PR review comments/);
  assert.match(prompt, /### Corrections to address \(round 1\)\n\n\*\*@alice\*\* \(2020-01-01T00:00:00\.000Z\):\nPlease add a test\./);
  assert.ok(!prompt.includes("Earlier review discussion"));
});

test("buildIssuePrompt: comments at/after revision.since are corrections; earlier ones stay 'earlier review discussion', corrections rendered first", () => {
  const comments = [
    prComment("bob", "2020-01-01T00:00:00.000Z", "Looks reasonable so far."),
    prComment("alice", "2020-01-02T00:00:00.000Z", "Please add a test."),
  ];
  const prompt = buildIssuePrompt(specIssue(), comments, { rounds: 1, since: "2020-01-01T12:00:00.000Z" });

  assert.match(prompt, /### Corrections to address \(round 2\)\n\n\*\*@alice\*\*/);
  assert.match(prompt, /### Earlier review discussion\n\n\*\*@bob\*\*/);
  assert.ok(prompt.indexOf("Corrections to address") < prompt.indexOf("Earlier review discussion"), "corrections must be surfaced first");
});

test("buildIssuePrompt: renders an inline comment's file:line anchor and a review's verdict", () => {
  const comments = [
    prComment("alice", "2020-01-01T00:00:00.000Z", "This branch is unreachable.", { path: "src/index.ts", line: 42 }),
    prComment("bob", "2020-01-02T00:00:00.000Z", "Needs another pass before I can approve.", { verdict: "CHANGES_REQUESTED" }),
  ];
  const prompt = buildIssuePrompt(specIssue(), comments);

  assert.match(prompt, /\*\*@alice\*\* \(2020-01-01T00:00:00\.000Z\) on `src\/index\.ts:42`:\nThis branch is unreachable\./);
  assert.match(prompt, /\*\*@bob\*\* \(2020-01-02T00:00:00\.000Z\) — CHANGES_REQUESTED:\nNeeds another pass before I can approve\./);
});

test("buildIssuePrompt: an oversized thread drops the oldest comments first and says so explicitly, never silently", () => {
  const comments = Array.from({ length: 5 }, (_, i) => prComment(`user${i}`, `2020-01-0${i + 1}T00:00:00.000Z`, "x".repeat(6000)));
  const prompt = buildIssuePrompt(specIssue(), comments);

  assert.match(prompt, /_\.\.\. \d+ earlier comment\(s\) omitted for length\._/);
  assert.ok(!prompt.includes("user0"), "the oldest comment must be the one dropped");
  assert.ok(prompt.includes("user4"), "the newest comment must survive");
});

// ── escapeForMarkup / truncateDigest / formatReviewDigest ───────────────────
// These three are what actually assembles the digest — the tests above only
// exercise core/watch.ts's three-way reviewLine selection via a stubbed
// runChain, so none of them ever call into these. Slack/GitHub markup
// escaping is the one security-relevant behavior spec item B calls out by
// name (a reviewer's findings are LLM-authored, hence untrusted), so it needs
// direct coverage.

test("escapeForMarkup: a Slack link-forgery attempt is neutralized, and & is escaped without double-escaping", () => {
  const escaped = escapeForMarkup("<https://evil.example/|click here> & enjoy");
  assert.equal(escaped, "&lt;https://evil.example/|click here&gt; &amp; enjoy");
  assert.ok(!escaped.includes("<") && !escaped.includes(">"), "no raw angle bracket must survive — that's what prevents a forged Slack mrkdwn link");
});

test("formatReviewDigest: an approved review's met findings are the actual signal, and are surfaced (not silently dropped)", () => {
  const review = reviewOutput({
    approved: true,
    findings: [
      { requirement: "endpoint returns 200", met: true, evidence: "curl output attached" },
      { requirement: "handles missing auth header", met: true, evidence: "" },
      { requirement: "logs the request id", met: true, evidence: "trace shows request_id field" },
    ],
    blocking: [],
  });
  const digest = formatReviewDigest(review);
  assert.match(digest, /^Reviewer verdict: approved\./);
  assert.match(digest, /Verified 3 requirement\(s\):/);
  assert.match(digest, /- endpoint returns 200 — curl output attached/);
  assert.match(digest, /- handles missing auth header/);
  assert.match(digest, /- logs the request id — trace shows request_id field/);
});

test("formatReviewDigest: blocking items and unmet findings are escaped before being joined in", () => {
  const review = reviewOutput({
    approved: false,
    blocking: ["contains a <https://evil.example/|forged link> & needs fixing"],
    findings: [{ requirement: "auth check <script>", met: false, evidence: "not implemented & untested" }],
  });
  const digest = formatReviewDigest(review);
  assert.match(digest, /^Reviewer verdict: changes requested\./);
  assert.match(digest, /- contains a &lt;https:\/\/evil\.example\/\|forged link&gt; &amp; needs fixing/);
  assert.match(digest, /- auth check &lt;script&gt; — not implemented &amp; untested/);
  assert.ok(!digest.includes("<script>") && !digest.includes("<https"), "raw markup from an unmet finding must not survive into the digest");
});

test("formatBuildDigest: every BuildOutput's summary is kept, in order — not just the last (fixLoop repairs don't eclipse the original)", () => {
  const digest = formatBuildDigest([
    buildOutput({ summary: "Added a /health endpoint.", changed_files: ["src/health.ts"] }),
    buildOutput({ summary: "Fixed the failing contract test for it.", changed_files: ["src/test/health.test.ts"] }),
  ]);
  assert.match(digest, /Added a \/health endpoint\./);
  assert.match(digest, /Fixed the failing contract test for it\./);
  const addedIdx = digest.indexOf("Added a");
  const fixedIdx = digest.indexOf("Fixed the");
  assert.ok(addedIdx >= 0 && fixedIdx > addedIdx, "the original summary must precede the repair's");
});

test("formatBuildDigest: changed_files is de-duplicated, listed, and capped with a '…and N more' tail", () => {
  const files = Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`);
  const digest = formatBuildDigest([buildOutput({ summary: "A wide refactor.", changed_files: [...files, "src/file0.ts"] })]);
  assert.match(digest, /Files changed \(25\):/);
  assert.match(digest, /- `src\/file0\.ts`/);
  assert.match(digest, /…and 5 more/);
});

test("formatBuildDigest: only the LAST non-empty notes_for_next_agent becomes 'How to verify'", () => {
  const digest = formatBuildDigest([
    buildOutput({ summary: "Added a /health endpoint.", notes_for_next_agent: "run the contract tests" }),
    buildOutput({ summary: "Fixed the test.", notes_for_next_agent: "" }),
    buildOutput({ summary: "Tightened the response schema.", notes_for_next_agent: "curl /health and check the uptime field" }),
  ]);
  assert.match(digest, /\*\*How to verify:\*\* curl \/health and check the uptime field/);
  assert.doesNotMatch(digest, /run the contract tests/);
});

test("formatBuildDigest: no summary on any envelope says so plainly rather than rendering an empty section", () => {
  const digest = formatBuildDigest([buildOutput({ summary: "", changed_files: ["src/health.ts"] })]);
  assert.match(digest, /the builder reported no summary of its own work/);
});

test("formatBuildDigest: a builder's prose is escaped before being joined in", () => {
  const digest = formatBuildDigest([buildOutput({ summary: "handles <script>alert(1)</script> & worse" })]);
  assert.match(digest, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; worse/);
  assert.ok(!digest.includes("<script>"));
});

// ── spliceGeneratedBody: the PR-body marker splice ───────────────────────────

test("spliceGeneratedBody: no existing region — wraps and appends the generated content in fresh markers", () => {
  const result = spliceGeneratedBody("", "fresh content");
  assert.equal(result, "<!-- piquette:pr-body -->\nfresh content\n<!-- /piquette:pr-body -->");
});

test("spliceGeneratedBody: an existing region is replaced, and anything a human appended below it survives", () => {
  const current = "<!-- piquette:pr-body -->\nold content\n<!-- /piquette:pr-body -->\n\n@alice: looks good, one nit below.";
  const result = spliceGeneratedBody(current, "new content");
  assert.match(result, /<!-- piquette:pr-body -->\nnew content\n<!-- \/piquette:pr-body -->/);
  assert.match(result, /@alice: looks good, one nit below\./);
  assert.ok(!result.includes("old content"));
});

test("spliceGeneratedBody: a marker mangled by the deferred-landing '-->' neutering is still found and replaced", () => {
  // `openPrForWinner`'s deferred-landing path does `body.replaceAll("-->", "--​>")`
  // on the WHOLE body before storing it — including our own markers' closing
  // `-->`. A body round-tripped through that path must still splice correctly.
  const ZWSP = "​";
  const mangled = `<!-- piquette:pr-body --${ZWSP}>\nold content\n<!-- /piquette:pr-body --${ZWSP}>`;
  const result = spliceGeneratedBody(mangled, "new content");
  assert.match(result, /<!-- piquette:pr-body -->\nnew content\n<!-- \/piquette:pr-body -->/);
  assert.ok(!result.includes("old content"));
});

test("truncateDigest: a digest over the cap is cut at exactly the codepoint boundary, without splitting a surrogate pair", () => {
  // An astral-plane emoji (2 UTF-16 code units, 1 codepoint) placed exactly
  // at the 1200th codepoint — a naive `.slice(0, 1200)` on UTF-16 units would
  // land mid-pair and emit a lone, invalid surrogate instead of the emoji.
  const emoji = "\u{1F600}"; // grinning face, codepoint #1200
  const filler = "a".repeat(1199); // codepoints #1-1199
  const text = filler + emoji + "more text that must be cut off entirely";

  const result = truncateDigest(text);
  assert.equal(result, filler + emoji + "…", "must keep exactly 1200 whole codepoints (the emoji intact) then the ellipsis");
  assert.ok(result.endsWith("…"), "a truncated digest must end with the ellipsis marker");

  const short = "short digest, well under the cap";
  assert.equal(truncateDigest(short), short, "text under the cap must pass through unchanged, with no ellipsis appended");
});

// ── watch.chain_options threading (fix for PR #20's stated KNOWN LIMITATION:
// chain options like --suite never reached an unattended `piquette watch` run) ──

test("claimNewWork: threads deps.chainOptions through to runChain's opts", async () => {
  const provider = new FakeProvider();
  provider.addIssue("70", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let seenOptions: Record<string, string> | undefined;
  const deps = makeDeps(provider, codeHost, {
    chainOptions: { suite: "strict" },
    runChain: async (opts) => {
      seenOptions = opts.chainOptions;
      return { accepted: true, adwId: opts.adwId, detail: "" };
    },
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(seenOptions, { suite: "strict" }, "watch.chain_options must reach the chain dispatch, not be silently dropped");
});

test("claimNewWork: an empty (default) chainOptions still reaches runChain as {}, not undefined", async () => {
  const provider = new FakeProvider();
  provider.addIssue("71", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let seenOptions: Record<string, string> | undefined;
  const deps = makeDeps(provider, codeHost, {
    runChain: async (opts) => {
      seenOptions = opts.chainOptions;
      return { accepted: true, adwId: opts.adwId, detail: "" };
    },
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(seenOptions, {});
});

test("claimSpecs: threads deps.chainOptions through to runRefine's opts, same as the build lane", async () => {
  const provider = new FakeProvider();
  provider.addIssue("170", "A spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let seenOptions: Record<string, string> | undefined;
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    chainOptions: { agent: "flue" },
    runRefine: async (opts) => {
      seenOptions = opts.chainOptions;
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [], split: [] };
    },
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(seenOptions, { agent: "flue" }, "watch.chain_options must reach the refine chain dispatch too");
});

// ── claimSpecs/runSpec: a spec's own priority label reaches the refiner ──

test("claimSpecs: a spec's piquette:priority label reaches both the prompt and runRefine's chainOptions", async () => {
  const provider = new FakeProvider();
  provider.addIssue("180", "An urgent spec", "spec-ready", null, { extraLabels: ["piquette:priority:p1"] });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let seenPrompt = "";
  let seenOptions: Record<string, string> | undefined;
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => {
      seenPrompt = opts.prompt;
      seenOptions = opts.chainOptions;
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [], split: [] };
    },
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.match(seenPrompt, /## Priority\n\nThis spec is labeled p1\./);
  assert.equal(seenOptions?.["priority"], "p1");
});

test("claimSpecs: a spec with no priority label reaches the refiner exactly as before this feature existed", async () => {
  const provider = new FakeProvider();
  provider.addIssue("181", "An unlabeled spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let seenPrompt = "";
  let seenOptions: Record<string, string> | undefined;
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => {
      seenPrompt = opts.prompt;
      seenOptions = opts.chainOptions;
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [], split: [] };
    },
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.ok(!seenPrompt.includes("## Priority"));
  assert.equal(seenOptions?.["priority"], undefined, "no ceiling — publishIssues() sees no priority key at all, same as before");
});

test("tick: a spec only reaches done once every issue it produced does — the refine lane, then finishTrackedSpecs, wired through tick() itself", async () => {
  const provider = new FakeProvider();
  provider.addIssue("300", "A spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => ({
      accepted: true,
      adwId: opts.adwId,
      detail: "",
      created: [{ id: "800", title: "The only leaf", kind: "story", isLeaf: true }],
      questions: [], split: [],
    }),
  });

  await tick(deps, state);
  await waitUntil(() => state.refining.size === 0);
  assert.equal(provider.entries.get("300")!.state, "spec-in-progress", "published, but the leaf hasn't landed yet — must not read as done");
  assert.deepEqual(provider.closedIssues, []);

  // The leaf doesn't exist on the fake tracker yet — this simulates it
  // having actually been created (publish() would, via createIssue) and its
  // own PR merging sometime later.
  provider.addIssue("800", "The only leaf", "done");

  await tick(deps, state);

  assert.equal(provider.entries.get("300")!.state, "done", "the spec's last dependent finished — only now can it close");
  assert.deepEqual(provider.closedIssues, ["300"]);
});

test("tick: a per-stage error is caught and fires exactly one watch_error", async () => {
  const provider = new FakeProvider();
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  provider.listEligible = async () => {
    throw new Error("listEligible exploded");
  };

  await tick(makeDeps(provider, codeHost, { notify }), state);

  assert.deepEqual(events.map((e) => e.kind), ["watch_error"]);
  assert.match(events[0]!.detail ?? "", /listEligible exploded/);
});

// ── #200: --once re-reads an empty label list ───────────────────────────────

/** Makes `provider.listEligible` return `[]` for the first `empties` calls, then the real list; returns the call counter. */
function flakyList(provider: FakeProvider, empties: number): { calls: number } {
  const real = provider.listEligible.bind(provider);
  const counter = { calls: 0 };
  provider.listEligible = async () => (counter.calls++ < empties ? [] : real());
  return counter;
}

test("claimNewWork --once: an empty list then a non-empty one still claims the issue", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Flaky list");
  const counter = flakyList(provider, 2);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const state = createWatchState();
  const deps = makeDeps(provider, new FakeCodeHost(), {
    log: (m) => logs.push(m),
    eligibleRetry: { delaysMs: [10, 20, 40], sleep: async (ms) => void sleeps.push(ms) },
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.claimCalls, ["1"]);
  assert.equal(counter.calls, 3);
  assert.deepEqual(sleeps, [10, 20]); // backoff stops as soon as a read is non-empty
  assert.ok(!logs.some((l) => /no piquette:ready issues/.test(l)));
});

test("claimNewWork --once: persistently empty logs 'no piquette:ready issues' exactly once and claims nothing", async () => {
  const provider = new FakeProvider();
  const counter = flakyList(provider, Infinity);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const deps = makeDeps(provider, new FakeCodeHost(), {
    log: (m) => logs.push(m),
    eligibleRetry: { delaysMs: [10, 20, 40], sleep: async (ms) => void sleeps.push(ms) },
  });

  await claimNewWork(deps, createWatchState());

  assert.equal(counter.calls, 4); // 1 read + 3 re-reads
  assert.deepEqual(sleeps, [10, 20, 40]);
  assert.deepEqual(provider.claimCalls, []);
  assert.equal(logs.filter((l) => /no piquette:ready issues/.test(l)).length, 1);
});

test("claimNewWork --once --dry-run: the same retry, then 'would claim'", async () => {
  const provider = new FakeProvider();
  provider.addIssue("7", "Dry run flaky");
  flakyList(provider, 1);
  const logs: string[] = [];
  const deps = makeDeps(provider, new FakeCodeHost(), {
    dryRun: true,
    log: (m) => logs.push(m),
    eligibleRetry: { delaysMs: [5], sleep: async () => {} },
  });

  await claimNewWork(deps, createWatchState());
  assert.ok(logs.some((l) => /\[dry-run\] would claim 7/.test(l)));
  assert.deepEqual(provider.claimCalls, []);

  const empty = new FakeProvider();
  flakyList(empty, Infinity);
  const emptyLogs: string[] = [];
  await claimNewWork(makeDeps(empty, new FakeCodeHost(), { dryRun: true, log: (m) => emptyLogs.push(m), eligibleRetry: { delaysMs: [5], sleep: async () => {} } }), createWatchState());
  assert.equal(emptyLogs.filter((l) => /no piquette:ready issues/.test(l)).length, 1);
});

test("claimNewWork (daemon, no eligibleRetry): a single read, no re-ask, no empty-queue log", async () => {
  const provider = new FakeProvider();
  const counter = flakyList(provider, Infinity);
  const logs: string[] = [];
  await claimNewWork(makeDeps(provider, new FakeCodeHost(), { log: (m) => logs.push(m) }), createWatchState());
  assert.equal(counter.calls, 1);
  assert.deepEqual(logs, []);
});

// ── landing resilience + work preservation ───────────────────────────────────

const noSleep = { sleep: async () => {} };
const fetchFailed = (): Error => new TypeError("fetch failed");

async function runOne(deps: WatchDeps): Promise<void> {
  const state = createWatchState();
  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);
}

test("landing: a transient openPr failure is retried and the issue still reaches review, never blocked", async () => {
  const provider = new FakeProvider();
  provider.addIssue("60", "Blip");
  const codeHost = new FakeCodeHost();
  codeHost.openPrErrors = [fetchFailed()];
  const sleeps: number[] = [];
  let chainRuns = 0;
  const deps = makeDeps(provider, codeHost, {
    retry: { sleep: async (ms) => void sleeps.push(ms) },
    runChain: async () => {
      chainRuns++;
      return { accepted: true, adwId: "issue-60", detail: "" };
    },
  });

  await runOne(deps);

  assert.equal(codeHost.openPrCalls, 2);
  assert.equal(codeHost.openedPrs.length, 1);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  assert.equal(provider.entries.get("60")!.marker?.landing, undefined);
  assert.equal(chainRuns, 1);
  assert.deepEqual(sleeps, [1000]);
});

/** The REAL error `GitHubProvider.openPr` throws when the socket dies mid-POST (not a hand-built stand-in). */
async function realOpenPrSocketError(): Promise<Error> {
  const original = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    const err = new TypeError("fetch failed");
    (err as Error & { cause?: unknown }).cause = { code: "UND_ERR_SOCKET" };
    throw err;
  };
  try {
    await new GitHubProvider("acme/widgets", "piquette", "tok").openPr({ branch: "b", title: "t", body: "", base: "main" });
  } catch (error) {
    return error as Error;
  } finally {
    globalThis.fetch = original;
  }
  throw new Error("openPr unexpectedly succeeded");
}

test("landing: a real GitHub openPr socket error stays transient (openOrAdoptPr is lookup-guarded) and the issue reaches review", async () => {
  const err = await realOpenPrSocketError();
  assert.equal(isTransientError(err), true, "openPr's transport error must not be tagged ambiguous");
  const provider = new FakeProvider();
  provider.addIssue("62", "Socket blip");
  const codeHost = new FakeCodeHost();
  codeHost.openPrErrors = [err];
  const deps = makeDeps(provider, codeHost, { retry: noSleep });

  await runOne(deps);

  assert.equal(codeHost.openPrCalls, 2);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
});

test("landing: a 4xx from openPr is not retried and blocks the issue as before", async () => {
  const provider = new FakeProvider();
  provider.addIssue("61", "Bad request");
  const codeHost = new FakeCodeHost();
  codeHost.openPrAlwaysError = new HttpError("GitHub POST /pulls -> 422: validation failed", 422);
  const deps = makeDeps(provider, codeHost, { retry: noSleep });

  await runOne(deps);

  assert.equal(codeHost.openPrCalls, 1);
  assert.equal(provider.transitions[0]?.to, "blocked");
  assert.match(provider.transitions[0]?.detail ?? "", /422/);
});

test("landing: a persistent transient failure after a SUCCESSFUL chain leaves the issue working with a landing marker, not blocked", async () => {
  const provider = new FakeProvider();
  provider.addIssue("62", "Outage");
  const codeHost = new FakeCodeHost();
  codeHost.openPrAlwaysError = fetchFailed();
  const { events, notify } = collectNotifications();
  let chainRuns = 0;
  const deps = makeDeps(provider, codeHost, {
    retry: noSleep,
    notify,
    runChain: async () => {
      chainRuns++;
      return { accepted: true, adwId: "issue-62", detail: "" };
    },
  });

  await runOne(deps);

  assert.equal(codeHost.openPrCalls, 4); // default 4 tries
  assert.equal(chainRuns, 1);
  assert.equal(provider.transitions.length, 0); // no blocked, no review
  assert.equal(provider.entries.get("62")!.state, "working");
  const landing = provider.entries.get("62")!.marker?.landing;
  assert.ok(landing);
  assert.equal(landing.branch, "piquette-watch/62-outage");
  assert.equal(landing.tries, 0);
  assert.match(landing.title, /Outage \(62\)/);
  assert.ok(events.some((e) => e.kind === "watch_error" && /landing deferred/.test(e.title)));
  assert.ok(!events.some((e) => e.kind === "issue_blocked"));
});

test("landing: the next tick's reconcileOrphans lands a deferred issue without rerunning the chain, then clears landing", async () => {
  const provider = new FakeProvider();
  provider.addIssue("63", "Outage then recovery");
  const codeHost = new FakeCodeHost();
  codeHost.openPrAlwaysError = fetchFailed();
  let chainRuns = 0;
  const deps = makeDeps(provider, codeHost, {
    retry: noSleep,
    runChain: async () => {
      chainRuns++;
      return { accepted: true, adwId: "issue-63", detail: "" };
    },
  });
  await runOne(deps);
  assert.equal(provider.entries.get("63")!.state, "working");

  codeHost.openPrAlwaysError = null; // network is back
  await reconcileOrphans(deps, createWatchState());

  assert.equal(chainRuns, 1, "the chain must not rerun");
  assert.equal(codeHost.openedPrs.length, 1);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  const marker = provider.entries.get("63")!.marker!;
  assert.equal(marker.landing, undefined);
  assert.equal(marker.pr, 1000);
  assert.equal(marker.attempt, 0);
});

test("landing: a buildSummary survives a deferred landing's '-->' neutering end to end, and a LATER feedback revision still splices the now-mangled-marker PR body correctly", async () => {
  const provider = new FakeProvider();
  provider.addIssue("88", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  codeHost.openPrAlwaysError = fetchFailed(); // round 1 lands transiently, deferred
  const deps = makeDeps(provider, codeHost, {
    retry: noSleep,
    runChain: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", buildSummary: "Added a /health endpoint." }),
  });
  await runOne(deps);
  assert.equal(provider.entries.get("88")!.state, "working");
  assert.equal(provider.entries.get("88")!.marker?.landing?.what_i_did, "Added a /health endpoint.", "the digest survives onto the landing marker, neutered body and all");

  codeHost.openPrAlwaysError = null; // network recovers
  await reconcileOrphans(deps, createWatchState());

  assert.equal(provider.entries.get("88")!.state, "review");
  const prNumber = provider.entries.get("88")!.marker!.pr!;
  const roundOneBody = codeHost.prBodies.get(prNumber)!;
  // The body actually posted to the (fake) code host is the NEUTERED one —
  // same string `deferLanding` stored, zero-width-space and all.
  assert.ok(roundOneBody.includes("--​>"), "the live body really does carry the mangled marker, not a clean one");
  assert.match(roundOneBody, /## What I did\n\nAdded a \/health endpoint\./);
  assert.match(provider.transitions.find((t) => t.to === "review")!.detail ?? "", /\*\*What I did:\*\* Added a \/health endpoint\./);

  // Round 2: a feedback revision on that SAME PR, whose live body still
  // carries round 1's mangled markers.
  await provider.transition(provider.entries.get("88")!.issue, "feedback");
  codeHost.prComments.set(prNumber, [prComment("alice", "2020-01-02T00:00:00.000Z", "Please also return a build SHA.")]);
  const deps2 = makeDeps(provider, codeHost, {
    retry: noSleep,
    runChain: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", buildSummary: "Added the build SHA to the response." }),
  });

  const state2 = createWatchState();
  await claimFeedback(deps2, state2);
  await waitUntil(() => state2.inflight.size === 0);

  const roundTwoBody = codeHost.prBodies.get(prNumber)!;
  assert.match(roundTwoBody, /## What I did\n\nAdded the build SHA to the response\./);
  assert.ok(!roundTwoBody.includes("Added a /health endpoint."), "round 1's content must be REPLACED, not left behind");
  assert.equal(roundTwoBody.split("<!-- piquette:pr-body -->").length - 1, 1, "exactly one region — the mangled region was found and replaced, not missed and appended to");
});

test("landing: a failing retry bumps landing.tries, still no blocked, no ready; blocks only after MAX_LANDING_TRIES", async () => {
  const provider = new FakeProvider();
  provider.addIssue("64", "Long outage");
  const codeHost = new FakeCodeHost();
  codeHost.openPrAlwaysError = fetchFailed();
  const deps = makeDeps(provider, codeHost, { retry: noSleep });
  await runOne(deps);

  await reconcileOrphans(deps, createWatchState());
  assert.equal(provider.entries.get("64")!.marker?.landing?.tries, 1);
  assert.equal(provider.transitions.length, 0);

  const entry = provider.entries.get("64")!;
  entry.marker = { ...entry.marker!, landing: { ...entry.marker!.landing!, tries: MAX_LANDING_TRIES - 1 } };
  await reconcileOrphans(deps, createWatchState());
  assert.deepEqual(provider.transitions.map((t) => t.to), ["blocked"]);
  assert.match(provider.transitions[0]!.detail ?? "", /piquette-watch\/64-long-outage/);
});

test("landing: retryLanding pushes again when the worktree is still on disk", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piquette-landing-"));
  const provider = new FakeProvider();
  provider.addIssue("65", "Push retry", "working", {
    worktree: dir,
    branch: "piquette-watch/65-push-retry",
    attempt: 0,
    landing: { adw_id: "issue-65", branch: "piquette-watch/65-push-retry", title: "t (65)", body: "b", base: "main", since: "now", tries: 0, review_line: "r", review_state: "not reviewed" },
  });
  const pushes: string[] = [];
  const deps = makeDeps(provider, new FakeCodeHost(), { retry: noSleep, worktreeGit: () => fakeGit({ push: (_r, b) => void pushes.push(b) }) });

  await reconcileOrphans(deps, createWatchState());

  assert.deepEqual(pushes, ["piquette-watch/65-push-retry"]);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
});

test("landing: an already-open PR for the branch is adopted, not duplicated", async () => {
  const provider = new FakeProvider();
  provider.addIssue("66", "Adopt me");
  const codeHost = new FakeCodeHost();
  codeHost.existingOpenPr = { number: 77, branch: "piquette-watch/66-adopt-me", url: "https://example.invalid/pr/77" };
  const deps = makeDeps(provider, codeHost, { retry: noSleep });

  await runOne(deps);

  assert.equal(codeHost.openPrCalls, 0);
  assert.equal(provider.entries.get("66")!.marker?.pr, 77);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
});

test("landing: a request that failed client-side but succeeded server-side is adopted on the retry, not duplicated", async () => {
  const provider = new FakeProvider();
  provider.addIssue("67", "Ghost success");
  const codeHost = new FakeCodeHost();
  // First openPr: "fails" after the server created the PR.
  codeHost.openPr = async () => {
    codeHost.openPrCalls++;
    codeHost.existingOpenPr = { number: 88, branch: "piquette-watch/67-ghost-success", url: "u" };
    throw fetchFailed();
  };
  const deps = makeDeps(provider, codeHost, { retry: noSleep });

  await runOne(deps);

  assert.equal(codeHost.openPrCalls, 1);
  assert.equal(provider.entries.get("67")!.marker?.pr, 88);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
});

test("orphans: a landing marker routes to retryLanding instead of back to ready", async () => {
  const provider = new FakeProvider();
  provider.addIssue("68", "Orphan landing", "working", {
    branch: "piquette-watch/68-orphan-landing",
    attempt: 0,
    landing: { adw_id: "issue-68", branch: "piquette-watch/68-orphan-landing", title: "t (68)", body: "b", base: "main", since: "now", tries: 0, review_line: "r", review_state: "not reviewed" },
  });
  const codeHost = new FakeCodeHost();
  const deps = makeDeps(provider, codeHost, { retry: noSleep });

  await reconcileOrphans(deps, createWatchState());

  assert.ok(!provider.transitions.some((t) => t.to === "ready"));
  assert.equal(provider.entries.get("68")!.marker?.attempt, 0);
  assert.equal(codeHost.openedPrs.length, 1);
});

test("work preservation: a failed chain commits dirty changes, pushes the -wip branch, and names it in the blocked comment", async () => {
  const provider = new FakeProvider();
  provider.addIssue("70", "Lost work");
  const codeHost = new FakeCodeHost();
  const commits: string[] = [];
  const pushes: Array<{ branch: string; opts?: { remoteBranch?: string; forceWithLease?: boolean } }> = [];
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    retry: noSleep,
    notify,
    runChain: async () => ({ accepted: false, adwId: "issue-70", detail: "claude produced no result message (exit 0)" }),
    worktreeGit: () =>
      fakeGit({
        isDirty: () => true,
        commitAll: (m) => (commits.push(m), "abc"),
        diffFiles: () => ["src/a.ts"],
        push: (_r, branch, opts) => void pushes.push({ branch, opts }),
      }),
  });

  await runOne(deps);

  assert.equal(commits.length, 1);
  assert.match(commits[0]!, /^wip: piquette watch 70 failed/);
  assert.deepEqual(pushes, [{ branch: "piquette-watch/70-lost-work", opts: { remoteBranch: "piquette-watch/70-lost-work-wip", forceWithLease: true } }]);
  const blocked = provider.transitions[0]!;
  assert.equal(blocked.to, "blocked");
  assert.match(blocked.detail!, /^claude produced no result message \(exit 0\)/);
  assert.match(blocked.detail!, /piquette-watch\/70-lost-work-wip/);
  assert.deepEqual(events.find((e) => e.kind === "issue_blocked")!.fields?.find((f) => f[0] === "wip_branch"), ["wip_branch", "piquette-watch/70-lost-work-wip"]);
});

test("work preservation: a thrown chain error also preserves the work", async () => {
  const provider = new FakeProvider();
  provider.addIssue("71", "Thrown");
  const pushes: string[] = [];
  const deps = makeDeps(provider, new FakeCodeHost(), {
    retry: noSleep,
    runChain: async () => {
      throw new Error("claude produced no result message (exit 0)");
    },
    worktreeGit: () => fakeGit({ diffFiles: () => ["x.ts"], push: (_r, _b, o) => void pushes.push(o?.remoteBranch ?? "") }),
  });

  await runOne(deps);

  assert.deepEqual(pushes, ["piquette-watch/71-thrown-wip"]);
  assert.match(provider.transitions[0]!.detail!, /^piquette watch error while running the chain: claude produced no result message/);
  assert.match(provider.transitions[0]!.detail!, /71-thrown-wip/);
});

test("work preservation: a diff_risk signoff stop that flagged secrets commits and pushes NOTHING, and says so", async () => {
  const provider = new FakeProvider();
  provider.addIssue("74", "Leaky");
  const commits: string[] = [];
  const pushes: string[] = [];
  const deps = makeDeps(provider, new FakeCodeHost(), {
    retry: noSleep,
    runChain: async () => {
      throw new SignoffRequiredError("diff_risk requires human signoff (flagged: risk:secrets)", ["risk:secrets"]);
    },
    worktreeGit: () => fakeGit({ isDirty: () => true, commitAll: (m) => (commits.push(m), "sha"), diffFiles: () => ["x.ts"], push: (_r, _b, o) => void pushes.push(o?.remoteBranch ?? "") }),
  });

  await runOne(deps);

  assert.deepEqual(commits, [], "the unreviewed tree is not committed");
  assert.deepEqual(pushes, [], "and never pushed");
  assert.equal(provider.transitions[0]!.to, "blocked");
  assert.match(provider.transitions[0]!.detail!, /NOT committed or pushed/);
});

test("work preservation: a diff_risk signoff stop that flagged only non-secret risks still preserves the work like any failed run", async () => {
  const provider = new FakeProvider();
  provider.addIssue("75", "Schema");
  const pushes: string[] = [];
  const deps = makeDeps(provider, new FakeCodeHost(), {
    retry: noSleep,
    runChain: async () => {
      throw new SignoffRequiredError("diff_risk requires human signoff (flagged: risk:schema)", ["risk:schema"]);
    },
    worktreeGit: () => fakeGit({ diffFiles: () => ["x.ts"], push: (_r, _b, o) => void pushes.push(o?.remoteBranch ?? "") }),
  });

  await runOne(deps);

  assert.deepEqual(pushes, ["piquette-watch/75-schema-wip"]);
});

test("work preservation: a failing WIP push keeps the commits on a local branch, with the original detail intact and no pushed claim (#125)", async () => {
  const provider = new FakeProvider();
  provider.addIssue("72", "Push fails");
  const kept: string[] = [];
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, new FakeCodeHost(), {
    retry: noSleep,
    notify,
    runChain: async () => ({ accepted: false, adwId: "issue-72", detail: "original failure detail" }),
    worktreeGit: () =>
      fakeGit({
        diffFiles: () => ["x.ts"],
        shortSha: () => "abc1234",
        branchAt: (name) => void kept.push(name),
        push: () => {
          throw new Error("remote rejected");
        },
      }),
  });

  await runOne(deps);

  assert.deepEqual(kept, ["piquette-failed/72-push-fails-abc1234"]);
  const blocked = provider.transitions[0]!;
  assert.equal(blocked.to, "blocked");
  assert.match(blocked.detail!, /^original failure detail\n\n/);
  assert.match(blocked.detail!, /kept LOCALLY on branch `piquette-failed\/72-push-fails-abc1234`/);
  assert.match(blocked.detail!, /git push origin piquette-failed\/72-push-fails-abc1234:refs\/heads\/<branch>/, "says how to recover it");
  assert.doesNotMatch(blocked.detail!, /pushed to origin/);
  const fields = events.find((e) => e.kind === "issue_blocked")!.fields!;
  assert.deepEqual(fields.find((f) => f[0] === "kept_branch"), ["kept_branch", "piquette-failed/72-push-fails-abc1234"]);
  assert.equal(fields.find((f) => f[0] === "wip_branch"), undefined);
});

test("work preservation: nothing to push and nothing kept when keeping the branch fails too — the original detail stands alone", async () => {
  const provider = new FakeProvider();
  provider.addIssue("76", "Nothing works");
  const deps = makeDeps(provider, new FakeCodeHost(), {
    retry: noSleep,
    runChain: async () => ({ accepted: false, adwId: "issue-76", detail: "original failure detail" }),
    worktreeGit: () =>
      fakeGit({
        diffFiles: () => ["x.ts"],
        branchAt: () => {
          throw new Error("cannot lock ref");
        },
        push: () => {
          throw new Error("remote rejected");
        },
      }),
  });

  await runOne(deps);

  assert.deepEqual(provider.transitions, [{ id: "76", to: "blocked", detail: "original failure detail" }]);
});

test("keptBranchName moves a watch branch out of the piquette-watch/ namespace the next claim recreates", () => {
  assert.equal(keptBranchName("piquette-watch/CTX-10-a-proposed-change", "008b179"), "piquette-failed/CTX-10-a-proposed-change-008b179");
  assert.equal(keptBranchName("piquette-watch/7-x-r2", "abc"), "piquette-failed/7-x-r2-abc");
});

/**
 * #125 end to end, against real git: a green, committed chain whose landing
 * push a repo `pre-push` hook rejects (its report on stdout, the way a test
 * runner hook prints it). Before the fix the blocked comment carried only
 * git's stderr — no hook output — and the cleanup deleted the only branch
 * holding the commit, because the `-wip` rescue push hit the same hook.
 */
test("landing: a pre-push hook rejection blocks with the hook's output, and the committed work survives on a local branch (#125)", async () => {
  const root = mkdtempSync(path.join(scratchRoot, "push-hook-"));
  const sh = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  sh(["init", "--bare", "-b", "main", origin], root);
  mkdirSync(repo);
  sh(["init", "-b", "main"], repo);
  sh(["config", "user.email", "t@example.com"], repo);
  sh(["config", "user.name", "t"], repo);
  sh(["config", "commit.gpgsign", "false"], repo);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  sh(["add", "-A"], repo);
  sh(["commit", "-m", "base"], repo);
  sh(["remote", "add", "origin", origin], repo);
  sh(["push", "origin", "main"], repo);
  // Installed only now, so the base push above went through.
  const hooks = path.join(root, "hooks");
  mkdirSync(hooks);
  writeFileSync(
    path.join(hooks, "pre-push"),
    "#!/bin/sh\necho ' FAIL  src/db/pglite.test.ts > migrates the schema'\necho 'Error: Test timed out in 5000ms.'\necho ' Tests  7 failed | 145 passed (152)'\nexit 1\n",
    { mode: 0o755 },
  );
  sh(["config", "core.hooksPath", hooks], repo);

  const provider = new FakeProvider();
  provider.addIssue("90", "Hook rejects");
  let committed = "";
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, new FakeCodeHost(), {
    notify,
    retry: noSleep,
    git: makeGit(repo),
    worktreeGit: (p) => makeGit(p),
    worktreesDir: path.join(root, "worktrees"),
    runChain: async (opts) => {
      writeFileSync(path.join(opts.cwd, "feature.ts"), "export const x = 1;\n");
      makeGit(opts.cwd).commitAll("feat: the green build");
      committed = sh(["rev-parse", "HEAD"], opts.cwd);
      return { accepted: true, adwId: opts.adwId, detail: "" };
    },
  });

  await runOne(deps);

  const blocked = provider.transitions.find((t) => t.to === "blocked");
  assert.ok(blocked, "the issue is blocked");
  const detail = blocked.detail!;
  assert.match(detail, /^piquette watch error while landing the PR: git push origin HEAD:refs\/heads\/piquette-watch\/90-hook-rejects failed \(exit 1\)/);
  assert.match(detail, /FAIL {2}src\/db\/pglite\.test\.ts > migrates the schema/, "the hook's stdout reaches the comment");
  assert.match(detail, /Tests {2}7 failed \| 145 passed/);
  assert.match(detail, /```\n[\s\S]*failed to push some refs[\s\S]*\n```/, "fenced, with git's own line");
  assert.match(detail, /named entry under `quality\.checks`, and list that name in the `quality\.suites` suite/, "and says how to put the hook's check where the fix loop sees it");
  const errored = events.find((e) => e.kind === "watch_error");
  assert.ok(errored, "a watch_error notification fired");
  assert.match(errored.detail ?? "", /Tests {2}7 failed \| 145 passed/, "the notification carries the hook's output, not just git's stderr");

  const kept = keptBranchName("piquette-watch/90-hook-rejects", sh(["rev-parse", "--short", committed], repo));
  assert.match(detail, new RegExp(`kept LOCALLY on branch \`${kept.replace(/[/.-]/g, "\\$&")}\``));
  assert.equal(sh(["rev-parse", kept], repo), committed, "the green commit is still on a local branch");
  assert.equal(sh(["show", `${kept}:feature.ts`], repo), "export const x = 1;");
  assert.equal(sh(["for-each-ref", "--format=%(refname:short)", "refs/heads/piquette-watch/"], repo), "", "the run's own branch is cleaned up as before");
  assert.equal(sh(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], origin), "main", "nothing reached origin");
});

test("work preservation: a throwing commit (preserveWork internals) never masks the original failure or escapes", async () => {
  const provider = new FakeProvider();
  provider.addIssue("73", "Commit fails");
  const deps = makeDeps(provider, new FakeCodeHost(), {
    retry: noSleep,
    runChain: async () => ({ accepted: false, adwId: "issue-73", detail: "original" }),
    worktreeGit: () =>
      fakeGit({
        isDirty: () => true,
        commitAll: () => {
          throw new Error("hook rejected");
        },
      }),
  });

  await runOne(deps);

  assert.deepEqual(provider.transitions, [{ id: "73", to: "blocked", detail: "original" }]);
});

test("landing: the agent switched to another branch and committed — HEAD is pushed to the expected branch and the PR opens", async () => {
  const provider = new FakeProvider();
  provider.addIssue("72", "The opt-in forms that have");
  const codeHost = new FakeCodeHost();
  const pushes: string[] = [];
  const logs: string[] = [];
  const ancestorChecks: string[] = [];
  const deps = makeDeps(provider, codeHost, {
    retry: noSleep,
    log: (m) => logs.push(m),
    worktreeGit: () =>
      fakeGit({
        currentBranch: () => "feat/72-form-disclaimer-backfill",
        diffFiles: () => ["src/index.ts"],
        isAncestor: (a) => (ancestorChecks.push(a), true),
        push: (_r, b, o) => void pushes.push(o?.remoteBranch ?? b),
      }),
  });

  await runOne(deps);

  assert.equal(pushes.length, 1);
  assert.match(pushes[0]!, /^piquette-watch\/72-/);
  assert.equal(ancestorChecks.length, 1);
  assert.equal(codeHost.openedPrs.length, 1);
  assert.equal(codeHost.openedPrs[0]!.branch, pushes[0]);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  assert.ok(logs.some((l) => /feat\/72-form-disclaimer-backfill.*not the expected/.test(l)), "warns about the branch mismatch");
});

test("landing: HEAD that does not descend from the base is blocked loudly, with no push and no PR", async () => {
  const provider = new FakeProvider();
  provider.addIssue("73", "Drifted");
  const codeHost = new FakeCodeHost();
  const pushes: string[] = [];
  const deps = makeDeps(provider, codeHost, {
    retry: noSleep,
    worktreeGit: () =>
      fakeGit({
        currentBranch: () => "orphan-branch",
        diffFiles: () => ["src/index.ts"],
        isAncestor: () => false,
        push: (_r, b, o) => void pushes.push(o?.remoteBranch ?? b),
      }),
  });

  await runOne(deps);

  assert.deepEqual(pushes, []);
  assert.equal(codeHost.openPrCalls, 0);
  const blocked = provider.transitions.find((t) => t.to === "blocked");
  assert.ok(blocked, "issue is blocked");
  assert.match(blocked!.detail ?? "", /does not descend from the run's base/);
  assert.match(blocked!.detail ?? "", /orphan-branch/);
});

test("landing: normal path (HEAD on the expected branch) pushes the expected name and logs no mismatch warning", async () => {
  const provider = new FakeProvider();
  provider.addIssue("74", "Normal");
  const codeHost = new FakeCodeHost();
  const pushes: Array<{ branch: string; opts?: unknown }> = [];
  const logs: string[] = [];
  const deps = makeDeps(provider, codeHost, {
    retry: noSleep,
    log: (m) => logs.push(m),
    worktreeGit: () =>
      fakeGit({
        currentBranch: () => provider.entries.get("74")?.marker?.branch ?? "",
        diffFiles: () => ["src/index.ts"],
        push: (_r, branch, opts) => void pushes.push({ branch, opts }),
      }),
  });

  await runOne(deps);

  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]!.opts, undefined);
  assert.match(pushes[0]!.branch, /^piquette-watch\/74-/);
  assert.equal(logs.some((l) => /not the expected/.test(l)), false);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
});

// ── closing keyword in the PR body (same-GitHub tracker only) ───────────────

test("closingReference: same repo -> 'Closes #n' for '84' and '#84'; other repo -> qualified; no config / non-numeric -> null", () => {
  const same = { issueRepo: "Acme/App", prRepo: "acme/app" };
  assert.equal(closingReference("84", same), "Closes #84");
  assert.equal(closingReference("#84", same), "Closes #84");
  assert.equal(closingReference("84", { issueRepo: "acme/issues", prRepo: "acme/app" }), "Closes acme/issues#84");
  assert.equal(closingReference("acme/app#7", { issueRepo: "acme/issues", prRepo: "acme/app" }), "Closes #7");
  assert.equal(closingReference("PROJ-12", same), null);
  assert.equal(closingReference("84", undefined), null);
  assert.equal(closingReference("84", { issueRepo: "", prRepo: "acme/app" }), null);
});

test("claimNewWork: with closingRefs the PR body carries 'Closes #n' exactly once, inside the generated region; without, none", async () => {
  for (const withRefs of [true, false]) {
    const provider = new FakeProvider();
    provider.addIssue("84", "Refactor routes");
    const codeHost = new FakeCodeHost();
    const state = createWatchState();
    const deps = makeDeps(provider, codeHost, withRefs ? { closingRefs: { issueRepo: "acme/app", prRepo: "acme/app" } } : {});
    await claimNewWork(deps, state);
    await waitUntil(() => state.inflight.size === 0);
    const body = codeHost.openedPrs[0]!.body;
    const count = (body.match(/Closes #84/g) ?? []).length;
    assert.equal(count, withRefs ? 1 : 0);
    if (withRefs) {
      const region = /<!-- piquette:pr-body -->([\s\S]*)<!-- \/piquette:pr-body -->/.exec(body)!;
      assert.match(region[1]!, /Closes #84/);
      // A revision splices the same generated text: the keyword is replaced, not duplicated.
      const generated = region[1]!.trim();
      assert.equal(((spliceGeneratedBody(body, generated).match(/Closes #84/g)) ?? []).length, 1);
    }
  }
});

test("closingRefsFromConfig: github-projects with a cross-repo issue_repo qualifies the reference (never a bare 'Closes #n')", async () => {
  const { SFConfigSchema } = await import("../core/data_types.js");
  const v = await import("valibot");
  const mk = (watch: Record<string, unknown>) => v.parse(SFConfigSchema, { watch }) as import("../core/data_types.js").SFConfig;
  for (const issue_provider of ["github", "github-projects"]) {
    const refs = closingRefsFromConfig(mk({ code_host: "github", issue_provider, repo: "acme/app", issue_repo: "acme/tracker" }));
    assert.deepEqual(refs, { issueRepo: "acme/tracker", prRepo: "acme/app" }, issue_provider);
    assert.equal(closingReference("5", refs), "Closes acme/tracker#5", issue_provider);
    const same = closingRefsFromConfig(mk({ code_host: "github", issue_provider, repo: "acme/app", issue_repo: "" }));
    assert.equal(closingReference("5", same), "Closes #5", issue_provider);
  }
  assert.equal(closingRefsFromConfig(mk({ code_host: "bitbucket", issue_provider: "github", repo: "acme/app" })), undefined);
});

// ── #159 ticket D: an unverified change still lands, and a person is asked ──

function unverifiedOutcome(): VerificationOutcome {
  return {
    status: "unverified",
    reasons: ["The change still fails its own proof after 3 of 3 attempt(s): 1 of 3 check(s) failed."],
    journeys: "/h/journeys.yaml",
    base: { key: "piquette/attempts/issue-81/1/receipt.json", stage: "base", attempt: 1, verdict: "FAIL", reason: "2 of 3 check(s) failed", tree: "a".repeat(40) },
    head: {
      key: "piquette/attempts/issue-81/4/receipt.json",
      stage: "head",
      attempt: 4,
      verdict: "FAIL",
      reason: "1 of 3 check(s) failed",
      tree: "b".repeat(40),
      video: "piquette/attempts/issue-81/4/video.mp4",
    },
    failed_proofs: 3,
    max_failed_proofs: 3,
  };
}

test("claimNewWork: an UNVERIFIED change still opens its PR, goes to review (not blocked), and is escalated to a person", async () => {
  const provider = new FakeProvider();
  provider.addIssue("81", "Shorten the unknown-chain error");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    notify,
    runChain: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", reviewRequired: false, verification: unverifiedOutcome() }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  // Never a block: the PR opens and the issue goes to review.
  assert.equal(codeHost.openedPrs.length, 1);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  assert.match(codeHost.openedPrs[0]!.body, /\*\*Verification:\*\* \*\*Unverified — a person needs to decide\.\*\*/);
  assert.match(codeHost.openedPrs[0]!.body, /still fails its own proof after 3 of 3/);
  assert.match(codeHost.openedPrs[0]!.body, /video: `piquette\/attempts\/issue-81\/4\/video\.mp4`/);

  // Communicated: pr_opened carries the status, and a separate notice asks a person.
  const prOpened = events.find((e) => e.kind === "pr_opened")!;
  assert.deepEqual(prOpened.fields.find(([k]) => k === "verification"), ["verification", "unverified"]);
  const escalation = events.find((e) => e.kind === "verification_unverified");
  assert.ok(escalation, "an escalation notification was sent");
  assert.equal(escalation.level, "notice");
  assert.match(escalation.title, /is unverified — a person needs to decide/);
  assert.match(escalation.detail ?? "", /after 3 of 3/);
  assert.deepEqual(escalation.fields.find(([k]) => k === "failed_proofs"), ["failed_proofs", "3/3"]);
  assert.ok(escalation.fields.some(([k]) => k === "pr"));

  // …and on the issue itself, where the person who filed it will see it.
  const comments = provider.entries.get("81")!.comments.map((c) => c.body);
  assert.ok(comments.some((c) => /Unverified — a person needs to decide/.test(c) && /Decide: merge as it is, ask for a fix, or close it\./.test(c)));
});

test("claimNewWork: a VERIFIED change says so on the PR and sends no escalation", async () => {
  const provider = new FakeProvider();
  provider.addIssue("82", "Shorten the unknown-chain error");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const verified: VerificationOutcome = { ...unverifiedOutcome(), status: "verified", reasons: [], failed_proofs: 0 };
  const deps = makeDeps(provider, codeHost, {
    notify,
    runChain: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", reviewRequired: false, verification: verified }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.match(codeHost.openedPrs[0]!.body, /\*\*Verification:\*\* \*\*Verified\.\*\*/);
  assert.deepEqual(events.find((e) => e.kind === "pr_opened")!.fields.find(([k]) => k === "verification"), ["verification", "verified"]);
  assert.equal(events.some((e) => e.kind === "verification_unverified"), false);
});

// ── watch.setup (#159 pilot): install/build in the fresh worktree ──────────

test("runIssue: a failing watch.setup blocks the issue with the command's output, and the chain never runs", async () => {
  const provider = new FakeProvider();
  provider.addIssue("91", "Needs dependencies to test");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  let chainRuns = 0;
  const deps = makeDeps(provider, codeHost, {
    notify,
    setupWorktree: () => {
      throw new Error("`npm ci --ignore-scripts` exited 1\n\nnpm ERR! missing lockfile");
    },
    runChain: async (opts) => (chainRuns++, { accepted: true, adwId: opts.adwId, detail: "" }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.equal(chainRuns, 0, "no chain runs on a worktree that couldn't be set up");
  assert.equal(codeHost.openedPrs.length, 0);
  const blocked = provider.transitions.find((t) => t.to === "blocked");
  assert.ok(blocked, "the issue is blocked");
  assert.match(blocked.detail ?? "", /Worktree setup \(`watch\.setup`\) failed/);
  assert.match(blocked.detail ?? "", /npm ERR! missing lockfile/);
  assert.ok(events.some((e) => e.kind === "issue_blocked"));
});

test("runIssue: watch.setup runs in the issue's worktree before the chain", async () => {
  const provider = new FakeProvider();
  provider.addIssue("92", "Needs dependencies to test");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const order: string[] = [];
  const deps = makeDeps(provider, codeHost, {
    setupWorktree: (worktreePath) => void order.push(`setup ${worktreePath.endsWith("issue-92") ? "issue-92" : worktreePath}`),
    runChain: async (opts) => (order.push("chain"), { accepted: true, adwId: opts.adwId, detail: "" }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(order, ["setup issue-92", "chain"]);
});

// ── onRunFinished (#221: sync.on_watch) ──────────────────────────────────────

test("onRunFinished: a finished run fires the hook exactly once, after the run settled", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a /health endpoint");
  const state = createWatchState();
  let calls = 0;
  const deps = makeDeps(provider, new FakeCodeHost(), { onRunFinished: () => void calls++ });
  await claimNewWork(deps, state);
  await waitUntil(() => calls === 1);
  assert.equal(state.inflight.size, 0, "the hook fires after the run settled");
  assert.equal(calls, 1);
});

test("onRunFinished: a blocked (rejected) run also fires it, and a throwing hook never changes the run's result", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "will fail");
  const state = createWatchState();
  let calls = 0;
  const deps = makeDeps(provider, new FakeCodeHost(), {
    runChain: async () => ({ accepted: false, adwId: "issue-1", detail: "boom" }),
    onRunFinished: () => {
      calls++;
      throw new Error("sync exploded");
    },
  });
  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);
  assert.equal(calls, 1);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["blocked"]);
});

// The dry-run guard itself lives in buildSyncOnWatch (sync_on_watch.test.ts): claimNewWork's dry-run branch never launches a run.

test("onRunFinished: a finished refine (claimSpecs) run fires it", async () => {
  const provider = new FakeProvider();
  provider.addIssue("101", "Team invitations", "spec-ready");
  const state = createWatchState();
  let calls = 0;
  const deps = makeDeps(provider, new FakeCodeHost(), {
    refineEnabled: true,
    onRunFinished: () => void calls++,
  });
  await claimSpecs(deps, state);
  await waitUntil(() => calls === 1);
  assert.equal(state.refining.size, 0);
});

test("onRunFinished: a finished revision (claimFeedback) run fires it", async () => {
  const provider = new FakeProvider();
  provider.addIssue("70", "Add auth", "feedback", { pr: 900, branch: "piquette-watch/70-add-auth", attempt: 0 });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(900, { merged: false, state: "open", ciStatus: "pending" });
  codeHost.prComments.set(900, [prComment("alice", "2020-01-02T00:00:00.000Z", "Please add a test for the 401 case.")]);
  const state = createWatchState();
  let calls = 0;
  const deps = makeDeps(provider, codeHost, {
    git: fakeGit({}),
    runChain: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "" }),
    onRunFinished: () => void calls++,
  });
  await claimFeedback(deps, state);
  await waitUntil(() => calls === 1);
  assert.equal(state.inflight.size, 0);
});

// ---------------------------------------------------------------------------
// #223: a transient error right after claim releases the claim, never blocks.

class FlakyMarkerProvider extends FakeProvider {
  readMarkerErrors: Error[] = [];
  readMarkerCalls = 0;
  override async readMarker(issue: Issue): Promise<WatchMarker | null> {
    this.readMarkerCalls++;
    const e = this.readMarkerErrors.shift();
    if (e) throw e;
    return super.readMarker(issue);
  }
}

test("claim: a single transient first call is retried (injected delay) and the run proceeds, not blocked", async () => {
  const provider = new FlakyMarkerProvider();
  provider.addIssue("70", "Blip at claim");
  provider.readMarkerErrors = [fetchFailed()];
  const sleeps: number[] = [];
  let chainRuns = 0;
  const deps = makeDeps(provider, new FakeCodeHost(), {
    retry: { sleep: async (ms) => void sleeps.push(ms) },
    runChain: async () => {
      chainRuns++;
      return { accepted: true, adwId: "issue-70", detail: "" };
    },
  });

  await runOne(deps);

  assert.equal(chainRuns, 1);
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
});

test("claim: a persistent transient error releases the claim to ready with no comment, no blocked, and a notice", async () => {
  const provider = new FlakyMarkerProvider();
  provider.addIssue("71", "Outage at claim");
  provider.readMarkerErrors = [fetchFailed(), fetchFailed(), fetchFailed(), fetchFailed()];
  const { events, notify } = collectNotifications();
  const sleeps: number[] = [];
  let chainRuns = 0;
  const deps = makeDeps(provider, new FakeCodeHost(), {
    retry: { sleep: async (ms) => void sleeps.push(ms) },
    notify,
    runChain: async () => {
      chainRuns++;
      return { accepted: true, adwId: "issue-71", detail: "" };
    },
  });

  await runOne(deps);

  assert.equal(chainRuns, 0);
  assert.equal(sleeps.length, 3);
  assert.deepEqual(provider.transitions, [{ id: "71", to: "ready", detail: undefined }]);
  assert.equal(provider.entries.get("71")!.state, "ready");
  assert.ok(!events.some((e) => e.kind === "issue_blocked"));
  assert.ok(events.some((e) => e.kind === "watch_error" && e.level === "notice" && /released/.test(e.title)));

  // Next tick: the issue is claimable again and the run proceeds.
  provider.readMarkerErrors = [];
  await runOne(deps);
  assert.equal(chainRuns, 1);
  assert.equal(provider.entries.get("71")!.state, "review");
});

test("claim: a transient git fetch failure releases the claim and clears no-op partial state", async () => {
  const provider = new FakeProvider();
  provider.addIssue("72", "Fetch outage");
  let fetches = 0;
  const base = makeDeps(provider, new FakeCodeHost(), { retry: noSleep });
  const deps: WatchDeps = {
    ...base,
    git: {
      ...base.git,
      fetch: () => {
        fetches++;
        throw fetchFailed();
      },
    },
  };

  await runOne(deps);

  assert.equal(fetches, 4);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["ready"]);
});

test("claim: a non-transient pre-chain error still blocks, and the comment names the failing step", async () => {
  const provider = new FlakyMarkerProvider();
  provider.addIssue("73", "Real failure");
  provider.readMarkerErrors = [new Error("marker is corrupt")];
  const deps = makeDeps(provider, new FakeCodeHost(), { retry: noSleep });

  await runOne(deps);

  assert.equal(provider.readMarkerCalls, 1); // not retried
  assert.equal(provider.transitions[0]?.to, "blocked");
  assert.match(provider.transitions[0]?.detail ?? "", /while reading the issue marker: marker is corrupt/);
});

// ---------------------------------------------------------------------------
// #223 follow-ups: release uses a fresh snapshot, is bounded, skips what is no longer ours, and is never taken after a non-retried tracker write.

/** Records the labels of the issue snapshot each `transition` was handed, and can fail chosen transitions. */
class SnapshotProvider extends FakeProvider {
  snapshots: string[][] = [];
  failTransitions: Array<{ to: WatchState; error: Error; times: number }> = [];
  override async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    const f = this.failTransitions.find((x) => x.to === to && x.times > 0);
    if (f) {
      f.times--;
      throw f.error;
    }
    this.snapshots.push([...issue.labels]);
    return super.transition(issue, to, detail);
  }
}

function failingFetchDeps(provider: FakeProvider, overrides: Partial<WatchDeps> = {}): WatchDeps {
  const base = makeDeps(provider, new FakeCodeHost(), overrides);
  return {
    ...base,
    git: {
      ...base.git,
      fetch: () => {
        throw fetchFailed();
      },
    },
  };
}

test("release: transitions from a FRESH snapshot that carries the claim label, so the tracker can strip it", async () => {
  const provider = new SnapshotProvider();
  provider.addIssue("80", "Outage");
  await runOne(failingFetchDeps(provider));
  assert.deepEqual(provider.transitions.map((t) => t.to), ["ready"]);
  assert.ok(provider.snapshots[0]!.includes("piquette:working"), "the snapshot handed to transition lists the working label");
});

test("release: a human who parked the issue during the retries is not overwritten", async () => {
  const provider = new SnapshotProvider();
  provider.addIssue("81", "Parked mid-outage");
  const base = failingFetchDeps(provider);
  let parked = false;
  const deps: WatchDeps = {
    ...base,
    git: {
      ...base.git,
      fetch: () => {
        if (!parked) {
          parked = true;
          const e = provider.entries.get("81")!;
          e.state = "blocked";
          e.issue = { ...e.issue, labels: ["piquette:blocked"] };
        }
        throw fetchFailed();
      },
    },
  };
  await runOne(deps);
  assert.deepEqual(provider.transitions, []);
  assert.equal(provider.entries.get("81")!.state, "blocked");
});

test("release: a streak of transient releases is bounded — after the cap the issue is blocked with a comment", async () => {
  const provider = new SnapshotProvider();
  provider.addIssue("82", "Long outage");
  const { events, notify } = collectNotifications();
  const deps = failingFetchDeps(provider, { notify });
  const state = createWatchState();
  for (let i = 0; i < 12; i++) {
    await claimNewWork(deps, state);
    await waitUntil(() => state.inflight.size === 0);
  }
  const tos = provider.transitions.map((t) => t.to);
  assert.deepEqual(tos, ["ready", "ready", "ready", "ready", "ready", "blocked"]);
  assert.match(provider.transitions.at(-1)!.detail ?? "", /not released again/);
  assert.equal(events.filter((e) => /released/.test(e.title)).length, 5, "at most one notice per release, none past the cap");
});

test("release: a spec released from continue-refinement goes back to continue-refinement", async () => {
  const provider = new SnapshotProvider();
  provider.addIssue("201", "Answered spec", "continue-refinement", { feedback: { rounds: 1, asked_at: new Date(1000).toISOString() } });
  const state = createWatchState();
  const base = makeDeps(provider, new FakeCodeHost(), { refineEnabled: true });
  const deps: WatchDeps = {
    ...base,
    git: {
      ...base.git,
      fetch: () => {
        throw fetchFailed();
      },
    },
  };
  await claimSpecs(deps, state, "continue-refinement");
  await waitUntil(() => state.refining.size === 0);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["continue-refinement"]);
  assert.ok(provider.snapshots[0]!.includes("piquette:refining"));
});

test("release: a plain spec released from a transient failure goes back to spec-ready", async () => {
  const provider = new SnapshotProvider();
  provider.addIssue("202", "Fresh spec", "spec-ready");
  const state = createWatchState();
  const base = makeDeps(provider, new FakeCodeHost(), { refineEnabled: true });
  const deps: WatchDeps = { ...base, git: { ...base.git, fetch: () => { throw fetchFailed(); } } };
  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["spec-ready"]);
});

test("release: a revision (claimFeedback) with a persistent transient failure goes back to feedback", async () => {
  const provider = new SnapshotProvider();
  provider.addIssue("70", "Add auth", "feedback", { pr: 900, branch: "piquette-watch/70-add-auth", attempt: 0 });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(900, { merged: false, state: "open", ciStatus: "pending" });
  codeHost.prComments.set(900, [prComment("alice", "2020-01-02T00:00:00.000Z", "Please add a test.")]);
  const state = createWatchState();
  const base = makeDeps(provider, codeHost);
  const deps: WatchDeps = { ...base, git: { ...base.git, fetch: () => { throw fetchFailed(); } } };
  await claimFeedback(deps, state);
  await waitUntil(() => state.inflight.size === 0);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["feedback"]);
});

test("release: a release transition that itself keeps failing leaves the issue claimed and does not throw", async () => {
  const provider = new SnapshotProvider();
  provider.addIssue("83", "Double outage");
  provider.failTransitions.push({ to: "ready", error: fetchFailed(), times: 99 });
  const { logs, log } = (() => {
    const logs: string[] = [];
    return { logs, log: (m: string) => void logs.push(m) };
  })();
  await runOne(failingFetchDeps(provider, { log }));
  assert.equal(provider.entries.get("83")!.state, "working");
  assert.ok(logs.some((l) => /could not release the claim/.test(l)));
});

test("fan-out: a persistent transient failure before the chain releases the claim to ready", async () => {
  const provider = new SnapshotProvider();
  provider.addIssue("84", "Fanout outage");
  const base = makeDeps(provider, new FakeCodeHost());
  let probes = 0;
  const deps: WatchDeps = {
    ...base,
    fanout: {
      n: 2,
      concurrency: 2,
      repoRoot: scratchRoot,
      adwIdsFree: async () => {
        probes++;
        throw fetchFailed();
      },
    } as unknown as NonNullable<WatchDeps["fanout"]>,
  };
  await runOne(deps);
  assert.ok(probes >= 1);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["ready"]);
});

test("spec: a transient failure on the already-refined announcement blocks once — it is never re-announced on every tick", async () => {
  const provider = new SnapshotProvider();
  provider.addIssue("85", "Refined spec", "spec-ready", { refined: ["81", "82"] });
  provider.failTransitions.push({ to: "spec-in-progress", error: fetchFailed(), times: 99 });
  const state = createWatchState();
  const deps = makeDeps(provider, new FakeCodeHost(), { refineEnabled: true });
  for (let i = 0; i < 3; i++) {
    await claimSpecs(deps, state);
    await waitUntil(() => state.refining.size === 0);
  }
  const announcements = provider.entries.get("85")!.comments.filter((c) => /refined this spec into/.test(c.body));
  assert.equal(announcements.length, 1);
  assert.equal(provider.entries.get("85")!.state, "blocked");
});

test("revision: a transient failure on the no-recorded-PR block is not released back to feedback", async () => {
  const provider = new SnapshotProvider();
  provider.addIssue("86", "No PR", "feedback", { attempt: 0 });
  provider.failTransitions.push({ to: "blocked", error: fetchFailed(), times: 1 });
  const state = createWatchState();
  const deps = makeDeps(provider, new FakeCodeHost());
  await claimFeedback(deps, state);
  await waitUntil(() => state.inflight.size === 0);
  assert.ok(!provider.transitions.some((t) => t.to === "feedback"), "never released to feedback");
  assert.equal(provider.entries.get("86")!.state, "blocked");
});

// ── run links: the claimed issue and the opened PR reach the run's trace ─────

test("run links: the chain run is told its issue, and the opened PR is recorded on the same run", async () => {
  const provider = new FakeProvider();
  provider.addIssue("61", "Link me");
  provider.entries.get("61")!.issue.url = "https://github.com/acme/api/issues/61";
  const codeHost = new FakeCodeHost();
  const chainLinks: unknown[] = [];
  const recorded: Array<{ adwId: string; links: unknown }> = [];
  const deps = makeDeps(provider, codeHost, {
    runChain: async (opts): Promise<ChainRunResult> => {
      chainLinks.push(opts.links);
      return { accepted: true, adwId: opts.adwId, detail: "" };
    },
    recordRunLinks: async (adwId, links) => {
      recorded.push({ adwId, links });
    },
  });
  await runOne(deps);
  assert.deepEqual(chainLinks, [{ issue: { label: "#61", url: "https://github.com/acme/api/issues/61" } }]);
  assert.deepEqual(recorded, [
    {
      adwId: "issue-61",
      links: { issue: { label: "#61", url: "https://github.com/acme/api/issues/61" }, pr: { label: "#1000", url: "https://example.invalid/pr/1000" } },
    },
  ]);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
});

test("run links: a Jira key keeps its key as the label, and a failed record never blocks the landing", async () => {
  const provider = new FakeProvider();
  provider.addIssue("BT-1221", "Jira work");
  provider.entries.get("BT-1221")!.issue.url = "https://acme.atlassian.net/browse/BT-1221";
  const codeHost = new FakeCodeHost();
  const chainLinks: unknown[] = [];
  const logs: string[] = [];
  const deps = makeDeps(provider, codeHost, {
    runChain: async (opts): Promise<ChainRunResult> => {
      chainLinks.push(opts.links);
      return { accepted: true, adwId: opts.adwId, detail: "" };
    },
    recordRunLinks: async () => {
      throw new Error("db is locked");
    },
    log: (m) => logs.push(m),
  });
  await runOne(deps);
  assert.deepEqual(chainLinks, [{ issue: { label: "BT-1221", url: "https://acme.atlassian.net/browse/BT-1221" } }]);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"], "the PR still lands");
  assert.ok(logs.some((l) => /could not record PR #1000 on run issue-BT-1221 \(best-effort\) — db is locked/.test(l)), logs.join("\n"));
});

test("run links: a deferred landing records the PR on the run that built it once the retry opens it", async () => {
  const provider = new FakeProvider();
  provider.addIssue("62", "Blip then land");
  const codeHost = new FakeCodeHost();
  codeHost.openPrAlwaysError = fetchFailed();
  const recorded: Array<{ adwId: string; links: unknown }> = [];
  const deps = makeDeps(provider, codeHost, {
    runChain: async (opts): Promise<ChainRunResult> => ({ accepted: true, adwId: opts.adwId, detail: "" }),
    recordRunLinks: async (adwId, links) => {
      recorded.push({ adwId, links });
    },
  });
  await runOne(deps);
  assert.deepEqual(recorded, [], "no PR yet — nothing recorded");
  assert.equal(provider.entries.get("62")!.marker?.landing?.adw_id, "issue-62");
  codeHost.openPrAlwaysError = null;
  await reconcileOrphans(deps, createWatchState());
  assert.deepEqual(recorded, [{ adwId: "issue-62", links: { issue: { label: "#62", url: null }, pr: { label: "#1000", url: "https://example.invalid/pr/1000" } } }]);
});

test("run links: a revision pushed to an open PR known only by number looks the PR up by branch, so the revised run still links it", async () => {
  const provider = new FakeProvider();
  provider.addIssue("71", "Revise me", "feedback", { pr: 900, branch: "piquette-watch/71-revise-me", attempt: 0 });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(900, { merged: false, state: "open", ciStatus: "pending" });
  codeHost.prComments.set(900, [prComment("alice", "2020-01-02T00:00:00.000Z", "Rename the flag.")]);
  codeHost.existingOpenPr = { number: 900, branch: "piquette-watch/71-revise-me", url: "https://bitbucket.org/acme/api/pull-requests/900" };
  const recorded: Array<{ adwId: string; links: unknown }> = [];
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    runChain: async (opts): Promise<ChainRunResult> => ({ accepted: true, adwId: opts.adwId, detail: "" }),
    recordRunLinks: async (adwId, links) => {
      recorded.push({ adwId, links });
    },
  });
  await claimFeedback(deps, state);
  await waitUntil(() => state.inflight.size === 0);
  assert.equal(codeHost.openedPrs.length, 0, "no new PR");
  assert.deepEqual(recorded, [
    { adwId: "issue-71", links: { issue: { label: "#71", url: null }, pr: { label: "#900", url: "https://bitbucket.org/acme/api/pull-requests/900" } } },
  ]);
});

test("run links: the refine run is told the spec issue it refines", async () => {
  const provider = new FakeProvider();
  provider.addIssue("120", "A spec", "spec-ready");
  provider.entries.get("120")!.issue.url = "https://github.com/acme/api/issues/120";
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const seen: unknown[] = [];
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts): Promise<RefineRunResult> => {
      seen.push(opts.links);
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [], split: [] };
    },
  });
  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);
  assert.deepEqual(seen, [{ issue: { label: "#120", url: "https://github.com/acme/api/issues/120" } }]);
});
