/** Batch builders and credential seeding for the ingest tests. Contract-shaped, hand-built. */
import { SYNC_SCHEMA_VERSION, type SyncBatch, type SyncLevel } from "../../src/core/sync/contract.ts";

export const FACTORY_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const FACTORY_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const SVC_A = "svc-factory-a.access";
export const SVC_B = "svc-factory-b.access";

export interface BatchOpts {
  factory?: string;
  repo?: string;
  adw?: string;
  level?: SyncLevel;
  sentAt?: string;
  status?: string;
  request?: string | null;
  snapshot?: boolean;
  events?: number;
  eventType?: string;
  eventName?: string;
  gates?: number;
  endedAt?: string | null;
  tokens?: number;
  eventBase?: number;
  prompts?: boolean;
  envelopePayload?: string | null;
  /** Overrides the derived gate local_id base (local ids come from each repo's own database, so they collide across repos). */
  gateBase?: number;
  /** The run's issue/PR links, spread into the session row. Absent = an older factory's row, which carries no link keys at all. */
  links?: { issue_label?: string | null; issue_url?: string | null; pr_label?: string | null; pr_url?: string | null };
}

/** Default gate ids are derived from the session id so unrelated tests never collide. Real local ids are per trace database (autoincrement), so they DO repeat across repos of one factory: pass `gateBase` to model that. They also repeat across two checkouts of one repo with separate data dirs, which the key cannot tell apart (see the design doc, 'Known limits'). */
const gateBase = (adw: string): number => [...adw].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 100_000, 7) * 1000;

export function makeBatch(o: BatchOpts = {}): SyncBatch {
  const factory_id = o.factory ?? FACTORY_A;
  const adw = o.adw ?? "adw-1";
  const events = Array.from({ length: o.events ?? 2 }, (_, i) => ({
    factory_id,
    event_id: `${adw}-e${(o.eventBase ?? 0) + i}`,
    local_rowid: (o.eventBase ?? 0) + i + 1,
    adw_id: adw,
    phase_id: `${adw}-p1`,
    parent_id: null,
    type: o.eventType ?? "tool",
    name: o.eventName ?? "bash",
    payload_json: JSON.stringify({ n: i }),
    tokens: 10,
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:01.000Z",
  }));
  const gate_results = Array.from({ length: o.gates ?? 1 }, (_, i) => ({
    factory_id,
    local_id: (o.gateBase ?? gateBase(adw)) + i + 1,
    adw_id: adw,
    phase_id: `${adw}-p1`,
    attempt: 1,
    gate: "plan_gate",
    passed: 1,
    violations_json: "[]",
    checks_json: JSON.stringify([{ item: "x", ok: true }]),
    created_at: "2026-01-01T00:05:00+00:00",
  }));
  const snapshot =
    o.snapshot === false
      ? undefined
      : {
          session: {
            factory_id,
            adw_id: adw,
            adw_name: adw,
            request: o.request === undefined ? "do the thing" : o.request,
            status: o.status ?? "completed",
            engineer: "tester",
            started_at: "2026-01-01T00:00:00.000Z",
            ended_at: o.endedAt === undefined ? "2026-01-01T01:00:00.000Z" : o.endedAt,
            total_tokens: o.tokens ?? 100,
            total_cost: 0.5,
            billable_tokens: 90,
            ...(o.links ?? {}),
          },
          phases: [
            { factory_id, phase_id: `${adw}-p1`, adw_id: adw, seq: 1, name: "plan", kind: "agent", owner: "planner", description: null, status: "completed", attempt: 1, retries: 0, error: (o.level ?? "trace") === "summary" ? null : "ERR-DETAIL", started_at: null, ended_at: null },
          ],
          agent_sessions: [{ factory_id, adw_id: adw, agent: "planner", coding_agent: "claude", model: "m", color: null, session_id: null, context_tokens: 1, context_window: 2, created_at: null, last_used_at: null }],
          envelopes: [{ factory_id, envelope_id: `${adw}-env1`, adw_id: adw, phase_id: `${adw}-p1`, agent: "planner", output_type: "plan", payload_json: o.envelopePayload === undefined ? JSON.stringify({ plan: "p" }) : o.envelopePayload, valid: 1, attempt: 1, created_at: null }],
          prompts: o.prompts ? [{ factory_id, adw_id: adw, agent: "planner", system: "SYSTEM-PROMPT", user: "USER-PROMPT" }] : [],
        };
  return {
    sync_schema: SYNC_SCHEMA_VERSION,
    spf_version: "9.9.9",
    level: o.level ?? "trace",
    batch_id: "b".repeat(64),
    sent_at: o.sentAt ?? "2026-01-02T00:00:00.000Z",
    factory: { factory_id, name: "laptop", repo: o.repo ?? "Example.com/Acme/API" },
    sessions: [{ adw_id: adw, ...(snapshot ? { snapshot } : {}), events, gate_results }],
  };
}

/** Maps service-token common names to tenants (the hub's credential table). */
export async function seedCredentials(db: any, rows: { cn: string; tenant: string; factory?: string | null }[]): Promise<void> {
  for (const r of rows) await db.prepare("INSERT INTO factory_credentials (common_name, tenant, factory_id, created_at) VALUES (?, ?, ?, ?)").bind(r.cn, r.tenant, r.factory ?? null, "2026-01-01").run();
}

export const count = async (db: any, table: string, where = "1=1", ...params: unknown[]): Promise<number> =>
  ((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...params).first()) as { n: number }).n;
