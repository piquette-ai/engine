/**
 * The hosted dashboard reader over the cloud app's synced D1 (node-free).
 *
 * Isolation rule: EVERY query is scoped by `sessions.tenant`, where the
 * tenant set comes from the reader's grants and never from the request.
 * Child tables (events, phases, ...) carry no tenant, so they are always
 * reached through a join on `sessions (factory_id, repo, adw_id)` carrying the
 * tenant predicate. The tenant list and the filters are bound as ONE JSON
 * parameter each (`json_each`), so a reader with many tenants or filters
 * can never hit D1's 100-bound-parameter limit.
 *
 * `adw_id` is unique only within one (factory, repo): a factory (a machine)
 * serves many repos, so a lookup that matches more than one throws
 * `AmbiguousSession` unless the caller names the factory and/or repo.
 * The only write is the reader's own review flag in `reviews`; no synced
 * table is ever touched.
 */
import type {
  AgentPrompts,
  AgentSession,
  AgentStartPayload,
  Envelope,
  Event,
  EventsPage,
  GateResult,
  Phase,
  Session,
  SessionDetail,
  SessionSummary,
  SessionUsage,
} from "../shared/types.ts";
import {
  AmbiguousSession,
  BadFilter,
  type HostedHealth,
  type SessionCandidate,
  type SessionFilter,
  type SessionSel,
  type TraceReader,
} from "./trace_reader.ts";

/** The slice of D1 this reader uses (structural, so no workers-types dependency). */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }>; run(): Promise<{ meta?: { changes?: number } }> };
  };
}

const MAX_LIMIT = 1000;
const MAX_FILTER_VALUES = 50;
const MAX_FILTER_CHARS = 200;
/** Health counts at most this many rows: a poll must never scan an unbounded table. */
const HEALTH_COUNT_CAP = 10_000;
const MAX_FACTORIES = 500;

const clamp = (value: number, min: number, max: number): number => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min);

/** `s` is the sessions alias in every query below. */
const TENANT = "s.tenant IN (SELECT value FROM json_each(?))";
/** A bound JSON array of `[factory_id, repo, adw_id]` triples, as a row-value subquery. */
const TRIPLES = "SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]') FROM json_each(?) j";
const keyOf = (factory: string, repo: string, adw: string | null | undefined): string => `${factory}\u0000${repo}\u0000${adw}`;

export interface D1ReaderOptions {
  /** The tenants this reader may see. Never empty. */
  tenants: string[];
  /** Who archives (the Access email). */
  actor?: string;
  now?: () => Date;
}

function checkFilter(name: string, values: string[] | undefined): string[] {
  const out = [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))];
  if (out.length > MAX_FILTER_VALUES) throw new BadFilter(`at most ${MAX_FILTER_VALUES} ${name} values`);
  if (out.some((v) => v.length > MAX_FILTER_CHARS)) throw new BadFilter(`a ${name} value is longer than ${MAX_FILTER_CHARS} characters`);
  return out;
}

interface Resolved {
  factory_id: string;
  repo: string;
  tenant: string;
  level: string | null;
}

export class D1TraceReader implements TraceReader {
  readonly mode = "hosted" as const;
  readonly label = "d1:hub";
  readonly journalMode = "n/a (d1)";
  private readonly tenants: string;
  private readonly actor: string | undefined;
  private readonly now: () => Date;
  private readonly db: D1Like;

  constructor(db: D1Like, options: D1ReaderOptions) {
    this.db = db;
    if (options.tenants.length === 0) throw new Error("D1TraceReader: no tenants");
    this.tenants = JSON.stringify([...options.tenants].sort());
    this.actor = options.actor;
    this.now = options.now ?? (() => new Date());
  }

  private async rows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return (await this.db.prepare(sql).bind(...params).all<T>()).results;
  }

  /** The one place a session id becomes a (factory, repo, tenant). Tenant-scoped; more than one match is ambiguous. */
  private async resolve(adwId: string, sel?: SessionSel): Promise<Resolved | null> {
    const factory = sel?.factory?.trim();
    const repo = sel?.repo?.trim().toLowerCase();
    const rows = await this.rows<Resolved & { factory_name: string }>(
      `SELECT s.factory_id, s.repo, s.tenant, s.level, (SELECT COALESCE(f.name, f.factory_id) FROM factories f WHERE f.factory_id = s.factory_id AND f.tenant = s.tenant) AS factory_name
         FROM sessions s WHERE ${TENANT} AND s.adw_id = ?${factory ? " AND s.factory_id = ?" : ""}${repo ? " AND s.repo = ?" : ""} LIMIT 51`,
      this.tenants,
      adwId,
      ...(factory ? [factory] : []),
      ...(repo ? [repo] : []),
    );
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      const candidates: SessionCandidate[] = rows.map((r) => ({ factory_id: r.factory_id, factory_name: r.factory_name ?? r.factory_id, repo: r.repo }));
      candidates.sort((a, b) => a.repo.localeCompare(b.repo) || a.factory_id.localeCompare(b.factory_id));
      throw new AmbiguousSession(adwId, candidates);
    }
    return rows[0]!;
  }

  async sessionCount(): Promise<number> {
    const [row] = await this.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM sessions s WHERE ${TENANT} LIMIT ${HEALTH_COUNT_CAP})`, this.tenants);
    return row?.n ?? 0;
  }

  async hostedHealth(): Promise<HostedHealth> {
    const factories = await this.rows<{ id: string; name: string; repo: string; last_seen_at: string | null }>(
      `SELECT f.factory_id AS id, COALESCE(f.name, f.factory_id) AS name, f.repo, f.last_seen_at
         FROM factories f WHERE f.tenant IN (SELECT value FROM json_each(?))
        ORDER BY f.last_seen_at DESC, f.factory_id LIMIT ${MAX_FACTORIES}`,
      this.tenants,
    );
    // Repos come from factory_repos (a factory serves many); factories.repo is only the latest batch's.
    const repos = await this.rows<{ repo: string }>(`SELECT DISTINCT repo FROM factory_repos WHERE tenant IN (SELECT value FROM json_each(?)) ORDER BY repo`, this.tenants);
    return { repos: [...new Set(repos.map((r) => r.repo))].sort(), factories };
  }

  async sessions(limit: number, filter: SessionFilter = {}): Promise<SessionSummary[]> {
    const repos = checkFilter("repo", filter.repos).map((r) => r.toLowerCase());
    const factories = checkFilter("factory", filter.factories);
    const params: unknown[] = [this.tenants];
    let where = `${TENANT} AND COALESCE(r.archived, 0) = ${filter.archived ? 1 : 0}`;
    if (repos.length) {
      where += " AND s.repo IN (SELECT value FROM json_each(?))";
      params.push(JSON.stringify(repos));
    }
    if (factories.length) {
      where += " AND s.factory_id IN (SELECT value FROM json_each(?))";
      params.push(JSON.stringify(factories));
    }
    const from = `FROM sessions s LEFT JOIN reviews r ON r.tenant = s.tenant AND r.factory_id = s.factory_id AND r.repo = s.repo AND r.adw_id = s.adw_id WHERE ${where}`;
    const order = "ORDER BY s.started_at DESC, s.rowid DESC";
    const lim = clamp(limit, 1, MAX_LIMIT);

    const rows = await this.rows<SessionSummary & { factory_id: string; repo: string }>(
      `SELECT s.adw_id, s.adw_name, s.request, s.status, s.engineer, s.started_at, s.ended_at,
              s.total_tokens, s.total_cost, s.billable_tokens, COALESCE(r.archived, 0) AS archived,
              s.factory_id, (SELECT COALESCE(f.name, f.factory_id) FROM factories f WHERE f.factory_id = s.factory_id AND f.tenant = s.tenant) AS factory_name, s.repo
         ${from} ${order} LIMIT ?`,
      ...params,
      lim,
    );
    if (rows.length === 0) return [];

    // The page is evaluated once (above) and its (factory_id, repo, adw_id) triples are bound as ONE json parameter: the
    // sorted, joined page query is never re-run for the phases and agents lookups. The pairs came from the
    // tenant-scoped query, so they cannot name another tenant's session.
    const page = TRIPLES;
    const pageParams = [JSON.stringify(rows.map((r) => [r.factory_id, r.repo, r.adw_id]))];
    const phaseRows = await this.rows<Phase & { factory_id: string; repo: string }>(
      `SELECT p.factory_id, p.repo, p.phase_id, p.adw_id, p.seq, p.name, p.kind, p.owner, p.description, p.status, p.attempt, p.retries, p.error, p.started_at, p.ended_at
         FROM phases p WHERE (p.factory_id, p.repo, p.adw_id) IN (${page}) ORDER BY p.seq, p.rowid`,
      ...pageParams,
    );
    const phasesBy = new Map<string, Phase[]>();
    for (const { factory_id, repo, ...phase } of phaseRows) {
      const k = keyOf(factory_id, repo, phase.adw_id);
      (phasesBy.get(k) ?? phasesBy.set(k, []).get(k)!).push(phase);
    }
    const agentsBy = await this.agentsFor(page, pageParams);
    return rows.map((row) => {
      const k = keyOf(row.factory_id, row.repo, row.adw_id);
      const phases = phasesBy.get(k) ?? [];
      return Object.assign(row, { phases, phase_count: phases.length, agents: agentsBy.get(k) ?? [] });
    });
  }

  /** Agents for a set of sessions given as a tenant-scoped `(factory_id, repo, adw_id)` subquery. */
  private async agentsFor(scope: string, params: unknown[]): Promise<Map<string, AgentSession[]>> {
    const by = new Map<string, AgentSession[]>();
    const append = (factory: string, repo: string, agent: AgentSession) => {
      const k = keyOf(factory, repo, agent.adw_id);
      (by.get(k) ?? by.set(k, []).get(k)!).push(agent);
    };
    const completed = await this.rows<AgentSession & { factory_id: string; repo: string }>(
      `SELECT a.factory_id, a.repo, a.adw_id, a.agent, a.coding_agent, a.model, a.session_id, a.color, a.context_tokens, a.context_window, a.created_at, a.last_used_at
         FROM agent_sessions a WHERE (a.factory_id, a.repo, a.adw_id) IN (${scope}) ORDER BY a.created_at, a.agent`,
      ...params,
    );
    for (const { factory_id, repo, ...row } of completed) append(factory_id, repo, row);

    // A running agent has no agent_sessions row yet; its agent_start event labels the lane.
    const started = await this.rows<{ factory_id: string; repo: string; adw_id: string; agent: string | null; payload_json: string | null; started_at: string | null }>(
      `SELECT e.factory_id, e.repo, e.adw_id, p.owner AS agent, e.payload_json, e.started_at
         FROM events e JOIN phases p ON p.factory_id = e.factory_id AND p.repo = e.repo AND p.phase_id = e.phase_id
        WHERE (e.factory_id, e.repo, e.adw_id) IN (${scope}) AND e.type = 'agent_start'
        ORDER BY e.factory_id, e.repo, e.adw_id, e.local_rowid`,
      ...params,
    );
    for (const row of started) {
      if (!row.agent) continue;
      if (by.get(keyOf(row.factory_id, row.repo, row.adw_id))?.some((a) => a.agent === row.agent)) continue;
      let payload: AgentStartPayload = {};
      try {
        payload = JSON.parse(row.payload_json ?? "{}") as AgentStartPayload;
      } catch {
        // A malformed payload just means no label.
      }
      append(row.factory_id, row.repo, {
        adw_id: row.adw_id,
        agent: row.agent,
        coding_agent: null,
        model: payload.model ?? null,
        session_id: payload.session_id ?? null,
        color: payload.color ?? null,
        context_tokens: null,
        context_window: null,
        created_at: row.started_at,
        last_used_at: row.started_at,
      });
    }
    return by;
  }

  async session(adwId: string, sel?: SessionSel): Promise<Session | null> {
    const hit = await this.resolve(adwId, sel);
    return hit ? this.sessionRow(adwId, hit.factory_id, hit.repo) : null;
  }

  private async sessionRow(adwId: string, factoryId: string, repo: string): Promise<Session | null> {
    const [row] = await this.rows<Session>(
      `SELECT s.adw_id, s.adw_name, s.request, s.status, s.engineer, s.started_at, s.ended_at, s.total_tokens, s.total_cost, s.billable_tokens,
              s.factory_id, (SELECT COALESCE(f.name, f.factory_id) FROM factories f WHERE f.factory_id = s.factory_id AND f.tenant = s.tenant) AS factory_name, s.repo
         FROM sessions s WHERE ${TENANT} AND s.factory_id = ? AND s.repo = ? AND s.adw_id = ?`,
      this.tenants,
      factoryId,
      repo,
      adwId,
    );
    return row ?? null;
  }

  async sessionDetail(adwId: string, sel?: SessionSel): Promise<SessionDetail | null> {
    const hit = await this.resolve(adwId, sel);
    if (!hit) return null;
    const session = await this.sessionRow(adwId, hit.factory_id, hit.repo);
    if (!session) return null;
    const scope = `SELECT s.factory_id, s.repo, s.adw_id FROM sessions s WHERE ${TENANT} AND s.factory_id = ? AND s.repo = ? AND s.adw_id = ?`;
    const params = [this.tenants, hit.factory_id, hit.repo, adwId];
    const phases = await this.rows<Phase>(
      `SELECT p.phase_id, p.adw_id, p.seq, p.name, p.kind, p.owner, p.description, p.status, p.attempt, p.retries, p.error, p.started_at, p.ended_at
         FROM phases p WHERE (p.factory_id, p.repo, p.adw_id) IN (${scope}) ORDER BY p.seq, p.rowid`,
      ...params,
    );
    const agents = (await this.agentsFor(scope, params)).get(keyOf(hit.factory_id, hit.repo, adwId)) ?? [];
    return { session, usage: await this.usage(scope, params), phases, agents };
  }

  /** Raw tokens read and written, derived from `agent_end` payloads exactly as the local reader does. */
  private async usage(scope: string, params: unknown[]): Promise<SessionUsage> {
    const rows = await this.rows<{ payload_json: string | null }>(
      `SELECT e.payload_json FROM events e WHERE (e.factory_id, e.repo, e.adw_id) IN (${scope}) AND e.type = 'agent_end'`,
      ...params,
    );
    let read = 0;
    let written = 0;
    for (const row of rows) {
      if (!row.payload_json) continue;
      try {
        const u = (JSON.parse(row.payload_json) as { usage?: Record<string, number> }).usage;
        if (!u) continue;
        read += (u.input_tokens ?? 0) + (u.cache_write_tokens ?? 0);
        written += u.output_tokens ?? 0;
      } catch {
        /* an older payload contributes nothing */
      }
    }
    return { read, written };
  }

  async events(adwId: string, after = 0, limit = 500, sel?: SessionSel): Promise<EventsPage> {
    const hit = await this.resolve(adwId, sel);
    const capped = clamp(limit, 1, MAX_LIMIT);
    const cursor0 = Math.max(0, after);
    if (!hit) return { events: [], cursor: cursor0, has_more: false };
    const events = await this.rows<Event>(
      `SELECT e.local_rowid AS rowid, e.event_id, e.adw_id, e.phase_id, e.parent_id, e.type, e.name, e.payload_json, e.tokens, e.started_at, e.ended_at
         FROM events e JOIN sessions s ON s.factory_id = e.factory_id AND s.repo = e.repo AND s.adw_id = e.adw_id
        WHERE ${TENANT} AND e.factory_id = ? AND e.repo = ? AND e.adw_id = ? AND e.local_rowid > ?
        ORDER BY e.local_rowid LIMIT ?`,
      this.tenants,
      hit.factory_id,
      hit.repo,
      adwId,
      cursor0,
      capped,
    );
    return { events, cursor: events.length > 0 ? events[events.length - 1]!.rowid : cursor0, has_more: events.length === capped };
  }

  async envelopes(adwId: string, sel?: SessionSel): Promise<Envelope[]> {
    const hit = await this.resolve(adwId, sel);
    if (!hit) return [];
    return this.rows<Envelope>(
      `SELECT v.envelope_id, v.adw_id, v.phase_id, v.agent, v.output_type, v.payload_json, v.valid, v.attempt, v.created_at
         FROM envelopes v JOIN sessions s ON s.factory_id = v.factory_id AND s.repo = v.repo AND s.adw_id = v.adw_id
        WHERE ${TENANT} AND v.factory_id = ? AND v.repo = ? AND v.adw_id = ? ORDER BY v.created_at, v.rowid`,
      this.tenants,
      hit.factory_id,
      hit.repo,
      adwId,
    );
  }

  async gates(adwId: string, sel?: SessionSel): Promise<GateResult[]> {
    const hit = await this.resolve(adwId, sel);
    if (!hit) return [];
    return this.rows<GateResult>(
      `SELECT g.local_id AS id, g.adw_id, g.phase_id, g.attempt, g.gate, g.passed, g.violations_json, g.checks_json, g.created_at
         FROM gate_results g JOIN sessions s ON s.factory_id = g.factory_id AND s.repo = g.repo AND s.adw_id = g.adw_id
        WHERE ${TENANT} AND g.factory_id = ? AND g.repo = ? AND g.adw_id = ? ORDER BY g.local_id`,
      this.tenants,
      hit.factory_id,
      hit.repo,
      adwId,
    );
  }

  async prompts(adwId: string, agent: string, sel?: SessionSel): Promise<AgentPrompts> {
    const hit = await this.resolve(adwId, sel);
    // Only a `full` sync carries prompts; below that the rows (if any) are never served.
    if (!hit || hit.level !== "full") return { system: null, user: null };
    const [row] = await this.rows<AgentPrompts>(
      `SELECT p."system" AS system, p."user" AS user
         FROM prompts p JOIN sessions s ON s.factory_id = p.factory_id AND s.repo = p.repo AND s.adw_id = p.adw_id
        WHERE ${TENANT} AND s.level = 'full' AND p.factory_id = ? AND p.repo = ? AND p.adw_id = ? AND p.agent = ?`,
      this.tenants,
      hit.factory_id,
      hit.repo,
      adwId,
      agent,
    );
    return { system: row?.system ?? null, user: row?.user ?? null };
  }

  async setArchived(adwId: string, archived: boolean, sel?: SessionSel, actor?: string): Promise<boolean> {
    const hit = await this.resolve(adwId, sel);
    if (!hit) return false;
    // The tenant comes from the session row itself, selected under the reader's tenants, in the same statement as the write.
    const result = await this.db
      .prepare(
        `INSERT INTO reviews (tenant, factory_id, repo, adw_id, archived, archived_by, archived_at)
           SELECT s.tenant, s.factory_id, s.repo, s.adw_id, ?, ?, ? FROM sessions s WHERE ${TENANT} AND s.factory_id = ? AND s.repo = ? AND s.adw_id = ?
         ON CONFLICT (tenant, factory_id, repo, adw_id) DO UPDATE SET archived = excluded.archived, archived_by = excluded.archived_by, archived_at = excluded.archived_at`,
      )
      .bind(archived ? 1 : 0, actor ?? this.actor ?? null, this.now().toISOString(), this.tenants, hit.factory_id, hit.repo, adwId)
      .run();
    return (result.meta?.changes ?? 1) > 0;
  }
}
