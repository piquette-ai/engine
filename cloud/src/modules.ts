/**
 * The module registry and the app builder. One Worker, several modules
 * (receipts, ingest, dashboard), switched on by `SPF_MODULES`. An enabled
 * module whose binding is missing answers 503 on its own routes and never
 * falls through to another handler.
 */
import { Hono, type Context, type ExecutionContext } from "hono";
import { stripBase } from "../../src/receipts/index.ts";
import pkg from "../../package.json" with { type: "json" };
import { requireAnyAccess, requireIdentity, requireServiceToken } from "./access.ts";
import { assetHandler } from "./assets.ts";
import type { CloudBindings, CloudEnv } from "./env.ts";
import { mountIngest } from "./ingest/routes.ts";
import { mountDashboard } from "./dashboard.ts";
import { mountReceipts } from "./receipts.ts";

export { enabledModules, type CloudModuleName } from "./module_names.ts";
import { enabledModules, type CloudModuleName } from "./module_names.ts";
const KNOWN: readonly CloudModuleName[] = ["receipts", "ingest", "dashboard"];

interface ModuleDef {
  /** Routes this module owns, answered 503 when it is enabled but cannot run. */
  paths: string[];
  /** Who may even learn the module is unavailable: the same gate its routes sit behind. */
  gate(): ReturnType<typeof requireIdentity>;
  hasBinding(env: CloudBindings): boolean;
  /** Absent until the module lands in the Worker: it then answers 503 like a missing binding. */
  mount?(app: Hono<CloudEnv>): void;
}

const MODULES: Record<CloudModuleName, ModuleDef> = {
  receipts: { gate: requireIdentity, paths: ["/api/receipts", "/api/receipts/*"], hasBinding: (e) => !!e.RECEIPTS, mount: mountReceipts },
  ingest: { gate: requireServiceToken, paths: ["/ingest", "/ingest/*"], hasBinding: (e) => !!e.DB, mount: mountIngest },
  dashboard: { gate: requireIdentity, paths: ["/api", "/api/*"], hasBinding: (e) => !!e.DB, mount: mountDashboard },
};

const ready = (name: CloudModuleName, env: CloudBindings): boolean => MODULES[name].hasBinding(env) && !!MODULES[name].mount;

export type ModuleState = "ok" | "missing_binding" | "off";

export function moduleStates(env: CloudBindings): Record<CloudModuleName, ModuleState> {
  const on = enabledModules(env);
  return Object.fromEntries(KNOWN.map((n) => [n, !on.has(n) ? "off" : ready(n, env) ? "ok" : "missing_binding"])) as Record<CloudModuleName, ModuleState>;
}

/** The app: base-path strip, status, modules, /api 404, assets. Returns the outer app that does the strip. */
export function createCloudApp(env: CloudBindings): Hono<CloudEnv> {
  const enabled = enabledModules(env);
  const inner = new Hono<CloudEnv>();

  inner.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "private, no-store");
  });

  inner.get("/_spf/status", requireAnyAccess(), (c) => c.json({ version: pkg.version, modules: moduleStates(c.env) }, 200, { "cache-control": "private, no-store" }));

  for (const name of KNOWN) {
    if (!enabled.has(name)) continue;
    const def = MODULES[name];
    // The dashboard owns /api/* and serves the receipt routes itself: mounting them here too would register them twice.
    if (name === "receipts" && enabled.has("dashboard") && ready("dashboard", env) && ready("receipts", env)) continue;
    if (ready(name, env)) def.mount?.(inner);
    else {
      const unavailable = async (c: Context<CloudEnv>) => c.json({ error: "module_unavailable", module: name }, 503);
      for (const p of def.paths) inner.all(p, def.gate(), unavailable);
    }
  }

  // Before the asset handler, so an /api miss is JSON and never the SPA shell.
  inner.all("/api/*", requireIdentity(), (c) => c.json({ error: `no route ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));
  inner.get("*", requireIdentity(), assetHandler(enabled));
  inner.onError((error, c) => {
    console.error(`cloud: ${error.message}`);
    return c.json({ error: "internal error" }, 500);
  });

  const app = new Hono<CloudEnv>();
  app.all("*", (c) => {
    const url = new URL(c.req.url);
    const base = c.env.BASE_PATH || "/";
    if (base !== "/" && url.pathname === base) return c.redirect(`${base}/${url.search}`, 308);
    const stripped = stripBase(url.pathname, base);
    if (stripped === null) return c.text("not found\n", 404);
    const next = new URL(url);
    next.pathname = stripped;
    let ctx: ExecutionContext | undefined;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = undefined;
    }
    return inner.fetch(new Request(next, c.req.raw), c.env, ctx);
  });
  return app;
}
