/**
 * Fixture `/api` for the multi-factory UI (#138). Stands in for the hosted read
 * API (#137) so the app and its tests can run before that Worker exists:
 * three factories over two repos, and one `adw_id` that two factories share.
 *
 * `mockApi` is a pure router, so the vite dev plugin (`SPF_MOCK=hosted|local`
 * in app/) and the tests use the same answers. Times are relative to `nowMs`
 * so "Today" and "last synced Ns ago" read naturally whenever it is served.
 */

import { filterSessions, sortSessions, type HostedArchiveBody, type ListFilter } from "./hosted.js";
import type { AgentSession, HealthResponse, HostedFactory, Phase, Session, SessionDetail, SessionSummary } from "./types.js";

export type MockMode = "local" | "hosted";

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
}

const FACTORY_SEEDS = {
  laptop: { id: "f-3a1c", name: "jd@laptop", repo: REPO_API, syncedSecAgo: 8 },
  ci: { id: "f-9e47", name: "ci-runner-1", repo: REPO_API, syncedSecAgo: 190 },
  studio: { id: "f-b520", name: "jd@studio", repo: REPO_WEB, syncedSecAgo: 41 },
} as const;

const SEEDS: Seed[] = [
  { adw_id: "a1b2c3d4", factory: "laptop", request: "Add cursor pagination to /v1/runs", status: "running", startedMinAgo: 6, durationMin: 6, cost: 0.84, tokens: 212_400, phases: [["plan", "success"], ["build", "running"], ["test", "queued"]] },
  { adw_id: "c0ffee01", factory: "studio", request: "Dark-mode contrast pass on the settings page", status: "running", startedMinAgo: 14, durationMin: 14, cost: 1.12, tokens: 301_900, phases: [["plan", "success"], ["build", "success"], ["review", "running"]] },
  // The same adw_id under two factories: the trace link has to carry `factory`.
  { adw_id: "dead0042", factory: "ci", request: "Bump undici to patch CVE", status: "success", startedMinAgo: 55, durationMin: 12, cost: 0.31, tokens: 88_000, phases: [["plan", "success"], ["build", "success"], ["test", "success"]] },
  { adw_id: "dead0042", factory: "studio", request: "Replace moment with date-fns in the calendar widget", status: "fail", startedMinAgo: 95, durationMin: 21, cost: 2.4, tokens: 540_300, phases: [["plan", "success"], ["build", "success"], ["test", "fail"]] },
  { adw_id: "5f6a7b8c", factory: "laptop", request: "Retry flaky webhook delivery with backoff", status: "success", startedMinAgo: 200, durationMin: 33, cost: 3.05, tokens: 702_100, phases: [["plan", "success"], ["build", "success"], ["test", "success"], ["review", "success"]] },
  { adw_id: "9a8b7c6d", factory: "ci", request: "Index sessions(repo, started_at) for the hosted list", status: "success", startedMinAgo: 1500, durationMin: 9, cost: 0.46, tokens: 120_800, phases: [["plan", "success"], ["build", "success"]] },
  { adw_id: "1d2e3f40", factory: "studio", request: "Skeleton loaders for the dashboard grid", status: "success", startedMinAgo: 1700, durationMin: 18, cost: 1.6, tokens: 388_000, phases: [["plan", "success"], ["build", "success"], ["test", "success"]] },
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
      factory_id: f.id,
      factory_name: f.name,
      repo: f.repo,
    };
    return { ...session, phases, phase_count: phases.length, agents: [] as AgentSession[] };
  });
}

export function fixtureHealth(mode: MockMode, nowMs: number): HealthResponse {
  if (mode === "local") {
    return { ok: true, db: "fixture", journal_mode: "wal", sessions: 4, project: "api", repo: "acme/api", mode: "local" };
  }
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

/** Local mode serves one repo's rows with no factory or repo columns, like today's `spf ui`. */
function modeSessions(mode: MockMode, nowMs: number): SessionSummary[] {
  const all = fixtureSessions(nowMs);
  if (mode === "hosted") return all;
  return all
    .filter((s) => s.factory_id === FACTORY_SEEDS.laptop.id || s.factory_id === FACTORY_SEEDS.ci.id)
    .map(({ factory_id: _f, factory_name: _n, repo: _r, ...rest }) => rest as SessionSummary);
}

export interface MockResponse {
  status: number;
  body: unknown;
}

const ok = (body: unknown): MockResponse => ({ status: 200, body });

/** The hosted 409 body: which (repo, factory) pairs hold the id, sorted by repo then factory. */
const candidatesOf = (rows: SessionSummary[]) =>
  rows
    .map((s) => ({ factory_id: s.factory_id ?? "", factory_name: s.factory_name ?? s.factory_id ?? "", repo: s.repo ?? "" }))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.factory_id.localeCompare(b.factory_id));

/** The hosted archive write, `POST /api/reviews` with a HostedArchiveBody. Local mode has no such route. */
function mockWrite(mode: MockMode, pathname: string, req: { method: string; body?: unknown }, nowMs: number): MockResponse | null {
  if (mode !== "hosted" || req.method !== "POST" || pathname !== "/api/reviews") return null;
  const b = (req.body ?? {}) as Partial<HostedArchiveBody>;
  if (typeof b.adw_id !== "string" || typeof b.archived !== "boolean") return { status: 400, body: { error: "adw_id and archived are required" } };
  const matches = modeSessions(mode, nowMs).filter((s) => s.adw_id === b.adw_id && (!b.factory_id || s.factory_id === b.factory_id) && (!b.repo || s.repo === b.repo.toLowerCase()));
  if (matches.length === 0) return { status: 404, body: { error: `no session ${b.adw_id}` } };
  if (matches.length > 1) return { status: 409, body: { error: `adw_id ${b.adw_id} exists in ${matches.length} places`, candidates: candidatesOf(matches) } };
  return ok({ ok: true });
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
  if (req && req.method !== "GET") return mockWrite(mode, pathname, req, nowMs);
  if (pathname === "/api/health") return ok(fixtureHealth(mode, nowMs));
  if (pathname === "/api/sessions") {
    const filter: ListFilter =
      mode === "hosted" ? { repos: params.getAll("repo"), factories: params.getAll("factory") } : { repos: [], factories: [] };
    return ok(sortSessions(filterSessions(modeSessions(mode, nowMs), filter)));
  }
  const m = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(events|envelopes|gates))?$/);
  if (!m) return null;
  const adwId = decodeURIComponent(m[1] ?? "");
  const factory = mode === "hosted" ? params.get("factory") : null;
  const repo = mode === "hosted" ? params.get("repo")?.toLowerCase() : null;
  const matches = modeSessions(mode, nowMs).filter((s) => s.adw_id === adwId && (!factory || s.factory_id === factory) && (!repo || s.repo === repo));
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
    case "gates":
      return ok([]);
    default: {
      const { phases, phase_count: _c, agents, ...session } = hit;
      const detail: SessionDetail = { session, usage: { read: hit.total_tokens ?? 0, written: 0 }, phases, agents };
      return ok(detail);
    }
  }
}
