/**
 * The issue and PR a run belongs to (`core/run_links.ts`): how `spf watch`
 * labels them, how the tracer stores them on the session row, and how the
 * local reader (`spf ui`'s `SfDb`) hands them back — NULL for an
 * interactive run and for a db that predates the columns.
 */
import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanLink, issueLabel, issueLink, prLink, safeLinkUrl } from "../core/run_links.js";
import { Tracer } from "../core/tracer.js";
import { SfDb } from "../ui/server/db.js";
import * as v from "valibot";
import { SyncBatchSchema } from "../core/sync/contract.js";
import * as steps from "../chains/steps.js";

test("issueLink: a GitHub number gets a #, a Jira key stays a key", () => {
  assert.deepEqual(issueLink({ id: "216", url: "https://github.com/acme/api/issues/216" }), { label: "#216", url: "https://github.com/acme/api/issues/216" });
  assert.deepEqual(issueLink({ id: "BT-1221", url: "https://acme.atlassian.net/browse/BT-1221" }), { label: "BT-1221", url: "https://acme.atlassian.net/browse/BT-1221" });
  assert.deepEqual(issueLink({ id: "42" }), { label: "#42", url: null }, "no URL reported: label only, never a guessed URL");
  assert.equal(issueLabel("#7"), "#7");
});

test("prLink: always #<number>; an empty URL (a PR known only by number) is null", () => {
  assert.deepEqual(prLink({ number: 217, url: "https://github.com/acme/api/pull/217" }), { label: "#217", url: "https://github.com/acme/api/pull/217" });
  assert.deepEqual(prLink({ number: 12, url: "" }), { label: "#12", url: null });
});

test("safeLinkUrl / cleanLink: only absolute http(s) URLs survive; labels are one capped line", () => {
  assert.equal(safeLinkUrl("javascript:alert(1)"), null);
  assert.equal(safeLinkUrl("/issues/1"), null);
  assert.equal(safeLinkUrl("https://x.test/a b"), null);
  assert.equal(safeLinkUrl("  HTTPS://x.test/1  "), "HTTPS://x.test/1");
  assert.equal(safeLinkUrl("https://user:token@acme.atlassian.net/browse/BT-1"), null, "credentials in the authority never survive");
  assert.equal(safeLinkUrl("https://acme.atlassian.net/browse/BT-1?focus=a@b"), "https://acme.atlassian.net/browse/BT-1?focus=a@b", "an @ past the authority is fine");
  assert.equal(cleanLink({ label: "   ", url: "https://x.test" }), null);
  assert.deepEqual(cleanLink({ label: "#1\n#2", url: "data:text/html,hi" }), { label: "#1 #2", url: null });
  assert.equal(cleanLink({ label: "x".repeat(500), url: null })!.label.length, 100);
});

async function withDb(fn: (tracer: Tracer, dbPath: string, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "spf-run-links-"));
  const dbPath = join(dir, "spf.db");
  const tracer = await Tracer.open(dbPath, join(dir, "events.jsonl"));
  try {
    await fn(tracer, dbPath, dir);
  } finally {
    await tracer.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const linkCols = (dbPath: string, adw: string) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT issue_label, issue_url, pr_label, pr_url FROM sessions WHERE adw_id = ?").get(adw) as Record<string, unknown>;
  } finally {
    db.close();
  }
};

test("Tracer.sessionLinks: the issue at start, the PR later; an interactive run keeps NULLs", async () => {
  await withDb(async (tracer, dbPath) => {
    await tracer.sessionStart("issue-216", "watch", "plan-build-test");
    await tracer.sessionStart("interactive", "jd", "scout");
    assert.equal(await tracer.sessionLinks("issue-216", { issue: issueLink({ id: "216", url: "https://github.com/acme/api/issues/216" }) }), true);
    assert.deepEqual({ ...linkCols(dbPath, "issue-216") }, { issue_label: "#216", issue_url: "https://github.com/acme/api/issues/216", pr_label: null, pr_url: null });
    await tracer.sessionLinks("issue-216", { pr: prLink({ number: 217, url: "https://github.com/acme/api/pull/217" }) });
    assert.deepEqual(
      { ...linkCols(dbPath, "issue-216") },
      { issue_label: "#216", issue_url: "https://github.com/acme/api/issues/216", pr_label: "#217", pr_url: "https://github.com/acme/api/pull/217" },
      "recording the PR leaves the issue alone",
    );
    assert.deepEqual({ ...linkCols(dbPath, "interactive") }, { issue_label: null, issue_url: null, pr_label: null, pr_url: null });
  });
});

test("Tracer.sessionLinks: a PR known only by number keeps its URL; a different PR without one drops the old URL", async () => {
  await withDb(async (tracer, dbPath) => {
    await tracer.sessionStart("issue-9", "watch", "plan-build-test");
    await tracer.sessionLinks("issue-9", { pr: { label: "#30", url: "https://bitbucket.org/acme/api/pull-requests/30" } });
    await tracer.sessionLinks("issue-9", { pr: { label: "#30", url: null } }); // a revision pushed to the same PR
    assert.equal(linkCols(dbPath, "issue-9").pr_url, "https://bitbucket.org/acme/api/pull-requests/30");
    await tracer.sessionLinks("issue-9", { pr: { label: "#31", url: null } });
    assert.deepEqual([linkCols(dbPath, "issue-9").pr_label, linkCols(dbPath, "issue-9").pr_url], ["#31", null], "never #31 pointing at #30's page");
  });
});

test("Tracer.sessionLinks: never creates a session row, and stores no unsafe URL", async () => {
  await withDb(async (tracer, dbPath) => {
    assert.equal(await tracer.sessionLinks("not-started", { issue: { label: "#1", url: "https://x.test/1" } }), false);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 0);
    db.close();
    await tracer.sessionStart("s", "watch", "c");
    await tracer.sessionLinks("s", { issue: { label: "#1", url: "javascript:alert(1)" } });
    assert.deepEqual([linkCols(dbPath, "s").issue_label, linkCols(dbPath, "s").issue_url], ["#1", null]);
  });
});

test("SfDb: the sessions list and the session detail carry the links; NULL where none were recorded", async () => {
  await withDb(async (tracer, dbPath, dir) => {
    await tracer.sessionStart("issue-216", "watch", "plan-build-test");
    await tracer.sessionStart("interactive", "jd", "scout");
    await tracer.sessionLinks("issue-216", { issue: { label: "BT-1221", url: "https://acme.atlassian.net/browse/BT-1221" }, pr: { label: "#217", url: "https://github.com/acme/api/pull/217" } });
    const sfdb = await SfDb.open(dbPath, join(dir, "sessions"));
    try {
      const list = await sfdb.sessions();
      const row = list.find((s) => s.adw_id === "issue-216")!;
      assert.deepEqual([row.issue_label, row.issue_url, row.pr_label, row.pr_url], ["BT-1221", "https://acme.atlassian.net/browse/BT-1221", "#217", "https://github.com/acme/api/pull/217"]);
      const plain = list.find((s) => s.adw_id === "interactive")!;
      assert.deepEqual([plain.issue_label, plain.issue_url, plain.pr_label, plain.pr_url], [null, null, null, null]);
      const detail = await sfdb.session("issue-216");
      assert.equal(detail?.pr_label, "#217");
      assert.equal(detail?.issue_label, "BT-1221");
    } finally {
      await sfdb.close();
    }
  });
});

test("SfDb: a db from before the link columns reads them as NULL instead of failing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-run-links-old-"));
  try {
    const dbPath = join(dir, "spf.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sessions (adw_id TEXT PRIMARY KEY, request TEXT, status TEXT, engineer TEXT, started_at TEXT, ended_at TEXT, total_tokens INTEGER, total_cost REAL)");
    db.exec("CREATE TABLE phases (phase_id TEXT PRIMARY KEY, adw_id TEXT, seq INTEGER, name TEXT, kind TEXT, owner TEXT, description TEXT, status TEXT, attempt INTEGER, retries INTEGER, error TEXT, started_at TEXT, ended_at TEXT)");
    db.exec("CREATE TABLE agent_sessions (adw_id TEXT, agent TEXT, coding_agent TEXT, model TEXT, session_id TEXT, created_at TEXT, last_used_at TEXT)");
    db.exec("CREATE TABLE events (event_id TEXT PRIMARY KEY, adw_id TEXT, phase_id TEXT, parent_id TEXT, type TEXT, name TEXT, payload_json TEXT, tokens INTEGER, started_at TEXT, ended_at TEXT)");
    db.prepare("INSERT INTO sessions (adw_id, status, started_at) VALUES (?, ?, ?)").run("old", "success", "2026-01-01T00:00:00Z");
    db.close();
    const sfdb = await SfDb.open(dbPath, join(dir, "sessions"));
    try {
      const [row] = await sfdb.sessions();
      assert.deepEqual([row!.issue_label, row!.issue_url, row!.pr_label, row!.pr_url], [null, null, null, null]);
      assert.equal((await sfdb.session("old"))?.pr_url, null);
    } finally {
      await sfdb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync contract: a batch from a factory that predates links (no link keys) still validates; links validate when sent", () => {
  const session = { factory_id: "f", adw_id: "a", adw_name: null, request: null, status: "success", engineer: null, started_at: null, ended_at: null, total_tokens: 1, total_cost: 0, billable_tokens: 1 };
  const batch = (s: Record<string, unknown>) => ({
    sync_schema: 1,
    spf_version: "0.32.0",
    level: "summary",
    batch_id: "x",
    sent_at: "2026-01-01T00:00:00Z",
    factory: { factory_id: "f", name: "n", repo: "github.com/acme/api" },
    sessions: [{ adw_id: "a", snapshot: { session: s, phases: [], agent_sessions: [], envelopes: [], prompts: [] }, events: [], gate_results: [] }],
  });
  const old = v.safeParse(SyncBatchSchema, batch(session));
  assert.ok(old.success);
  assert.equal(old.output.sessions[0]!.snapshot!.session.pr_label, undefined);
  const withLinks = v.safeParse(SyncBatchSchema, batch({ ...session, issue_label: "BT-1221", issue_url: "https://acme.atlassian.net/browse/BT-1221", pr_label: "#217", pr_url: null }));
  assert.ok(withLinks.success);
  assert.equal(withLinks.output.sessions[0]!.snapshot!.session.issue_label, "BT-1221");
});

test("startRun: a watch dispatch's ctx.links lands on the session row at start; an interactive dispatch (no links) leaves NULLs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-run-links-start-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, "watch:\n  repo: acme/widgets\n");
    const base = { prompt: "Add a thing", config_paths: [configPath], cwd: dir, chain_name: "simple-sdlc", unattended: true };
    const watched = await steps.startRun({ ...base, adw_id: "issue-216", links: { issue: { label: "#216", url: "https://github.com/acme/widgets/issues/216" } } }, [], []);
    const plain = await steps.startRun({ ...base, adw_id: "by-hand", unattended: false }, [], []);
    try {
      const row = async (adw: string) =>
        (await watched.tracer.db.query("SELECT issue_label, issue_url, pr_label FROM sessions WHERE adw_id = ?").get(adw)) as Record<string, unknown>;
      assert.deepEqual({ ...(await row("issue-216")) }, { issue_label: "#216", issue_url: "https://github.com/acme/widgets/issues/216", pr_label: null });
      assert.deepEqual({ ...(await row("by-hand")) }, { issue_label: null, issue_url: null, pr_label: null });
    } finally {
      await watched.tracer.db.close();
      await plain.tracer.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
