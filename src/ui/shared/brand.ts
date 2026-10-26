/**
 * Whitelabel brand for the dashboard SPA (#214). One schema shape for the
 * hosted app (`cloud.brand`) and local `piquette ui` (`ui.brand`). Pure and
 * node-free: the Worker, `piquette ui`'s static server, the config schema and the
 * SPA all use it. Nothing here names an org; every value comes from config.
 *
 * The SPA bundle is one build for every org. The server injects a generated
 * `<style>` (token overrides) and a non-executable JSON `<script>` into the
 * HTML shell, so no rebuild and no script-src exception are needed.
 */

/** The semantic tokens a brand may override (see DESIGN.md: components bind to these, never to raw hues). */
export const BRAND_TOKENS = ["accent", "live", "ground", "face", "fg", "rule", "dim", "faint", "inset", "rule-soft"] as const;
export type BrandToken = (typeof BRAND_TOKENS)[number];

export interface BrandColor {
  light?: string;
  dark?: string;
}

export interface Brand {
  /** Product display name: header wordmark and document titles. */
  name?: string;
  /** https URL or `data:image/svg+xml,` URI. */
  logo_url?: string;
  /** https URL or `data:image/svg+xml,` URI. Falls back to the logo. */
  favicon_url?: string;
  /** Where the org's own root lives; shown as a link back to it. */
  home_url?: string;
  home_label?: string;
  colors?: Partial<Record<BrandToken, BrandColor>>;
}

/** What the server tells the SPA, in the `#piquette-brand` JSON script. */
export interface BrandPage {
  brand?: Brand;
  /** False on a receipts-only app: there is no dashboard root to go back to. */
  dashboard?: boolean;
}

export const BRAND_NAME_MAX = 60;
export const BRAND_LABEL_MAX = 40;
export const BRAND_DATA_URI_MAX = 32_000;
/**
 * Cloudflare caps one Worker var at 5 KB. The hosted brand travels as a single
 * var (BRAND_JSON), so its serialized UTF-8 size is capped below that, leaving headroom.
 */
export const BRAND_VAR_MAX_BYTES = 4096;

/** UTF-8 size of the brand as it would be written to the BRAND_JSON deploy var. */
export const brandVarBytes = (brand: unknown): number => new TextEncoder().encode(JSON.stringify(brand)).length;

const UNSAFE_URL_CHARS = /["'<>\s\\]/;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SVG_DATA_URI = /^data:image\/svg\+xml(?:;charset=utf-8|;base64)?,[^\s"'<>\\]+$/i;
// eslint-disable-next-line no-control-regex
const BAD_TEXT = /[\u0000-\u001f\u007f<>]/;

export function isHttpsUrl(value: string): boolean {
  if (UNSAFE_URL_CHARS.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** An image the shell may reference: a plain https URL, or an (encoded) SVG data URI. */
export function isBrandImage(value: string): boolean {
  return isHttpsUrl(value) || (value.length <= BRAND_DATA_URI_MAX && SVG_DATA_URI.test(value));
}

export const isHexColor = (value: string): boolean => HEX_COLOR.test(value);
export const isBrandText = (value: string, max: number): boolean => value.trim().length > 0 && value.length <= max && !BAD_TEXT.test(value);

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * Lenient normalizer for a brand read from a deploy var: a cosmetic problem
 * drops that field with a warning, it never breaks the app. (The config
 * schema is the strict gate; this guards the Worker against a hand-edited var.)
 */
export function sanitizeBrand(raw: unknown): { brand: Brand; warnings: string[] } {
  const brand: Brand = {};
  const warnings: string[] = [];
  if (!isObject(raw)) return { brand, warnings: raw === undefined ? [] : ["brand: not an object"] };
  const text = (key: "name" | "home_label", max: number) => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v === "string" && isBrandText(v, max)) brand[key] = v.trim();
    else warnings.push(`brand.${key}: ignored`);
  };
  const image = (key: "logo_url" | "favicon_url") => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v === "string" && isBrandImage(v)) brand[key] = v;
    else warnings.push(`brand.${key}: ignored (https URL or data:image/svg+xml only)`);
  };
  text("name", BRAND_NAME_MAX);
  text("home_label", BRAND_LABEL_MAX);
  image("logo_url");
  image("favicon_url");
  const home = raw["home_url"];
  if (home !== undefined) {
    if (typeof home === "string" && isHttpsUrl(home)) brand.home_url = home;
    else warnings.push("brand.home_url: ignored (https URL only)");
  }
  const colors = raw["colors"];
  if (colors !== undefined) {
    if (!isObject(colors)) warnings.push("brand.colors: ignored");
    else {
      for (const [token, pair] of Object.entries(colors)) {
        if (!(BRAND_TOKENS as readonly string[]).includes(token) || !isObject(pair)) {
          warnings.push(`brand.colors.${token}: ignored`);
          continue;
        }
        const out: BrandColor = {};
        for (const mode of ["light", "dark"] as const) {
          const c = pair[mode];
          if (c === undefined) continue;
          if (typeof c === "string" && isHexColor(c)) out[mode] = c;
          else warnings.push(`brand.colors.${token}.${mode}: ignored (hex color only)`);
        }
        if (out.light || out.dark) (brand.colors ??= {})[token as BrandToken] = out;
      }
    }
  }
  return { brand, warnings };
}

export const isEmptyBrand = (b: Brand | undefined): boolean => !b || Object.keys(b).length === 0;

/** `:root`-level token overrides. Light values land on `body`, dark on `body.board`, the same selectors style.css uses. */
export function brandCss(brand: Brand): string {
  const rules: string[] = [];
  for (const [mode, selector] of [["light", "body"], ["dark", "body.board"]] as const) {
    const decls = BRAND_TOKENS.flatMap((t) => {
      const c = brand.colors?.[t]?.[mode];
      return c && isHexColor(c) ? [`--${t}:${c}`] : [];
    });
    if (decls.length) rules.push(`${selector}{${decls.join(";")}}`);
  }
  return rules.join("");
}

/** Image origins to allow in `img-src`: https only (data: is already allowed). */
export function brandImgOrigins(brand: Brand | undefined): string[] {
  const out = new Set<string>();
  for (const u of [brand?.logo_url, brand?.favicon_url]) {
    if (u && isHttpsUrl(u)) out.add(new URL(u).origin);
  }
  return [...out];
}

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** JSON that cannot close its `<script>` or break out of it, whatever the values are. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029");
}

/**
 * Brands the HTML shell: title, favicon, token `<style>` and the JSON blob the
 * SPA reads. With no brand and a dashboard the HTML is returned byte-identical.
 */
export function applyBrand(html: string, page: BrandPage): string {
  const brand = page.brand && !isEmptyBrand(page.brand) ? page.brand : undefined;
  const dashboardOff = page.dashboard === false;
  if (!brand && !dashboardOff) return html;
  let out = html;
  if (brand?.name) out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeText(brand.name!)}</title>`);
  const icon = brand?.favicon_url ?? brand?.logo_url;
  if (icon) out = out.replace(/<link rel="icon"[^>]*>/, () => `<link rel="icon" href="${escapeAttr(icon)}" />`);
  const head: string[] = [];
  const css = brand ? brandCss(brand) : "";
  if (css) head.push(`<style id="piquette-brand-style">${css}</style>`);
  head.push(`<script type="application/json" id="piquette-brand">${safeJson({ ...(brand ? { brand } : {}), ...(dashboardOff ? { dashboard: false } : {}) })}</script>`);
  return out.replace("</head>", () => `${head.join("")}</head>`);
}
