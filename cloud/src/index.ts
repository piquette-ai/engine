/**
 * The piquette cloud app: one Worker, one deploy. Modules (receipts, ingest,
 * dashboard) are switched on by PIQUETTE_MODULES; all of them sit behind
 * Cloudflare Access, the only auth path.
 */
import type { ExecutionContext } from "hono";
import { createCloudApp, enabledModules } from "./modules.ts";
import type { CloudBindings } from "./env.ts";
import { parseRetention, runRetention } from "./ingest/retention.ts";

export default {
  fetch(request: Request, env: CloudBindings, ctx: ExecutionContext): Response | Promise<Response> {
    return createCloudApp(env).fetch(request, env, ctx);
  },
  /** Daily cron: the retention sweep. Only when ingest is enabled and bound; invalid settings skip it, never default. */
  async scheduled(_controller: unknown, env: CloudBindings): Promise<void> {
    if (!enabledModules(env).has("ingest") || !env.DB) return;
    const retention = parseRetention(env.RETENTION_DAYS);
    if (retention.kind === "invalid") {
      console.warn("retention: RETENTION_DAYS is not a non-negative integer: sweep skipped");
      return;
    }
    if (retention.kind === "off") return;
    const report = await runRetention(env.DB, { days: retention.days, now: new Date() });
    console.log(`retention: sessions=${report.sessions} events=${report.eventsDeleted} prompts=${report.promptsDeleted}`);
  },
};
