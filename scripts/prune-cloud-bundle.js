#!/usr/bin/env node
/**
 * `wrangler deploy --dry-run --outdir dist/worker` writes the bundle plus
 * wrangler's own scratch files (README, config, maps). Only the minified
 * Worker, `index.js`, ships; everything else is removed so no source or
 * node_modules path can reach the tarball. Fails when the bundle is missing.
 */
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "..", "dist", "worker");
const KEEP = new Set(["index.js", "migrations"]);
const migrations = path.resolve(import.meta.dirname, "..", "cloud", "migrations");

if (!existsSync(path.join(dir, "index.js"))) {
  console.error(`prune-cloud-bundle: ${path.join(dir, "index.js")} is missing: the wrangler bundle step did not produce it`);
  process.exit(1);
}
for (const name of readdirSync(dir)) {
  if (!KEEP.has(name)) rmSync(path.join(dir, name), { recursive: true, force: true });
}
// The D1 schema ships beside the bundle: `piquette cloud deploy` applies it with wrangler d1 migrations.
rmSync(path.join(dir, "migrations"), { recursive: true, force: true });
cpSync(migrations, path.join(dir, "migrations"), { recursive: true });
console.log("prune-cloud-bundle: kept dist/worker/index.js and copied migrations/");
