/** The shipped migrations apply with wrangler's own runner, in order, from an empty local database. No Cloudflare credentials. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const migrations = path.join(root, "migrations");

test("migration files are strictly ordered NNNN_name.sql, one statement per ';' line, no triggers", () => {
  const files = readdirSync(migrations).sort();
  assert.ok(files.length >= 1);
  files.forEach((f, i) => {
    assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/);
    assert.equal(Number(f.slice(0, 4)), i + 1, "numbers are contiguous from 0001");
    const sql = readFileSync(path.join(migrations, f), "utf8");
    assert.doesNotMatch(sql, /CREATE\s+TRIGGER/i);
    for (const line of sql.split("\n").filter((l) => l.trim() && !l.startsWith("--"))) assert.match(line, /;\s*$/, `one statement per line: ${line.slice(0, 50)}`);
  });
});

test("wrangler d1 migrations apply --local creates the schema (credentials stripped from the env)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-cloud-mig-"));
  try {
    const config = path.join(dir, "wrangler.json");
    writeFileSync(config, JSON.stringify({ name: "spf-mig-test", compatibility_date: "2026-07-01", d1_databases: [{ binding: "DB", database_name: "spf-hub", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: migrations }] }));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && !k.startsWith("CLOUDFLARE_") && !k.startsWith("CF_")) env[k] = v;
    env["WRANGLER_SEND_METRICS"] = "false";
    env["CI"] = "1";
    const res = spawnSync(path.join(root, "node_modules", ".bin", "wrangler"), ["d1", "migrations", "apply", "DB", "--local", "--persist-to", path.join(dir, "state"), "-c", config], { cwd: dir, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    const found: string[] = [];
    const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".sqlite") && found.push(path.join(d, e.name))));
    walk(path.join(dir, "state"));
    assert.ok(found.length >= 1);
    const db = new DatabaseSync(found.find((f) => /miniflare-D1DatabaseObject/.test(f)) ?? found[0]!);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["factories", "factory_repos", "factory_credentials", "reader_grants", "sessions", "phases", "agent_sessions", "envelopes", "events", "gate_results", "prompts", "reviews", "d1_migrations"]) assert.ok(tables.includes(t), t);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").get() as { n: number }).n, readdirSync(migrations).length);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
