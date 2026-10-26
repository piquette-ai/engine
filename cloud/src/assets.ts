/**
 * The SPA shell and built files from Workers static assets. Everything here
 * sits behind the identity gate; `run_worker_first` makes sure no asset
 * skips the Worker.
 */
import type { Context } from "hono";
import { viewerAssetPath } from "../../src/receipts/index.ts";
import { applyBrand, brandFromVars, chromeFromVars, injectShell, shellCsp } from "../../src/receipts/index.ts";
import type { CloudEnv } from "./env.ts";
import type { CloudModuleName } from "./module_names.ts";

export function assetHandler(enabled: ReadonlySet<CloudModuleName>) {
  return async (c: Context<CloudEnv>): Promise<Response> => {
    const url = new URL(c.req.url);
    let shellOutsideReceipts = false;
    const mapped = viewerAssetPath(url.pathname);
    if (mapped) url.pathname = mapped;
    else if (/^\/r(\/|$)/.test(url.pathname)) {
      if (!enabled.has("receipts")) return c.text("piquette cloud: the receipts module is off\n", 404);
    } else if (!url.pathname.startsWith("/assets/") && !/\.[a-z0-9]+$/i.test(url.pathname)) {
      // The dashboard SPA polls /api/sessions forever; every poll would be a billed invocation, so a
      // receipts-only app serves no shell outside /r/*.
      if (!enabled.has("dashboard")) return c.text("piquette cloud: open a /r/<run> link from a pull request\n", 404);
    } else if (!enabled.has("dashboard")) shellOutsideReceipts = true;
    const res = await c.env.ASSETS.fetch(new Request(url, c.req.raw));
    const base = (c.env.BASE_PATH || "/").replace(/\/+$/, "");
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location && base && location.startsWith("/") && !location.startsWith("//")) {
      // The asset layer's redirects are relative to the stripped path: keep them inside the mount.
      const headers = new Headers(res.headers);
      headers.set("location", base + location);
      return new Response(null, { status: res.status, headers });
    }
    // A miss falls back to the SPA shell (index.html); a receipts-only app must not serve it.
    if (shellOutsideReceipts && (res.headers.get("content-type") ?? "").startsWith("text/html")) return c.text("piquette cloud: not found\n", 404);
    if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) return res;
    const chrome = chromeFromVars(c.env);
    const brand = brandFromVars(c.env, chrome);
    const html = applyBrand(injectShell(await res.text(), chrome), { brand, dashboard: enabled.has("dashboard") });
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.delete("etag");
    headers.set("content-security-policy", shellCsp(chrome, brand));
    headers.set("cache-control", "private, no-store");
    return new Response(c.req.method === "HEAD" ? null : html, { status: res.status, headers });
  };
}
