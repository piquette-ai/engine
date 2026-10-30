/**
 * Which config layer a top-level block came from. `mergeRawConfig` merges the
 * layers; this re-reads only the top-level keys of each layer file so a
 * command can tell the user when a block that steers deploys or credentials
 * came from a repo (which a cloned repo controls), not their own machine.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ConfigLayerKind, ConfigResolution } from "./paths.ts";
import type { BrandConfig } from "./data_types.ts";
import { sanitizeBrand, type Brand } from "../ui/shared/brand.ts";

export interface ConfigOrigins {
  cloud?: ConfigLayerKind;
  /** The file the winning `cloud` block was read from. */
  cloudPath?: string;
  /** The layer whose `receipts.store` won (the bucket a deploy binds comes from it). */
  receiptsStore?: ConfigLayerKind;
  /**
   * Where sync credentials may be sent, and the factory's display name (identity is machine-owned): the `sync.endpoint` and credential env-var names declared by a built-in, machine or
   * explicit layer. A repo layer (which a cloned repo controls) never contributes; `routing_ignored` lists what it tried to set.
   */
  syncTrusted?: SyncRoutingTrust;
  /** `ui.brand` URL keys by trust (#214): a cloned repo can restyle the dashboard but cannot make it load or link to a host of its choosing. */
  uiBrandTrusted?: UiBrandTrust;
}

export const SYNC_ROUTING_KEYS = ["endpoint", "client_id_env", "client_secret_env", "factory_name"] as const;
export type SyncRoutingKey = (typeof SYNC_ROUTING_KEYS)[number];
export interface SyncRoutingTrust {
  values: Partial<Record<SyncRoutingKey, string>>;
  /** Routing keys a repo-layer `sync:` block set; they are ignored. */
  routing_ignored: Array<SyncRoutingKey | "on_watch" | "on_watch_interval_ms">;
  /** `sync.on_watch` from a non-repo layer (#221). */
  on_watch?: boolean;
  /** `sync.on_watch_interval_ms` from a non-repo layer — same trust rule as `on_watch` (#2). */
  on_watch_interval_ms?: number;
  /** A non-repo layer declared a `sync:` block (#221). */
  machine_block?: boolean;
  /** `sync.level` / `sync.repo` from a non-repo layer: what sync-on-watch sends and under which repo (#221). A repo layer's are not trusted there. */
  level?: string;
  repo?: string;
}

/** The URL-bearing brand keys: where a page loads an image from or sends a click. A repo layer must not set them. */
export const BRAND_URL_KEYS = ["logo_url", "favicon_url", "home_url"] as const;
export type BrandUrlKey = (typeof BRAND_URL_KEYS)[number];
export interface UiBrandTrust {
  /** The URL keys declared by a built-in, machine or explicit layer (the last one wins). */
  values: Partial<Record<BrandUrlKey, unknown>>;
  /** URL keys a repo-layer `ui.brand` set; `piquette ui` ignores them. */
  urls_ignored: BrandUrlKey[];
}

export function configOrigins(resolution: Pick<ConfigResolution, "layers">): ConfigOrigins {
  const out: ConfigOrigins = {};
  const trust: SyncRoutingTrust = { values: {}, routing_ignored: [] };
  out.syncTrusted = trust;
  const brandTrust: UiBrandTrust = { values: {}, urls_ignored: [] };
  out.uiBrandTrusted = brandTrust;
  for (const layer of resolution.layers) {
    if (!existsSync(layer.path)) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(layer.path, "utf-8"));
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const cloud = (parsed as Record<string, unknown>)["cloud"];
      // Same rule as mergeRawConfig: a later layer's non-null block replaces the earlier one whole.
      const receipts = (parsed as Record<string, unknown>)["receipts"];
      if (receipts && typeof receipts === "object" && !Array.isArray(receipts) && (receipts as Record<string, unknown>)["store"]) out.receiptsStore = layer.kind;
      const sync = (parsed as Record<string, unknown>)["sync"];
      if (sync && typeof sync === "object" && !Array.isArray(sync)) {
        const onWatch = (sync as Record<string, unknown>)["on_watch"];
        if (layer.kind !== "repo") trust.machine_block = true;
        if (onWatch !== undefined && onWatch !== null) {
          if (layer.kind === "repo") {
            if (!trust.routing_ignored.includes("on_watch")) trust.routing_ignored.push("on_watch");
          } else if (typeof onWatch === "boolean") trust.on_watch = onWatch;
        }
        const onWatchIntervalMs = (sync as Record<string, unknown>)["on_watch_interval_ms"];
        if (onWatchIntervalMs !== undefined && onWatchIntervalMs !== null) {
          if (layer.kind === "repo") {
            if (!trust.routing_ignored.includes("on_watch_interval_ms")) trust.routing_ignored.push("on_watch_interval_ms");
          } else if (typeof onWatchIntervalMs === "number") trust.on_watch_interval_ms = onWatchIntervalMs;
        }
        if (layer.kind !== "repo") {
          const level = (sync as Record<string, unknown>)["level"];
          const repo = (sync as Record<string, unknown>)["repo"];
          if (typeof level === "string") trust.level = level;
          if (typeof repo === "string") trust.repo = repo;
        }
        for (const key of SYNC_ROUTING_KEYS) {
          const value = (sync as Record<string, unknown>)[key];
          if (value === undefined || value === null) continue;
          if (layer.kind === "repo") {
            if (!trust.routing_ignored.includes(key)) trust.routing_ignored.push(key);
          } else if (typeof value === "string") trust.values[key] = value;
        }
      }
      const brand = ((parsed as Record<string, unknown>)["ui"] as Record<string, unknown> | null | undefined)?.["brand"];
      if (brand && typeof brand === "object" && !Array.isArray(brand)) {
        for (const key of BRAND_URL_KEYS) {
          const value = (brand as Record<string, unknown>)[key];
          if (value === undefined || value === null) continue;
          if (layer.kind === "repo") {
            if (!brandTrust.urls_ignored.includes(key)) brandTrust.urls_ignored.push(key);
          } else brandTrust.values[key] = value;
        }
      }
      if (cloud !== undefined && cloud !== null) {
        out.cloud = layer.kind;
        out.cloudPath = layer.path;
      }
    }
  }
  return out;
}

/**
 * The brand `piquette ui` serves: the merged `ui.brand` with its URL keys replaced
 * by the ones a non-repo layer declared (a repo's own are dropped, with a
 * warning each). Colors and text from a repo layer are kept: restyling is
 * harmless, loading or linking to a host the repo picked is not.
 */
export function trustedUiBrand(merged: BrandConfig | undefined, trust: UiBrandTrust | undefined): { brand: Brand; warnings: string[] } {
  const { brand, warnings } = sanitizeBrand(merged ?? {});
  if (!trust) return { brand, warnings };
  for (const key of BRAND_URL_KEYS) delete brand[key];
  const { brand: safe } = sanitizeBrand(trust.values);
  for (const key of BRAND_URL_KEYS) if (safe[key]) brand[key] = safe[key];
  for (const key of trust.urls_ignored) warnings.push(`ui.brand.${key} from the repo layer is ignored; set it in your machine-layer piquette.config.yaml`);
  return { brand, warnings };
}
