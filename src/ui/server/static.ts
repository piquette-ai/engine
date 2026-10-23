/**
 * Serves the packaged SPA (built once, at publish time — see app/vite.config.ts)
 * from web/, a sibling of dist/ in the published package. Hand-rolled rather
 * than @hono/node-server/serve-static, whose `root` option resolves against
 * process.cwd() — wrong here, since `spf ui` runs from an arbitrary target repo,
 * not from inside the package.
 *
 * A missing web/ (no dist/index.html) is a hard startup error, not a
 * plaintext fallback response: the SPA is always prebuilt before publish, so
 * its absence can only mean a corrupt install.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { Context } from "hono";
import { viewerAssetPath } from "./receipt_reader.ts";
import { applyBrand, type Brand } from "../shared/brand.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** Throws if `webDir` has no index.html — call this at startup, before serving anything. */
export function assertWebDir(webDir: string): void {
  if (!existsSync(join(webDir, "index.html"))) {
    throw new Error(
      `spf ui: no packaged UI found at ${webDir} (missing index.html) — this looks like a corrupt install; try reinstalling.`,
    );
  }
}

/** `assertWebDir` runs once, here, at app-construction time — not per request. */
export function serveStatic(webDir: string, options: { brand?: Brand } = {}) {
  assertWebDir(webDir);
  const shell = (html: string): string => applyBrand(html, { brand: options.brand });
  return (c: Context): Response => {
    const pathname = new URL(c.req.url).pathname;

    // At `/r/<run_id>` the page's relative `./assets/x.js` resolves to
    // `/r/assets/x.js`; serve the real asset instead of index.html (#202).
    for (const p of [pathname, viewerAssetPath(pathname)]) {
      if (p === null) continue;
      // Reject traversal before touching the filesystem.
      const candidate = resolve(join(webDir, p));
      if (candidate === webDir || candidate.startsWith(webDir + sep)) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          const headers: Record<string, string> = { "content-type": MIME[extname(candidate)] ?? "application/octet-stream" };
          // Vite content-hashes everything under assets/ — safe to cache forever.
          headers["cache-control"] = p.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store";
          if (extname(candidate) === ".html") return new Response(shell(readFileSync(candidate, "utf-8")), { headers });
          return new Response(readFileSync(candidate), { headers });
        }
      }
    }

    // SPA fallback: breadcrumb routes are client-side.
    return new Response(shell(readFileSync(join(webDir, "index.html"), "utf-8")), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  };
}
