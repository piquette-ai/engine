/**
 * SPF dashboard API over a `TraceReader`, plus the SPA through an injected
 * static handler. Node-free: `spf ui` supplies a local sqlite reader and a
 * filesystem `serveStatic` (see `serve.ts`); the cloud app supplies a D1
 * reader and Workers static assets. Reads are read-only; the one write is
 * review state (archive), through `setArchived`, which never touches
 * anything a tracer or a sync wrote.
 *
 * There is no ingest endpoint here and no websocket: the UI polls.
 *
 * Two deliberate behavior changes from the original Bun app: a GET to the
 * archive route 404s as JSON (it used to fall through to the SPA), and route
 * params are not decoded twice (Hono already decodes them).
 */
import { Hono, type Context, type Env } from "hono";
import { receiptRoutes } from "./receipt_routes.ts";
import type { ReceiptReader } from "./receipt_reader.ts";
import { AmbiguousSession, BadFilter, isSafeSegment, type SessionSel, type TraceReader } from "./trace_reader.ts";
import type { ApiError, HealthResponse } from "../shared/types.ts";

function intQueryParam(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface AppDeps<E extends Env = Env> {
  reader(c: Context<E>): TraceReader;
  /** The receipt store, or null for "no receipt store" (404). Omit for none. */
  receipts?(c: Context<E>): ReceiptReader | null;
  /** Everything that is not `/api/*`: the SPA and its assets. */
  static(c: Context<E>): Response | Promise<Response>;
  info?: { project?: string; repo?: string };
  /** Answer 500s with a generic message and keep the detail in the log: set on an internet-facing host. */
  genericErrors?: boolean;
}

export function createApp<E extends Env = Env>(deps: AppDeps<E>): Hono<E> {
  const app = new Hono<E>();
  const info = deps.info ?? {};
  const selOf = (c: Context<E>): SessionSel => {
    const factory = c.req.query("factory");
    return factory ? { factory } : {};
  };
  const err = (c: Context<E>, error: string, status: 400 | 404) => c.json({ error } satisfies ApiError, status);

  app.use("/api/*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });

  app.get("/api/health", async (c) => {
    const reader = deps.reader(c);
    const hosted = reader.mode === "hosted" ? await reader.hostedHealth?.() : undefined;
    return c.json({
      ok: true,
      db: reader.label,
      journal_mode: reader.journalMode,
      sessions: await reader.sessionCount(),
      mode: reader.mode,
      ...(info.project ? { project: info.project } : {}),
      ...(info.repo ? { repo: info.repo } : {}),
      ...(hosted ? { repos: hosted.repos, factories: hosted.factories } : {}),
    } satisfies HealthResponse);
  });

  app.get("/api/sessions", async (c) =>
    c.json(
      await deps.reader(c).sessions(intQueryParam(c.req.query("limit"), 200), {
        repos: c.req.queries("repo") ?? [],
        factories: c.req.queries("factory") ?? [],
      }),
    ),
  );

  app.get("/api/sessions/:adw_id", async (c) => {
    const adwId = c.req.param("adw_id");
    const detail = await deps.reader(c).sessionDetail(adwId, selOf(c));
    if (!detail) return err(c, `no session ${adwId}`, 404);
    return c.json(detail);
  });

  // Archiving is review triage: it belongs to the reader, not to the run.
  async function archive(c: Context<E>, adwId: string, factory: string | undefined, archivedRaw: unknown) {
    if (!isSafeSegment(adwId)) return err(c, "invalid adw_id", 400);
    const archived = archivedRaw === undefined ? true : Boolean(archivedRaw);
    if (!(await deps.reader(c).setArchived(adwId, archived, factory ? { factory } : {}))) return err(c, `no session ${adwId}`, 404);
    return c.json({ adw_id: adwId, archived });
  }

  app.post("/api/sessions/:adw_id/archive", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { archived?: unknown };
    return archive(c, c.req.param("adw_id"), selOf(c).factory, body.archived);
  });

  // The hosted UI's archive write (#210): the run is named in the body, with its factory.
  app.post("/api/reviews", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { adw_id?: unknown; factory_id?: unknown; archived?: unknown } | null;
    if (!body || typeof body.adw_id !== "string") return err(c, "adw_id is required", 400);
    if (body.factory_id !== undefined && body.factory_id !== null && typeof body.factory_id !== "string") return err(c, "factory_id must be a string or null", 400);
    return archive(c, body.adw_id, typeof body.factory_id === "string" && body.factory_id ? body.factory_id : undefined, body.archived);
  });

  app.get("/api/sessions/:adw_id/events", async (c) =>
    c.json(await deps.reader(c).events(c.req.param("adw_id"), intQueryParam(c.req.query("after"), 0), intQueryParam(c.req.query("limit"), 500), selOf(c))),
  );

  app.get("/api/sessions/:adw_id/envelopes", async (c) => c.json(await deps.reader(c).envelopes(c.req.param("adw_id"), selOf(c))));

  app.get("/api/sessions/:adw_id/gates", async (c) => c.json(await deps.reader(c).gates(c.req.param("adw_id"), selOf(c))));

  // The exact prompts an agent was sent. Absent reads as null, not an error.
  app.get("/api/sessions/:adw_id/agents/:agent/prompts", async (c) => {
    const adwId = c.req.param("adw_id");
    const agent = c.req.param("agent");
    if (!isSafeSegment(adwId) || !isSafeSegment(agent)) return err(c, "invalid adw_id or agent", 400);
    const reader = deps.reader(c);
    if (!(await reader.session(adwId, selOf(c)))) return err(c, `no session ${adwId}`, 404);
    return c.json(await reader.prompts(adwId, agent, selOf(c)));
  });

  // Receipts viewer (#202), shared with the microsite and the hub. A null reader answers 404 "no receipt store".
  app.route("/", receiptRoutes<E>((c) => deps.receipts?.(c) ?? null));

  // After every real /api/* route: a miss under /api/ is a 404, never the SPA fallback.
  app.all("/api/*", (c) => c.json({ error: `no route ${c.req.path}` } satisfies ApiError, 404));

  app.get("*", (c) => deps.static(c));

  app.onError((error, c) => {
    if (error instanceof AmbiguousSession) return c.json({ error: error.message, candidates: error.candidates }, 409);
    if (error instanceof BadFilter) return c.json({ error: error.message } satisfies ApiError, 400);
    console.error(`[spf] ${c.req.method} ${c.req.path}:`, error);
    return c.json({ error: deps.genericErrors ? "internal error" : error.message } satisfies ApiError, 500);
  });

  return app;
}
