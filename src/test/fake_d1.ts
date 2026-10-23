/**
 * A fake Cloudflare D1 HTTP API shared by the trace-db and sync tests: a real
 * `node:sqlite` engine behind a mocked `fetch`, so SQL is actually parsed and
 * D1's 100-bound-parameter cap is actually enforced.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * D1's real HTTP `/query` endpoint rejects any single statement bound with
 * more than 100 parameters. `chunked()` (`ui/server/db.ts`) exists solely to
 * keep every `IN (...)` lookup under that cap — a test that never enforces
 * the cap can't tell a correctly-chunked query from one that just shoved all
 * N ids into a single unbounded bind, so `sqliteBackedFetch` below enforces
 * it too, the same way the real API would.
 */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * A `fetch` stand-in that answers D1's HTTP `/query` contract (single
 * `{sql,params}` or `{batch:[{sql},...]}`, each answered with `results`/
 * `meta`) by actually running the SQL against `memDb` — never a real network
 * call, but a real SQLite engine underneath, so an invalid statement (a
 * shredded `CREATE TABLE`, a bad `ALTER`) throws exactly like it would
 * against the real D1 HTTP API instead of silently "succeeding" against a
 * mock that never parses SQL at all. Also enforces D1's real >100-bound-
 * param cap per statement (see `D1_MAX_BOUND_PARAMS`), which a mock that
 * merely echoes back whatever the caller sends would never catch.
 */
export function sqliteBackedFetch(memDb: DatabaseSync): typeof fetch {
  const runOne = (sql: string, params: unknown[] = []): { success: true; results: unknown[]; meta: { changes: number; last_row_id: number } } => {
    if (params.length > D1_MAX_BOUND_PARAMS) {
      throw new D1ParamLimitError(
        `too many SQL variables: ${params.length} bound parameters exceeds D1's limit of ${D1_MAX_BOUND_PARAMS}`,
      );
    }
    const stmt = memDb.prepare(sql);
    const boundParams = params as SQLInputValue[];
    if (/^\s*(select|pragma)/i.test(sql)) {
      const results = stmt.all(...boundParams) as unknown[];
      return { success: true, results, meta: { changes: 0, last_row_id: 0 } };
    }
    const info = stmt.run(...boundParams);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  };

  return (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    try {
      const result = Array.isArray(body.batch)
        ? body.batch.map((s: { sql: string }) => runOne(s.sql))
        : [runOne(body.sql, body.params ?? [])];
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });
    } catch (error) {
      if (error instanceof D1ParamLimitError) {
        // Mirrors the real D1 HTTP API's shape for a rejected statement: a
        // 400 with `success:false` and an `errors[]` entry — not a thrown
        // network error — so `D1TraceDb.post`'s ordinary "D1 HTTP 400: ..."
        // error path is what a caller actually sees, same as production.
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 7500, message: error.message }], messages: [], result: [] }),
          { status: 400 },
        );
      }
      throw error;
    }
  }) as typeof fetch;
}

export class D1ParamLimitError extends Error {}
