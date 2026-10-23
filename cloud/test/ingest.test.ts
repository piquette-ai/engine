import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SyncBatchSchema, SyncSessionRowSchema, SyncPhaseRowSchema, SyncAgentSessionRowSchema, SyncEnvelopeRowSchema, SyncEventRowSchema, SyncGateRowSchema, SyncPromptRowSchema } from "../../src/core/sync/contract.ts";
import * as v from "valibot";
import { signToken, startSite, type Site } from "./harness.ts";
import { FACTORY_A, FACTORY_B, SVC_A, SVC_B, count, makeBatch, seedCredentials, type BatchOpts } from "./ingest_helpers.ts";

let site: Site;
let db: any;
const TABLES = ["factories", "sessions", "phases", "agent_sessions", "envelopes", "events", "gate_results", "prompts"];

async function post(body: unknown, o: { cn?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const token = await signToken({ commonName: o.cn ?? SVC_A });
  return site.fetch("/ingest/v1", { method: "POST", token, headers: { "content-type": "application/json", ...(o.headers ?? {}) }, body: o.raw ?? JSON.stringify(body) });
}
const snapshotCounts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(db, t)])));

describe("ingest", () => {
  before(async () => {
    site = await startSite({ SPF_MODULES: "receipts,ingest", D1: "1", MAX_BODY_BYTES: "200000" });
    db = await site.db();
    await seedCredentials(db, [
      { cn: SVC_A, tenant: "tenant-a" },
      { cn: SVC_B, tenant: "tenant-b" },
      { cn: "svc-pinned.access", tenant: "tenant-a", factory: FACTORY_A },
    ]);
  });
  after(() => site.dispose());

  test("rows land under the credential's tenant with the lowercased repo; replays change nothing", async () => {
    const res = await post(makeBatch({ events: 3, gates: 2 }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, accepted: { sessions: 1, events: 3, gates: 2 } });
    const s = await db.prepare("SELECT tenant, repo, level FROM sessions").first();
    assert.deepEqual({ ...s }, { tenant: "tenant-a", repo: "example.com/acme/api", level: "trace" });
    assert.equal((await db.prepare("SELECT tenant FROM factories").first()).tenant, "tenant-a");
    const before = await snapshotCounts();
    assert.equal(before.events, 3);
    assert.equal((await post(makeBatch({ events: 3, gates: 2 }))).status, 200);
    assert.deepEqual(await snapshotCounts(), before);
  });

  test("the tenant is never taken from the payload", async () => {
    const b = makeBatch({ factory: FACTORY_B, adw: "adw-t" }) as any;
    b.tenant = "tenant-a";
    b.factory.tenant = "tenant-a";
    b.sessions[0].snapshot.session.tenant = "tenant-a";
    assert.equal((await post(b, { cn: SVC_B })).status, 200);
    assert.equal((await db.prepare("SELECT tenant FROM sessions WHERE adw_id = 'adw-t'").first()).tenant, "tenant-b");
    assert.equal((await db.prepare("SELECT tenant FROM factories WHERE factory_id = ?").bind(FACTORY_B).first()).tenant, "tenant-b");
  });

  test("403 and no rows: unknown credential, pinned mismatch, a factory owned by another tenant, a row for another factory", async () => {
    const before = await snapshotCounts();
    assert.equal((await post(makeBatch({ adw: "x1" }), { cn: "svc-unknown.access" })).status, 403);
    assert.equal((await post(makeBatch({ adw: "x2", factory: FACTORY_B }), { cn: "svc-pinned.access" })).status, 403);
    // FACTORY_A is tenant-a's; tenant-b's credential may not push for it
    assert.equal((await post(makeBatch({ adw: "x3", factory: FACTORY_A }), { cn: SVC_B })).status, 403);
    const forged = makeBatch({ adw: "x4" });
    forged.sessions[0]!.events[0]!.factory_id = FACTORY_B;
    assert.equal((await post(forged)).status, 403);
    assert.deepEqual(await snapshotCounts(), before);
  });

  test("a row whose adw_id differs from its entry is 400", async () => {
    const before = await snapshotCounts();
    for (const mutate of [
      (b: any) => (b.sessions[0].events[0].adw_id = "other"),
      (b: any) => (b.sessions[0].gate_results[0].adw_id = "other"),
      (b: any) => (b.sessions[0].snapshot.phases[0].adw_id = "other"),
      (b: any) => (b.sessions[0].snapshot.session.adw_id = "other"),
      (b: any) => (b.sessions[0].snapshot.envelopes[0].adw_id = "other"),
    ]) {
      const b = makeBatch({ adw: "y1" });
      mutate(b);
      assert.equal((await post(b)).status, 400);
    }
    assert.deepEqual(await snapshotCounts(), before);
  });

  test("sync_schema outside [1,1] is 409 with the range; the header must agree with the body", async () => {
    for (const n of [0, 2]) {
      const res = await post({ ...makeBatch(), sync_schema: n });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { supported: [1, 1] });
    }
    assert.equal((await post(makeBatch(), { headers: { "X-SPF-Sync-Schema": "2" } })).status, 400);
    assert.equal((await post(makeBatch({ adw: "h1" }), { headers: { "X-SPF-Sync-Schema": "1" } })).status, 200);
  });

  test("unknown fields are dropped (200); bad JSON is 400 with no echo; oversize is 413", async () => {
    const b = makeBatch({ adw: "u1" }) as any;
    b.surprise = "x";
    b.sessions[0].events[0].surprise = "y";
    assert.equal((await post(b)).status, 200);
    const bad = await post(null, { raw: "{not json SECRET-VALUE" });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(await bad.text(), /SECRET-VALUE/);
    const wrong = await post({ ...makeBatch(), level: "everything" });
    assert.equal(wrong.status, 400);
    const body = (await wrong.json()) as { error: string; paths: string[] };
    assert.equal(body.error, "invalid_batch");
    assert.ok(body.paths.length <= 5 && body.paths.includes("level"));
    assert.equal((await post(null, { raw: "x".repeat(250_000) })).status, 413);
  });

  test("two factories of one tenant with the same adw_id coexist", async () => {
    await seedCredentials(db, [{ cn: "svc-a2.access", tenant: "tenant-a" }]);
    assert.equal((await post(makeBatch({ adw: "same", factory: FACTORY_A }))).status, 200);
    const other = "cccccccc-3333-4333-8333-cccccccccccc";
    assert.equal((await post(makeBatch({ adw: "same", factory: other }), { cn: "svc-a2.access" })).status, 200);
    assert.equal(await count(db, "sessions", "adw_id = 'same'"), 2);
  });

  test("an older sent_at arriving late does not regress a session", async () => {
    await post(makeBatch({ adw: "ord", status: "completed", sentAt: "2026-02-02T00:00:00.000Z" }));
    await post(makeBatch({ adw: "ord", status: "running", sentAt: "2026-02-01T00:00:00.000Z" }));
    assert.equal((await db.prepare("SELECT status FROM sessions WHERE adw_id = 'ord'").first()).status, "completed");
    await post(makeBatch({ adw: "ord", status: "failed", sentAt: "2026-02-03T00:00:00.000Z" }));
    assert.equal((await db.prepare("SELECT status FROM sessions WHERE adw_id = 'ord'").first()).status, "failed");
  });

  test("a malformed or far-future sent_at is refused and writes nothing", async () => {
    const before = await snapshotCounts();
    for (const bad of ["", "yesterday", "9999-01-01T00:00:00Z", "2026-01-01 00:00:00", new Date(Date.now() + 3_600_000).toISOString()]) {
      const res = await post(makeBatch({ adw: "badts", sentAt: bad }));
      assert.equal(res.status, 400, bad);
      assert.deepEqual(await res.json(), { error: "invalid_sent_at" });
    }
    assert.deepEqual(await snapshotCounts(), before);
    assert.equal((await post(makeBatch({ adw: "okts", sentAt: new Date().toISOString() }))).status, 200);
  });

  test("a summary snapshot after a trace snapshot keeps request, phase error and envelope payload", async () => {
    await post(makeBatch({ adw: "tier", level: "trace", sentAt: "2026-03-01T00:00:00.000Z" }));
    await post(makeBatch({ adw: "tier", level: "summary", request: null, envelopePayload: null, sentAt: "2026-03-02T00:00:00.000Z", status: "failed" }));
    const s = await db.prepare("SELECT request, status, level FROM sessions WHERE adw_id = 'tier'").first();
    assert.deepEqual({ ...s }, { request: "do the thing", status: "failed", level: "summary" });
    assert.equal((await db.prepare("SELECT error FROM phases WHERE adw_id = 'tier'").first()).error, "ERR-DETAIL");
    assert.equal((await db.prepare("SELECT payload_json FROM envelopes WHERE adw_id = 'tier'").first()).payload_json !== null, true);
  });

  test("factories.last_seen_at, spf_version and repo update on every ingest", async () => {
    await post(makeBatch({ adw: "seen", repo: "example.com/acme/api" }));
    const first = await db.prepare("SELECT last_seen_at FROM factories WHERE factory_id = ?").bind(FACTORY_A).first();
    await new Promise((r) => setTimeout(r, 15));
    const b = makeBatch({ adw: "seen", repo: "example.com/acme/renamed" });
    b.spf_version = "10.0.0";
    await post(b);
    const f = await db.prepare("SELECT last_seen_at, spf_version, repo FROM factories WHERE factory_id = ?").bind(FACTORY_A).first();
    assert.ok(f.last_seen_at > first.last_seen_at);
    assert.equal(f.spf_version, "10.0.0");
    assert.equal(f.repo, "example.com/acme/renamed");
  });

  test("decision, decision_triage and legacy jev_* events land verbatim", async () => {
    for (const [i, name] of ["decision", "decision_triage", "jev_decision", "jev_choice", "jev_triage"].entries()) {
      assert.equal((await post(makeBatch({ adw: `ev${i}`, events: 1, eventType: "log", eventName: name }))).status, 200);
      assert.equal((await db.prepare("SELECT name FROM events WHERE adw_id = ?").bind(`ev${i}`).first()).name, name);
    }
  });

  test("atomic: a failing statement leaves no rows from the batch and last_seen_at unchanged", async () => {
    await post(makeBatch({ adw: "atomic0" }));
    const seen = (await db.prepare("SELECT last_seen_at FROM factories WHERE factory_id = ?").bind(FACTORY_A).first()).last_seen_at;
    const rows = await snapshotCounts();
    await db.prepare("ALTER TABLE gate_results RENAME TO gate_results_off").run();
    try {
      await new Promise((r) => setTimeout(r, 15));
      const res = await post(makeBatch({ adw: "atomic1", gates: 1 }));
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "ingest_failed" });
    } finally {
      await db.prepare("ALTER TABLE gate_results_off RENAME TO gate_results").run();
    }
    assert.equal(await count(db, "sessions", "adw_id = 'atomic1'"), 0);
    assert.equal(await count(db, "events", "adw_id = 'atomic1'"), 0);
    assert.equal((await db.prepare("SELECT last_seen_at FROM factories WHERE factory_id = ?").bind(FACTORY_A).first()).last_seen_at, seen);
    assert.deepEqual(await snapshotCounts(), rows);
  });

  test("an append-only entry bumps synced_at of its session and nothing else", async () => {
    await post(makeBatch({ adw: "app" }));
    const before = (await db.prepare("SELECT synced_at FROM sessions WHERE adw_id = 'app'").first()).synced_at;
    await new Promise((r) => setTimeout(r, 15));
    await post(makeBatch({ adw: "app", snapshot: false, events: 1, eventBase: 50 }));
    const after = (await db.prepare("SELECT synced_at, status FROM sessions WHERE adw_id = 'app'").first());
    assert.ok(after.synced_at > before);
    assert.equal(after.status, "completed");
  });

  test("GET: 401 without a token, 200 {supported} with a mapped token, 403 for an unmapped one; other paths 404", async () => {
    assert.equal((await site.fetch("/ingest/v1", { token: null })).status, 401);
    const ok = await site.fetch("/ingest/v1", { token: await signToken({ commonName: SVC_A }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { supported: [1, 1] });
    assert.equal((await site.fetch("/ingest/v1", { token: await signToken({ commonName: "svc-nobody.access" }) })).status, 403);
    assert.equal((await site.fetch("/ingest/v2", { token: await signToken({ commonName: SVC_A }) })).status, 404);
    assert.equal((await site.fetch("/ingest", { token: await signToken({ commonName: SVC_A }) })).status, 404);
  });

  test("an identity token (a person) cannot ingest", async () => {
    const res = await site.fetch("/ingest/v1", { method: "POST", body: JSON.stringify(makeBatch({ adw: "idn" })) });
    assert.equal(res.status, 403);
    assert.equal(await count(db, "sessions", "adw_id = 'idn'"), 0);
  });

  test("contract drift: every contract column exists in the migrated table", async () => {
    const pairs: [string, { entries: Record<string, unknown> }][] = [
      ["sessions", SyncSessionRowSchema],
      ["phases", SyncPhaseRowSchema],
      ["agent_sessions", SyncAgentSessionRowSchema],
      ["envelopes", SyncEnvelopeRowSchema],
      ["events", SyncEventRowSchema],
      ["gate_results", SyncGateRowSchema],
      ["prompts", SyncPromptRowSchema],
    ];
    for (const [table, schema] of pairs) {
      const have = new Set(((await db.prepare(`PRAGMA table_info(${table})`).all()).results as { name: string }[]).map((c) => c.name));
      for (const key of Object.keys(schema.entries)) assert.ok(have.has(key), `${table}.${key}`);
    }
    assert.ok(v.safeParse(SyncBatchSchema, makeBatch()).success, "helper batches are contract-valid");
  });
});

describe("ingest: field limits", () => {
  test("a field over MAX_FIELD_BYTES is stored as a truncation marker, not the data", async () => {
    const s = await startSite({ SPF_MODULES: "ingest", D1: "1" });
    try {
      const d = await s.db();
      await seedCredentials(d, [{ cn: SVC_A, tenant: "tenant-a" }]);
      const b = makeBatch({ adw: "big", events: 1 });
      b.sessions[0]!.events[0]!.payload_json = "z".repeat(300_000);
      const res = await s.fetch("/ingest/v1", { method: "POST", token: await signToken({ commonName: SVC_A }), body: JSON.stringify(b) });
      assert.equal(res.status, 200);
      assert.equal((await d.prepare("SELECT payload_json FROM events").first()).payload_json, JSON.stringify({ _spf_truncated: 300_000 }));
    } finally {
      await s.dispose();
    }
  });
});

describe("ingest: full tier", () => {
  test("prompts land only from a full-level snapshot and carry the session's level", async () => {
    const s = await startSite({ SPF_MODULES: "ingest", D1: "1" });
    try {
      const d = await s.db();
      await seedCredentials(d, [{ cn: SVC_A, tenant: "tenant-a" }]);
      const res = await s.fetch("/ingest/v1", { method: "POST", token: await signToken({ commonName: SVC_A }), body: JSON.stringify(makeBatch({ adw: "f1", level: "full", prompts: true } as BatchOpts)) });
      assert.equal(res.status, 200);
      assert.equal((await d.prepare("SELECT user FROM prompts").first()).user, "USER-PROMPT");
      assert.equal((await d.prepare("SELECT level FROM sessions").first()).level, "full");
    } finally {
      await s.dispose();
    }
  });
});
