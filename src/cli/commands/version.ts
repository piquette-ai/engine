import { readFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../../core/paths.ts";
import { closestNames } from "../unknown_name.ts";

const KNOWN_OPTIONS = ["--json"] as const;
/** Global flags that take a value; the value must not be treated as an option. */
const VALUE_FLAGS = new Set(["--cwd", "--config"]);

export function versionCommand(args: readonly string[] = []): number {
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("--cwd=") || a.startsWith("--config=")) continue;
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a.startsWith("-")) {
      const name = a.split("=")[0]!;
      const lines = [`unknown option: ${name}`];
      const close = closestNames(name, KNOWN_OPTIONS);
      if (close.length > 0) lines.push(`did you mean: ${close.join(", ")}?`);
      lines.push("usage: spf version [--json]");
      console.error(lines.join("\n"));
      return 2;
    }
  }
  const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8")) as { name: string; version: string };
  console.log(json ? JSON.stringify({ name: pkg.name, version: pkg.version }) : `${pkg.name} ${pkg.version}`);
  return 0;
}
