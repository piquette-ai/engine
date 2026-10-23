import { parseCli } from "../../core/utils.ts";
import { openTrace } from "./trace.ts";
import { isInteractive } from "../ask.ts";

export async function sessionsCommand(argv: string[]): Promise<number> {
  const { options, flags } = parseCli(argv, ["cwd", "config", "limit"], ["json"]);
  let limit = 20;
  const rawLimit = options["limit"];
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit) || Number.parseInt(rawLimit, 10) < 1) {
      console.error(`--limit must be a positive integer, got "${rawLimit}"`);
      return 1;
    }
    limit = Number.parseInt(rawLimit, 10);
  }
  const { db } = await openTrace(options);
  const rows = await db.sessions(limit);

  if (flags["json"]) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log("no sessions yet");
    return 0;
  }
  const table = rows.map((s) => [s.adw_id, s.status ?? "", s.started_at ?? "", (s.request ?? "").slice(0, 60)]);
  if (isInteractive()) {
    const { renderTable } = await import("../ui/reports.tsx");
    await renderTable(table);
  } else {
    for (const [adwId, status, startedAt, request] of table) {
      console.log(`${adwId}  ${status.padEnd(8)}  ${startedAt}  ${request}`);
    }
  }
  return 0;
}
