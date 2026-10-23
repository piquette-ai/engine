import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { mockApi, type MockMode } from "../src/ui/shared/hosted_fixtures";

// Only used by the dev server's /api proxy (`npm run dev` inside app/, for
// iterating on the SPA against a real spf ui process on the side). The
// packaged build never reaches this — one process serves both, same-origin.
const API_PORT = process.env.PORT ?? "4600";

// `SPF_MOCK=hosted npm run dev` (or `local`) answers /api from the fixtures in
// src/ui/shared/hosted_fixtures.ts instead of proxying to a real spf ui: two
// repos, three factories, one adw_id shared by two of them. Dev server only.
const MOCK = process.env.SPF_MOCK as MockMode | undefined;

function mockApiPlugin(mode: MockMode): Plugin {
  return {
    name: "spf-mock-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        const url = new URL(req.url, "http://localhost");
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          let body: unknown;
          try {
            body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
          } catch {
            body = undefined;
          }
          const hit = mockApi(mode, url.pathname, url.searchParams, Date.now(), { method: req.method ?? "GET", body });
          res.statusCode = hit?.status ?? 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(hit?.body ?? { error: "not in the fixture" }));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === "video-player" || tag === "video-skin" } } }), ...(MOCK === "hosted" || MOCK === "local" ? [mockApiPlugin(MOCK)] : [])],
  // Mount-point-agnostic: spf ui always serves this at the root it binds, but
  // relative URLs cost nothing and stop being wrong the first time someone
  // reverse-proxies it under a path prefix.
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../src/ui/shared", import.meta.url)),
    },
  },
  server: {
    port: 4601,
    proxy: MOCK ? undefined : {
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    // A sibling of dist/ in the published package — never dist/ itself, so
    // `emptyOutDir` here can never eat the compiled CLI.
    outDir: "../web",
    emptyOutDir: true,
    // Inlines the (now 48x48, ~1-2 KB each) provider icons as data URIs
    // instead of separate HTTP requests.
    assetsInlineLimit: 4096,
  },
});
