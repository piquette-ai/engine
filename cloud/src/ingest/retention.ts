/**
 * Retention: prune trace DETAIL of old sessions. Sessions, phases, agent
 * sessions, gate pass/fail, violations and factories are never deleted, and a
 * running session is untouched because its synced_at stays fresh. Invalid
 * input skips the sweep: it never falls back to a default.
 */
import type { D1Database, D1PreparedStatement } from "../env.ts";

export type Retention = { kind: "off" } | { kind: "days"; days: number } | { kind: "invalid" };

/** `"0"` disables; a non-negative integer is a day count; anything else is invalid. */
export function parseRetention(raw: string | undefined): Retention {
  const text = (raw ?? "").trim();
  if (!/^\d{1,5}$/.test(text)) return { kind: "invalid" };
  const days = Number(text);
  return days === 0 ? { kind: "off" } : { kind: "days", days };
}

export interface RetentionReport {
  sessions: number;
  eventsDeleted: number;
  promptsDeleted: number;
  skipped?: string;
}

const CHUNK = 200;
const PAIRS_PER_STATEMENT = 49;

export async function runRetention(db: D1Database, opts: { days: number; now: Date; maxChunks?: number }): Promise<RetentionReport> {
  const report: RetentionReport = { sessions: 0, eventsDeleted: 0, promptsDeleted: 0 };
  const cutoff = new Date(opts.now.getTime() - opts.days * 86_400_000).toISOString();
  const nowIso = opts.now.toISOString();
  for (let chunk = 0; chunk < (opts.maxChunks ?? 20); chunk++) {
    const { results } = await db
      .prepare(
        "SELECT factory_id, adw_id FROM sessions WHERE COALESCE(ended_at, synced_at) < ? AND (pruned_at IS NULL OR synced_at > pruned_at) ORDER BY COALESCE(ended_at, synced_at) LIMIT ?",
      )
      .bind(cutoff, CHUNK)
      .all<{ factory_id: string; adw_id: string }>();
    if (results.length === 0) break;
    const statements: D1PreparedStatement[] = [];
    const kinds: string[] = [];
    for (let i = 0; i < results.length; i += PAIRS_PER_STATEMENT) {
      const pairs = results.slice(i, i + PAIRS_PER_STATEMENT);
      const where = pairs.map(() => "(factory_id = ? AND adw_id = ?)").join(" OR ");
      const params = pairs.flatMap((p) => [p.factory_id, p.adw_id]);
      const add = (sql: string, kind: string, extra: unknown[] = []): void => {
        statements.push(db.prepare(sql).bind(...extra, ...params));
        kinds.push(kind);
      };
      add(`DELETE FROM events WHERE ${where}`, "events");
      add(`DELETE FROM prompts WHERE ${where}`, "prompts");
      add(`UPDATE envelopes SET payload_json = NULL WHERE ${where}`, "other");
      add(`UPDATE gate_results SET checks_json = NULL WHERE ${where}`, "other");
      add(`UPDATE sessions SET pruned_at = ? WHERE ${where}`, "other", [nowIso]);
    }
    const res = (await db.batch(statements)) as { meta?: { changes?: number } }[];
    res.forEach((r, i) => {
      const changes = r?.meta?.changes ?? 0;
      if (kinds[i] === "events") report.eventsDeleted += changes;
      else if (kinds[i] === "prompts") report.promptsDeleted += changes;
    });
    report.sessions += results.length;
    if (results.length < CHUNK) break;
  }
  return report;
}
