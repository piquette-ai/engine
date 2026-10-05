import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubProjectsProvider, type GitHubProjectsBoardConfig } from "../core/issues/github_projects_provider.js";
import type { GithubProjectsStatusMap } from "../core/data_types.js";

const REPO = "acme/widgets";

const DEFAULT_STATUS_MAP: GithubProjectsStatusMap = {
  ready: "Todo",
  working: "In Progress",
  review: "In Review",
  done: "Done",
  blocked: "Blocked",
};

function makeProvider(board: Partial<GitHubProjectsBoardConfig> = {}): GitHubProjectsProvider {
  return new GitHubProjectsProvider(REPO, "spf", "ghp_test-token", {
    projectNumber: 3,
    owner: "",
    statusField: "Status",
    unmappedStatus: "",
    snapshotTtlMs: 30_000,
    statusMap: DEFAULT_STATUS_MAP,
    ...board,
  });
}

interface FetchCall {
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** Same approach as `github_provider.test.ts`'s own mock — captures every sequential fetch call and serves `.json()`. */
function mockFetch(responses: Array<{ status?: number; body?: unknown }>): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  let i = 0;
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const resp = responses[Math.min(i, responses.length - 1)]!;
    i++;
    const status = resp.status ?? (resp.body === undefined ? 204 : 200);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (resp.body === undefined ? "" : JSON.stringify(resp.body)),
      json: async () => resp.body,
    } as unknown as Response;
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Silences and captures `console.error` for the duration of a test — several behaviors here are "log once, never throw." */
function captureErrors(): { messages: string[]; restore: () => void } {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.error = original;
    },
  };
}

const RATE_LIMIT_OK = { cost: 1, remaining: 4999, resetAt: "2026-01-01T00:00:00.000Z" };

function boardMetaBody(
  options: Array<{ id: string; name: string }> = [
    { id: "opt_todo", name: "Todo" },
    { id: "opt_progress", name: "In Progress" },
    { id: "opt_review", name: "In Review" },
    { id: "opt_done", name: "Done" },
    { id: "opt_blocked", name: "Blocked" },
  ],
) {
  return {
    data: {
      organization: { projectV2: { id: "PVT_1", fields: { pageInfo: { hasNextPage: false }, nodes: [{ id: "PVTSSF_1", name: "Status", options }] } } },
      user: null,
    },
  };
}

interface IssueNodeOpts {
  number: number;
  statusName?: string | null;
  labels?: string[];
  repo?: string;
  type?: "ISSUE" | "PULL_REQUEST" | "DRAFT_ISSUE" | "REDACTED";
  isArchived?: boolean;
  databaseId?: number;
  createdAt?: string;
  state?: "OPEN" | "CLOSED";
  author?: string | null;
}

function issueNode(opts: IssueNodeOpts) {
  const type = opts.type ?? "ISSUE";
  return {
    isArchived: opts.isArchived ?? false,
    type,
    fieldValueByName: opts.statusName ? { name: opts.statusName } : null,
    content:
      type === "ISSUE"
        ? {
            __typename: "Issue",
            number: opts.number,
            databaseId: opts.databaseId ?? opts.number + 1000,
            title: `issue ${opts.number}`,
            body: "",
            createdAt: opts.createdAt ?? "2026-01-01T00:00:00.000Z",
            state: opts.state ?? "OPEN",
            author: opts.author === null ? null : { login: opts.author ?? "alice" },
            labels: { nodes: (opts.labels ?? []).map((name) => ({ name })) },
            repository: { nameWithOwner: opts.repo ?? REPO },
          }
        : type === "DRAFT_ISSUE"
          ? { __typename: "DraftIssue" }
          : null, // PULL_REQUEST and REDACTED both carry null/irrelevant content for our purposes
  };
}

function boardItemsPage(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      rateLimit: RATE_LIMIT_OK,
      organization: { projectV2: { items: { pageInfo: { hasNextPage, endCursor }, nodes } } },
      user: null,
    },
  };
}

// ── listEligible / listInState: paging, ordering, filtering ────────────────

test("listEligible: a single page, one matching item, spliced with exactly one state label", async () => {
  const { restore } = mockFetch([
    { body: boardMetaBody() },
    { body: boardItemsPage([issueNode({ number: 1, statusName: "Todo", labels: ["spf:priority:p1", "spf:type:bug"] })]) },
  ]);
  try {
    const provider = makeProvider();
    const issues = await provider.listEligible();
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.id, "1");
    assert.deepEqual(
      [...issues[0]!.labels].sort(),
      ["spf:priority:p1", "spf:ready", "spf:type:bug"],
      "exactly one synthetic state label spliced in; priority/type labels survive untouched",
    );
  } finally {
    restore();
  }
});

test("listInState: pages across pageInfo.hasNextPage, passing the previous page's endCursor forward", async () => {
  const { calls, restore } = mockFetch([
    { body: boardMetaBody() },
    { body: boardItemsPage([issueNode({ number: 1, statusName: "Todo" })], true, "cursor-1") },
    { body: boardItemsPage([issueNode({ number: 2, statusName: "Todo" })], false) },
  ]);
  try {
    const provider = makeProvider();
    const issues = await provider.listEligible();
    assert.deepEqual(
      issues.map((i) => i.id),
      ["1", "2"],
    );
    assert.equal(calls[2]!.body.variables.cursor, "cursor-1", "the second page request must carry the first page's endCursor");
  } finally {
    restore();
  }
});

test("listEligible: items are sorted by createdAt ascending regardless of the board's own return order", async () => {
  const { restore } = mockFetch([
    { body: boardMetaBody() },
    {
      body: boardItemsPage([
        issueNode({ number: 2, statusName: "Todo", createdAt: "2026-01-02T00:00:00.000Z" }),
        issueNode({ number: 1, statusName: "Todo", createdAt: "2026-01-01T00:00:00.000Z" }),
      ]),
    },
  ]);
  try {
    const provider = makeProvider();
    const issues = await provider.listEligible();
    assert.deepEqual(
      issues.map((i) => i.id),
      ["1", "2"],
      "the board returned #2 before #1, but createdAt order must win — orderEligible's own final tiebreaker depends on it",
    );
  } finally {
    restore();
  }
});

test("listEligible: draft issues, pull requests, redacted content, foreign-repo items, and archived items are all excluded", async () => {
  const { restore } = mockFetch([
    { body: boardMetaBody() },
    {
      body: boardItemsPage([
        issueNode({ number: 1, statusName: "Todo" }), // kept
        issueNode({ number: 2, statusName: "Todo", type: "DRAFT_ISSUE" }),
        issueNode({ number: 3, statusName: "Todo", type: "PULL_REQUEST" }),
        issueNode({ number: 4, statusName: "Todo", type: "REDACTED" }),
        issueNode({ number: 5, statusName: "Todo", repo: "acme/other-repo" }),
        issueNode({ number: 6, statusName: "Todo", isArchived: true }),
      ]),
    },
  ]);
  const errs = captureErrors();
  try {
    const provider = makeProvider();
    const issues = await provider.listEligible();
    assert.deepEqual(issues.map((i) => i.id), ["1"]);
    assert.ok(
      errs.messages.some((m) => m.includes("draft")),
      "draft items must be logged, not silently dropped",
    );
    assert.ok(
      errs.messages.some((m) => m.includes("acme/other-repo")),
      "a foreign-repo item must be logged, naming the repo",
    );
  } finally {
    errs.restore();
    restore();
  }
});

test("listInState: an unrecognized Status option derives no state and matches nothing", async () => {
  const { restore } = mockFetch([{ body: boardMetaBody() }, { body: boardItemsPage([issueNode({ number: 1, statusName: "Someone Renamed This" })]) }]);
  try {
    const provider = makeProvider();
    assert.deepEqual(await provider.listEligible(), []);
  } finally {
    restore();
  }
});

test("listInState: includeAll controls whether a CLOSED issue is returned", async () => {
  const { restore } = mockFetch([{ body: boardMetaBody() }, { body: boardItemsPage([issueNode({ number: 1, statusName: "In Review", state: "CLOSED" })]) }]);
  try {
    const provider = makeProvider();
    assert.deepEqual(await provider.listInState("review", { includeAll: false }), []);
  } finally {
    restore();
  }
});

test("listInState: includeAll: true returns a CLOSED issue too — matches GitHub auto-close-on-merge without the issue ever vanishing from the board", async () => {
  const { restore } = mockFetch([{ body: boardMetaBody() }, { body: boardItemsPage([issueNode({ number: 1, statusName: "In Review", state: "CLOSED" })]) }]);
  try {
    const provider = makeProvider();
    const issues = await provider.listInState("review", { includeAll: true });
    assert.equal(issues.length, 1);
  } finally {
    restore();
  }
});

test("listEligible: a label-only state SHADOWS the board — a real spf:refining label wins over a board Status that maps to ready", async () => {
  const { restore } = mockFetch([{ body: boardMetaBody() }, { body: boardItemsPage([issueNode({ number: 1, statusName: "Todo", labels: ["spf:refining"] })]) }]);
  try {
    const provider = makeProvider();
    assert.deepEqual(await provider.listEligible(), [], "the item's board Status says Todo (-> ready), but its real spf:refining label must shadow that");
  } finally {
    restore();
  }
});

test("listInState: two calls in the same tick reuse one board scan (the per-tick snapshot)", async () => {
  const { calls, restore } = mockFetch([{ body: boardMetaBody() }, { body: boardItemsPage([issueNode({ number: 1, statusName: "Todo" }), issueNode({ number: 2, statusName: "In Progress" })]) }]);
  try {
    const provider = makeProvider();
    await provider.listEligible();
    await provider.listInState("working");
    assert.equal(calls.length, 2, "a second listInState call must not re-page the board — board meta + one page, total, for both calls combined");
  } finally {
    restore();
  }
});

test("listInState: a label-only state delegates to the inherited REST label search, not the board", async () => {
  const { calls, restore } = mockFetch([{ body: [{ id: 7, number: 7, title: "x", body: "", labels: ["spf:refining"] }] }]);
  try {
    const provider = makeProvider();
    const issues = await provider.listInState("refining");
    assert.equal(issues.length, 1);
    assert.ok(issues[0]!.labels.includes("spf:refining"));
    assert.ok(calls[0]!.url.includes("/issues?labels="), "must be a plain REST label search, not a GraphQL board scan");
  } finally {
    restore();
  }
});

// ── transition ───────────────────────────────────────────────────────────

test("transition: a board-mapped state strips real state labels, writes the board field, and adds no label", async () => {
  const { calls, restore } = mockFetch([
    {}, // DELETE spf:working
    { body: boardMetaBody() }, // resolveBoardMeta (via resolveItemId's caller)
    { body: { data: { repository: { issue: { id: "I_1", projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: "PVTI_1", project: { id: "PVT_1" } }] } } } } } }, // resolveItemId: already on project
    { body: { data: {} } }, // updateProjectV2ItemFieldValue
  ]);
  try {
    const provider = makeProvider();
    await provider.transition({ id: "42", title: "x", body: "", labels: ["spf:working"] }, "review");
    assert.equal(calls.length, 4);
    assert.equal(calls[0]!.method, "DELETE");
    assert.match(calls[1]!.url, /\/graphql$/);
    assert.match(calls[3]!.body.query, /updateProjectV2ItemFieldValue/);
    assert.deepEqual(calls[3]!.body.variables, { projectId: "PVT_1", itemId: "PVTI_1", fieldId: "PVTSSF_1", optionId: "opt_review" });
  } finally {
    restore();
  }
});

test("transition: an unmapped state with no unmapped_status adds the real label, writes no Status mutation, and logs exactly once per state", async () => {
  const errs = captureErrors();
  // The issue carries no state label to begin with, so each transition
  // makes exactly ONE call (POST the new label) — no DELETE, no GraphQL.
  const { calls, restore } = mockFetch([{}, {}]);
  try {
    const provider = makeProvider();
    const issue = { id: "42", title: "x", body: "", labels: [] };
    await provider.transition(issue, "refining");
    await provider.transition(issue, "refining");
    assert.equal(calls.length, 2, "no GraphQL calls at all for an unmapped state");
    assert.ok(calls.every((c) => !c.url.includes("/graphql")));
    const unmappedWarnings = errs.messages.filter((m) => m.includes('"refining" has no watch.github_projects.status_map entry'));
    assert.equal(unmappedWarnings.length, 1, "the warning must fire once per state per process, not once per transition");
  } finally {
    errs.restore();
    restore();
  }
});

test("transition: an unmapped state WITH unmapped_status set also writes the holding column", async () => {
  // The issue carries no state label to begin with, so there's no DELETE —
  // just: POST the new label, resolve the board, resolve (or add) the item,
  // then the holding-column mutation.
  const { calls, restore } = mockFetch([
    {}, // POST label
    {
      body: boardMetaBody([
        { id: "opt_todo", name: "Todo" },
        { id: "opt_progress", name: "In Progress" },
        { id: "opt_review", name: "In Review" },
        { id: "opt_done", name: "Done" },
        { id: "opt_blocked", name: "Blocked" },
        { id: "opt_backlog", name: "Backlog" }, // the unmapped_status holding column
      ]),
    },
    { body: { data: { repository: { issue: { id: "I_1", projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: "PVTI_1", project: { id: "PVT_1" } }] } } } } } },
    { body: { data: {} } }, // updateProjectV2ItemFieldValue for the holding column
  ]);
  try {
    const provider = makeProvider({ unmappedStatus: "Backlog" });
    await provider.transition({ id: "42", title: "x", body: "", labels: [] }, "refining");
    assert.equal(calls.length, 4, "no DELETE issued since the issue carried no real state label to strip");
    assert.match(calls[3]!.body.query, /updateProjectV2ItemFieldValue/);
  } finally {
    restore();
  }
});

test("transition: a mapped state whose Status mutation fails THROWS — the inversion from the legacy mirror's log-and-swallow", async () => {
  const { restore } = mockFetch([
    {},
    { body: boardMetaBody() },
    { body: { data: { repository: { issue: { id: "I_1", projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: "PVTI_1", project: { id: "PVT_1" } }] } } } } } },
    { status: 500, body: "server error" },
  ]);
  try {
    const provider = makeProvider();
    await assert.rejects(() => provider.transition({ id: "42", title: "x", body: "", labels: ["spf:working"] }, "review"));
  } finally {
    restore();
  }
});

// ── claim ────────────────────────────────────────────────────────────────

function freshStateBody(labels: string[], statusName: string | null, itemId = "PVTI_1", projectId = "PVT_1", closed = false) {
  return {
    data: {
      repository: {
        issue: {
          state: closed ? "CLOSED" : "OPEN",
          labels: { nodes: labels.map((name) => ({ name })) },
          projectItems: { nodes: itemId ? [{ id: itemId, project: { id: projectId }, fieldValueByName: statusName ? { name: statusName } : null }] : [] },
        },
      },
    },
  };
}

test("claim: happy path — pre-verify matches, writes, read-back confirms", async () => {
  const { restore } = mockFetch([
    { body: boardMetaBody() }, // resolveBoardMeta (via fetchFreshState's own resolveBoardMeta call)
    { body: freshStateBody(["spf:ready"], "Todo") }, // pre-verify fetch
    {}, // DELETE spf:ready
    { body: { data: {} } }, // updateProjectV2ItemFieldValue (working)
    { body: freshStateBody([], "In Progress") }, // read-back fetch
  ]);
  try {
    const provider = makeProvider();
    const claimed = await provider.claim({ id: "42", title: "x", body: "", labels: ["spf:ready"] });
    assert.equal(claimed, true);
  } finally {
    restore();
  }
});

test("claim: pre-verify mismatch returns false and makes no write", async () => {
  const { calls, restore } = mockFetch([
    { body: boardMetaBody() },
    { body: freshStateBody(["spf:blocked"], "Blocked") }, // already moved on
  ]);
  try {
    const provider = makeProvider();
    const claimed = await provider.claim({ id: "42", title: "x", body: "", labels: [] });
    assert.equal(claimed, false);
    assert.equal(calls.length, 2, "no DELETE/POST/mutation calls after a failed pre-verify");
  } finally {
    restore();
  }
});

test("claim: read-back showing a THIRD state returns false and does not revert", async () => {
  const { calls, restore } = mockFetch([
    { body: boardMetaBody() },
    { body: freshStateBody(["spf:ready"], "Todo") }, // pre-verify: ready, matches "from"
    {}, // DELETE
    { body: { data: {} } }, // mutation to working
    { body: freshStateBody([], "Blocked") }, // read-back: a human moved it to Blocked mid-claim
  ]);
  try {
    const provider = makeProvider();
    const claimed = await provider.claim({ id: "42", title: "x", body: "", labels: ["spf:ready"] });
    assert.equal(claimed, false);
    assert.equal(calls.length, 5, "no further write after seeing an unexpected third state — never fights a human's own edit");
  } finally {
    restore();
  }
});

test("claim: both from and to are label-only states — delegates to the inherited REST claim, no GraphQL at all", async () => {
  const { calls, restore } = mockFetch([
    {}, // DELETE spf:continue-refinement
    {}, // POST spf:refining
    { body: { id: 42, number: 42, title: "x", body: "", labels: ["spf:refining"] } }, // read-back GET
  ]);
  try {
    const provider = makeProvider();
    const claimed = await provider.claim({ id: "42", title: "x", body: "", labels: ["spf:continue-refinement"] }, { from: "continue-refinement", to: "refining" });
    assert.equal(claimed, true);
    assert.ok(calls.every((c) => !c.url.includes("/graphql")));
  } finally {
    restore();
  }
});

// ── ensureLabels / validateBoard ─────────────────────────────────────────

test("ensureLabels: seeds type/priority labels and unmapped-state labels only — never touches the board", async () => {
  // Every label goes through getLabel (404 -> not found) then POST (create) —
  // alternating responses so every GET sees a 404 and every POST sees a 2xx
  // (a single repeated 404 would make the POST calls fail too, since `gh()`
  // throws on any non-2xx).
  const responses: Array<{ status?: number; body?: unknown }> = [];
  for (let i = 0; i < 20; i++) {
    responses.push({ status: 404 });
    responses.push({ status: 201, body: {} });
  }
  const { calls, restore } = mockFetch(responses);
  try {
    const provider = makeProvider();
    await provider.ensureLabels();
    assert.ok(
      calls.every((c) => !c.url.includes("/graphql") && !c.body?.query?.includes?.("updateProjectV2Field")),
      "ensureLabels must never create or edit a Status option",
    );
    const createdNames = calls.filter((c) => c.method === "POST" && c.url.endsWith("/labels")).map((c) => c.body.name);
    for (const mapped of ["spf:ready", "spf:working", "spf:review", "spf:done", "spf:blocked"]) {
      assert.ok(!createdNames.includes(mapped), `${mapped} is board-mapped and must not be seeded as a label`);
    }
    assert.ok(createdNames.includes("spf:refining"), "an unmapped state must still get a label seeded");
    assert.ok(createdNames.includes("spf:type:bug"));
    assert.ok(createdNames.includes("spf:priority:p0"));
  } finally {
    restore();
  }
});

test("validateBoard: every required state mapped and present -> ok", async () => {
  const { restore } = mockFetch([{ body: boardMetaBody() }]);
  try {
    const provider = makeProvider();
    const result = await provider.validateBoard();
    assert.equal(result.ok, true);
    assert.ok(result.checks.every((c) => !c.required || (c.mapped && c.exists)));
  } finally {
    restore();
  }
});

test("validateBoard: a missing Status option for a mapped state -> not ok", async () => {
  const { restore } = mockFetch([{ body: boardMetaBody([{ id: "opt_todo", name: "Todo" }]) }]); // "In Progress" etc. all absent
  try {
    const provider = makeProvider();
    const result = await provider.validateBoard();
    assert.equal(result.ok, false);
    const working = result.checks.find((c) => c.state === "working")!;
    assert.equal(working.mapped, true);
    assert.equal(working.exists, false);
  } finally {
    restore();
  }
});

test("validateBoard: a required state with no status_map entry at all -> not ok", async () => {
  const { restore } = mockFetch([{ body: boardMetaBody() }]);
  try {
    const provider = makeProvider({ statusMap: { ready: "Todo", working: "In Progress", review: "In Review", done: "Done" } }); // blocked missing
    const result = await provider.validateBoard();
    assert.equal(result.ok, false);
    const blocked = result.checks.find((c) => c.state === "blocked")!;
    assert.equal(blocked.mapped, false);
  } finally {
    restore();
  }
});

test("validateBoard: two states mapped to the same option name -> non-injective, not ok", async () => {
  const { restore } = mockFetch([{ body: boardMetaBody() }]);
  try {
    const provider = makeProvider({ statusMap: { ...DEFAULT_STATUS_MAP, done: "In Review" } }); // done now collides with review
    const result = await provider.validateBoard();
    assert.equal(result.ok, false);
    assert.equal(result.nonInjectiveOptions.length, 1);
    assert.deepEqual(result.nonInjectiveOptions[0]!.states.sort(), ["done", "review"]);
  } finally {
    restore();
  }
});

test("validateBoard: duplicate option names on the board itself are reported", async () => {
  const { restore } = mockFetch([
    {
      body: boardMetaBody([
        { id: "opt_todo", name: "Todo" },
        { id: "opt_todo_2", name: "Todo" },
        { id: "opt_progress", name: "In Progress" },
        { id: "opt_review", name: "In Review" },
        { id: "opt_done", name: "Done" },
        { id: "opt_blocked", name: "Blocked" },
      ]),
    },
  ]);
  try {
    const provider = makeProvider();
    const result = await provider.validateBoard();
    assert.deepEqual(result.duplicateOptionNames, ["Todo"]);
    assert.equal(result.ok, false);
  } finally {
    restore();
  }
});

// ── createIssue ──────────────────────────────────────────────────────────

test("createIssue: a label-only state (e.g. refined) needs no board WRITE — the final getIssue refetch still reads the board (every getIssue does), but nothing mutates it", async () => {
  const { calls, restore } = mockFetch([
    { body: { id: 9, number: 9, title: "leaf", body: "", labels: ["spf:refined"] } }, // REST create
    { body: boardMetaBody() }, // final getIssue -> boardItems() -> resolveBoardMeta (no cache yet)
    { body: boardItemsPage([issueNode({ number: 9, statusName: null, labels: ["spf:refined"] })]) }, // final getIssue -> boardItems() page
    { body: { id: 9, number: 9, title: "leaf", body: "", labels: ["spf:refined"] } }, // final getIssue -> REST fetch
  ]);
  try {
    const provider = makeProvider();
    const created = await provider.createIssue({ title: "leaf", body: "", labels: ["spf:refined"], kind: "bug" });
    assert.ok(created.labels.includes("spf:refined"));
    assert.ok(
      calls.every((c) => !c.body?.query?.includes?.("addProjectV2ItemById") && !c.body?.query?.includes?.("updateProjectV2ItemFieldValue")),
      "a label-only state must never add the issue to the board or write its Status field",
    );
  } finally {
    restore();
  }
});

test("createIssue: a board-mapped state label is moved onto the board and the REST label is stripped", async () => {
  const { restore } = mockFetch([
    { body: { id: 10, number: 10, title: "spec", body: "", labels: ["spf:ready"] } }, // REST create
    { body: boardMetaBody() }, // resolveBoardMeta
    { body: { data: { repository: { issue: { id: "I_2", projectItems: { pageInfo: { hasNextPage: false }, nodes: [] } } } } } }, // resolveItemId: not yet on project
    { body: { data: { addProjectV2ItemById: { item: { id: "PVTI_2" } } } } }, // add to project
    { body: { data: {} } }, // updateProjectV2ItemFieldValue
    {}, // DELETE the now-redundant spf:ready label
    // resolveBoardMeta's TTL cache is still warm from the calls above (same
    // instance, well within snapshotTtlMs), so the final getIssue -> boardItems()
    // makes exactly ONE more network call: the items page itself.
    { body: boardItemsPage([issueNode({ number: 10, statusName: "Todo" })]) },
    { body: { id: 10, number: 10, title: "spec", body: "", labels: [] } }, // final getIssue -> REST fetch
  ]);
  try {
    const provider = makeProvider({ statusMap: { ...DEFAULT_STATUS_MAP, "spec-ready": undefined } });
    const created = await provider.createIssue({ title: "spec", body: "", labels: ["spf:ready"], kind: "story" });
    assert.ok(created.labels.includes("spf:ready"), "state is now carried by the board, but toIssue's splice must still surface it as a label for watch.ts's label-reading consumers");
  } finally {
    restore();
  }
});
