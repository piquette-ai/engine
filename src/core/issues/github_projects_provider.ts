/**
 * `issue_provider: "github-projects"` — a GitHub Projects v2 board's
 * "Status" single-select field, rather than a `<prefix>:<state>` label, IS
 * the state machine. Subclasses `GitHubProvider` (`github_provider.ts`) and
 * reuses its REST transport, PR lifecycle, comment/marker handling, and
 * sub-issue hierarchy wholesale — a board swaps out INTAKE and TRANSITIONS,
 * nothing else; `openPr`/`prStatus`/`listPrComments`/`comment`/`readMarker`/
 * `writeMarker`/`listComments`/`closeIssue`/`linkChild` are all inherited
 * unchanged. `super()` is always called with `projectNumber = 0`, which
 * disables the base class's own best-effort Projects v2 mirror
 * (`syncStatus()`) so it never double-writes the same Status field this
 * class manages directly.
 *
 * SCOPE (both deliberate, both logged when hit, neither supported):
 *  - Draft items (no backing repo issue) are skipped. They have no issue
 *    number, no labels, no comments — `WatchMarker`, `listComments()`, and
 *    PR cross-linking all have nowhere to live.
 *  - A board can span repos; only items whose `content.repository.
 *    nameWithOwner` matches this instance's `repo` are tracked. No per-repo
 *    worktrees, no per-repo `base_branch`.
 *
 * STATE MODEL — five board columns, the rest shadowed by labels:
 * `WatchState` has fourteen members (`provider.ts`); forcing every one onto
 * a human's kanban is hostile, and the refine lane's bookkeeping states
 * (`refining`, `split-proposed`, ...) are machine-internal, not work a human
 * schedules by. `watch.github_projects.status_map` lets an operator map
 * ANY subset of the fourteen onto real Status options (`ready`/`working`/
 * `review`/`done`/`blocked` are required — see `GITHUB_PROJECTS_REQUIRED_
 * STATES` below; everything else is opt-in). A state with NO entry stays
 * LABEL-ONLY: `transition()` still writes a real `<prefix>:<state>` label
 * for it, exactly like `issue_provider: "github"` always does, and the
 * board's Status field is left alone (or set to `unmapped_status`, if
 * configured, as a purely cosmetic holding column).
 *
 * `core/watch.ts` is NOT provider-agnostic about state representation —
 * `rollUp`/`frontierBlockedOn`/`finishTrackedSpecs` all read
 * `Issue.labels.includes(`${prefix}:done`)` directly rather than asking the
 * provider. Rather than teach four call sites in `watch.ts` a second way to
 * read state, this provider PROJECTS the board's Status back into
 * `Issue.labels` as a synthetic state label: `toIssue()` (overridden below)
 * derives a `WatchState` from the Status option (or from a label-only
 * state's real label, which SHADOWS the board — see `deriveState()`),
 * strips every real `<prefix>:<state>` label, and splices in exactly the
 * one derived label. Every label-reading consumer in `watch.ts` keeps
 * working unmodified; the provider stays the only thing that knows
 * Status<->state.
 *
 * Because `toIssue()` is the ONE seam every `Issue`-constructing method
 * funnels through, overriding it (via ordinary virtual dispatch) is also
 * what makes `getIssue`/`listChildren` correct with almost no code of their
 * own below — see their doc comments.
 */
import type { GithubProjectsStatusMap } from "../data_types.ts";
import { GitHubProvider, ISSUE_KINDS, LABEL_META, PRIORITIES, PRIORITY_LABEL_META, STATES, TYPE_LABEL_META } from "./github_provider.ts";
import type { EnsureLabelsResult, Issue, IssueAuthoringKind, WatchState } from "./provider.ts";

/**
 * The build lane's five — a board with fewer columns than this isn't a
 * usable kanban for `spf watch` to drive, so these MUST be mapped, checked
 * at `spf watch`/`spf watch init` startup (`cli/commands/watch.ts`), not by
 * this valibot schema (same "fails loudly before anything spawns, not
 * eagerly at parse time" pattern `WatchRefineConfigSchema`'s sibling fields
 * already follow).
 */
export const GITHUB_PROJECTS_REQUIRED_STATES: readonly WatchState[] = ["ready", "working", "review", "done", "blocked"];

/**
 * Board-visible if an operator wants them there, label-only otherwise — the
 * build lane's own `feedback` escape hatch, plus the refine lane's two
 * human-facing waypoints (`spec-ready`, `spec-in-progress`). Every other
 * `WatchState` (the refine lane's internal bookkeeping) is ALSO legal to map
 * — `isBoardMapped()` below just asks `status_map`, never consults this
 * list — but doing so is rarely worth a column. Exported purely for
 * doctor/interview/`spf watch init` reporting, never consulted by this
 * class's own logic.
 */
export const GITHUB_PROJECTS_OPTIONAL_BOARD_STATES: readonly WatchState[] = ["feedback", "spec-ready", "spec-in-progress"];

/** `boardItems()`'s pagination bound — 2x `github_provider.ts`'s own `MAX_LIST_PAGES` item budget, since one walk here serves EVERY state this tick, not one per state. Same loud-warning-not-silent-truncation rule. */
const MAX_BOARD_PAGES = 10;

/** `fetchFreshState`/`resolveItemId`'s own item-membership page size — 20 boards per issue is already an unusual setup; see `pageInfo.hasNextPage`'s own loud warning at each call site below. */
const MAX_PROJECT_ITEMS_PER_ISSUE = 20;

export interface GitHubProjectsBoardConfig {
  /** Owner-scoped, not repo-scoped — see `WatchGithubProjectsConfigSchema`'s doc comment (`data_types.ts`). `0` means unconfigured; the factory (`cli/commands/watch.ts`) refuses to construct this class at all when it's `0`, so every method below may assume it's a real, positive number. */
  projectNumber: number;
  /** `""` = derive from `repo`'s owner half, resolved once at construction (not per-call, unlike the legacy mirror) since it never changes for the life of an instance. */
  owner: string;
  statusField: string;
  statusMap: GithubProjectsStatusMap;
  /** `""` = leave a label-only state's Status field untouched entirely. */
  unmappedStatus: string;
  /** How long `boardItems()`'s per-tick snapshot and `resolveBoardMeta()`'s field/option cache stay fresh before the next read re-pages — see both methods' own doc comments for why NEITHER caches for the instance's full (potentially daemon-long) lifetime the way the legacy mirror's `projectMeta` does. */
  snapshotTtlMs: number;
}

/** One `WatchState` row in `validateBoard()`'s report — see that method's own doc comment. */
export interface GithubProjectsBoardCheck {
  state: WatchState;
  required: boolean;
  mapped: boolean;
  statusName?: string;
  /** `true` when unmapped (nothing to fail) OR mapped-and-found; `false` only when mapped but no such Status option exists. */
  exists: boolean;
}

export interface GithubProjectsBoardValidation {
  statusField: string;
  /** Every Status option currently on the board, as `spf watch init` prints them. */
  options: string[];
  checks: GithubProjectsBoardCheck[];
  /** Two Status options sharing a name — `deriveState()`'s reverse (name -> state) lookup can't be trusted while this is non-empty; see `validateBoard()`'s own doc comment. */
  duplicateOptionNames: string[];
  /** Two OR MORE states mapped to the same option name — makes `deriveState()` nondeterministic (whichever happened to be checked first in `STATES`'s order "wins"), which could make e.g. `finishReviews` see an issue as `done` that's actually `review`. */
  nonInjectiveOptions: Array<{ optionName: string; states: WatchState[] }>;
  /** Every required state mapped and existing, no duplicate option names, no non-injective mapping. */
  ok: boolean;
}

interface BoardMeta {
  at: number;
  projectId: string;
  statusFieldId: string;
  optionIdByName: Map<string, string>;
  /** Raw, NOT deduplicated — `validateBoard()`'s duplicate-name check needs the raw list; `optionIdByName` already collapsed duplicates (last-wins) by the time it's built. */
  rawOptionNames: string[];
}

interface BoardIssueContent {
  __typename: string;
  number?: number;
  databaseId?: number;
  title?: string;
  body?: string | null;
  createdAt?: string;
  state?: string;
  author?: { login: string } | null;
  labels?: { nodes: Array<{ name: string }> };
  repository?: { nameWithOwner: string };
  url?: string;
}

interface BoardItemNode {
  isArchived: boolean;
  type: string; // "ISSUE" | "PULL_REQUEST" | "DRAFT_ISSUE" | "REDACTED"
  fieldValueByName: { name: string } | null;
  content: BoardIssueContent | null;
}

interface BoardProjectV2 {
  items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: BoardItemNode[] };
}

interface BoardItemsResp {
  rateLimit?: { cost: number; remaining: number; resetAt: string };
  organization: { projectV2: BoardProjectV2 | null } | null;
  user: { projectV2: BoardProjectV2 | null } | null;
}

/**
 * `boardItems()`'s per-tick cache — a plain named type, not an index into
 * `GitHubProjectsProvider["snapshot"]`: that self-reference (a method's
 * return type depending on a property type ON THE SAME CLASS) was enough to
 * confuse TypeScript's control-flow analysis of locals declared inside the
 * method body (`data`/`project` below came back "implicitly any" with that
 * form — a narrow circularity, not a real type error).
 */
interface BoardSnapshot {
  at: number;
  issues: Array<{ issue: Issue; closed: boolean; createdAt: string }>;
  statusByIssueId: Map<string, string | null>;
}

/**
 * One walk serves every `WatchState` this tick — `ProjectV2.items` has no
 * server-side filter by field value (confirmed against the live schema:
 * its only filter args are `archivedStates` and an undocumented, unverified
 * `query` string — see this module's own research notes in the project's
 * plan file for why that one isn't relied on). `rateLimit` is read so
 * `boardItems()` can warn once this scan's cost pushes the budget low —
 * GraphQL's points-per-hour budget is a different currency from REST's
 * requests-per-hour, and nothing else in this codebase watches it.
 */
const BOARD_ITEMS_QUERY = `
  query($login: String!, $number: Int!, $cursor: String, $statusField: String!) {
    rateLimit { cost remaining resetAt }
    organization(login: $login) { projectV2(number: $number) { ...Board } }
    user(login: $login) { projectV2(number: $number) { ...Board } }
  }
  fragment Board on ProjectV2 {
    items(first: 100, after: $cursor, archivedStates: [NOT_ARCHIVED]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        isArchived
        type
        fieldValueByName(name: $statusField) {
          ... on ProjectV2ItemFieldSingleSelectValue { name }
        }
        content {
          __typename
          ... on Issue {
            number
            databaseId
            title
            body
            createdAt
            state
            author { login }
            labels(first: 50) { nodes { name } }
            repository { nameWithOwner }
            url
          }
        }
      }
    }
  }
`;

export class GitHubProjectsProvider extends GitHubProvider {
  private boardMetaCache?: BoardMeta;
  private snapshot?: BoardSnapshot;
  /** Logged once per state per PROCESS lifetime, not once per tick — see `transition()`'s own doc comment. */
  private readonly warnedUnmapped = new Set<WatchState>();
  /** One-time "label shadows a build-lane Status" warnings, keyed by issue+label+Status — see `deriveState()`. */
  private readonly warnedShadowed = new Set<string>();
  /** Issues whose stale `<prefix>:refined` label we already tried to delete this process — one attempt each, so a failing DELETE can't retry every tick. */
  private readonly triedStaleRefined = new Set<string>();

  constructor(
    repo: string,
    labelPrefix: string,
    token: string,
    private readonly board: GitHubProjectsBoardConfig,
  ) {
    // `projectNumber = 0, statusMap = {}` — disables GitHubProvider's own
    // best-effort Projects v2 mirror (`syncStatus()`, reachable only via
    // `resolveProjectStatusField()`'s `if (!this.projectNumber) return null`
    // guard) so it can never double-write the same Status field this class
    // manages directly through its OWN `resolveBoardMeta()`/`boardItems()`.
    super(repo, labelPrefix, token, 0, {});
  }

  private isBoardMapped(state: WatchState): boolean {
    return Boolean((this.board.statusMap as Record<string, string | undefined>)[state]);
  }

  private reverseStatusMapCache?: Map<string, WatchState>;
  /** Name -> state, built once from config and cached for the instance's lifetime (config never changes mid-run). Last-wins on a duplicate option name across states — `validateBoard()` is what catches and reports that as a real misconfiguration; this map just has to not throw while it exists. */
  private reverseStatusMap(): Map<string, WatchState> {
    if (this.reverseStatusMapCache) return this.reverseStatusMapCache;
    const map = new Map<string, WatchState>();
    for (const state of STATES) {
      const name = (this.board.statusMap as Record<string, string | undefined>)[state];
      if (name) map.set(name, state);
    }
    this.reverseStatusMapCache = map;
    return map;
  }

  /**
   * True for the one explicit-promotion case where the board beats a
   * label-only state's label: the issue carries `<prefix>:refined` (the
   * refine lane's "awaiting human review" marker) AND its board Status is
   * the option mapped to `ready`. On a board-driven tracker, dragging the
   * card to the Ready column IS the promotion; `<prefix>:refined` can't be
   * removed by the human in the same gesture, so it is treated as stale.
   */
  private isPromotedRefined(labels: string[], boardOptionName: string | null): boolean {
    if (!boardOptionName || this.isBoardMapped("refined")) return false;
    if (!labels.includes(this.label("refined"))) return false;
    return this.isBoardMapped("ready") && boardOptionName === (this.board.statusMap as Record<string, string | undefined>)["ready"];
  }

  /**
   * The resolution rule this whole provider depends on — see this module's
   * doc comment's "STATE MODEL" section.
   *  0. EXCEPTION: `<prefix>:refined` + board Status mapped to `ready` is a
   *     human promotion — the board wins, the issue is `ready` (the stale
   *     label is cleaned up by `boardItems()`/`claim()`). Only this one pair;
   *     every other label-only state still shadows.
   *  1. A real `<prefix>:<state>` label for a state that is NOT board-mapped
   *     wins outright — label-only states SHADOW the board. If the board
   *     Status maps to a DIFFERENT build-lane state, that's logged once per
   *     issue (`issueId`) so a silently-ignored card move never goes unseen.
   *  2. Otherwise, the board's Status option name reverse-maps to a state.
   *  3. Otherwise `null` — no recognized state; invisible to every
   *     `listInState`.
   */
  private deriveState(labels: string[], boardOptionName: string | null, issueId?: string): WatchState | null {
    if (this.isPromotedRefined(labels, boardOptionName)) return "ready";
    for (const state of STATES) {
      if (this.isBoardMapped(state)) continue;
      if (labels.includes(this.label(state))) {
        this.warnIfShadowing(state, boardOptionName, issueId);
        return state;
      }
    }
    if (boardOptionName) {
      const state = this.reverseStatusMap().get(boardOptionName);
      if (state) return state;
    }
    return null;
  }

  private warnIfShadowing(labelState: WatchState, boardOptionName: string | null, issueId?: string): void {
    if (!boardOptionName) return;
    const boardState = this.reverseStatusMap().get(boardOptionName);
    if (!boardState || boardState === labelState || !GITHUB_PROJECTS_REQUIRED_STATES.includes(boardState)) return;
    const key = `${issueId ?? "?"}|${labelState}|${boardOptionName}`;
    if (this.warnedShadowed.has(key)) return;
    this.warnedShadowed.add(key);
    console.error(
      `spf watch: #${issueId ?? "?"} carries the ${this.label(labelState)} label but its board Status is "${boardOptionName}" (${boardState}) — the label shadows the board, so it is treated as "${labelState}" and NOT as "${boardState}". Remove the ${this.label(labelState)} label to let the board Status win.`,
    );
  }

  /** Strip every real `<prefix>:<state>` label present, then splice in exactly the one derived label (or none). Shared by `toIssue()` below and by `boardItems()`'s own direct GraphQL->Issue construction. */
  private spliceLabels(labels: string[], derived: WatchState | null): string[] {
    const stripped = labels.filter((l) => !STATES.some((s) => l === this.label(s)));
    return derived ? [...stripped, this.label(derived)] : stripped;
  }

  /**
   * The one override that makes `getIssue`/`listChildren`/`createIssue`
   * (all inherited, all unmodified below) board-aware for free: each calls
   * `this.toIssue(rawGhIssue)` internally, and ordinary virtual dispatch
   * means that call resolves to THIS override on a `GitHubProjectsProvider`
   * instance, not `GitHubProvider`'s own synchronous version. The board
   * option name comes from `this.snapshot` — built by `boardItems()` — so
   * `getIssue`/`listChildren` await a fresh-enough snapshot before
   * delegating to `super`, which is the only reason those two need any
   * override at all (see their own doc comments).
   */
  protected toIssue(raw: Parameters<GitHubProvider["toIssue"]>[0]): Issue {
    const base = super.toIssue(raw);
    const boardOptionName = this.snapshot?.statusByIssueId.get(base.id) ?? null;
    return { ...base, labels: this.spliceLabels(base.labels, this.deriveState(base.labels, boardOptionName, base.id)) };
  }

  /**
   * Board/field metadata (project id, Status field id, its options) —
   * `github_provider.ts`'s `resolveProjectStatusField()` twin, but TTL'd
   * (`board.snapshotTtlMs`), not cached for the instance's entire lifetime:
   * a human renaming a Status option mid-run would otherwise make every
   * later mutation write a now-stale `optionId` until the daemon restarts.
   * THROWS on failure rather than returning `null` — the legacy mirror's
   * "log and degrade" contract is right for an optional best-effort layer;
   * here the board IS the tracker, so an unresolvable board has to stop the
   * tick, not silently no-op it.
   */
  private async resolveBoardMeta(): Promise<BoardMeta> {
    if (this.boardMetaCache && Date.now() - this.boardMetaCache.at < this.board.snapshotTtlMs) return this.boardMetaCache;
    const owner = this.board.owner || this.repo.split("/")[0]!;
    interface FieldNode {
      id: string;
      name: string;
      options: Array<{ id: string; name: string }>;
    }
    interface ProjectNode {
      id: string;
      fields: { pageInfo?: { hasNextPage: boolean }; nodes: Array<FieldNode | null> };
    }
    let data: { organization: { projectV2: ProjectNode | null } | null; user: { projectV2: ProjectNode | null } | null };
    try {
      data = await this.ghGraphql(
        `query($login: String!, $number: Int!) {
          organization(login: $login) { projectV2(number: $number) { id fields(first: 50) { pageInfo { hasNextPage } nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } }
          user(login: $login) { projectV2(number: $number) { id fields(first: 50) { pageInfo { hasNextPage } nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } }
        }`,
        { login: owner, number: this.board.projectNumber },
      );
    } catch (err) {
      throw new Error(`couldn't resolve GitHub Projects #${this.board.projectNumber} for ${owner} — ${err instanceof Error ? err.message : String(err)}`);
    }
    const project = data.organization?.projectV2 ?? data.user?.projectV2;
    if (!project) {
      throw new Error(`GitHub Projects #${this.board.projectNumber} not found for ${owner} (or GITHUB_TOKEN lacks the "project" scope)`);
    }
    if (project.fields.pageInfo?.hasNextPage) {
      console.error(
        `spf watch: GitHub Projects #${this.board.projectNumber} has more than 50 fields — "${this.board.statusField}" may be on a later page this query doesn't fetch`,
      );
    }
    const statusField = project.fields.nodes.find((f): f is FieldNode => f !== null && f.name === this.board.statusField);
    if (!statusField) {
      throw new Error(`GitHub Projects #${this.board.projectNumber} has no "${this.board.statusField}" single-select field`);
    }
    this.boardMetaCache = {
      at: Date.now(),
      projectId: project.id,
      statusFieldId: statusField.id,
      optionIdByName: new Map(statusField.options.map((o) => [o.name, o.id])),
      rawOptionNames: statusField.options.map((o) => o.name),
    };
    return this.boardMetaCache;
  }

  /**
   * Pages the WHOLE board, once per `snapshotTtlMs` window — every
   * `listEligible`/`listInState` call this tick (`tick()` makes 8-10 of
   * them, `core/watch.ts:2604`) reuses the same snapshot rather than
   * re-paging per state. Every mutator (`claim`/`transition`/`createIssue`)
   * calls `invalidateBoard()`, so a later claim in the SAME tick never sees
   * an issue a human — or this daemon itself — already moved.
   *
   * Skips, each logged at most once per SCAN (not once per item): a draft
   * item (no backing issue — out of scope), a non-Issue/non-PullRequest
   * item (`REDACTED` — deleted or a permissions gap), and an item from a
   * repo other than this instance's `repo` (a board can span repos; this
   * provider tracks exactly one). `isArchived` is filtered twice over —
   * once server-side via `archivedStates: [NOT_ARCHIVED]`, once defensively
   * client-side — belt and suspenders against a default changing upstream.
   *
   * THROWS if the board itself can't be resolved (via `resolveBoardMeta()`)
   * — same "the tracker of record failing stops the tick" reasoning as that
   * method's own doc comment.
   */
  private async boardItems(): Promise<BoardSnapshot> {
    if (this.snapshot && Date.now() - this.snapshot.at < this.board.snapshotTtlMs) return this.snapshot;
    await this.resolveBoardMeta();
    const owner = this.board.owner || this.repo.split("/")[0]!;
    const statusByIssueId = new Map<string, string | null>();
    const issues: Array<{ issue: Issue; closed: boolean; createdAt: string }> = [];
    const staleRefined: string[] = [];
    const warnedForeignRepos = new Set<string>();
    let warnedDraft = false;
    let warnedRedacted = false;
    let cursor: string | null = null;
    for (let page = 1; page <= MAX_BOARD_PAGES; page++) {
      const data: BoardItemsResp = await this.ghGraphql<BoardItemsResp>(BOARD_ITEMS_QUERY, {
        login: owner,
        number: this.board.projectNumber,
        cursor,
        statusField: this.board.statusField,
      });
      const project: BoardProjectV2 | null = data.organization?.projectV2 ?? data.user?.projectV2 ?? null;
      if (!project) {
        throw new Error(`GitHub Projects #${this.board.projectNumber} not found for ${owner} while paging board items`);
      }
      if (data.rateLimit && data.rateLimit.remaining < 500) {
        console.error(
          `spf watch: GitHub GraphQL rate limit low while paging GitHub Projects #${this.board.projectNumber} — ${data.rateLimit.remaining} points remaining, resets ${data.rateLimit.resetAt}`,
        );
      }
      for (const node of project.items.nodes) {
        if (node.isArchived) continue;
        if (node.type === "DRAFT_ISSUE") {
          if (!warnedDraft) {
            warnedDraft = true;
            console.error(
              `spf watch: GitHub Projects #${this.board.projectNumber} has one or more draft items (no backing repo issue) — skipped, draft issues aren't supported`,
            );
          }
          continue;
        }
        if (node.type !== "ISSUE") continue; // PULL_REQUEST — routine on a board, skip silently
        const content = node.content;
        if (!content) {
          if (!warnedRedacted) {
            warnedRedacted = true;
            console.error(`spf watch: GitHub Projects #${this.board.projectNumber} has an item this token can't see the content of (deleted, or a permissions gap) — skipped`);
          }
          continue;
        }
        const foreign = content.repository?.nameWithOwner;
        if (foreign !== this.repo) {
          const name = foreign ?? "(unknown repo)";
          if (!warnedForeignRepos.has(name)) {
            warnedForeignRepos.add(name);
            console.error(
              `spf watch: GitHub Projects #${this.board.projectNumber} has items from ${name}, not just ${this.repo} — ${name}'s items are skipped (this provider tracks a single repo)`,
            );
          }
          continue;
        }
        const ghLabels = (content.labels?.nodes ?? []).map((n: { name: string }) => n.name);
        const issueId = String(content.number ?? "");
        const optionName = node.fieldValueByName?.name ?? null;
        statusByIssueId.set(issueId, optionName);
        const derived = this.deriveState(ghLabels, optionName, issueId);
        if (this.isPromotedRefined(ghLabels, optionName)) staleRefined.push(issueId);
        const issue: Issue = {
          id: issueId,
          internal_id: content.databaseId !== undefined ? String(content.databaseId) : undefined,
          title: content.title ?? "",
          body: content.body ?? "",
          labels: this.spliceLabels(ghLabels, derived),
          author: content.author?.login ?? "unknown",
          ...(content.url ? { url: content.url } : {}),
        };
        issues.push({ issue, closed: content.state === "CLOSED", createdAt: content.createdAt ?? new Date(0).toISOString() });
      }
      if (!project.items.pageInfo.hasNextPage) break;
      cursor = project.items.pageInfo.endCursor;
      if (page === MAX_BOARD_PAGES) {
        console.error(
          `spf watch: GitHub Projects #${this.board.projectNumber} board scan hit the ${MAX_BOARD_PAGES}-page (${MAX_BOARD_PAGES * 100}-item) cap — items past this cap are invisible this tick`,
        );
      }
    }
    // `ProjectV2ItemOrderField` has exactly one value, `POSITION` (confirmed
    // against the live schema) — there is no server-side creation-time
    // ordering to ask for. `orderEligible` (`watch.ts:2228`) documents that
    // it preserves "listEligible's own created-asc order" as its final
    // tiebreaker, matching `listByLabel`'s `sort=created&direction=asc` —
    // so that contract is reproduced here explicitly, client-side.
    issues.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    this.snapshot = { at: Date.now(), issues, statusByIssueId };
    // Best-effort cleanup of `<prefix>:refined` on cards a human promoted to
    // Ready (see `isPromotedRefined()`): one attempt per issue per process,
    // never throws. The state is already derived correctly without it —
    // this just stops the label lingering (and `claim()` strips it anyway).
    for (const id of staleRefined) {
      if (this.triedStaleRefined.has(id)) continue;
      this.triedStaleRefined.add(id);
      await this.gh(`/repos/${this.repo}/issues/${id}/labels/${encodeURIComponent(this.label("refined"))}`, { method: "DELETE" }).catch((err) => {
        console.error(`spf watch: #${id} — couldn't remove the stale ${this.label("refined")} label after its card was moved to Ready — ${err instanceof Error ? err.message : String(err)} (treated as ready regardless)`);
      });
    }
    return this.snapshot;
  }

  /** Every mutator calls this — see `boardItems()`'s own doc comment on why staleness-within-a-tick matters. */
  protected invalidateBoard(): void {
    this.snapshot = undefined;
  }

  /**
   * A single issue's CURRENT labels, Status option name, and project-item
   * id, read fresh (never from `this.snapshot`) — the one read `claim()`'s
   * pre-verify and read-back need, since a stale snapshot would defeat the
   * entire point of verifying before/after a write. Returns `null` only
   * when the issue itself is gone (deleted); a GraphQL-level failure
   * (network, auth) is allowed to throw and propagate to the caller.
   */
  private async fetchFreshState(issue: Issue): Promise<{ labels: string[]; statusOption: string | null; itemId: string | null; closed: boolean } | null> {
    const meta = await this.resolveBoardMeta();
    const [owner, name] = this.repo.split("/") as [string, string];
    interface Resp {
      repository: {
        issue: {
          state: string;
          labels: { nodes: Array<{ name: string }> };
          projectItems: { nodes: Array<{ id: string; project: { id: string }; fieldValueByName: { name: string } | null }> };
        } | null;
      } | null;
    }
    const data = await this.ghGraphql<Resp>(
      `query($owner: String!, $name: String!, $number: Int!, $statusField: String!) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            state
            labels(first: 50) { nodes { name } }
            projectItems(first: ${MAX_PROJECT_ITEMS_PER_ISSUE}) {
              nodes { id project { id } fieldValueByName(name: $statusField) { ... on ProjectV2ItemFieldSingleSelectValue { name } } }
            }
          }
        }
      }`,
      { owner, name, number: Number(issue.id), statusField: this.board.statusField },
    );
    const ghIssue = data.repository?.issue;
    if (!ghIssue) return null;
    const item = ghIssue.projectItems.nodes.find((n) => n.project.id === meta.projectId);
    return {
      labels: ghIssue.labels.nodes.map((n) => n.name),
      statusOption: item?.fieldValueByName?.name ?? null,
      itemId: item?.id ?? null,
      closed: ghIssue.state === "CLOSED",
    };
  }

  /**
   * The item-id half of `transition()`/`createIssue()`'s board writes —
   * unlike `claim()` (which REFUSES an issue that isn't already on the
   * board; see `claim()`'s own doc comment), this ADDS it if missing, same
   * as the legacy mirror's `resolveProjectItemId()`. The asymmetry is
   * deliberate: `claim()` guards ENTRY into the lane (an issue should
   * already be ready-and-on-the-board to be legitimately claimable), while
   * `transition()`/`createIssue()` act on an issue ALREADY in-flight under
   * this daemon's management, where failing to find it on the board would
   * strand it with no way to ever reach `done` — worse than the minor side
   * effect of adding it. THROWS on failure (both lookup and the add
   * mutation) — reused only from paths that already throw on a board
   * write failure.
   */
  private async resolveItemId(issue: Issue, projectId: string): Promise<string | null> {
    const [owner, name] = this.repo.split("/") as [string, string];
    interface Resp {
      repository: { issue: { id: string; projectItems: { pageInfo?: { hasNextPage: boolean }; nodes: Array<{ id: string; project: { id: string } }> } } | null } | null;
    }
    let data: Resp;
    try {
      data = await this.ghGraphql<Resp>(
        `query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) { id projectItems(first: ${MAX_PROJECT_ITEMS_PER_ISSUE}) { pageInfo { hasNextPage } nodes { id project { id } } } }
          }
        }`,
        { owner, name, number: Number(issue.id) },
      );
    } catch (err) {
      throw new Error(`couldn't look up issue #${issue.id}'s GitHub Projects membership — ${err instanceof Error ? err.message : String(err)}`);
    }
    const ghIssue = data.repository?.issue;
    if (!ghIssue) return null; // deleted between the earlier read and here
    if (ghIssue.projectItems.pageInfo?.hasNextPage) {
      console.error(`spf watch: issue #${issue.id} is on more than ${MAX_PROJECT_ITEMS_PER_ISSUE} GitHub Projects boards — this project's membership may be on a later page`);
    }
    const existing = ghIssue.projectItems.nodes.find((n) => n.project.id === projectId);
    if (existing) return existing.id;
    const added = await this.ghGraphql<{ addProjectV2ItemById: { item: { id: string } } }>(
      `mutation($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } } }`,
      { projectId, contentId: ghIssue.id },
    );
    return added.addProjectV2ItemById.item.id;
  }

  /** The one mutation every board write funnels through — `itemId` must already be resolved (by `claim()`'s fresh read, or by `resolveItemId()`'s add-if-missing). THROWS on a missing option or a rejected mutation. */
  private async setBoardStatusOptionByItemId(issue: Issue, itemId: string, optionName: string): Promise<void> {
    const meta = await this.resolveBoardMeta();
    const optionId = meta.optionIdByName.get(optionName);
    if (!optionId) {
      throw new Error(`GitHub Projects #${this.board.projectNumber} has no "${this.board.statusField}" option named ${JSON.stringify(optionName)} (issue #${issue.id})`);
    }
    await this.ghGraphql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: {singleSelectOptionId: $optionId}}) { clientMutationId }
      }`,
      { projectId: meta.projectId, itemId, fieldId: meta.statusFieldId, optionId },
    );
  }

  /** `ensureLabels()`'s board analog is `validateBoard()` — this is NEVER called to seed a Status option. See `ensureLabels()`'s own doc comment for why. */
  async ensureLabels(): Promise<EnsureLabelsResult> {
    const result: EnsureLabelsResult = { created: [], updated: [], unchanged: [] };
    // Non-state vocabulary — identical regardless of how state is tracked,
    // still read by `issuePriority`/the refine lane's type dispatch
    // (`watch.ts`) on every provider.
    for (const kind of ISSUE_KINDS) {
      const { color, description } = TYPE_LABEL_META[kind];
      await this.ensureOneLabel(this.typeLabel(kind), color, description, result);
    }
    for (const priority of PRIORITIES) {
      const { color, description } = PRIORITY_LABEL_META[priority];
      await this.ensureOneLabel(this.priorityLabel(priority), color, description, result);
    }
    // State labels: ONLY for states this config leaves label-only. Seeding
    // `spf:ready` on a board-driven repo would invite a human to apply a
    // label that does nothing — the board's Status field is authoritative
    // for every MAPPED state.
    for (const state of STATES) {
      if (this.isBoardMapped(state)) continue;
      const { color, description } = LABEL_META[state];
      await this.ensureOneLabel(this.label(state), color, description, result);
    }
    return result;
  }

  /**
   * Read-only validation of `watch.github_projects.status_map` against the
   * real board — what `spf watch init` and `spf watch`'s own startup check
   * call to catch a missing required state, a misnamed option, a duplicate
   * option name, or a non-injective mapping before an unattended run trusts
   * any of it. Deliberately NEVER mutates the board — see `ensureLabels()`'s
   * own doc comment for why creating/editing Status options is out of
   * scope entirely. THROWS if the board/field itself can't be resolved at
   * all (via `resolveBoardMeta()`) — the caller should let that failure
   * stand on its own rather than folding it into `checks`.
   */
  async validateBoard(): Promise<GithubProjectsBoardValidation> {
    const meta = await this.resolveBoardMeta();
    const checks: GithubProjectsBoardCheck[] = [];
    const byOption = new Map<string, WatchState[]>();
    for (const state of STATES) {
      const statusName = (this.board.statusMap as Record<string, string | undefined>)[state];
      const required = GITHUB_PROJECTS_REQUIRED_STATES.includes(state);
      const mapped = Boolean(statusName);
      const exists = mapped ? meta.optionIdByName.has(statusName!) : true;
      checks.push({ state, required, mapped, statusName, exists });
      if (mapped && exists) {
        const arr = byOption.get(statusName!) ?? [];
        arr.push(state);
        byOption.set(statusName!, arr);
      }
    }
    const duplicateOptionNames = [...new Set(meta.rawOptionNames.filter((name, i) => meta.rawOptionNames.indexOf(name) !== i))];
    const nonInjectiveOptions = [...byOption.entries()].filter(([, states]) => states.length > 1).map(([optionName, states]) => ({ optionName, states }));
    const ok = checks.every((c) => !c.required || (c.mapped && c.exists)) && duplicateOptionNames.length === 0 && nonInjectiveOptions.length === 0;
    return { statusField: this.board.statusField, options: meta.rawOptionNames, checks, duplicateOptionNames, nonInjectiveOptions, ok };
  }

  /**
   * Unlike a label-only `ready` (always an explicit `<prefix>:ready` the
   * refine lane or a human applied on purpose), a board-mapped `ready` is a
   * Status option — and GitHub's own built-in project workflows ("Item
   * added to project", "Auto-add to project") can push a freshly filed
   * issue straight into that column with NO spf involvement at all, the
   * moment a human adds it to the board. `claimNewWork` would then claim it
   * on the very next tick, racing (and duplicating) whatever that human is
   * already doing by hand — see the incident this guards against: issue
   * #104/PR #103 vs. spf's own #105 in a consumer repo, where spf
   * claimed a human-filed issue ~30s after it hit the board and shipped a
   * second PR for the same fix.
   *
   * The fix: require one of `ISSUE_KINDS`' `<prefix>:type:*` labels before
   * treating a board-ready issue as claimable. Every issue spf itself
   * produces (the refine lane's `typeLabel()` in `refine.ts`) already
   * carries one; a human who deliberately wants spf to pick up an issue
   * they filed by hand can add the label themselves. One that was only
   * ever moved to "Ready" by board automation, never typed by or for spf,
   * is left alone.
   */
  async listEligible(): Promise<Issue[]> {
    const issues = await this.listInState("ready");
    const typed: Issue[] = [];
    for (const issue of issues) {
      if (ISSUE_KINDS.some((kind) => issue.labels.includes(this.typeLabel(kind)))) {
        typed.push(issue);
        continue;
      }
      console.error(
        `spf watch: #${issue.id} is in the board's "ready" column but carries no ${this.labelPrefix}:type:* label — skipping ` +
          `(board automation, not spf, likely moved it there; add a type label yourself if you want spf to claim it)`,
      );
    }
    return typed;
  }

  /**
   * A label-only state delegates straight to `super.listInState()` — a
   * plain REST label search finds it correctly (the label IS that state's
   * record), and the returned issues flow through the OVERRIDDEN `toIssue`
   * via virtual dispatch regardless, so the synthetic splice still happens.
   * A board-mapped state reads the per-tick snapshot (`boardItems()`) and
   * filters by the derived state's OWN label (already spliced onto every
   * snapshot issue) — simpler than re-deriving per call, and exactly
   * equivalent since every issue in the snapshot was spliced the same way.
   */
  async listInState(state: WatchState, opts?: { includeAll?: boolean }): Promise<Issue[]> {
    if (!this.isBoardMapped(state)) {
      return super.listInState(state, opts);
    }
    const { issues } = await this.boardItems();
    const label = this.label(state);
    return issues.filter((bi) => bi.issue.labels.includes(label) && (opts?.includeAll || !bi.closed)).map((bi) => bi.issue);
  }

  /**
   * Awaits a fresh-enough board snapshot before delegating to the inherited
   * REST fetch — necessary because `getIssue` is the frontier check's own
   * read (`frontierBlockedOn` in `watch.ts`), and an issue it fetches may
   * never have appeared in this tick's `listEligible`/`listInState` calls
   * (it's a BLOCKER, not necessarily a `ready` issue). Without this,
   * `this.snapshot` could be stale or entirely absent, and the synthetic
   * state label `toIssue()` splices in would be silently wrong — a blocker
   * that's actually `done` could read back as `null` state and wedge every
   * dependent forever. In the common case (same tick already called
   * `listEligible`), the snapshot is already warm and this is a no-op.
   */
  async getIssue(id: string): Promise<Issue | null> {
    await this.boardItems();
    return super.getIssue(id);
  }

  /** Same reasoning as `getIssue` above — `rollUp` (`watch.ts`) reads `labels.includes(doneLabel)` on every child this returns. */
  async listChildren(parent: Issue): Promise<Issue[]> {
    await this.boardItems();
    return super.listChildren(parent);
  }

  /**
   * Compare-and-set over a field value, not a true atomic claim — same
   * honest limitation `GitHubProvider.claim()`'s own doc comment already
   * states for the label version: two daemons both seeing `from` and both
   * writing `to` both read back `to` and both return `true`. The PRE-verify
   * (not the read-back) is what catches the common case; the real safety
   * net remains `spf watch`'s own single-instance lockfile
   * (`cli/commands/watch.ts`'s `acquireLock`) plus the per-issue
   * `acquirePidLock` in `claimNewWork`/`claimSpecs`/`claimFeedback`. A
   * SHARED BOARD makes two daemons racing the same issue more plausible
   * than a shared repo does — see README's own caveat.
   *
   * Deliberately does NOT add a missing issue to the board (contrast
   * `resolveItemId()`, used by `transition()`/`createIssue()`): an issue
   * not already on the board is simply not claimable into a board-mapped
   * state — adding-then-claiming would let an off-board issue get built
   * just because `status_map` happened to configure an entry for it.
   *
   * A THIRD state after the write (neither `from` nor `to`) means a human
   * moved the card mid-claim — logged, not reverted; fighting a human's
   * own edit would be worse than losing this one claim attempt.
   */
  async claim(issue: Issue, opts?: { from?: WatchState; to?: WatchState }): Promise<boolean> {
    const from = opts?.from ?? "ready";
    const to = opts?.to ?? "working";
    if (!this.isBoardMapped(from) && !this.isBoardMapped(to)) {
      return super.claim(issue, opts);
    }
    let before: Awaited<ReturnType<GitHubProjectsProvider["fetchFreshState"]>>;
    try {
      before = await this.fetchFreshState(issue);
    } catch (err) {
      console.error(`spf watch: #${issue.id} — couldn't read its current board/label state while claiming — ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    if (!before) {
      console.error(`spf watch: #${issue.id} — no longer exists while claiming`);
      return false;
    }
    const beforeState = this.deriveState(before.labels, before.statusOption, issue.id);
    if (beforeState !== from) {
      console.error(`spf watch: #${issue.id} — expected "${from}" before claiming, found ${beforeState ? `"${beforeState}"` : "no recognized state"} — not claiming (lost the race, or it already moved on)`);
      return false;
    }
    if (this.isBoardMapped(to) && !before.itemId) {
      console.error(
        `spf watch: #${issue.id} — not on GitHub Projects #${this.board.projectNumber}; can't claim it into board-mapped state "${to}" (spf never adds an issue to the board on a claim — add it to the board yourself first)`,
      );
      return false;
    }
    try {
      for (const state of STATES) {
        const label = this.label(state);
        if (before.labels.includes(label)) {
          await this.gh(`/repos/${this.repo}/issues/${issue.id}/labels/${encodeURIComponent(label)}`, { method: "DELETE" }).catch(() => undefined);
        }
      }
      if (this.isBoardMapped(to)) {
        const optionName = (this.board.statusMap as Record<string, string | undefined>)[to]!;
        await this.setBoardStatusOptionByItemId(issue, before.itemId!, optionName);
      } else {
        await this.gh(`/repos/${this.repo}/issues/${issue.id}/labels`, { method: "POST", body: JSON.stringify({ labels: [this.label(to)] }) });
        if (before.itemId && this.board.unmappedStatus) {
          await this.setBoardStatusOptionByItemId(issue, before.itemId, this.board.unmappedStatus).catch(() => undefined);
        }
      }
    } catch (err) {
      console.error(`spf watch: #${issue.id} — couldn't write "${to}" while claiming — ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.invalidateBoard();
    let after: Awaited<ReturnType<GitHubProjectsProvider["fetchFreshState"]>>;
    try {
      after = await this.fetchFreshState(issue);
    } catch {
      after = null;
    }
    const afterState = after ? this.deriveState(after.labels, after.statusOption, issue.id) : null;
    if (afterState === to) return true;
    if (afterState === from || afterState === null) return false;
    console.error(`spf watch: #${issue.id} — board state is "${afterState}" after the claim attempt, neither "${to}" nor "${from}" — a human likely moved it mid-claim; not reverting`);
    return false;
  }

  /**
   * Strips every real state label (unconditionally — this is what
   * un-shadows rule 1 of `deriveState()` for the NEXT read), then writes
   * `to`: a board mutation for a mapped state, a real label for an
   * unmapped one. A MAPPED state's board write THROWS on failure — the
   * critical inversion from `GitHubProvider.syncStatus()`'s "log and
   * swallow everything" contract. That contract is right for an optional
   * best-effort mirror on top of the label state machine; here the Status
   * write IS the transition, so swallowing it would strand the issue in a
   * state nothing will ever reconcile. `tick()` (`watch.ts:2604`) already
   * catches per-stage, so a throw here surfaces as a `watch_error`
   * notification and the next tick retries — it does not crash the daemon.
   */
  async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    for (const state of STATES) {
      const label = this.label(state);
      if (issue.labels.includes(label)) {
        await this.gh(`/repos/${this.repo}/issues/${issue.id}/labels/${encodeURIComponent(label)}`, { method: "DELETE" }).catch(() => undefined);
      }
    }
    if (this.isBoardMapped(to)) {
      const meta = await this.resolveBoardMeta();
      const itemId = await this.resolveItemId(issue, meta.projectId);
      if (!itemId) throw new Error(`issue #${issue.id} no longer exists — can't move it to "${to}" on GitHub Projects #${this.board.projectNumber}`);
      const optionName = (this.board.statusMap as Record<string, string | undefined>)[to]!;
      await this.setBoardStatusOptionByItemId(issue, itemId, optionName);
    } else {
      await this.gh(`/repos/${this.repo}/issues/${issue.id}/labels`, { method: "POST", body: JSON.stringify({ labels: [this.label(to)] }) });
      if (this.board.unmappedStatus) {
        try {
          const meta = await this.resolveBoardMeta();
          const itemId = await this.resolveItemId(issue, meta.projectId);
          if (itemId) await this.setBoardStatusOptionByItemId(issue, itemId, this.board.unmappedStatus);
        } catch (err) {
          // Best-effort only — unmapped_status is a cosmetic holding
          // column, never the state of record for a label-only state, so a
          // failure here must not throw (contrast the mapped branch above).
          console.error(`spf watch: #${issue.id} — couldn't set the unmapped_status holding column for "${to}" — ${err instanceof Error ? err.message : String(err)} (tracked by the ${this.label(to)} label regardless)`);
        }
      } else if (!this.warnedUnmapped.has(to)) {
        this.warnedUnmapped.add(to);
        console.error(
          `spf watch: "${to}" has no watch.github_projects.status_map entry — tracked by the ${this.label(to)} LABEL only; the board's Status for #${issue.id} is left as-is. Map it, or set watch.github_projects.unmapped_status, to make it board-visible.`,
        );
      }
    }
    this.invalidateBoard();
    if (detail) await this.comment(issue, detail);
  }

  /**
   * `refine.ts`'s `publish()`/`publishSpecs()` create issues carrying a
   * real `<prefix>:<state>` label (`refined` or `spec-ready`) in
   * `input.labels` — on a board-driven tracker, if that state is
   * board-mapped, a plain REST-created label is invisible to
   * `listInState()` and the issue would be lost to the lane that created
   * it. So: REST-create as usual, then if the created issue's state label
   * names a BOARD-MAPPED state, add it to the board and set Status there,
   * stripping the now-redundant label. A label-only state (the common case
   * — `refined` almost always is) needs none of this; rule 1 of
   * `deriveState()` already makes it visible with no board involvement.
   *
   * Re-fetches the final result via `getIssue()` rather than trusting the
   * REST response directly: whatever actually ended up true (board set
   * successfully, or the label kept because the board write failed) is
   * what the caller should see, not a snapshot from partway through this
   * method that could show neither.
   */
  async createIssue(input: { title: string; body: string; labels: string[]; kind: IssueAuthoringKind }): Promise<Issue> {
    const created = await super.createIssue(input);
    const stateLabel = STATES.find((s) => input.labels.includes(this.label(s)));
    if (stateLabel && (this.isBoardMapped(stateLabel) || this.board.unmappedStatus)) {
      try {
        const meta = await this.resolveBoardMeta();
        const itemId = await this.resolveItemId(created, meta.projectId);
        if (itemId) {
          const optionName = this.isBoardMapped(stateLabel) ? (this.board.statusMap as Record<string, string | undefined>)[stateLabel]! : this.board.unmappedStatus;
          await this.setBoardStatusOptionByItemId(created, itemId, optionName);
          if (this.isBoardMapped(stateLabel)) {
            await this.gh(`/repos/${this.repo}/issues/${created.id}/labels/${encodeURIComponent(this.label(stateLabel))}`, { method: "DELETE" }).catch(() => undefined);
          }
        }
      } catch (err) {
        console.error(
          `spf watch: couldn't put newly-created issue #${created.id} on GitHub Projects #${this.board.projectNumber} — it keeps its ${this.label(stateLabel)} label only — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.invalidateBoard();
    const fresh = await this.getIssue(created.id);
    return fresh ?? created;
  }
}
