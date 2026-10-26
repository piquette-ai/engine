import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { run198, signToken, startSite } from "./harness.ts";

async function withSite<T>(opts: Record<string, string>, fn: (site: Awaited<ReturnType<typeof startSite>>) => Promise<T>): Promise<T> {
  const site = await startSite(opts);
  try {
    return await fn(site);
  } finally {
    await site.dispose();
  }
}

describe("modules", () => {
  test("unavailable modules answer 401 to an unauthenticated caller, not 503", async () => {
    await withSite({ PIQUETTE_MODULES: "receipts,ingest,dashboard" }, async (site) => {
      for (const p of ["/api/sessions", "/ingest/v1"]) {
        const res = await site.fetch(p, { token: null });
        assert.equal(res.status, 401, p);
        assert.doesNotMatch(await res.text(), /module_unavailable/);
      }
    });
  });

  test("receipts-only: an html miss outside /r is 404, not the SPA shell", async () => {
    await withSite({ PIQUETTE_MODULES: "receipts" }, async (site) => {
      for (const p of ["/nope.html", "/"]) {
        const res = await site.fetch(p);
        assert.equal(res.status, 404, p);
        assert.doesNotMatch(await res.text(), /<html/i);
      }
    });
  });

  test("receipts off: its routes and shell are 404, status says off", async () => {
    await withSite({ PIQUETTE_MODULES: "dashboard,ingest" }, async (site) => {
      await site.seed(run198());
      for (const p of ["/api/receipts/issue-198", "/r/issue-198"]) {
        const res = await site.fetch(p);
        assert.equal(res.status, p.startsWith("/api") ? 503 : 404, p);
        assert.doesNotMatch(await res.text(), /PIQUETTE-FIXTURE-MARKER|attempt/);
      }
      const status = (await (await site.fetch("/_piquette/status")).json()) as { modules: Record<string, string> };
      assert.equal(status.modules.receipts, "off");
    });
    await withSite({ PIQUETTE_MODULES: "" }, async (site) => {
      for (const p of ["/api/receipts/issue-198", "/r/issue-198", "/"]) {
        const res = await site.fetch(p);
        assert.equal(res.status, 404, p);
        await res.arrayBuffer();
      }
    });
  });

  test("ingest on without DB: 503 module_unavailable, never another handler", async () => {
    await withSite({ PIQUETTE_MODULES: "receipts,ingest" }, async (site) => {
      for (const method of ["GET", "POST"]) {
        const res = await site.fetch("/ingest/v1", { method, token: await signToken({ commonName: "svc.access" }) });
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { error: "module_unavailable", module: "ingest" });
      }
      const status = (await (await site.fetch("/_piquette/status")).json()) as { modules: Record<string, string> };
      assert.deepEqual(status.modules, { receipts: "ok", ingest: "missing_binding", dashboard: "off" });
    });
  });

  test("receipts enabled without its bucket: 503 on its routes", async () => {
    await withSite({ NO_R2: "1" }, async (site) => {
      const res = await site.fetch("/api/receipts/issue-198");
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "module_unavailable", module: "receipts" });
      const status = (await (await site.fetch("/_piquette/status")).json()) as { modules: Record<string, string> };
      assert.equal(status.modules.receipts, "missing_binding");
    });
  });

  test("unknown module names are ignored", async () => {
    await withSite({ PIQUETTE_MODULES: "receipts, bogus" }, async (site) => {
      const status = (await (await site.fetch("/_piquette/status")).json()) as { modules: Record<string, string> };
      assert.deepEqual(status.modules, { receipts: "ok", ingest: "off", dashboard: "off" });
    });
  });

  test("a service-token JWT on /api/receipts is 403 (it must not read)", async () => {
    await withSite({}, async (site) => {
      await site.seed(run198());
      const res = await site.fetch("/api/receipts/issue-198", { token: await signToken({ commonName: "svc.access" }) });
      assert.equal(res.status, 403);
      await res.arrayBuffer();
    });
  });
});
