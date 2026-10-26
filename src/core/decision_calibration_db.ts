/**
 * The read side of `piquette decisions calibrate` (#151): every recorded decision
 * across the trace db, and the run facts the outcome rules in
 * `decision_calibration.ts` join them to. SELECTs only — a trace db is
 * opened read-only for this, and nothing here writes.
 *
 * Both row shapes are read: the current `decision` event and the pre-#150
 * `jev_decision` (via `parseRecordedDecision`, which maps `jev_choice` to
 * `model_choice`). `SfDb.allRecordedDecisions` / `SfDb.runFacts` delegate
 * here, the same way `SfDb.recordedDecisions` delegates to
 * `listRecordedDecisions`.
 */
import { RUN_KILLED_EVENT } from "./data_types.ts";
import { DECISION_EVENT, LEGACY_DECISION_EVENT, parseRecordedDecision } from "./decisions.ts";
import type { RecordedDecisionRow, RunFacts } from "./decision_calibration.ts";
import type { TraceDb } from "./trace_db.ts";

/** D1 caps bound parameters at 100 per statement — see `SfDb.chunked`. */
const CHUNK = 90;

async function chunked<T>(ids: readonly string[], fn: (placeholders: string, chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    out.push(...(await fn(chunk.map(() => "?").join(", "), chunk)));
  }
  return out;
}

/**
 * Every recorded decision in the db, oldest first, across all runs.
 * `kind` filters by decision kind; `since` (an ISO timestamp) drops rows
 * recorded before it. A corrupt or foreign row is skipped, never a failure.
 */
export async function listAllRecordedDecisions(db: TraceDb, filter: { kind?: string; since?: string } = {}): Promise<RecordedDecisionRow[]> {
  const rows = await db
    .query<{ adw_id: string | null; phase_id: string | null; started_at: string | null; payload_json: string | null }, [string, string, string]>(
      "SELECT adw_id, phase_id, started_at, payload_json FROM events WHERE type=? AND name IN (?, ?) ORDER BY started_at, rowid",
    )
    .all("log", DECISION_EVENT, LEGACY_DECISION_EVENT);
  const sinceMs = filter.since === undefined ? null : Date.parse(filter.since);
  const out: RecordedDecisionRow[] = [];
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json ?? "");
    } catch {
      continue;
    }
    const decision = parseRecordedDecision(payload);
    if (!decision || (filter.kind !== undefined && decision.kind !== filter.kind)) continue;
    if (sinceMs !== null && row.started_at !== null) {
      const at = Date.parse(row.started_at);
      if (!Number.isNaN(at) && at < sinceMs) continue;
    }
    out.push({ adw_id: row.adw_id ?? "", phase_id: row.phase_id ?? "", started_at: row.started_at, decision });
  }
  return out;
}

/**
 * Session status, failed gates and phases for each run in `adwIds`.
 * `verdictAdwIds` (a subset) additionally resolves each phase's `verdict` —
 * a quality suite's logged `passed`, or a review envelope's `approved` —
 * which only the loop-control rule needs, so only those runs pay for it.
 */
export async function readRunFacts(db: TraceDb, adwIds: readonly string[], verdictAdwIds: ReadonlySet<string> = new Set()): Promise<Map<string, RunFacts>> {
  const facts = new Map<string, RunFacts>();
  for (const id of adwIds) facts.set(id, { adw_id: id, session: null, run_starts: [], open_phases: [], kills: [], failed_gates: [], phases: [] });

  for (const s of await chunked(adwIds, (ph, ids) =>
    db.query<{ adw_id: string; status: string | null; ended_at: string | null }, string[]>(`SELECT adw_id, status, ended_at FROM sessions WHERE adw_id IN (${ph})`).all(...ids),
  )) {
    facts.get(s.adw_id)!.session = { status: s.status, ended_at: s.ended_at };
  }

  // One `adw` process row per run started under an adw_id (`session.ensure`): a revision or re-claim adds one.
  for (const r of await chunked(adwIds, (ph, ids) =>
    db.query<{ adw_id: string; started_at: string | null }, string[]>(`SELECT adw_id, started_at FROM processes WHERE kind = 'adw' AND adw_id IN (${ph})`).all(...ids),
  )) {
    facts.get(r.adw_id)!.run_starts.push(r.started_at);
  }

  // The `run_killed` marker the signal handler writes before anything can close a phase (`session.ts`).
  for (const k of await chunked(adwIds, (ph, ids) =>
    db.query<{ adw_id: string; started_at: string | null }, string[]>(`SELECT adw_id, started_at FROM events WHERE type = 'log' AND name = '${RUN_KILLED_EVENT}' AND adw_id IN (${ph})`).all(...ids),
  )) {
    facts.get(k.adw_id)!.kills.push(k.started_at);
  }

  for (const g of await chunked(adwIds, (ph, ids) =>
    db.query<{ adw_id: string; created_at: string | null }, string[]>(`SELECT adw_id, created_at FROM gate_results WHERE passed = 0 AND adw_id IN (${ph})`).all(...ids),
  )) {
    facts.get(g.adw_id)!.failed_gates.push({ created_at: g.created_at });
  }

  for (const p of await chunked(adwIds, (ph, ids) =>
    db
      .query<{ phase_id: string; adw_id: string; seq: number; name: string | null; started_at: string | null; ended_at: string | null }, string[]>(
        `SELECT phase_id, adw_id, seq, name, started_at, ended_at FROM phases WHERE adw_id IN (${ph}) ORDER BY seq, rowid`,
      )
      .all(...ids),
  )) {
    // The start-of-phase upsert has no `ended_at`; the end upsert sets it. A kill leaves it NULL.
    if (p.ended_at === null) facts.get(p.adw_id)!.open_phases.push(p.started_at);
    facts.get(p.adw_id)!.phases.push({ phase_id: p.phase_id, seq: p.seq, name: p.name ?? "", started_at: p.started_at, verdict: null });
  }

  const verdictIds = adwIds.filter((id) => verdictAdwIds.has(id));
  if (verdictIds.length > 0) {
    const verdicts = new Map<string, boolean>();
    // A quality suite phase logs `{passed: boolean, ...}` under its own phase_id.
    for (const e of await chunked(verdictIds, (ph, ids) =>
      db
        .query<{ phase_id: string | null; payload_json: string | null }, string[]>(
          `SELECT phase_id, payload_json FROM events WHERE type = 'log' AND payload_json LIKE '%"passed"%' AND adw_id IN (${ph}) ORDER BY rowid`,
        )
        .all(...ids),
    )) {
      try {
        const passed = (JSON.parse(e.payload_json ?? "") as { passed?: unknown }).passed;
        if (e.phase_id && typeof passed === "boolean") verdicts.set(e.phase_id, passed);
      } catch {
        // not a verdict
      }
    }
    // A review phase's envelope carries `approved`; the newest valid attempt wins.
    for (const e of await chunked(verdictIds, (ph, ids) =>
      db
        .query<{ phase_id: string | null; payload_json: string | null }, string[]>(
          `SELECT phase_id, payload_json FROM envelopes WHERE output_type = 'ReviewOutput' AND valid = 1 AND adw_id IN (${ph}) ORDER BY created_at, rowid`,
        )
        .all(...ids),
    )) {
      try {
        const approved = (JSON.parse(e.payload_json ?? "") as { approved?: unknown }).approved;
        if (e.phase_id && typeof approved === "boolean") verdicts.set(e.phase_id, approved);
      } catch {
        // not a verdict
      }
    }
    for (const id of verdictIds) {
      for (const p of facts.get(id)!.phases) p.verdict = verdicts.get(p.phase_id) ?? null;
    }
  }
  return facts;
}
