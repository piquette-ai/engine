import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { parseRetention, runRetention } from "../src/ingest/retention.ts";
import { signToken, startSite, type Site } from "./harness.ts";
import { FACTORY_A, SVC_A, count, makeBatch, seedCredentials } from "./ingest_helpers.ts";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("retention", () => {
  let site: Site;
  let db: any;
  before(async () => {
    site = await startSite({ PIQUETTE_MODULES: "ingest", D1: "1" });
    db = await site.db();
    await seedCredentials(db, [{ cn: SVC_A, tenant: "tenant-a" }]);
  });
  after(() => site.dispose());

  /** Seeds a session with detail rows directly, with chosen timestamps. */
  async function seed(adw: string, o: { ended: string | null; synced: string; prompts?: boolean }) {
    const b = makeBatch({ adw, events: 3, gates: 2, level: "full", prompts: o.prompts ?? true, endedAt: o.ended });
    const res = await site.fetch("/ingest/v1", { method: "POST", token: await signToken({ commonName: SVC_A }), body: JSON.stringify(b) });
    assert.equal(res.status, 200);
    await db.prepare("UPDATE sessions SET synced_at = ?, pruned_at = NULL WHERE adw_id = ?").bind(o.synced, adw).run();
  }
  const detail = async (adw: string) => ({
    events: await count(db, "events", "adw_id = ?", adw),
    prompts: await count(db, "prompts", "adw_id = ?", adw),
    session: await count(db, "sessions", "adw_id = ?", adw),
    phases: await count(db, "phases", "adw_id = ?", adw),
    agents: await count(db, "agent_sessions", "adw_id = ?", adw),
    gates: await count(db, "gate_results", "adw_id = ?", adw),
  });

  test("90 days: old detail is pruned, summaries and gate verdicts are kept, recent and running are untouched", async () => {
    await seed("old", { ended: daysAgo(120), synced: daysAgo(120) });
    await seed("recent", { ended: daysAgo(10), synced: daysAgo(10) });
    await seed("running", { ended: null, synced: daysAgo(0.01) });
    const report = await runRetention(db, { days: 90, now: NOW });
    assert.equal(report.sessions, 1);
    assert.equal(report.eventsDeleted, 3);
    assert.equal(report.promptsDeleted, 1);
    assert.deepEqual(await detail("old"), { events: 0, prompts: 0, session: 1, phases: 1, agents: 1, gates: 2 });
    assert.equal((await db.prepare("SELECT checks_json, passed FROM gate_results WHERE adw_id = 'old' LIMIT 1").first()).checks_json, null);
    assert.equal((await db.prepare("SELECT passed FROM gate_results WHERE adw_id = 'old' LIMIT 1").first()).passed, 1);
    assert.equal((await db.prepare("SELECT payload_json FROM envelopes WHERE adw_id = 'old'").first()).payload_json, null);
    assert.ok((await db.prepare("SELECT pruned_at FROM sessions WHERE adw_id = 'old'").first()).pruned_at);
    for (const keep of ["recent", "running"]) assert.deepEqual(await detail(keep), { events: 3, prompts: 1, session: 1, phases: 1, agents: 1, gates: 2 }, keep);
    assert.equal(await count(db, "factories"), 1, "factories are never deleted");
  });

  test("the same adw_id old in repo A and fresh in repo B: only A is pruned", async () => {
    const RA = "example.com/acme/ra";
    const RB = "example.com/acme/rb";
    for (const [repo, when] of [[RA, daysAgo(200)], [RB, daysAgo(1)]] as const) {
      const b = makeBatch({ adw: "twin", repo, events: 3, gates: 1, gateBase: 7000, level: "full", prompts: true, endedAt: when });
      assert.equal((await site.fetch("/ingest/v1", { method: "POST", token: await signToken({ commonName: SVC_A }), body: JSON.stringify(b) })).status, 200);
      await db.prepare("UPDATE sessions SET synced_at = ?, pruned_at = NULL WHERE adw_id = 'twin' AND repo = ?").bind(when, repo).run();
    }
    await runRetention(db, { days: 90, now: NOW });
    const n = (t: string, repo: string) => count(db, t, "adw_id = 'twin' AND repo = ?", repo);
    assert.deepEqual([await n("events", RA), await n("prompts", RA)], [0, 0]);
    assert.deepEqual([await n("events", RB), await n("prompts", RB)], [3, 1]);
    assert.ok((await db.prepare("SELECT pruned_at FROM sessions WHERE adw_id = 'twin' AND repo = ?").bind(RA).first()).pruned_at);
    assert.equal((await db.prepare("SELECT pruned_at FROM sessions WHERE adw_id = 'twin' AND repo = ?").bind(RB).first()).pruned_at, null);
  });

  test("a re-ingested pruned session is pruned again; a second sweep does nothing", async () => {
    assert.equal((await runRetention(db, { days: 90, now: NOW })).sessions, 0);
    await seed("old", { ended: daysAgo(120), synced: daysAgo(120) });
    const res = await site.fetch("/ingest/v1", { method: "POST", token: await signToken({ commonName: SVC_A }), body: JSON.stringify(makeBatch({ adw: "old", events: 3, endedAt: daysAgo(120) })) });
    assert.equal(res.status, 200);
    // synced_at is now fresh (ingest time), so it is a candidate only once its own age passes the cutoff: simulate by moving "now"
    const later = new Date(Date.now() + 200 * 86_400_000);
    const report = await runRetention(db, { days: 90, now: later });
    assert.ok(report.sessions >= 1);
    assert.equal((await detail("old")).events, 0);
  });

  test("RETENTION_DAYS=7 prunes a 10-day-old session", async () => {
    await seed("ten", { ended: daysAgo(10), synced: daysAgo(10) });
    const report = await runRetention(db, { days: 7, now: NOW });
    assert.ok(report.sessions >= 1);
    assert.equal((await detail("ten")).events, 0);
  });

  test("parseRetention: 0 disables, integers are days, everything else is invalid (never a default)", () => {
    assert.deepEqual(parseRetention("0"), { kind: "off" });
    assert.deepEqual(parseRetention("90"), { kind: "days", days: 90 });
    for (const bad of ["abc", "", undefined, "-5", "1.5", "9e3", "90d", "999999"]) assert.deepEqual(parseRetention(bad), { kind: "invalid" }, String(bad));
  });

  test("the scheduled handler sweeps when configured, skips on invalid or 0, and does nothing without ingest", async () => {
    const run = async (opts: Record<string, string>): Promise<{ events: number }> => {
      const s = await startSite({ D1: "1", ...opts });
      try {
        const d = await s.db();
        await seedCredentials(d, [{ cn: SVC_A, tenant: "tenant-a" }]);
        const res = await s.fetch("/ingest/v1", { method: "POST", token: await signToken({ commonName: SVC_A }), body: JSON.stringify(makeBatch({ adw: "sch", events: 2, endedAt: "2020-01-01T00:00:00.000Z" })) });
        if (opts["PIQUETTE_MODULES"]?.includes("ingest")) assert.equal(res.status, 200);
        await d.prepare("UPDATE sessions SET synced_at = '2020-01-02T00:00:00.000Z'").run();
        await (await s.mf.getWorker()).scheduled({ cron: "17 3 * * *" });
        return { events: await count(d, "events") };
      } finally {
        await s.dispose();
      }
    };
    assert.equal((await run({ PIQUETTE_MODULES: "ingest", RETENTION_DAYS: "90" })).events, 0);
    assert.equal((await run({ PIQUETTE_MODULES: "ingest", RETENTION_DAYS: "0" })).events, 2);
    assert.equal((await run({ PIQUETTE_MODULES: "ingest", RETENTION_DAYS: "abc" })).events, 2);
    assert.equal((await run({ PIQUETTE_MODULES: "receipts", RETENTION_DAYS: "90" })).events, 0, "no ingest module: nothing was ingested to begin with");
  });
});
void FACTORY_A;
