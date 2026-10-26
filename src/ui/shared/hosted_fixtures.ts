/**
 * Fixture `/api` for the multi-factory UI (#138). Stands in for the hosted read
 * API (#137) so the app and its tests can run before that Worker exists:
 * three factories over two repos, and one `adw_id` that two factories share.
 *
 * `mockApi` is a pure router, so the vite dev plugin (`PIQUETTE_MOCK=hosted|local`
 * in app/) and the tests use the same answers. Times are relative to `nowMs`
 * so "Today" and "last synced Ns ago" read naturally whenever it is served.
 */

import { filterSessions, sortSessions, type HostedArchiveBody, type ListFilter } from "./hosted.js";
import { demoGates, demoHealth, demoReceiptFile, demoReceiptRun, demoSessions } from "./demo_fixtures.js";
import type { AgentSession, HealthResponse, HostedFactory, Phase, Session, SessionDetail, SessionSummary } from "./types.js";

/**
 * `hosted` is the small test-pinned dataset (two repos, three factories). `local`
 * and `demo` serve the richer one in demo_fixtures.ts: `local` as one repo's
 * `piquette ui` would (no factory or repo columns), `demo` with hosted semantics.
 */
export type MockMode = "local" | "hosted" | "demo";

export const REPO_API = "github.com/acme/api";
export const REPO_WEB = "github.com/acme/web";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

interface Seed {
  adw_id: string;
  factory: "laptop" | "ci" | "studio";
  request: string;
  status: "running" | "success" | "fail";
  startedMinAgo: number;
  durationMin: number;
  cost: number;
  tokens: number;
  phases: Array<[string, Phase["status"]]>;
  /** The issue and PR `piquette watch` recorded (the trace's `issue_*`/`pr_*` columns); absent for an interactive run. */
  links?: { issue: [string, string]; pr?: [string, string] };
}

// acme/api tracks its work in Jira on a placeholder site; acme/web in GitHub issues.
const jira = (key: string): [string, string] => [key, `https://example.atlassian.net/browse/${key}`];
const gh = (repo: string, kind: "issues" | "pull", n: number): [string, string] => [`#${n}`, `https://${repo}/${kind}/${n}`];

const FACTORY_SEEDS = {
  laptop: { id: "f-3a1c", name: "jd@laptop", repo: REPO_API, syncedSecAgo: 8 },
  ci: { id: "f-9e47", name: "ci-runner-1", repo: REPO_API, syncedSecAgo: 190 },
  studio: { id: "f-b520", name: "jd@studio", repo: REPO_WEB, syncedSecAgo: 41 },
} as const;

const SEEDS: Seed[] = [
  { adw_id: "a1b2c3d4", factory: "laptop", request: "Add cursor pagination to /v1/runs", status: "running", startedMinAgo: 6, durationMin: 6, cost: 0.84, tokens: 212_400, phases: [["plan", "success"], ["build", "running"], ["test", "queued"]], links: { issue: jira("API-412") } },
  { adw_id: "c0ffee01", factory: "studio", request: "Dark-mode contrast pass on the settings page", status: "running", startedMinAgo: 14, durationMin: 14, cost: 1.12, tokens: 301_900, phases: [["plan", "success"], ["build", "success"], ["review", "running"]] },
  // The same adw_id under two factories: the trace link has to carry `factory`.
  { adw_id: "dead0042", factory: "ci", request: "Bump undici to patch CVE", status: "success", startedMinAgo: 55, durationMin: 12, cost: 0.31, tokens: 88_000, phases: [["plan", "success"], ["build", "success"], ["test", "success"]], links: { issue: jira("API-407"), pr: gh(REPO_API, "pull", 88) } },
  { adw_id: "dead0042", factory: "studio", request: "Replace moment with date-fns in the calendar widget", status: "fail", startedMinAgo: 95, durationMin: 21, cost: 2.4, tokens: 540_300, phases: [["plan", "success"], ["build", "success"], ["test", "fail"]] },
  { adw_id: "5f6a7b8c", factory: "laptop", request: "Retry flaky webhook delivery with backoff", status: "success", startedMinAgo: 200, durationMin: 33, cost: 3.05, tokens: 702_100, phases: [["plan", "success"], ["build", "success"], ["test", "success"], ["review", "success"]], links: { issue: jira("API-398"), pr: gh(REPO_API, "pull", 85) } },
  { adw_id: "9a8b7c6d", factory: "ci", request: "Index sessions(repo, started_at) for the hosted list", status: "success", startedMinAgo: 1500, durationMin: 9, cost: 0.46, tokens: 120_800, phases: [["plan", "success"], ["build", "success"]] },
  { adw_id: "1d2e3f40", factory: "studio", request: "Skeleton loaders for the dashboard grid", status: "success", startedMinAgo: 1700, durationMin: 18, cost: 1.6, tokens: 388_000, phases: [["plan", "success"], ["build", "success"], ["test", "success"]], links: { issue: gh(REPO_WEB, "issues", 31), pr: gh(REPO_WEB, "pull", 34) } },
];

function buildPhase(adw: string, name: string, status: Phase["status"], seq: number, startMs: number): Phase {
  return {
    phase_id: `${adw}-p${seq}`,
    adw_id: adw,
    seq,
    name,
    kind: name === "test" ? "code" : "agent",
    owner: name === "test" ? null : "builder",
    description: null,
    status,
    attempt: 1,
    retries: 0,
    error: status === "fail" ? "1 gate failed" : null,
    started_at: status === "queued" ? null : iso(startMs),
    ended_at: status === "success" || status === "fail" ? iso(startMs + 2 * MIN) : null,
  };
}

export function fixtureFactories(nowMs: number): HostedFactory[] {
  return Object.values(FACTORY_SEEDS).map((f) => ({
    id: f.id,
    name: f.name,
    repo: f.repo,
    last_seen_at: iso(nowMs - f.syncedSecAgo * 1000),
  }));
}

export function fixtureSessions(nowMs: number): SessionSummary[] {
  return SEEDS.map((s) => {
    const f = FACTORY_SEEDS[s.factory];
    const start = nowMs - s.startedMinAgo * MIN;
    const phases = s.phases.map(([name, status], i) => buildPhase(s.adw_id, name, status, i + 1, start + i * 2 * MIN));
    const running = s.status === "running";
    const session: Session = {
      adw_id: s.adw_id,
      adw_name: "plan + build-test",
      request: s.request,
      status: s.status,
      engineer: f.name.split("@")[0] ?? null,
      started_at: iso(start),
      ended_at: running ? null : iso(start + s.durationMin * MIN),
      total_tokens: s.tokens,
      total_cost: s.cost,
      billable_tokens: s.tokens,
      archived: 0,
      issue_label: s.links?.issue[0] ?? null,
      issue_url: s.links?.issue[1] ?? null,
      pr_label: s.links?.pr?.[0] ?? null,
      pr_url: s.links?.pr?.[1] ?? null,
      factory_id: f.id,
      factory_name: f.name,
      repo: f.repo,
    };
    return { ...session, phases, phase_count: phases.length, agents: [] as AgentSession[] };
  });
}

export function fixtureHealth(mode: MockMode, nowMs: number): HealthResponse {
  if (mode === "local" || mode === "demo") return demoHealth(mode, nowMs);
  const factories = fixtureFactories(nowMs);
  return {
    ok: true,
    db: "fixture",
    journal_mode: "d1",
    sessions: SEEDS.length,
    mode: "hosted",
    repos: [REPO_API, REPO_WEB],
    factories,
  };
}

/**
 * Archive state lives for the life of the process (a dev server or a test run), per mode, so the
 * mock behaves like the real reader state without touching the fixtures themselves.
 */
const archivedRows = new Map<MockMode, Set<string>>();
const rowKey = (s: SessionSummary) => `${s.factory_id ?? ""}|${s.repo ?? ""}|${s.adw_id}`;

/** Forget every archive write (tests, or a fresh start without restarting the server). */
export function resetMockArchive(): void {
  archivedRows.clear();
}

/** The mode's rows with factory and repo columns intact and no archive state applied. */
const rawRows = (mode: MockMode, nowMs: number): SessionSummary[] => (mode === "hosted" ? fixtureSessions(nowMs) : demoSessions(nowMs));

/**
 * The rows a reader sees. Like the real list, archived runs drop out unless `includeArchived`
 * (the detail route and the archive write still find them). Local mode serves one repo's rows
 * with no factory or repo columns, like today's `piquette ui`.
 */
function modeSessions(mode: MockMode, nowMs: number, includeArchived = false): SessionSummary[] {
  const archived = archivedRows.get(mode);
  const rows = rawRows(mode, nowMs)
    .map((s) => (archived?.has(rowKey(s)) ? { ...s, archived: 1 } : s))
    .filter((s) => includeArchived || !s.archived);
  return mode === "local" ? rows.map(({ factory_id: _f, factory_name: _n, repo: _r, ...rest }) => rest as SessionSummary) : rows;
}

export interface MockResponse {
  status: number;
  body: unknown;
  /** Set for non-JSON bodies (`body` is then the raw text). */
  contentType?: string;
  /** With `contentType`: `body` is base64 of binary content. */
  base64?: boolean;
}

const ok = (body: unknown): MockResponse => ({ status: 200, body });

/** The hosted 409 body: which (repo, factory) pairs hold the id, sorted by repo then factory. */
const candidatesOf = (rows: SessionSummary[]) =>
  rows
    .map((s) => ({ factory_id: s.factory_id ?? "", factory_name: s.factory_name ?? s.factory_id ?? "", repo: s.repo ?? "" }))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.factory_id.localeCompare(b.factory_id));

/** Real adw_id guard (isSafeSegment): letters, digits, dot, underscore, dash; never "." or "..". */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const isSafeSegment = (v: string) => SAFE_SEGMENT.test(v) && v !== "." && v !== "..";

/** The reader's archive write: mirrors `archive()` in server/app.ts, `{ adw_id, archived }` on success. */
function archiveRun(mode: MockMode, adwId: string, sel: { factory?: string | null; repo?: string | null }, archivedRaw: unknown, nowMs: number): MockResponse {
  if (!isSafeSegment(adwId)) return { status: 400, body: { error: "invalid adw_id" } };
  const archived = archivedRaw === undefined ? true : Boolean(archivedRaw);
  const hosted = mode !== "local";
  const matches = rawRows(mode, nowMs).filter((s) => s.adw_id === adwId && (!hosted || ((!sel.factory || s.factory_id === sel.factory) && (!sel.repo || s.repo === sel.repo.toLowerCase()))));
  if (matches.length === 0) return { status: 404, body: { error: `no session ${adwId}` } };
  if (matches.length > 1) return { status: 409, body: { error: `adw_id ${adwId} exists in ${matches.length} places`, candidates: candidatesOf(matches) } };
  const set = archivedRows.get(mode) ?? new Set<string>();
  archivedRows.set(mode, set);
  const key = rowKey(matches[0] as SessionSummary);
  if (archived) set.add(key);
  else set.delete(key);
  return ok({ adw_id: adwId, archived });
}

/**
 * The archive writes. `POST /api/sessions/:adw_id/archive` (local and hosted, factory/repo as query)
 * and the hosted UI's `POST /api/reviews` with a HostedArchiveBody. `/api/reviews` stays unmodelled
 * in local mode, which never calls it.
 */
function mockWrite(mode: MockMode, pathname: string, params: URLSearchParams, req: { method: string; body?: unknown }, nowMs: number): MockResponse | null {
  if (req.method !== "POST") return null;
  const m = pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/);
  if (m) {
    const b = (req.body ?? {}) as { archived?: unknown };
    return archiveRun(mode, decodeURIComponent(m[1] ?? ""), mode === "local" ? {} : { factory: params.get("factory"), repo: params.get("repo") }, b.archived, nowMs);
  }
  if (mode === "local" || pathname !== "/api/reviews") return null;
  const b = req.body as Partial<HostedArchiveBody> | null | undefined;
  if (!b || typeof b !== "object" || typeof b.adw_id !== "string") return { status: 400, body: { error: "adw_id is required" } };
  if (b.factory_id != null && typeof b.factory_id !== "string") return { status: 400, body: { error: "factory_id must be a string or null" } };
  if (b.repo != null && typeof b.repo !== "string") return { status: 400, body: { error: "repo must be a string or null" } };
  return archiveRun(mode, b.adw_id, { factory: b.factory_id, repo: b.repo }, b.archived, nowMs);
}

/**
 * Answer a GET the app makes. Returns null for paths the fixture does not
 * model, so a caller can fall through to a 404.
 */
export function mockApi(
  mode: MockMode,
  pathname: string,
  params: URLSearchParams,
  nowMs = Date.now(),
  req?: { method: string; body?: unknown },
): MockResponse | null {
  if (req && req.method !== "GET") return mockWrite(mode, pathname, params, req, nowMs);
  if (pathname === "/api/health") return ok(fixtureHealth(mode, nowMs));
  if (pathname === "/api/sessions") {
    const filter: ListFilter =
      mode !== "local" ? { repos: params.getAll("repo"), factories: params.getAll("factory") } : { repos: [], factories: [] };
    // `?archived=only` is the Reviewed view: the runs a reader archived, nothing else.
    const rows = params.get("archived") === "only" ? modeSessions(mode, nowMs, true).filter((s) => s.archived) : modeSessions(mode, nowMs);
    return ok(sortSessions(filterSessions(rows, filter)));
  }
  const rc = pathname.match(/^\/api\/receipts\/([^/]+)(\/file)?$/);
  if (rc && mode !== "hosted") {
    const runId = decodeURIComponent(rc[1] ?? "");
    if (rc[2]) {
      const f = demoReceiptFile(runId, params.get("key") ?? "");
      return f ? { status: 200, body: f.text, contentType: f.contentType, ...(f.base64 ? { base64: true } : {}) } : { status: 404, body: { error: "no such file" } };
    }
    const run = demoReceiptRun(runId, nowMs);
    return run ? ok(run) : { status: 404, body: { error: `no receipt for ${runId}` } };
  }
  const m = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(events|envelopes|gates))?$/);
  if (!m) return null;
  const adwId = decodeURIComponent(m[1] ?? "");
  const factory = mode !== "local" ? params.get("factory") : null;
  const repo = mode !== "local" ? params.get("repo")?.toLowerCase() : null;
  const matches = modeSessions(mode, nowMs, true).filter((s) => s.adw_id === adwId && (!factory || s.factory_id === factory) && (!repo || s.repo === repo));
  if (matches.length === 0) return { status: 404, body: { error: `no session ${adwId}` } };
  if (matches.length > 1) {
    // The hosted contract: an ambiguous adw_id lists its candidates instead of guessing.
    return { status: 409, body: { error: `adw_id ${adwId} exists in ${matches.length} places`, candidates: candidatesOf(matches) } };
  }
  const hit = matches[0] as SessionSummary;
  switch (m[2]) {
    case "events":
      return ok({ events: [], cursor: Number(params.get("after") ?? 0), has_more: false });
    case "envelopes":
      return ok([]);
    case "gates":
      return ok(demoGates(hit.phases));
    default: {
      const { phases, phase_count: _c, agents, ...session } = hit;
      const detail: SessionDetail = { session, usage: { read: hit.total_tokens ?? 0, written: 0 }, phases, agents };
      return ok(detail);
    }
  }
}
