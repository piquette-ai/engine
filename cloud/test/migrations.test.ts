/** The shipped migrations apply with wrangler's own runner, in order, from an empty local database. No Cloudflare credentials. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrationStatements } from "./harness.ts";

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
  const dir = mkdtempSync(path.join(tmpdir(), "piquette-cloud-mig-"));
  try {
    const config = path.join(dir, "wrangler.json");
    writeFileSync(config, JSON.stringify({ name: "piquette-mig-test", compatibility_date: "2026-07-01", d1_databases: [{ binding: "DB", database_name: "piquette-hub", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: migrations }] }));
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

const fileStatements = (file: string): string[] =>
  readFileSync(path.join(migrations, file), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("--"))
    .map((l) => l.trim());
const upTo = (n: number): string[] => readdirSync(migrations).sort().filter((f) => Number(f.slice(0, 4)) <= n).flatMap(fileStatements);

const F1 = "f1111111-1111-4111-8111-111111111111";
const F2 = "f2222222-2222-4222-8222-222222222222";

/** Seeds the pre-0004 schema: two factories, F1 serving two repos, a shared gate local_id, a NULL-adw event, an orphan phase, a review, agent_sessions and prompts. */
function seedOld(db: DatabaseSync): void {
  const run = (sql: string, ...p: (string | number | null)[]) => void db.prepare(sql).run(...p);
  run("INSERT INTO factories VALUES (?, 't', 'laptop', 'org/repo-b', '0.29.0', 1, 'x', 'y')", F1);
  run("INSERT INTO factories VALUES (?, 't', 'ci', 'org/repo-c', '0.29.0', 1, 'x', 'y')", F2);
  const sess = (f: string, adw: string, repo: string) => run("INSERT INTO sessions (factory_id, adw_id, tenant, repo, synced_at) VALUES (?, ?, 't', ?, 'z')", f, adw, repo);
  sess(F1, "a1", "org/repo-a");
  sess(F1, "b1", "org/repo-b");
  sess(F2, "c1", "org/repo-c");
  for (const [f, adw] of [[F1, "a1"], [F1, "b1"], [F2, "c1"]] as const) {
    run("INSERT INTO phases (factory_id, phase_id, adw_id, seq) VALUES (?, ?, ?, 1)", f, `${adw}_01_plan`, adw);
    run("INSERT INTO agent_sessions (factory_id, adw_id, agent) VALUES (?, ?, 'planner')", f, adw);
    run("INSERT INTO envelopes (factory_id, envelope_id, adw_id) VALUES (?, ?, ?)", f, `env_${adw}`, adw);
    run("INSERT INTO events (factory_id, event_id, local_rowid, adw_id, type) VALUES (?, ?, 1, ?, 'tool')", f, `evt_${adw}`, adw);
    run("INSERT INTO prompts (factory_id, adw_id, agent, system, user) VALUES (?, ?, 'planner', 's', 'u')", f, adw);
  }
  run("INSERT INTO gate_results (factory_id, local_id, adw_id) VALUES (?, 5, 'b1')", F1); // the shared local_id: only one survives under the old key
  run("INSERT INTO gate_results (factory_id, local_id, adw_id) VALUES (?, 6, 'a1')", F1);
  run("INSERT INTO events (factory_id, event_id, local_rowid, adw_id, type) VALUES (?, 'evt_null', 9, NULL, 'tool')", F1);
  run("INSERT INTO phases (factory_id, phase_id, adw_id, seq) VALUES (?, 'orphan_01', 'ghost', 1)", F1);
  run("INSERT INTO reviews (tenant, factory_id, adw_id, archived) VALUES ('t', ?, 'a1', 1)", F1);
}

const TABLES8 = ["sessions", "phases", "agent_sessions", "envelopes", "events", "gate_results", "prompts", "reviews"];
const NEW_PK: Record<string, string[]> = {
  sessions: ["factory_id", "repo", "adw_id"],
  phases: ["factory_id", "repo", "phase_id"],
  agent_sessions: ["factory_id", "repo", "adw_id", "agent"],
  envelopes: ["factory_id", "repo", "envelope_id"],
  events: ["factory_id", "repo", "event_id"],
  gate_results: ["factory_id", "repo", "local_id"],
  prompts: ["factory_id", "repo", "adw_id", "agent"],
  reviews: ["tenant", "factory_id", "repo", "adw_id"],
};
const NEW_INDEXES: Record<string, string[]> = {
  idx_sessions_tenant_repo_started: ["tenant", "repo", "started_at"],
  idx_sessions_tenant_started: ["tenant", "started_at"],
  idx_phases_session: ["factory_id", "repo", "adw_id", "seq"],
  idx_envelopes_session: ["factory_id", "repo", "adw_id"],
  idx_events_session: ["factory_id", "repo", "adw_id", "local_rowid"],
  idx_events_type: ["factory_id", "repo", "adw_id", "type", "local_rowid"],
  idx_gate_results_session: ["factory_id", "repo", "adw_id"],
};

function assertMigrated(db: DatabaseSync, before: Record<string, number>, rowids: Record<string, number[]>): void {
  const all = (sql: string, ...p: string[]) => db.prepare(sql).all(...p) as any[];
  for (const t of TABLES8) {
    assert.equal(all(`SELECT COUNT(*) AS n FROM ${t}`)[0].n, before[t], `${t} count`);
    assert.deepEqual(all(`SELECT rowid FROM ${t} ORDER BY rowid`).map((r) => r.rowid), rowids[t], `${t} rowids`);
    const pk = all(`PRAGMA table_info(${t})`).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    assert.deepEqual(pk, NEW_PK[t], `${t} primary key`);
    assert.equal(all(`SELECT COUNT(*) AS n FROM ${t} WHERE repo = ''`)[0].n, 0, `${t} has no empty repo`);
  }
  for (const [idx, cols] of Object.entries(NEW_INDEXES)) {
    assert.deepEqual(all(`PRAGMA index_xinfo(${idx})`).filter((c) => c.key === 1).sort((a, b) => a.seqno - b.seqno).map((c) => c.name), cols, idx);
  }
  const names = all("SELECT name FROM sqlite_master WHERE name LIKE '%_new'");
  assert.deepEqual(names, [], "no leftover _new tables");
  for (const t of ["phases", "agent_sessions", "envelopes", "events", "gate_results", "prompts"]) {
    assert.equal(all(`SELECT COUNT(*) AS n FROM ${t} c JOIN sessions s ON s.factory_id = c.factory_id AND s.adw_id = c.adw_id WHERE c.repo <> s.repo`)[0].n, 0, `${t} repo follows its session`);
  }
  assert.equal(all("SELECT repo FROM events WHERE event_id = 'evt_null'")[0].repo, "org/repo-b", "NULL adw_id falls back to factories.repo");
  assert.equal(all("SELECT repo FROM phases WHERE phase_id = 'orphan_01'")[0].repo, "org/repo-b", "orphan falls back to factories.repo");
  assert.equal(all("SELECT repo FROM reviews WHERE adw_id = 'a1'")[0].repo, "org/repo-a");
  assert.equal(all("SELECT repo FROM phases WHERE phase_id = 'a1_01_plan'")[0].repo, "org/repo-a");
  assert.equal(all("SELECT repo FROM agent_sessions WHERE adw_id = 'c1'")[0].repo, "org/repo-c");
  assert.equal(all("SELECT repo FROM prompts WHERE adw_id = 'b1'")[0].repo, "org/repo-b");
  assert.deepEqual(all("PRAGMA integrity_check").map((r) => r.integrity_check), ["ok"]);
  assert.deepEqual(all("PRAGMA foreign_key_check"), []);
  // the new key: the same (factory, repo, adw) again fails, the same adw in another repo succeeds
  const ins = (repo: string) => db.prepare("INSERT INTO sessions (factory_id, repo, adw_id, tenant, synced_at) VALUES (?, ?, 'a1', 't', 'z')").run(F1, repo);
  assert.throws(() => ins("org/repo-a"), /UNIQUE|PRIMARY/);
  ins("org/repo-other");
  db.prepare("INSERT INTO gate_results (factory_id, repo, local_id) VALUES (?, 'org/repo-a', 5)").run(F1);
}

test("0004 on a populated database keeps every row, backfills repo, keeps rowids, and installs the new keys and indexes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const sql of upTo(3)) db.exec(sql);
    seedOld(db);
    const before: Record<string, number> = {};
    const rowids: Record<string, number[]> = {};
    for (const t of TABLES8) {
      before[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      rowids[t] = (db.prepare(`SELECT rowid FROM ${t} ORDER BY rowid`).all() as { rowid: number }[]).map((r) => r.rowid);
    }
    assert.ok(before["events"]! >= 4 && before["reviews"] === 1);
    for (const sql of fileStatements("0004_session_repo_key.sql")) db.exec(sql);
    assertMigrated(db, before, rowids);
  } finally {
    db.close();
  }
});

test("the full migration set is what the Miniflare harness applies (0004 included)", () => {
  assert.ok(migrationStatements().some((s) => s.startsWith("CREATE TABLE sessions_new")));
});

function wrangler(dir: string, config: string, args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && !k.startsWith("CLOUDFLARE_") && !k.startsWith("CF_")) env[k] = v;
  env["WRANGLER_SEND_METRICS"] = "false";
  env["CI"] = "1";
  return spawnSync(path.join(root, "node_modules", ".bin", "wrangler"), ["d1", ...args, "DB", "--local", "--persist-to", path.join(dir, "state"), "-c", config], { cwd: dir, env, encoding: "utf8", timeout: 120_000 });
}

test("wrangler applies 0004 over a populated 0001-0003 database (the live rollout path)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piquette-cloud-mig-pop-"));
  try {
    const mdir = path.join(dir, "migrations");
    mkdirSync(mdir);
    for (const f of readdirSync(migrations).sort().filter((x) => Number(x.slice(0, 4)) <= 3)) copyFileSync(path.join(migrations, f), path.join(mdir, f));
    const config = path.join(dir, "wrangler.json");
    writeFileSync(config, JSON.stringify({ name: "piquette-mig-test", compatibility_date: "2026-07-01", d1_databases: [{ binding: "DB", database_name: "piquette-hub", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: mdir }] }));
    const first = wrangler(dir, config, ["migrations", "apply"]);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    // seed through a throwaway sqlite copy of the statements, written as a SQL file for `d1 execute --file`
    const scratch = new DatabaseSync(":memory:");
    for (const sql of upTo(3)) scratch.exec(sql);
    seedOld(scratch);
    const tables = ["factories", ...TABLES8];
    const lines: string[] = [];
    for (const t of tables) {
      const rows = scratch.prepare(`SELECT rowid AS _r, * FROM ${t}`).all() as Record<string, unknown>[];
      for (const r of rows) {
        const { _r, ...cols } = r;
        const names = Object.keys(cols);
        const lit = (v: unknown) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
        lines.push(`INSERT INTO ${t} (rowid, ${names.join(", ")}) VALUES (${_r}, ${names.map((n) => lit(cols[n])).join(", ")});`);
      }
    }
    scratch.close();
    const seedFile = path.join(dir, "seed.sql");
    writeFileSync(seedFile, lines.join("\n") + "\n");
    const seeded = spawnSync(path.join(root, "node_modules", ".bin", "wrangler"), ["d1", "execute", "DB", "--local", "--persist-to", path.join(dir, "state"), "-c", config, "--file", seedFile], { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, encoding: "utf8", timeout: 120_000 });
    assert.equal(seeded.status, 0, `${seeded.stdout}\n${seeded.stderr}`);
    copyFileSync(path.join(migrations, "0004_session_repo_key.sql"), path.join(mdir, "0004_session_repo_key.sql"));
    const second = wrangler(dir, config, ["migrations", "apply"]);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const found: string[] = [];
    const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".sqlite") && found.push(path.join(d, e.name))));
    walk(path.join(dir, "state"));
    const db = new DatabaseSync(found.find((f) => /miniflare-D1DatabaseObject/.test(f)) ?? found[0]!);
    const ref = new DatabaseSync(":memory:");
    for (const sql of upTo(3)) ref.exec(sql);
    seedOld(ref);
    const before: Record<string, number> = {};
    const rowids: Record<string, number[]> = {};
    for (const t of TABLES8) {
      before[t] = (ref.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      rowids[t] = (ref.prepare(`SELECT rowid FROM ${t} ORDER BY rowid`).all() as { rowid: number }[]).map((r) => r.rowid);
    }
    ref.close();
    assertMigrated(db, before, rowids);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").get() as { n: number }).n, 4);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrangler applies 0005 over a populated 0001-0004 database: rows and rowids kept, the four link columns added as NULL", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piquette-cloud-mig-links-"));
  try {
    const mdir = path.join(dir, "migrations");
    mkdirSync(mdir);
    for (const f of readdirSync(migrations).sort().filter((x) => Number(x.slice(0, 4)) <= 4)) copyFileSync(path.join(migrations, f), path.join(mdir, f));
    const config = path.join(dir, "wrangler.json");
    writeFileSync(config, JSON.stringify({ name: "piquette-mig-test", compatibility_date: "2026-07-01", d1_databases: [{ binding: "DB", database_name: "piquette-hub", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: mdir }] }));
    const first = wrangler(dir, config, ["migrations", "apply"]);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    // The populated 0004 database, built in a scratch sqlite and replayed through `d1 execute --file` with its rowids.
    const ref = new DatabaseSync(":memory:");
    for (const sql of upTo(3)) ref.exec(sql);
    seedOld(ref);
    for (const sql of fileStatements("0004_session_repo_key.sql")) ref.exec(sql);
    const lit = (v: unknown) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
    const lines: string[] = [];
    const before: Record<string, number> = {};
    const rowids: Record<string, number[]> = {};
    for (const t of ["factories", ...TABLES8]) {
      const rows = ref.prepare(`SELECT rowid AS _r, * FROM ${t} ORDER BY rowid`).all() as Record<string, unknown>[];
      before[t] = rows.length;
      rowids[t] = rows.map((r) => r["_r"] as number);
      for (const { _r, ...cols } of rows) {
        const names = Object.keys(cols);
        lines.push(`INSERT INTO ${t} (rowid, ${names.join(", ")}) VALUES (${_r}, ${names.map((n) => lit(cols[n])).join(", ")});`);
      }
    }
    ref.close();
    assert.ok(before["sessions"]! >= 1);
    const seedFile = path.join(dir, "seed.sql");
    writeFileSync(seedFile, lines.join("\n") + "\n");
    const seeded = wrangler(dir, config, ["execute", "--file", seedFile]);
    assert.equal(seeded.status, 0, `${seeded.stdout}\n${seeded.stderr}`);
    copyFileSync(path.join(migrations, "0005_session_links.sql"), path.join(mdir, "0005_session_links.sql"));
    const second = wrangler(dir, config, ["migrations", "apply"]);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const found: string[] = [];
    const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".sqlite") && found.push(path.join(d, e.name))));
    walk(path.join(dir, "state"));
    const db = new DatabaseSync(found.find((f) => /miniflare-D1DatabaseObject/.test(f)) ?? found[0]!);
    for (const t of ["factories", ...TABLES8]) {
      const after = (db.prepare(`SELECT rowid FROM ${t} ORDER BY rowid`).all() as { rowid: number }[]).map((r) => r.rowid);
      assert.deepEqual(after, rowids[t], `${t} rows and rowids kept`);
    }
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["issue_label", "issue_url", "pr_label", "pr_url"]) {
      assert.ok(cols.includes(c), c);
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${c} IS NOT NULL`).get() as { n: number }).n, 0, `${c} is NULL on every existing row`);
    }
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").get() as { n: number }).n, 5);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
