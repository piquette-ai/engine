/** The cloud package names no org and no host: only placeholders and the test team, and no account-id-shaped literals. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const SCAN = ["src", "test", "migrations", "scripts", "wrangler.jsonc", "README.md"];

function files(p: string): string[] {
  const full = path.join(root, p);
  if (!statSync(full, { throwIfNoEntry: false })) return [];
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name === "dist" ? [] : e.isDirectory() ? files(path.join(p, e.name)) : [path.join(full, e.name)]));
}

test("only <team> or test-team cloudflareaccess.com hosts appear", () => {
  for (const f of SCAN.flatMap(files)) {
    if (f === import.meta.filename) continue;
    for (const m of readFileSync(f, "utf8").matchAll(/([a-z0-9<>-]+)\.cloudflareaccess\.com/gi)) assert.ok(["test-team", "<team>", "evil"].includes(m[1]!), `${path.relative(root, f)}: ${m[0]}`);
  }
});

test("no 32-hex literals (account ids, AUD tags, database ids)", () => {
  for (const f of SCAN.flatMap(files)) {
    if (f === import.meta.filename) continue;
    assert.doesNotMatch(readFileSync(f, "utf8"), /\b[0-9a-f]{32}\b/i, path.relative(root, f));
  }
});
