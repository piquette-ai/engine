/** The receipts module: the receipt routes over the R2 binding, readers only. */
import type { Hono } from "hono";
import { receiptRoutes, R2ReceiptReader } from "../../src/receipts/index.ts";
import { requireIdentity } from "./access.ts";
import type { CloudEnv } from "./env.ts";

export function mountReceipts(app: Hono<CloudEnv>): void {
  app.use("/api/receipts/*", requireIdentity());
  app.route(
    "/",
    receiptRoutes<CloudEnv>((c) => (c.env.RECEIPTS ? new R2ReceiptReader(c.env.RECEIPTS, { prefix: c.env.RECEIPTS_PREFIX ?? "" }) : null)),
  );
}
