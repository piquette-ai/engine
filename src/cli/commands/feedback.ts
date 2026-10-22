/**
 * `spf feedback <adw_id> "text"` — record operator feedback on a finished (or
 * running) run as a first-class `feedback` trace event, tied to the run, its
 * chain(s) and a hash of its recorded prompt, so it survives prompt edits and
 * stays attributable to the version it critiqued. Evidence for the evolution
 * chain; it cannot be backfilled, so capture it as it happens.
 *
 * NOT the watch `<prefix>:feedback` label lane (PR revision) — that is an
 * issue-provider workflow; this is a trace annotation.
 *
 * The write goes through `Tracer.event`, the same path every other event
 * takes, so it works unchanged for both the sqlite and D1 trace backends.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { makeEventRecord } from "../../core/data_types.ts";
import { Tracer } from "../../core/tracer.ts";
import { engineerName, parseCli } from "../../core/utils.ts";
import { openTrace, resolveTrace } from "./trace.ts";

/** sha256 of the session's recorded request (sessions.request, which the tracer truncates to 500 chars) — null when none was recorded. */
export function promptHash(request: string | null | undefined): string | null {
  return request ? createHash("sha256").update(request).digest("hex") : null;
}

export async function feedbackCommand(argv: string[]): Promise<number> {
  const { positionals, options } = parseCli(argv, ["cwd", "config"]);
  const text = positionals.slice(1).join(" ").trim();
  if (positionals.length < 2 || !text) {
    console.error('usage: spf feedback <adw_id> "<text>" [--cwd <dir>] [--config <path>]');
    return 1;
  }
  const adwId = positionals[0];

  // Read side first: refuse feedback on a run that does not exist rather than
  // orphaning an event no `spf events` call would ever be asked for.
  const { db } = await openTrace(options);
  let session;
  try {
    session = await db.session(adwId);
  } finally {
    await db.close();
  }
  if (!session) {
    console.error(`no such run: ${adwId} (see \`spf sessions\`)`);
    return 1;
  }

  const { dataPaths } = resolveTrace(options);
  const tracer = await Tracer.open(dataPaths.db, path.join(dataPaths.sessions_dir, adwId, "events.jsonl"));
  try {
    const eventId = await tracer.event(
      makeEventRecord({
        adw_id: adwId,
        type: "feedback",
        name: "operator_feedback",
        payload: {
          text,
          chain: session.adw_name ?? null,
          prompt_hash: promptHash(session.request),
          operator: engineerName(),
        },
      }),
    );
    console.log(`recorded feedback ${eventId} on ${adwId}`);
    return 0;
  } finally {
    await tracer.close();
  }
}
