/**
 * The dashboard module: the shared API route table over the synced D1,
 * scoped to the signed-in reader's tenants, plus the SPA. It owns `/api/*`,
 * so with the dashboard on the receipt routes come from `createApp` and the
 * receipts module does not mount them a second time.
 */
import type { Hono } from "hono";
import { createApp } from "../../src/ui/server/app.ts";
import { D1TraceReader } from "../../src/ui/server/trace_reader_d1.ts";
import { R2ReceiptReader } from "../../src/receipts/index.ts";
import { requireIdentity } from "./access.ts";
import { assetHandler } from "./assets.ts";
import type { CloudEnv } from "./env.ts";
import { enabledModules } from "./module_names.ts";
import { ScopedReceiptReader, tenantSegments } from "./receipt_scope.ts";
import { requireTenants } from "./tenants.ts";

export function mountDashboard(app: Hono<CloudEnv>): void {
  // Identity for everything below (a service token is never a reader), and a tenant for every trace route.
  // Receipts follow RECEIPTS_VISIBILITY: `tenant` scopes them to the repos the reader's tenants synced; the
  // default `perimeter` serves them to any Access identity, so a PR's evidence link works before its repo syncs.
  // The SPA shell and its assets carry no data.
  app.use("*", requireIdentity());
  for (const p of ["/api/health", "/api/sessions", "/api/sessions/*", "/api/reviews"]) app.use(p, requireTenants());
  const tenantReceipts = requireTenants();
  app.use("/api/receipts/*", (c, next) => (tenantScoped(c.env) ? tenantReceipts(c, next) : next()));

  app.route(
    "/",
    createApp<CloudEnv>({
      reader: (c) => new D1TraceReader(c.env.DB!, { tenants: c.get("tenants") ?? [], actor: c.get("access")?.email }),
      receipts: (c) => {
        if (!enabledModules(c.env).has("receipts") || !c.env.RECEIPTS) return null;
        const reader = new R2ReceiptReader(c.env.RECEIPTS, { prefix: c.env.RECEIPTS_PREFIX ?? "" });
        if (!tenantScoped(c.env)) return reader;
        const db = c.env.DB!;
        const tenants = c.get("tenants") ?? [];
        return new ScopedReceiptReader(reader, () => tenantSegments(db, tenants));
      },
      static: (c) => assetHandler(enabledModules(c.env))(c),
      genericErrors: true,
    }),
  );
}

const tenantScoped = (env: CloudEnv["Bindings"]): boolean => env.RECEIPTS_VISIBILITY === "tenant";
