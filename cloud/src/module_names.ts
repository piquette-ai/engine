/** The module names, parsed from `SPF_MODULES`. Kept apart from the module registry so a module can ask which others are on. */
import type { CloudBindings } from "./env.ts";

export type CloudModuleName = "receipts" | "ingest" | "dashboard";
const KNOWN: readonly CloudModuleName[] = ["receipts", "ingest", "dashboard"];

const warned = new Set<string>();

export function enabledModules(env: Pick<CloudBindings, "SPF_MODULES">): Set<CloudModuleName> {
  const out = new Set<CloudModuleName>();
  for (const raw of (env.SPF_MODULES ?? "").split(",")) {
    const name = raw.trim();
    if (!name) continue;
    if ((KNOWN as readonly string[]).includes(name)) out.add(name as CloudModuleName);
    else if (!warned.has(name)) {
      warned.add(name);
      console.warn(`modules: ignoring unknown module "${name}"`);
    }
  }
  return out;
}

