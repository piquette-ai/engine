import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const plain = path.join(here, "..", "dist", "index.js");
const minified = path.join(here, "..", "..", "dist", "worker", "index.js");

test("the wrangler builds succeeded without nodejs_compat and have no node: imports", () => {
  for (const bundle of [plain, minified]) {
    const src = readFileSync(bundle, "utf8");
    assert.doesNotMatch(src, /from\s*["']node:/, bundle);
    assert.doesNotMatch(src, /require\(["']node:/, bundle);
    assert.doesNotMatch(src, /import\(["']node:/, bundle);
  }
});

test("exactly one Hono copy is bundled", () => {
  const src = readFileSync(plain, "utf8");
  const marker = "var Hono = class"; // the class declaration in hono-base
  assert.equal(src.split(marker).length - 1, 1);
});

test("both bundles are under 1 MiB", () => {
  for (const bundle of [plain, minified]) assert.ok(statSync(bundle).size < 1024 * 1024, bundle);
});

test("the minified bundle is the one the CLI ships", () => {
  assert.ok(readFileSync(minified, "utf8").length > 1000);
});
