/** createApp over a fake reader: ?repo= reaches the reader, /api/reviews validates and forwards the repo (#218). */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp } from "../ui/server/app.ts";
import { AmbiguousSession, type SessionSel, type TraceReader } from "../ui/server/trace_reader.ts";

function fakeReader() {
  const calls: { fn: string; id: string; sel?: SessionSel; archived?: boolean }[] = [];
  const reader = {
    mode: "hosted",
    label: "fake",
    journalMode: "n/a",
    sessionCount: async () => 0,
    sessions: async () => [],
    sessionDetail: async (id: string, sel?: SessionSel) => {
      calls.push({ fn: "detail", id, ...(sel ? { sel } : {}) });
      return null;
    },
    session: async (id: string, sel?: SessionSel) => {
      calls.push({ fn: "session", id, ...(sel ? { sel } : {}) });
      if (id === "amb") throw new AmbiguousSession(id, [{ factory_id: "f", factory_name: "laptop", repo: "r/a" }, { factory_id: "f", factory_name: "laptop", repo: "r/b" }]);
      return { adw_id: id } as never;
    },
    events: async (id: string, _a: number, _l: number, sel?: SessionSel) => {
      calls.push({ fn: "events", id, ...(sel ? { sel } : {}) });
      return { events: [], cursor: 0, has_more: false };
    },
    envelopes: async () => [],
    gates: async () => [],
    prompts: async () => ({ system: null, user: null }),
    setArchived: async (id: string, archived: boolean, sel?: SessionSel) => {
      calls.push({ fn: "archive", id, archived, ...(sel ? { sel } : {}) });
      return true;
    },
  } satisfies TraceReader;
  const app = createApp({ reader: () => reader, static: () => new Response("spa") });
  return { app, calls };
}
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("session selector: factory and repo", () => {
  test("?factory= and ?repo= are forwarded to the reader on session routes", async () => {
    const { app, calls } = fakeReader();
    await app.request("/api/sessions/a1?factory=f1&repo=h/o/n");
    await app.request("/api/sessions/a1/events?repo=h/o/n");
    await app.request("/api/sessions/a1");
    assert.deepEqual(calls[0]?.sel, { factory: "f1", repo: "h/o/n" });
    assert.deepEqual(calls[1]?.sel, { repo: "h/o/n" });
    assert.deepEqual(calls[2]?.sel, {});
  });

  test("POST /api/reviews forwards repo; null or absent is no repo; a non-string repo is a 400", async () => {
    const { app, calls } = fakeReader();
    assert.equal((await app.request("/api/reviews", json({ adw_id: "a1", factory_id: "f1", repo: "h/o/n", archived: true }))).status, 200);
    assert.deepEqual(calls.at(-1), { fn: "archive", id: "a1", archived: true, sel: { factory: "f1", repo: "h/o/n" } });
    assert.equal((await app.request("/api/reviews", json({ adw_id: "a1", factory_id: "f1", repo: null }))).status, 200);
    assert.deepEqual(calls.at(-1)?.sel, { factory: "f1" });
    assert.equal((await app.request("/api/reviews", json({ adw_id: "a1" }))).status, 200);
    const n = calls.length;
    for (const repo of [5, true, ["x"], {}]) assert.equal((await app.request("/api/reviews", json({ adw_id: "a1", repo }))).status, 400, JSON.stringify(repo));
    assert.equal(calls.length, n, "a refused write never reaches the reader");
  });

  test("an ambiguous session is a 409 whose candidates are { factory_id, factory_name, repo } objects", async () => {
    const { app } = fakeReader();
    const res = await app.request("/api/sessions/amb/agents/planner/prompts");
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; candidates: unknown[] };
    assert.deepEqual(body.candidates, [{ factory_id: "f", factory_name: "laptop", repo: "r/a" }, { factory_id: "f", factory_name: "laptop", repo: "r/b" }]);
    assert.match(body.error, /r\/a @ laptop, r\/b @ laptop/);
  });
});
