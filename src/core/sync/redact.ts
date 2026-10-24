/**
 * Egress tiers for `spf sync` (#135), FAIL-CLOSED: every row below is built
 * field by field from an allowlist — never by deleting fields from a raw row —
 * so a column or payload key nobody thought about can only fail to leave, never
 * leak. The `trace` tier reuses `core/otel.ts`'s numbers-only allowlist
 * (`usageNumbersOnly`, `toolSpanName`); see the design doc §4.2.
 *
 *   summary  sessions (no request), phases (no error), agent_sessions, gate
 *            pass/fail + violated items (notes dropped; checks reduced to item/ok). No events,
 *            envelopes or prompts.
 *   trace    + request, envelope metadata (never contents), events whose
 *            payload is token/cost numbers only and whose name is a fixed
 *            vocabulary word (or a tool's own name).
 *   full     everything, each field capped at MAX_FIELD_BYTES, + prompt files.
 *
 * `scrubSecrets` then runs at EVERY level as the last step: a credential that
 * somehow reached a free-text field (a pasted token in a request, a log line)
 * is replaced even at `full`.
 */
import { resolveObservabilityDb, type SFConfig } from "../data_types.ts";
import { toolSpanName, usageNumbersOnly } from "../otel.ts";
import {
  MAX_FIELD_BYTES,
  type SyncAgentSessionRow,
  type SyncEnvelopeRow,
  type SyncEventRow,
  type SyncGateRow,
  type SyncLevel,
  type SyncPhaseRow,
  type SyncPromptRow,
  type SyncSessionEntry,
  type SyncSessionRow,
  type SyncSnapshot,
} from "./contract.ts";

const NAME_KEPT_TYPES = new Set(["phase_start", "phase_end", "gate_pass", "gate_fail", "agent_start", "agent_end", "handoff", "error"]);
const TYPE_RE = /^[a-z_]{1,40}$/;

const clip = (s: string | null, n: number): string | null => (s === null ? null : s.slice(0, n));

/** `full` only: a field past MAX_FIELD_BYTES is replaced by a marker saying how big it was. */
function cap(s: string | null, level: SyncLevel): string | null {
  if (s === null || level !== "full") return s;
  const bytes = Buffer.byteLength(s);
  return bytes > MAX_FIELD_BYTES ? JSON.stringify({ _spf_truncated: bytes }) : s;
}

/** `[{item, ok, note}]` -> `[{item, ok}]`: WHAT a gate verified, never its notes (which quote code and output). */
function checksItemOk(json: string | null): string | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;
    return JSON.stringify(
      parsed.map((c) => {
        const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
        return { item: String(o["item"] ?? "").slice(0, 200), ok: Boolean(o["ok"]) };
      }),
    );
  } catch {
    return null;
  }
}

/** `["item: note"]` -> `["item"]`: a violation's note quotes the agent's claim and command output, like a check's note. */
function violationItems(json: string | null): string | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;
    return JSON.stringify(
      parsed.map((x) => {
        const s = String(x);
        const at = s.indexOf(": ");
        // no `item: note` shape (a legacy gate's free text): nothing safe to keep
        return at === -1 ? "(unspecified)" : s.slice(0, at).slice(0, 200);
      }),
    );
  } catch {
    return null;
  }
}

function eventAtTrace(e: SyncEventRow): SyncEventRow {
  let payload: unknown = null;
  try {
    payload = e.payload_json === null ? null : JSON.parse(e.payload_json);
  } catch {
    // an unparseable payload carries no allowlisted numbers
  }
  const usage = usageNumbersOnly(payload);
  const type = e.type !== null && TYPE_RE.test(e.type) ? e.type : "unknown";
  let name: string | null = null;
  if (NAME_KEPT_TYPES.has(type)) name = clip(e.name, 200);
  else if (type === "tool_call") name = toolSpanName(e.name);
  // log, feedback and any unknown type: null — their names are free text
  return {
    factory_id: e.factory_id,
    event_id: e.event_id,
    local_rowid: e.local_rowid,
    adw_id: e.adw_id,
    phase_id: e.phase_id,
    parent_id: e.parent_id,
    type,
    name,
    payload_json: usage ? JSON.stringify(usage) : null,
    tokens: e.tokens,
    started_at: e.started_at,
    ended_at: e.ended_at,
  };
}

function sessionRow(r: SyncSessionRow, level: SyncLevel): SyncSessionRow {
  return {
    factory_id: r.factory_id,
    adw_id: r.adw_id,
    adw_name: r.adw_name,
    request: level === "summary" ? null : cap(r.request, level),
    status: r.status,
    engineer: r.engineer,
    started_at: r.started_at,
    ended_at: r.ended_at,
    total_tokens: r.total_tokens,
    total_cost: r.total_cost,
    billable_tokens: r.billable_tokens,
    // A label and an http(s) URL, at every level: where the run's work is
    // tracked, never what it says (no issue title or body crosses).
    issue_label: r.issue_label ?? null,
    issue_url: r.issue_url ?? null,
    pr_label: r.pr_label ?? null,
    pr_url: r.pr_url ?? null,
  };
}

function phaseRow(r: SyncPhaseRow, level: SyncLevel): SyncPhaseRow {
  return {
    factory_id: r.factory_id,
    phase_id: r.phase_id,
    adw_id: r.adw_id,
    seq: r.seq,
    name: r.name,
    kind: r.kind,
    owner: r.owner,
    description: r.description,
    status: r.status,
    attempt: r.attempt,
    retries: r.retries,
    error: level === "full" ? cap(r.error, level) : null,
    started_at: r.started_at,
    ended_at: r.ended_at,
  };
}

function agentSessionRow(r: SyncAgentSessionRow): SyncAgentSessionRow {
  return {
    factory_id: r.factory_id,
    adw_id: r.adw_id,
    agent: r.agent,
    coding_agent: r.coding_agent,
    model: r.model,
    color: r.color,
    session_id: r.session_id,
    context_tokens: r.context_tokens,
    context_window: r.context_window,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
  };
}

function envelopeRow(r: SyncEnvelopeRow, level: SyncLevel): SyncEnvelopeRow {
  return {
    factory_id: r.factory_id,
    envelope_id: r.envelope_id,
    adw_id: r.adw_id,
    phase_id: r.phase_id,
    agent: r.agent,
    output_type: r.output_type,
    payload_json: level === "full" ? cap(r.payload_json, level) : null,
    valid: r.valid,
    attempt: r.attempt,
    created_at: r.created_at,
  };
}

function gateRow(r: SyncGateRow, level: SyncLevel): SyncGateRow {
  return {
    factory_id: r.factory_id,
    local_id: r.local_id,
    adw_id: r.adw_id,
    phase_id: r.phase_id,
    attempt: r.attempt,
    gate: r.gate,
    passed: r.passed,
    violations_json: level === "full" ? cap(r.violations_json, level) : violationItems(r.violations_json),
    checks_json: level === "full" ? cap(r.checks_json, level) : checksItemOk(r.checks_json),
    created_at: r.created_at,
  };
}

function promptRow(r: SyncPromptRow, level: SyncLevel): SyncPromptRow {
  return { factory_id: r.factory_id, adw_id: r.adw_id, agent: r.agent, system: cap(r.system, level), user: cap(r.user, level) };
}

function eventRow(r: SyncEventRow, level: SyncLevel): SyncEventRow {
  return {
    factory_id: r.factory_id,
    event_id: r.event_id,
    local_rowid: r.local_rowid,
    adw_id: r.adw_id,
    phase_id: r.phase_id,
    parent_id: r.parent_id,
    type: r.type,
    name: cap(r.name, level),
    payload_json: cap(r.payload_json, level),
    tokens: r.tokens,
    started_at: r.started_at,
    ended_at: r.ended_at,
  };
}

function snapshotAt(level: SyncLevel, s: SyncSnapshot): SyncSnapshot {
  return {
    session: sessionRow(s.session, level),
    phases: s.phases.map((r) => phaseRow(r, level)),
    agent_sessions: s.agent_sessions.map(agentSessionRow),
    envelopes: level === "summary" ? [] : s.envelopes.map((r) => envelopeRow(r, level)),
    prompts: level === "full" ? s.prompts.map((r) => promptRow(r, level)) : [],
  };
}

export function applyLevel(level: SyncLevel, entry: SyncSessionEntry): SyncSessionEntry {
  return {
    adw_id: entry.adw_id,
    ...(entry.snapshot ? { snapshot: snapshotAt(level, entry.snapshot) } : {}),
    events: level === "summary" ? [] : entry.events.map((e) => (level === "trace" ? eventAtTrace(e) : eventRow(e, level))),
    gate_results: entry.gate_results.map((g) => gateRow(g, level)),
  };
}

const SECRET_KEY_RE = /(TOKEN|SECRET|PASSWORD|API_KEY|_KEY$|CREDENTIAL)/i;
const MIN_SECRET_LENGTH = 8;

/** Values worth scrubbing: the sync credentials, the D1 API token, and anything in the environment that looks like a secret. */
export function collectSecrets(cfg: Pick<SFConfig, "sync" | "observability">): string[] {
  const names = new Set<string>([cfg.sync?.client_id_env ?? "SPF_SYNC_CLIENT_ID", cfg.sync?.client_secret_env ?? "SPF_SYNC_CLIENT_SECRET"]);
  try {
    const db = resolveObservabilityDb(cfg.observability.db);
    if (db.kind === "d1") names.add(db.api_token_env);
  } catch {
    // an unresolvable db config has no token to name
  }
  const values = new Set<string>();
  for (const name of names) {
    const value = (process.env[name] ?? "").trim();
    if (value) values.add(value);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value && SECRET_KEY_RE.test(key)) values.add(value.trim());
  }
  return [...values].filter((s) => s.length >= MIN_SECRET_LENGTH);
}

/** Replace each secret — raw, and as it appears inside a JSON string — with `[redacted]` in every string of `entry`. */
export function scrubSecrets<T>(entry: T, secrets: string[]): T {
  const needles = [...new Set(secrets.filter((s) => s.length >= MIN_SECRET_LENGTH).flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]))];
  if (needles.length === 0) return entry;
  // longest first, so a secret that contains another is replaced whole
  needles.sort((a, b) => b.length - a.length);
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const n of needles) if (out.includes(n)) out = out.split(n).join("[redacted]");
      return out;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(entry) as T;
}
