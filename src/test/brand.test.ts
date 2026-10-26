/** Whitelabel brand (#214): validation, injection, CSP, merge survival, and the repo-layer URL rule. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { loadConfig } from "../core/agents.js";
import { BrandSchema, SFConfigSchema } from "../core/data_types.js";
import { configOrigins, trustedUiBrand } from "../core/config_origins.js";
import { BUILTIN_CONFIG_PATH } from "../core/paths.js";
import { brandVar } from "../cloud/config.js";
import { applyBrand, brandCss, brandVarBytes, brandImgOrigins, safeJson, sanitizeBrand } from "../ui/shared/brand.js";
import { serveStatic } from "../ui/server/static.js";
import { brandFromVars, shellCsp } from "../cloud/shell.js";

const HTML = '<!doctype html><html><head><meta charset="UTF-8" /><link rel="icon" type="image/svg+xml" href="./logo.svg" /><title>PIQUETTE</title></head><body><div id="app"></div></body></html>';

test("schema: accepts https and svg data URIs, hex colors, allowlisted tokens only", () => {
  const ok = v.parse(BrandSchema, {
    name: "Acme Factory",
    logo_url: "https://cdn.example.com/l.svg",
    favicon_url: "data:image/svg+xml,%3Csvg%2F%3E",
    home_url: "https://www.example.com/",
    home_label: "Acme home",
    colors: { accent: { light: "#0a7a5c", dark: "#5eead4" }, live: { dark: "#fff" } },
  });
  assert.equal(ok.colors?.accent?.dark, "#5eead4");
  const bad: Array<[string, unknown]> = [
    ["http logo", { logo_url: "http://cdn.example.com/l.png" }],
    ["png data uri", { logo_url: "data:image/png;base64,AAAA" }],
    ["svg with markup", { logo_url: "data:image/svg+xml,<svg/>" }],
    ["credentials", { home_url: "https://u:p@www.example.com/" }],
    ["javascript url", { home_url: "javascript:alert(1)" }],
    ["markup in name", { name: "<b>x</b>" }],
    ["empty name", { name: "  " }],
    ["css injection", { colors: { accent: { light: "red; } body { display:none" } } }],
    ["named color", { colors: { accent: { light: "red" } } }],
    ["unknown token", { colors: { shadow: { light: "#000" } } }],
    ["empty pair", { colors: { accent: {} } }],
    ["unknown key", { logo: "https://x.example.com/l.svg" }],
  ];
  for (const [why, input] of bad) assert.throws(() => v.parse(BrandSchema, input), /./, why);
});

test("sanitizeBrand drops bad fields with warnings and keeps good ones", () => {
  const { brand, warnings } = sanitizeBrand({ name: "Ok", logo_url: "http://x.example.com/l.png", colors: { accent: { light: "#abc", dark: "nope" }, bogus: { light: "#abc" } } });
  assert.deepEqual(brand, { name: "Ok", colors: { accent: { light: "#abc" } } });
  assert.equal(warnings.length, 3);
});

test("brandCss: light on body, dark on body.board, nothing when unset", () => {
  assert.equal(brandCss({ colors: { accent: { light: "#0a7a5c", dark: "#5eead4" }, live: { dark: "#fff" } } }), "body{--accent:#0a7a5c}body.board{--accent:#5eead4;--live:#fff}");
  assert.equal(brandCss({ name: "x" }), "");
});

test("applyBrand: stock shell is byte-identical; a brand sets title, favicon, style and an escaped JSON blob", () => {
  assert.equal(applyBrand(HTML, {}), HTML);
  assert.equal(applyBrand(HTML, { brand: {} }), HTML);
  assert.equal(applyBrand(HTML, { dashboard: true }), HTML);
  const out = applyBrand(HTML, { brand: { name: "Acme & Co", logo_url: "https://cdn.example.com/l.svg", home_label: "</script><b>" } });
  assert.match(out, /<title>Acme &amp; Co<\/title>/);
  assert.match(out, /<link rel="icon" href="https:\/\/cdn\.example\.com\/l\.svg" \/>/, "the logo is the favicon fallback");
  const blob = /<script type="application\/json" id="piquette-brand">([^]*?)<\/script>/.exec(out)![1]!;
  assert.doesNotMatch(blob, /[<>&]/);
  assert.equal((JSON.parse(blob) as { brand: { home_label: string } }).brand.home_label, "</script><b>");
  assert.match(applyBrand(HTML, { dashboard: false }), /"dashboard":false/);
  assert.equal(safeJson({ a: " <" }), '{"a":"\\u2028\\u003c"}');
});

test("img-src gains logo/favicon origins only when configured (https only)", () => {
  assert.doesNotMatch(shellCsp({ header_height: 56 }), /cdn\.example/);
  assert.match(shellCsp({ header_height: 56 }), /img-src 'self' data:;/);
  const brand = { logo_url: "https://cdn.example.com/a/l.svg", favicon_url: "https://static.example.net/f.ico" };
  assert.deepEqual(brandImgOrigins(brand), ["https://cdn.example.com", "https://static.example.net"]);
  assert.match(shellCsp({ header_height: 56 }, brand), /img-src 'self' data: https:\/\/cdn\.example\.com https:\/\/static\.example\.net;/);
  assert.deepEqual(brandImgOrigins({ logo_url: "data:image/svg+xml,%3Csvg%2F%3E" }), []);
});

test("brandFromVars folds the chrome home link in as a fallback only", () => {
  assert.equal(brandFromVars({}, { header_height: 56, home_url: "https://org.example.com/" }).home_url, "https://org.example.com/");
  assert.equal(brandFromVars({ BRAND_JSON: '{"home_url":"https://brand.example.com/"}' }, { header_height: 56, home_url: "https://org.example.com/" }).home_url, "https://brand.example.com/");
});

test("serveStatic brands index.html (fallback and direct) and leaves assets alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-brand-web-"));
  try {
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), HTML);
    writeFileSync(join(dir, "assets", "a.js"), "console.log(1)");
    const stock = serveStatic(dir);
    const branded = serveStatic(dir, { brand: { name: "Acme", colors: { accent: { light: "#0a7a5c" } } } });
    const get = async (h: ReturnType<typeof serveStatic>, p: string) => h({ req: { url: `http://127.0.0.1${p}` } } as never).text();
    assert.equal(await get(stock, "/"), HTML);
    assert.match(await get(branded, "/"), /<title>Acme<\/title>.*--accent:#0a7a5c/s);
    assert.match(await get(branded, "/index.html"), /<title>Acme<\/title>/);
    assert.match(await get(branded, "/r/run-1"), /piquette-brand/);
    assert.equal(await get(branded, "/assets/a.js"), "console.log(1)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── config: merge survival and the repo-layer rule ──────────────────────────

function layers(machine: string, repo: string) {
  const dir = mkdtempSync(join(tmpdir(), "piquette-brand-merge-"));
  try {
    writeFileSync(join(dir, "machine.yaml"), machine);
    writeFileSync(join(dir, "repo.yaml"), repo);
    const resolution = { layers: [{ kind: "built-in" as const, path: BUILTIN_CONFIG_PATH }, { kind: "machine" as const, path: join(dir, "machine.yaml") }, { kind: "repo" as const, path: join(dir, "repo.yaml") }] };
    const cfg = loadConfig(resolution.layers.map((l) => l.path));
    return { cfg, trust: configOrigins(resolution).uiBrandTrusted };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MACHINE_UI = `
ui:
  brand:
    name: Acme Factory
    logo_url: https://cdn.example.com/l.svg
    home_url: https://www.example.com/
    colors: { accent: { light: "#0a7a5c" } }
`;

test("ui.brand survives the layer merge key-by-key; colors replace whole", () => {
  const { cfg } = layers(MACHINE_UI, "ui:\n  brand:\n    home_label: Acme home\n    colors: { live: { dark: '#fff' } }\n");
  assert.equal(cfg.ui?.brand?.name, "Acme Factory");
  assert.equal(cfg.ui?.brand?.logo_url, "https://cdn.example.com/l.svg");
  assert.equal(cfg.ui?.brand?.home_label, "Acme home");
  assert.deepEqual(cfg.ui?.brand?.colors, { live: { dark: "#fff" } }, "no half-merged palette");
});

test("no layer declares ui: it is absent, not an empty block", () => {
  assert.equal(layers("sync: {}\n", "defaults: {}\n").cfg.ui, undefined);
});

test("cloud.brand parses inside the cloud block", () => {
  const cfg = v.parse(SFConfigSchema, { cloud: { provider: "cloudflare", access: { team_domain: "t.cloudflareaccess.com", aud: ["a"] }, brand: { name: "Acme Factory" } } });
  assert.equal(cfg.cloud?.brand?.name, "Acme Factory");
  assert.throws(() => v.parse(SFConfigSchema, { cloud: { provider: "cloudflare", access: { team_domain: "t.cloudflareaccess.com", aud: ["a"] }, brand: { logo_url: "http://x.example.com/l.png" } } }));
});

test("a repo layer cannot set the brand's URLs: the machine's survive, the repo's are ignored with a warning", () => {
  const { cfg, trust } = layers(MACHINE_UI, "ui:\n  brand:\n    name: Repo Name\n    logo_url: https://tracker.example.net/p.png\n    home_url: https://phish.example.net/\n    colors: { accent: { dark: '#fff' } }\n");
  assert.equal(cfg.ui?.brand?.logo_url, "https://tracker.example.net/p.png", "the merge itself is neutral");
  const { brand, warnings } = trustedUiBrand(cfg.ui?.brand, trust);
  assert.equal(brand.logo_url, "https://cdn.example.com/l.svg");
  assert.equal(brand.home_url, "https://www.example.com/");
  assert.equal(brand.name, "Repo Name", "text and colors may come from the repo");
  assert.deepEqual(brand.colors, { accent: { dark: "#fff" } });
  assert.equal(warnings.length, 2);
});

test("a repo-only brand URL is dropped entirely", () => {
  const { cfg, trust } = layers("sync: {}\n", "ui:\n  brand:\n    logo_url: https://tracker.example.net/p.png\n");
  const { brand } = trustedUiBrand(cfg.ui?.brand, trust);
  assert.equal(brand.logo_url, undefined);
});

// ── review fixes: var size, surface tokens, per-isolate parse, ui --db ──────

const CLOUD = { provider: "cloudflare", access: { team_domain: "t.cloudflareaccess.com", aud: ["a"] } };
const bigSvg = (n: number) => `data:image/svg+xml,${"a".repeat(n)}`;

test("cloud.brand is capped to fit one Worker var; ui.brand is not", () => {
  assert.ok(v.parse(SFConfigSchema, { cloud: { ...CLOUD, brand: { logo_url: bigSvg(3000) } } }));
  assert.throws(() => v.parse(SFConfigSchema, { cloud: { ...CLOUD, brand: { logo_url: bigSvg(6000) } } }), /Worker var/);
  assert.throws(() => brandVar({ logo_url: bigSvg(6000) }), /at most 4096/);
  assert.equal(brandVar({}), "");
  assert.equal(brandVar(undefined), "");
  assert.ok(v.parse(SFConfigSchema, { ui: { brand: { logo_url: bigSvg(6000) } } }));
  const multibyte = { name: "é".repeat(60), logo_url: bigSvg(4050) };
  assert.ok(brandVarBytes(multibyte) > JSON.stringify(multibyte).length, "bytes, not characters");
});

test("a brand can repair contrast: dim, faint, inset and rule-soft are tokens and survive the merge", () => {
  const colors = { ground: { light: "#1b2a3a" }, dim: { light: "#c9d3dd" }, faint: { light: "#a8b4c0" }, inset: { light: "#243648" }, "rule-soft": { light: "#35495c" } };
  assert.equal(brandCss({ colors }), "body{--ground:#1b2a3a;--dim:#c9d3dd;--faint:#a8b4c0;--inset:#243648;--rule-soft:#35495c}");
  assert.deepEqual(sanitizeBrand({ colors }).brand.colors, colors);
  assert.ok(v.parse(BrandSchema, { colors }));
  const { cfg } = layers("ui:\n  brand:\n    colors: { dim: { light: '#c9d3dd' } }\n", "sync: {}\n");
  assert.deepEqual(cfg.ui?.brand?.colors, { dim: { light: "#c9d3dd" } });
});

test("brandFromVars parses and warns once per distinct var, and returns a fresh object each time", () => {
  const warn = console.warn;
  const seen: string[] = [];
  console.warn = (m: unknown) => void seen.push(String(m));
  try {
    const env = { BRAND_JSON: '{"name":"Once Test","colors":{"accent":{"light":"nope"}}}' };
    const chrome = { header_height: 56 };
    const a = brandFromVars(env, chrome);
    const b = brandFromVars(env, chrome);
    assert.equal(seen.length, 1, "one warning set, not one per request");
    assert.notEqual(a, b);
    a.name = "mutated";
    assert.equal(brandFromVars(env, chrome).name, "Once Test");
    brandFromVars({ BRAND_JSON: '{"name":"Other","colors":{"accent":{"light":"bad"}}}' }, chrome);
    assert.equal(seen.length, 2, "a changed var is reported again");
  } finally {
    console.warn = warn;
  }
});
