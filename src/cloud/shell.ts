/**
 * Pure, node-free helpers for serving the SPA from a Worker under a base
 * path with optional host chrome (#212/#214). No fs, no process.
 */
import { brandImgOrigins, sanitizeBrand, type Brand } from "../ui/shared/brand.ts";

/**
 * The pathname the app sees, with the mount base removed. `null` means "not
 * ours": a prefix trick (`/spfx` for base `/spf`), a `..` segment, an encoded
 * slash, or a remainder that would turn into a scheme-relative URL (`//x`).
 * `/base` itself maps to `/` (the caller redirects it to `/base/` first).
 */
export function stripBase(pathname: string, base: string): string | null {
  if (!pathname.startsWith("/")) return null;
  if (/%2f|%5c/i.test(pathname)) return null;
  if (pathname.split("/").some((seg) => seg === ".." || /^(%2e|\.)(%2e|\.)$/i.test(seg))) return null;
  const b = base.length > 1 ? base.replace(/\/+$/, "") : "/";
  let rest: string;
  if (b === "/") rest = pathname;
  else if (pathname === b) rest = "/";
  else if (pathname.startsWith(`${b}/`)) rest = pathname.slice(b.length);
  else return null;
  if (rest.startsWith("//")) return null;
  return rest;
}

export interface Chrome {
  stylesheet_url?: string;
  header_url?: string;
  header_height: number;
  home_url?: string;
}

export interface ChromeVars {
  CHROME_STYLESHEET_URL?: string;
  CHROME_HEADER_URL?: string;
  CHROME_HEADER_HEIGHT?: string;
  CHROME_HOME_URL?: string;
}

function cleanHttps(name: string, value: string | undefined): string | undefined {
  const v = (value ?? "").trim();
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password || /["'<>\s]/.test(v)) throw new Error("not a plain https URL");
    return u.href;
  } catch {
    console.warn(`chrome: ignoring ${name}: not a plain https URL`);
    return undefined;
  }
}

/** Chrome is cosmetic: an invalid value is ignored with a warning, never an error. */
export function chromeFromVars(env: ChromeVars): Chrome {
  const height = Number.parseInt(env.CHROME_HEADER_HEIGHT ?? "", 10);
  const chrome: Chrome = { header_height: Number.isInteger(height) && height >= 24 && height <= 200 ? height : 56 };
  const css = cleanHttps("CHROME_STYLESHEET_URL", env.CHROME_STYLESHEET_URL);
  const header = cleanHttps("CHROME_HEADER_URL", env.CHROME_HEADER_URL);
  const home = cleanHttps("CHROME_HOME_URL", env.CHROME_HOME_URL);
  if (css) chrome.stylesheet_url = css;
  if (header) chrome.header_url = header;
  if (home) chrome.home_url = home;
  return chrome;
}

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Adds the host chrome to the shell. With no chrome URLs the HTML is returned byte-identical. */
export function injectShell(html: string, chrome: Chrome): string {
  if (!chrome.stylesheet_url && !chrome.header_url && !chrome.home_url) return html;
  let out = html;
  const head: string[] = [];
  if (chrome.stylesheet_url) head.push(`<link rel="stylesheet" href="${escapeAttr(chrome.stylesheet_url)}" crossorigin="anonymous">`);
  if (chrome.home_url) head.push(`<meta name="spf-home-url" content="${escapeAttr(chrome.home_url)}">`);
  if (head.length) out = out.replace("</head>", () => `${head.join("")}</head>`);
  if (chrome.header_url) {
    const frame = `<iframe class="spf-host-header" src="${escapeAttr(chrome.header_url)}" title="site header" sandbox="allow-scripts allow-popups allow-top-navigation-by-user-activation" style="border:0;width:100%;height:${chrome.header_height}px"></iframe>`;
    out = out.replace('<div id="app">', () => `${frame}<div id="app">`);
  }
  return out;
}

const originOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** The CSP for HTML shell responses: self only, plus the chrome origins and, only when configured, the brand logo/favicon origins in img-src. */
export function shellCsp(chrome: Chrome, brand?: Brand): string {
  const css = originOf(chrome.stylesheet_url);
  const header = originOf(chrome.header_url);
  const extra = css ? ` ${css}` : "";
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'unsafe-inline'${extra}`,
    `img-src 'self' data:${extra}${brandImgOrigins(brand).map((o) => ` ${o}`).join("")}`,
    `font-src 'self'${extra}`,
    "media-src 'self'",
    "connect-src 'self'",
    `frame-src ${header ?? "'none'"}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

let brandCache: { text: string; brand: Brand } | undefined;

/**
 * The brand from the deploy var, with the chrome home link as a fallback home.
 * Cosmetic: a bad var drops fields with a warning, never an error.
 */
export function brandFromVars(env: { BRAND_JSON?: string }, chrome: Chrome): Brand {
  const text = (env.BRAND_JSON ?? "").trim();
  // The var cannot change within an isolate, so parse and warn once per distinct value, not per page view.
  let cached = brandCache;
  if (!cached || cached.text !== text) {
    let raw: unknown;
    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        console.warn("brand: ignoring BRAND_JSON: not valid JSON");
      }
    }
    const parsed = sanitizeBrand(raw);
    for (const w of parsed.warnings) console.warn(w);
    cached = brandCache = { text, brand: parsed.brand };
  }
  const brand: Brand = structuredClone(cached.brand);
  if (!brand.home_url && chrome.home_url) brand.home_url = chrome.home_url;
  return brand;
}
