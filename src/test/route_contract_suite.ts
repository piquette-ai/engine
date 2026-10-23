/**
 * One contract, two servers. `runRouteContract` pins the shapes of the dashboard
 * API (health, sessions, detail, events, envelopes, gates, prompts, archive, the
 * /api 404 and the receipt misses) so the local `spf ui` app and the hosted D1
 * Worker cannot drift apart. Compiled into dist/test (not shipped); the cloud
 * package imports it by path. No relative imports: it must load from both sides.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

export interface RouteContractFixture {
  /** A session that exists, has at least one phase, and whose agent below ran. */
  adwId: string;
  agent: string;
  hosted: boolean;
  /** Hosted: the factory that owns `adwId` (sent as `?factory=`). */
  factory?: string;
  /** True when the agent's prompts were recorded and the server may serve them. */
  expectPrompts: boolean;
  /** A run id stored under more than one repo, for the receipt 409. */
  conflictRun?: string;
}

export type ContractFetch = (path: string, init?: RequestInit) => Promise<Response>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function runRouteContract(fetchFn: ContractFetch, fx: RouteContractFixture): void {
  const q = fx.hosted && fx.factory ? `?factory=${encodeURIComponent(fx.factory)}` : "";
  const qa = q ? q.replace("?", "&") : "";
  const id = encodeURIComponent(fx.adwId);
  const json = async (path: string, init?: RequestInit) => {
    const res = await fetchFn(path, init);
    assert.match(res.headers.get("content-type") ?? "", /json/, `${path} is JSON`);
    return { res, body: (await res.json()) as any };
  };

  describe(`route contract (${fx.hosted ? "hosted" : "local"})`, () => {
    test("GET /api/health", async () => {
      const { res, body } = await json("/api/health");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(body.ok, true);
      assert.equal(typeof body.db, "string");
      assert.equal(typeof body.journal_mode, "string");
      assert.equal(typeof body.sessions, "number");
      assert.equal(body.mode, fx.hosted ? "hosted" : "local");
      if (fx.hosted) {
        assert.ok(Array.isArray(body.repos) && body.repos.every((r: unknown) => typeof r === "string"));
        assert.ok(Array.isArray(body.factories) && body.factories.length > 0);
        for (const f of body.factories) {
          assert.deepEqual(Object.keys(f).sort(), ["id", "last_seen_at", "name", "repo"]);
        }
      } else {
        assert.ok(!("repos" in body) && !("factories" in body));
      }
    });

    test("GET /api/sessions", async () => {
      const { res, body } = await json("/api/sessions");
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(body));
      const row = body.find((s: any) => s.adw_id === fx.adwId);
      assert.ok(row, "the fixture session is listed");
      for (const k of ["adw_id", "request", "status", "started_at", "total_tokens", "phases", "phase_count", "agents"]) assert.ok(k in row, k);
      assert.ok(Array.isArray(row.phases) && row.phase_count === row.phases.length && row.phases.length > 0);
      assert.ok(Array.isArray(row.agents));
      if (fx.hosted) {
        assert.equal(typeof row.factory_id, "string");
        assert.equal(typeof row.repo, "string");
      }
    });

    test("GET /api/sessions/:id and a miss", async () => {
      const { res, body } = await json(`/api/sessions/${id}${q}`);
      assert.equal(res.status, 200);
      assert.equal(body.session.adw_id, fx.adwId);
      assert.deepEqual(Object.keys(body.usage).sort(), ["read", "written"]);
      assert.ok(Array.isArray(body.phases) && Array.isArray(body.agents));
      const miss = await json(`/api/sessions/nope-nope${q}`);
      assert.equal(miss.res.status, 404);
      assert.equal(typeof miss.body.error, "string");
    });

    test("GET /api/sessions/:id/events pages with a cursor", async () => {
      const { res, body } = await json(`/api/sessions/${id}/events?after=0&limit=1${qa}`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(body.events) && typeof body.cursor === "number" && typeof body.has_more === "boolean");
      for (const e of body.events) for (const k of ["rowid", "event_id", "adw_id", "type", "payload_json"]) assert.ok(k in e, k);
      if (body.events.length > 0) assert.equal(body.cursor, body.events.at(-1).rowid);
    });

    test("GET envelopes and gates", async () => {
      const env = await json(`/api/sessions/${id}/envelopes${q}`);
      assert.equal(env.res.status, 200);
      assert.ok(Array.isArray(env.body));
      for (const e of env.body) for (const k of ["envelope_id", "adw_id", "agent", "output_type", "payload_json", "valid"]) assert.ok(k in e, k);
      const gates = await json(`/api/sessions/${id}/gates${q}`);
      assert.equal(gates.res.status, 200);
      assert.ok(Array.isArray(gates.body));
      for (const g of gates.body) for (const k of ["id", "adw_id", "gate", "passed", "violations_json", "checks_json"]) assert.ok(k in g, k);
    });

    test("GET prompts: shape, bad segment, unknown session", async () => {
      const { res, body } = await json(`/api/sessions/${id}/agents/${encodeURIComponent(fx.agent)}/prompts${q}`);
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(body).sort(), ["system", "user"]);
      if (fx.expectPrompts) assert.ok(body.system !== null || body.user !== null);
      else assert.deepEqual(body, { system: null, user: null });
      const bad = await json(`/api/sessions/${id}/agents/${encodeURIComponent("a b")}/prompts${q}`);
      assert.equal(bad.res.status, 400);
      const none = await json(`/api/sessions/nope-nope/agents/${encodeURIComponent(fx.agent)}/prompts${q}`);
      assert.equal(none.res.status, 404);
    });

    test("archive hides a session and restoring brings it back; GET and unknown ids answer JSON 404", async () => {
      const post = (body: unknown) => json(`/api/sessions/${id}/archive${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const listed = async () => ((await json("/api/sessions")).body as any[]).some((s) => s.adw_id === fx.adwId);
      const off = await post({ archived: true });
      assert.equal(off.res.status, 200);
      assert.deepEqual(off.body, { adw_id: fx.adwId, archived: true });
      assert.equal(await listed(), false);
      assert.equal((await post({ archived: false })).res.status, 200);
      assert.equal(await listed(), true);
      const unknown = await json(`/api/sessions/nope-nope/archive${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(unknown.res.status, 404);
      const get = await json(`/api/sessions/${id}/archive`);
      assert.equal(get.res.status, 404);
      const badId = await json(`/api/sessions/${encodeURIComponent("a b")}/archive`, { method: "POST", body: "{}" });
      assert.equal(badId.res.status, 400);
    });

    test("GET /api/sessions?archived=only lists reviewed runs, and the default list leaves them out", async () => {
      const post = (archived: boolean) => json(`/api/sessions/${id}/archive${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived }) });
      const inList = async (path: string) => {
        const { res, body } = await json(path);
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(body));
        return (body as any[]).some((s) => s.adw_id === fx.adwId);
      };
      assert.equal(await inList("/api/sessions?archived=only"), false);
      assert.equal((await post(true)).res.status, 200);
      assert.equal(await inList("/api/sessions?archived=only"), true);
      assert.equal(await inList("/api/sessions"), false);
      assert.equal((await post(false)).res.status, 200);
      assert.equal(await inList("/api/sessions?archived=only"), false);
      assert.equal(await inList("/api/sessions"), true);
    });

    test("POST /api/reviews archives by body, as the hosted UI sends it", async () => {
      const post = (archived: boolean) =>
        json("/api/reviews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ adw_id: fx.adwId, factory_id: fx.hosted ? (fx.factory ?? null) : null, archived }) });
      assert.equal((await post(true)).res.status, 200);
      assert.equal(((await json("/api/sessions")).body as any[]).some((s) => s.adw_id === fx.adwId), false);
      assert.equal((await post(false)).res.status, 200);
      assert.equal(((await json("/api/sessions")).body as any[]).some((s) => s.adw_id === fx.adwId), true);
      assert.equal((await json("/api/reviews", { method: "POST", body: "{}" })).res.status, 400);
    });

    test("an /api miss is JSON 404, never the SPA", async () => {
      const { res, body } = await json("/api/definitely-not-a-route");
      assert.equal(res.status, 404);
      assert.ok(isObj(body) && typeof body.error === "string");
    });

    test("receipts: a run with no receipt is a JSON 404; a run under two repos is a 409 with candidates", async () => {
      const miss = await json("/api/receipts/no-such-run");
      assert.equal(miss.res.status, 404);
      assert.equal(typeof miss.body.error, "string");
      if (fx.conflictRun) {
        const both = await json(`/api/receipts/${encodeURIComponent(fx.conflictRun)}`);
        assert.equal(both.res.status, 409);
        assert.ok(Array.isArray(both.body.candidates) && both.body.candidates.length > 1);
      }
    });
  });
}
