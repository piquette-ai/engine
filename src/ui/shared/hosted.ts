/**
 * Pure logic behind the multi-factory view (#138): the hash-route grammar with
 * its filter query, and how an aggregated session list is filtered, keyed and
 * labelled. No DOM and no Vue, so the node test runner covers it and the app
 * imports it through the `@shared` alias.
 *
 *   #/?repo=a,b&factory=x      list, filtered
 *   #/<adw_id>?factory=<id>&repo=<slug>   a trace; a factory serves many repos and two can share an adw_id
 *   #/<adw_id>/<phase_id>      phase panel open (factory and repo optional; old factory-only links still open when unambiguous)
 */

import type { HealthResponse, HostedFactory, SessionSummary } from "./types.js";

export interface ListFilter {
  repos: string[];
  factories: string[];
}

export interface ParsedHash {
  adwId: string | null;
  phaseId: string | null;
  /** Trace routes: the factory the run belongs to. */
  factory: string | null;
  /** Trace routes: the repo the run belongs to (a single value; list routes read `repo` as the filter list). */
  repo: string | null;
  /** List route: the active filter. Empty arrays mean "all". */
  filter: ListFilter;
}

export const EMPTY_FILTER: ListFilter = { repos: [], factories: [] };

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Repo slugs are `host/owner/name`; keep the slashes readable in a shared link. */
const encodeValue = (s: string): string => encodeURIComponent(s).replace(/%2F/gi, "/");

/** Comma-separated list; a comma inside a value is percent-encoded, so splitting is unambiguous. */
const splitList = (raw: string | null): string[] => {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = safeDecode(part).trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
};

export function parseHash(hash: string): ParsedHash {
  const body = hash.replace(/^#\/?/, "");
  const q = body.indexOf("?");
  const pathPart = q === -1 ? body : body.slice(0, q);
  const params = new URLSearchParams(q === -1 ? "" : body.slice(q + 1));
  const parts = pathPart.split("/").filter(Boolean).map(safeDecode);
  const adwId = parts[0] ?? null;
  // URLSearchParams decodes once; our list values are comma-split first, so read the raw pairs.
  const rawOf = (key: string): string | null => {
    for (const pair of (q === -1 ? "" : body.slice(q + 1)).split("&")) {
      const eq = pair.indexOf("=");
      if (eq !== -1 && safeDecode(pair.slice(0, eq)) === key) return pair.slice(eq + 1);
    }
    return null;
  };
  return {
    adwId,
    phaseId: parts[1] ?? null,
    factory: adwId ? params.get("factory") || null : null,
    repo: adwId ? params.get("repo") || null : null,
    filter: adwId ? EMPTY_FILTER : { repos: splitList(rawOf("repo")), factories: splitList(rawOf("factory")) },
  };
}

export function filterQuery(filter: ListFilter): string {
  const pairs: string[] = [];
  if (filter.repos.length) pairs.push(`repo=${filter.repos.map(encodeValue).join(",")}`);
  if (filter.factories.length) pairs.push(`factory=${filter.factories.map(encodeValue).join(",")}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

/** Inverse of parseHash for routes the app can link to. */
export function buildHash(opts: {
  adwId?: string | null;
  phaseId?: string | null;
  factory?: string | null;
  repo?: string | null;
  filter?: ListFilter;
}): string {
  if (!opts.adwId) return `#/${filterQuery(opts.filter ?? EMPTY_FILTER)}`;
  let h = `#/${encodeURIComponent(opts.adwId)}`;
  if (opts.phaseId) h += `/${encodeURIComponent(opts.phaseId)}`;
  const sel: string[] = [];
  if (opts.factory) sel.push(`factory=${encodeValue(opts.factory)}`);
  if (opts.repo) sel.push(`repo=${encodeValue(opts.repo)}`);
  if (sel.length) h += `?${sel.join("&")}`;
  return h;
}

export const filterIsEmpty = (f: ListFilter): boolean => f.repos.length === 0 && f.factories.length === 0;

export const sameFilter = (a: ListFilter, b: ListFilter): boolean =>
  a.repos.join("\0") === b.repos.join("\0") && a.factories.join("\0") === b.factories.join("\0");

/** Add the value when absent, remove it when present. Order of selection is kept. */
export function toggleValue(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Query string for `GET /api/sessions`: `repo` repeats, per the hosted API's multi-value contract. */
export function sessionsQuery(filter: ListFilter, limit?: number): string {
  const p = new URLSearchParams();
  for (const r of filter.repos) p.append("repo", r);
  for (const f of filter.factories) p.append("factory", f);
  if (limit) p.set("limit", String(limit));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** `GET /api/sessions` URL. Local mode passes no filter, so it is exactly the bare route it always was. */
export const sessionsUrl = (filter?: ListFilter): string => `/api/sessions${filter ? sessionsQuery(filter) : ""}`;

/** Picks one run when an adw_id repeats (hosted): a factory serves many repos, and a repo many factories. Local mode ignores it. */
export interface SessionSel {
  factory?: string | null;
  repo?: string | null;
}

/** `?factory=<id>&repo=<slug>` for a session-scoped call; empty when neither is known. `sep` is `&` when appended to an existing query. */
export function selQuery(sel?: SessionSel | null, sep: "?" | "&" = "?"): string {
  const parts: string[] = [];
  if (sel?.factory) parts.push(`factory=${encodeURIComponent(sel.factory)}`);
  if (sel?.repo) parts.push(`repo=${encodeURIComponent(sel.repo)}`);
  return parts.length ? `${sep}${parts.join("&")}` : "";
}

/** The selector a WebMCP tool call names: `factory_id` and `repo` inputs, each only when a non-empty string. */
export const selFromInputs = (inputs: Record<string, unknown>): SessionSel => ({
  factory: typeof inputs["factory_id"] === "string" && inputs["factory_id"] ? inputs["factory_id"] : null,
  repo: typeof inputs["repo"] === "string" && inputs["repo"] ? inputs["repo"] : null,
});

/** Body of the hosted archive write, `POST /api/reviews` (#137 owns the handler; this is the contract the app sends). */
export interface HostedArchiveBody {
  adw_id: string;
  factory_id: string | null;
  repo: string | null;
  archived: boolean;
}

/** Where an archive write goes and what it carries: per-session route locally, the reviews route when hosted. */
export function archiveRequest(
  hosted: boolean,
  adwId: string,
  archived: boolean,
  factory?: string | null,
  repo?: string | null,
): { url: string; body: HostedArchiveBody | { archived: boolean } } {
  return hosted
    ? { url: "/api/reviews", body: { adw_id: adwId, factory_id: factory ?? null, repo: repo ?? null, archived } }
    : { url: `/api/sessions/${encodeURIComponent(adwId)}/archive`, body: { archived } };
}

/** Case-insensitive match over the fields a search covers: request, chain name, id, and every phase's name/description/error. */
export function sessionMatchesQuery(query: string, s: SessionSummary): boolean {
  const q = query.toLowerCase();
  const has = (v: string | null | undefined) => (v ?? "").toLowerCase().includes(q);
  return has(s.request) || has(s.adw_name) || has(s.adw_id) || s.phases.some((p) => has(p.name) || has(p.description) || has(p.error));
}

/** Rows for a ranked list of row keys, in rank order; keys no longer in `rows` drop out. */
export function rowsByKeys(keys: readonly string[], rows: readonly SessionSummary[]): SessionSummary[] {
  const byKey = new Map(rows.map((s) => [sessionKey(s), s]));
  return keys.map((k) => byKey.get(k)).filter((s): s is SessionSummary => s != null);
}

/** Hosted mode is declared by the server; anything else (including an old server) is local. */
export const isHosted = (h: Pick<HealthResponse, "mode"> | null | undefined): boolean => h?.mode === "hosted";

/**
 * Hosted filters show as soon as there is one repo / one factory: a single chip still tells the reader
 * what the hub holds and where filtering lives, instead of the control appearing only once a second
 * repo or factory happens to sync.
 */
export const showRepoFilter = (h: HealthResponse | null | undefined): boolean =>
  isHosted(h) && (h?.repos?.length ?? 0) > 0;

export const showFactoryFilter = (h: HealthResponse | null | undefined): boolean =>
  isHosted(h) && (h?.factories?.length ?? 0) > 0;

const startedAt = (s: SessionSummary): number => {
  const t = s.started_at ? Date.parse(s.started_at) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** started_at DESC across factories; ties break on key so the order never flickers between polls. */
export function sortSessions(rows: readonly SessionSummary[]): SessionSummary[] {
  return rows.toSorted((a, b) => startedAt(b) - startedAt(a) || (sessionKey(a) < sessionKey(b) ? -1 : 1));
}

/** Row identity. `adw_id` alone collides once factories share one view, and one factory serves many repos. Local mode has neither, so both are ''. (Local keys changed shape in #218, so the IndexedDB vector cache re-embeds once after the upgrade.) */
export const sessionKey = (s: Pick<SessionSummary, "adw_id" | "factory_id" | "repo">): string =>
  `${s.factory_id ?? ""}\u0000${s.repo ?? ""}\u0000${s.adw_id}`;

/**
 * Client-side mirror of the hosted API's `repo`/`factory` predicates. The
 * server does the real filtering; this serves fixtures and anything that has
 * to re-filter rows it already holds (an optimistic archive, a stale poll).
 * Rows with no repo (local mode) only survive an empty filter.
 */
export function filterSessions(rows: readonly SessionSummary[], filter: ListFilter): SessionSummary[] {
  return rows.filter(
    (s) =>
      (filter.repos.length === 0 || (s.repo != null && filter.repos.includes(s.repo))) &&
      (filter.factories.length === 0 || (s.factory_id != null && filter.factories.includes(s.factory_id))),
  );
}

/** Last path segment of a repo slug: `github.com/acme/api` -> `api`. */
export const repoShortName = (repo: string): string => repo.split("/").filter(Boolean).pop() ?? repo;

/**
 * Chip label per repo: the short name, widened to `owner/name` only where two
 * repos would otherwise read the same.
 */
export function repoLabels(repos: readonly string[]): Map<string, string> {
  const shortCount = new Map<string, number>();
  for (const r of repos) shortCount.set(repoShortName(r), (shortCount.get(repoShortName(r)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const r of repos) {
    const short = repoShortName(r);
    out.set(r, (shortCount.get(short) ?? 0) > 1 ? r.split("/").filter(Boolean).slice(-2).join("/") : short);
  }
  return out;
}

export interface RepoOption {
  repo: string;
  label: string;
  selected: boolean;
  /** Rows currently loaded for this repo; null when the list is filtered and the count would mislead. */
  count: number | null;
}

/**
 * Options for the repo chip bar: `health.repos`, plus any selected repo the
 * server no longer lists (a shared link to a repo with no recent runs must
 * still show, and be removable).
 */
export function repoOptions(
  repos: readonly string[],
  selected: readonly string[],
  rows: readonly SessionSummary[],
  filterActive: boolean,
): RepoOption[] {
  const all = [...repos];
  for (const r of selected) if (!all.includes(r)) all.push(r);
  const labels = repoLabels(all);
  const counts = new Map<string, number>();
  for (const s of rows) if (s.repo) counts.set(s.repo, (counts.get(s.repo) ?? 0) + 1);
  return all.map((repo) => ({
    repo,
    label: labels.get(repo) ?? repo,
    selected: selected.includes(repo),
    count: filterActive ? null : (counts.get(repo) ?? 0),
  }));
}

/** Seconds since the factory last synced, or null when it never has. */
export function syncAgeSeconds(lastSeenAt: string | null | undefined, nowMs: number): number | null {
  if (!lastSeenAt) return null;
  const t = Date.parse(lastSeenAt);
  return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 1000)) : null;
}

/** "last synced 12s ago", "last synced 3m ago", "last synced 2h ago"; "never synced" with no timestamp. */
export function syncLabel(lastSeenAt: string | null | undefined, nowMs: number): string {
  const s = syncAgeSeconds(lastSeenAt, nowMs);
  if (s == null) return "never synced";
  if (s < 60) return `last synced ${s}s ago`;
  if (s < 3600) return `last synced ${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `last synced ${Math.floor(s / 3600)}h ago`;
  return `last synced ${Math.floor(s / 86_400)}d ago`;
}

export function factoryIndex(factories: readonly HostedFactory[] | undefined): Map<string, HostedFactory> {
  return new Map((factories ?? []).map((f) => [f.id, f]));
}
