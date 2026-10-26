/** The dashboard module on the real Worker bundle: tenant isolation, factory disambiguation, gates, archive, SPA. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { runObjects } from "../../src/test/receipt_fixture.ts";
import { runRouteContract } from "../../src/test/route_contract_suite.ts";
import { D1TraceReader } from "../../src/ui/server/trace_reader_d1.ts";
import { readerTenants } from "../src/tenants.ts";
import { signToken, startSite, type Site } from "./harness.ts";
import { FACTORY_A, FACTORY_B, SVC_A, SVC_B, count, makeBatch, seedCredentials } from "./ingest_helpers.ts";

const FACTORY_C = "cccccccc-3333-4333-8333-cccccccccccc";
const SVC_C = "svc-factory-c.access";
const ALICE = "alice@example.com"; // tenant-a by exact email
const BOB = "bob@other.example.com"; // tenant-b by domain
const BOTH = "both@example.com"; // tenant-a and tenant-b by exact email
const NOBODY = "nobody@nowhere.example.net";

let site: Site;
let db: any;
const as = (email: string) => signToken({ email });

async function ingest(cn: string, batch: unknown) {
  const res = await site.fetch("/ingest/v1", { method: "POST", token: await signToken({ commonName: cn }), headers: { "content-type": "application/json" }, body: JSON.stringify(batch) });
  assert.equal(res.status, 200, await res.clone().text());
  await res.arrayBuffer();
}
async function api(email: string | null, path: string, init: RequestInit = {}) {
  const res = await site.fetch(path, { ...init, token: email === null ? null : await as(email) });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, body, headers: res.headers };
}
const post = (email: string, path: string, body: unknown) => api(email, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const listIds = async (email: string, qs = "") => ((await api(email, `/api/sessions${qs}`)).body as any[]).map((s) => `${s.factory_id}/${s.adw_id}`).sort();

const LINKS = { issue_label: "BT-1221", issue_url: "https://acme.atlassian.net/browse/BT-1221", pr_label: "#217", pr_url: "https://bitbucket.org/acme/api/pull-requests/217" };

describe("dashboard module", () => {
  before(async () => {
    site = await startSite({ PIQUETTE_MODULES: "receipts,ingest,dashboard", D1: "1", MAX_BODY_BYTES: "200000", RECEIPTS_VISIBILITY: "tenant" });
    db = await site.db();
    await seedCredentials(db, [
      { cn: SVC_A, tenant: "tenant-a" },
      { cn: SVC_C, tenant: "tenant-a" },
      { cn: SVC_B, tenant: "tenant-b" },
    ]);
    for (const [kind, value, tenant] of [
      ["email", ALICE, "tenant-a"],
      ["email", BOTH, "tenant-a"],
      ["email", BOTH, "tenant-b"],
      ["email_domain", "other.example.com", "tenant-b"],
    ] as const) await db.prepare("INSERT INTO reader_grants (tenant, kind, value) VALUES (?, ?, ?)").bind(tenant, kind, value).run();

    // tenant-a: two factories over two repos, one adw_id ("shared") on both; tenant-b: its own run and a "shared" too.
    await ingest(SVC_A, makeBatch({ factory: FACTORY_A, adw: "adw-1", level: "full", prompts: true, repo: "example.com/acme/api", links: LINKS }));
    // The same run replayed by a factory that predates run links (no link keys at all): the stored links survive.
    await ingest(SVC_A, makeBatch({ factory: FACTORY_A, adw: "adw-1", level: "full", prompts: true, repo: "example.com/acme/api" }));
    await ingest(SVC_A, makeBatch({ factory: FACTORY_A, adw: "shared", level: "trace", prompts: true, repo: "example.com/acme/api" }));
    await ingest(SVC_C, makeBatch({ factory: FACTORY_C, adw: "shared", level: "trace", repo: "example.com/acme/web" }));
    await ingest(SVC_B, makeBatch({ factory: FACTORY_B, adw: "b-only", level: "full", prompts: true, repo: "example.com/other/secret" }));
    await ingest(SVC_B, makeBatch({ factory: FACTORY_B, adw: "shared", level: "trace", repo: "example.com/other/secret" }));
    // Receipt segments are the repos' `owner--name`: tenant-a owns acme--api and acme--web, tenant-b owns other--secret.
    await site.seed(runObjects("acme--api", "dup-run"));
    await site.seed(runObjects("acme--web", "dup-run"));
    await site.seed(runObjects("other--secret", "dup-run"));
    await site.seed(runObjects("other--secret", "b-run"));
    await site.seed(runObjects("unowned--repo", "orphan-run"));
  });
  after(() => site.dispose());

  runRouteContract(
    async (path, init) => {
      // The contract archives and restores; run it as a user who sees one tenant.
      const headers = new Headers(init?.headers);
      headers.set("Cf-Access-Jwt-Assertion", await as(ALICE));
      return site.mf.dispatchFetch(`https://receipts.test${path}`, { ...init, headers } as never) as unknown as Promise<Response>;
    },
    { adwId: "adw-1", agent: "planner", hosted: true, factory: FACTORY_A, expectPrompts: true, conflictRun: "dup-run", links: LINKS },
  );

  test("the reader lists every factory it may see, with repo and factory filters", async () => {
    assert.deepEqual(await listIds(ALICE), [`${FACTORY_A}/adw-1`, `${FACTORY_A}/shared`, `${FACTORY_C}/shared`]);
    assert.deepEqual(await listIds(ALICE, "?repo=example.com/acme/web"), [`${FACTORY_C}/shared`]);
    assert.deepEqual(await listIds(ALICE, "?repo=EXAMPLE.com/acme/web&repo=example.com/acme/api"), [`${FACTORY_A}/adw-1`, `${FACTORY_A}/shared`, `${FACTORY_C}/shared`]);
    assert.deepEqual(await listIds(ALICE, `?factory=${FACTORY_A}`), [`${FACTORY_A}/adw-1`, `${FACTORY_A}/shared`]);
    assert.deepEqual(await listIds(ALICE, `?factory=${FACTORY_C}&repo=example.com/acme/api`), []);
    const health = (await api(ALICE, "/api/health")).body;
    assert.deepEqual(health.factories.map((f: any) => f.id).sort(), [FACTORY_A, FACTORY_C].sort());
    assert.deepEqual(health.repos, ["example.com/acme/api", "example.com/acme/web"]);
    const row = ((await api(ALICE, "/api/sessions")).body as any[]).find((s) => s.adw_id === "adw-1");
    assert.equal(row.factory_name, "laptop");
    assert.equal(row.repo, "example.com/acme/api");
  });

  test("a shared adw_id is a 409 with candidates; the factory resolves it", async () => {
    for (const path of ["/api/sessions/shared", "/api/sessions/shared/events", "/api/sessions/shared/gates", "/api/sessions/shared/envelopes", "/api/sessions/shared/agents/planner/prompts"]) {
      const { status, body } = await api(ALICE, path);
      assert.equal(status, 409, path);
      assert.deepEqual(body.candidates, [
        { factory_id: FACTORY_A, factory_name: "laptop", repo: "example.com/acme/api" },
        { factory_id: FACTORY_C, factory_name: "laptop", repo: "example.com/acme/web" },
      ], path);
    }
    assert.equal((await post(ALICE, "/api/sessions/shared/archive", {})).status, 409);
    assert.equal((await post(ALICE, "/api/reviews", { adw_id: "shared", factory_id: null, archived: true })).status, 409);
    const one = await api(ALICE, `/api/sessions/shared?factory=${FACTORY_C}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.session.factory_id, FACTORY_C);
    assert.equal((await api(ALICE, `/api/sessions/shared?factory=${FACTORY_B}`)).status, 404);
  });

  test("tenant A never lists, reads, archives or sees tenant B's sessions, factories or repos", async () => {
    assert.ok(!(await listIds(ALICE)).some((k) => k.includes(FACTORY_B)));
    assert.ok(!(await listIds(ALICE, `?factory=${FACTORY_B}`)).length);
    assert.ok(!(await listIds(ALICE, "?repo=example.com/other/secret")).length);
    const health = JSON.stringify((await api(ALICE, "/api/health")).body);
    assert.ok(!health.includes(FACTORY_B) && !health.includes("secret"));
    for (const p of ["", "/events", "/envelopes", "/gates", "/agents/planner/prompts"]) {
      const res = await api(ALICE, `/api/sessions/b-only${p}`);
      if (p === "/events") assert.deepEqual(res.body.events, [], p);
      else if (p === "/envelopes" || p === "/gates") assert.deepEqual(res.body, [], p);
      else assert.equal(res.status, 404, p);
      assert.doesNotMatch(JSON.stringify(res.body), /SYSTEM-PROMPT|ERR-DETAIL|do the thing/, p);
    }
    // A forged factory_id does not reach across tenants, by either archive route.
    assert.equal((await post(ALICE, "/api/reviews", { adw_id: "b-only", factory_id: FACTORY_B, archived: true })).status, 404);
    assert.equal((await post(ALICE, `/api/sessions/b-only/archive?factory=${FACTORY_B}`, {})).status, 404);
    assert.equal((await post(ALICE, "/api/reviews", { adw_id: "shared", factory_id: FACTORY_B, archived: true })).status, 404);
    assert.equal(await count(db, "reviews", "tenant = 'tenant-b'"), 0);
    // And tenant B sees only its own.
    assert.deepEqual(await listIds(BOB), [`${FACTORY_B}/b-only`, `${FACTORY_B}/shared`]);
    assert.equal((await api(BOB, "/api/sessions/adw-1")).status, 404);
  });

  test("a reader granted two tenants sees both and needs the factory for a shared id", async () => {
    assert.equal((await listIds(BOTH)).length, 5);
    assert.equal((await api(BOTH, "/api/sessions/shared")).status, 409);
    assert.equal((await api(BOTH, `/api/sessions/shared?factory=${FACTORY_B}`)).status, 200);
  });

  test("archive is per tenant, written to reviews only, and records the reader", async () => {
    const syncedBefore = JSON.stringify((await db.prepare("SELECT * FROM sessions ORDER BY factory_id, adw_id").all()).results);
    const counts = async () => Promise.all(["factories", "sessions", "phases", "events", "envelopes", "gate_results", "prompts", "agent_sessions"].map((t) => count(db, t)));
    const before = await counts();
    const res = await post(BOTH, "/api/reviews", { adw_id: "shared", factory_id: FACTORY_B, archived: true });
    assert.equal(res.status, 200);
    assert.deepEqual(await counts(), before);
    assert.equal(JSON.stringify((await db.prepare("SELECT * FROM sessions ORDER BY factory_id, adw_id").all()).results), syncedBefore);
    const rows = (await db.prepare("SELECT tenant, factory_id, adw_id, archived, archived_by FROM reviews WHERE adw_id = 'shared'").all()).results;
    assert.deepEqual(rows.map((r: any) => ({ ...r })), [{ tenant: "tenant-b", factory_id: FACTORY_B, adw_id: "shared", archived: 1, archived_by: BOTH }]);
    // Tenant A still sees its own "shared" runs; tenant B no longer lists it.
    assert.equal((await listIds(ALICE)).filter((k) => k.endsWith("/shared")).length, 2);
    assert.deepEqual(await listIds(BOB), [`${FACTORY_B}/b-only`]);
    assert.equal((await post(BOTH, "/api/reviews", { adw_id: "shared", factory_id: FACTORY_B, archived: false })).status, 200);
    assert.deepEqual(await listIds(BOB), [`${FACTORY_B}/b-only`, `${FACTORY_B}/shared`]);
  });

  test("an identity with no grant is 403; a service token is 403; no token is 401", async () => {
    for (const p of ["/api/health", "/api/sessions", "/api/sessions/adw-1", "/api/sessions/adw-1/events"]) {
      const none = await api(NOBODY, p);
      assert.equal(none.status, 403, p);
      assert.deepEqual(none.body, { error: "no tenant for this identity" });
      const svc = await site.fetch(p, { token: await signToken({ commonName: SVC_A }) });
      assert.equal(svc.status, 403, p);
      assert.doesNotMatch(await svc.text(), /adw-1/);
      const anon = await site.fetch(p, { token: null });
      assert.equal(anon.status, 401, p);
      await anon.arrayBuffer();
    }
    assert.equal((await post(NOBODY, "/api/reviews", { adw_id: "adw-1", archived: true })).status, 403);
    // A token with no email at all is not an identity.
    assert.equal((await site.fetch("/api/sessions", { token: await signToken({ email: null }) })).status, 403);
  });

  test("receipts are tenant-scoped: a reader sees only the repos their tenants synced", async () => {
    // alice (tenant-a): her own repos play; tenant-b's run is a plain 404, as if it did not exist.
    assert.equal((await api(ALICE, "/api/receipts/dup-run?repo=acme--api")).status, 200);
    const mine = await api(ALICE, "/api/receipts/dup-run");
    assert.equal(mine.status, 409);
    assert.deepEqual([...mine.body.candidates].sort(), ["acme--api", "acme--web"]);
    const foreign = await api(ALICE, "/api/receipts/b-run?repo=other--secret");
    assert.equal(foreign.status, 404);
    assert.equal((await api(ALICE, "/api/receipts/b-run")).status, 404);
    assert.equal((await api(ALICE, "/api/receipts/orphan-run?repo=unowned--repo")).status, 404);
    // The file route cannot reach another tenant's evidence either.
    const file = await api(ALICE, `/api/receipts/dup-run/file?repo=other--secret&key=${encodeURIComponent("other--secret/attempts/dup-run/1/receipt.json")}`);
    assert.equal(file.status, 404);
    // bob (tenant-b) sees tenant-b's run and none of tenant-a's.
    assert.equal((await api(BOB, "/api/receipts/b-run")).status, 200);
    assert.equal((await api(BOB, "/api/receipts/dup-run?repo=acme--api")).status, 404);
    assert.deepEqual((await api(BOB, "/api/receipts/dup-run")).body.repo, "other--secret");
    // both tenants: the union.
    assert.equal((await api(BOTH, "/api/receipts/b-run")).status, 200);
    assert.equal((await api(BOTH, "/api/receipts/dup-run")).status, 409);
  });

  test("receipts need a tenant: no grant is 403, never a repo list", async () => {
    for (const p of ["/api/receipts/b-run", "/api/receipts/b-run?repo=other--secret", "/api/receipts/dup-run"]) {
      const res = await api(NOBODY, p);
      assert.equal(res.status, 403, p);
      assert.doesNotMatch(JSON.stringify(res.body), /secret|acme/);
    }
    assert.equal((await site.fetch("/api/receipts/dup-run?repo=acme--api", { token: null })).status, 401);
    assert.equal((await site.fetch("/api/receipts/dup-run?repo=acme--api", { token: await signToken({ commonName: SVC_A }) })).status, 403);
  });

  test("prompts are null below the full sync level, and served at full", async () => {
    const full = await api(ALICE, `/api/sessions/adw-1/agents/planner/prompts?factory=${FACTORY_A}`);
    assert.deepEqual(full.body, { system: "SYSTEM-PROMPT", user: "USER-PROMPT" });
    // "shared" in factory A was ingested at trace level with prompts in the batch: they are never served.
    const trace = await api(ALICE, `/api/sessions/shared/agents/planner/prompts?factory=${FACTORY_A}`);
    assert.deepEqual(trace.body, { system: null, user: null });
  });

  test("filters are bounded and never become SQL", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `repo=r${i}`).join("&");
    assert.equal((await api(ALICE, `/api/sessions?${many(50)}`)).status, 200);
    assert.equal((await api(ALICE, `/api/sessions?${many(51)}`)).status, 400);
    assert.equal((await api(ALICE, `/api/sessions?factory=${"x".repeat(201)}`)).status, 400);
    const evil = await api(ALICE, `/api/sessions?repo=${encodeURIComponent("x' OR '1'='1")}&factory=${encodeURIComponent("') OR 1=1 --")}`);
    assert.equal(evil.status, 200);
    assert.deepEqual(evil.body, []);
    const real = await api(ALICE, `/api/sessions?factory=${encodeURIComponent(`${FACTORY_A}' OR '1'='1`)}`);
    assert.deepEqual(real.body, []);
  });

  test("many tenants and many filter values never overflow D1's bound-parameter limit", async () => {
    const tenants = [...Array.from({ length: 150 }, (_, i) => `t-${i}`), "tenant-a"];
    const reader = new D1TraceReader(db, { tenants });
    assert.equal((await reader.sessions(100, { repos: Array.from({ length: 50 }, (_, i) => `r${i}`), factories: Array.from({ length: 50 }, (_, i) => `f${i}`) })).length, 0);
    assert.equal((await reader.sessions(100)).length, 3);
    assert.equal((await reader.hostedHealth()).factories.length, 2);
    assert.equal(await reader.sessionCount(), 3);
    assert.throws(() => new D1TraceReader(db, { tenants: [] }), /no tenants/);
  });

  test("a reader granted more than 100 tenants loses none", async () => {
    const s = await startSite({ PIQUETTE_MODULES: "ingest,dashboard", D1: "1" });
    try {
      const d = await s.db();
      for (let i = 0; i < 120; i++) await d.prepare("INSERT INTO reader_grants (tenant, kind, value) VALUES (?, 'email_domain', 'wide.example.com')").bind(`t-${String(i).padStart(3, "0")}`).run();
      assert.equal((await readerTenants(d, "x@wide.example.com")).length, 120);
    } finally {
      await s.dispose();
    }
  });

  test("a hosted 500 is generic: no SQL or internal text reaches the reader", async () => {
    await db.prepare("ALTER TABLE reviews RENAME TO reviews_gone").run();
    try {
      const res = await post(ALICE, "/api/reviews", { adw_id: "adw-1", archived: true, factory: FACTORY_A });
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { error: "internal error" });
    } finally {
      await db.prepare("ALTER TABLE reviews_gone RENAME TO reviews").run();
    }
  });

  test("the agent scans use the type index, and the page is not re-sorted per lookup", async () => {
    const plan = async (sql: string, ...p: unknown[]) =>
      ((await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...p).all()).results as { detail: string }[]).map((r) => r.detail).join("\n");
    const pairs = JSON.stringify([[FACTORY_A, "adw-1"]]);
    const start = await plan(
      "SELECT e.payload_json FROM events e WHERE (e.factory_id, e.adw_id) IN (SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]') FROM json_each(?) j) AND e.type = 'agent_end'",
      pairs,
    );
    assert.match(start, /idx_events_type/);
    assert.doesNotMatch(start, /idx_events_session/);
    // Exercised end to end: the list still returns agents and phases through the bound pairs.
    const rows = (await api(ALICE, `/api/sessions?factory=${FACTORY_A}`)).body as { phases: unknown[] }[];
    assert.ok(rows.length > 0 && rows.some((r) => r.phases.length > 0));
  });

  test("readerTenants: exact email and exact domain only", async () => {
    assert.deepEqual(await readerTenants(db, "ALICE@example.com"), ["tenant-a"]);
    assert.deepEqual(await readerTenants(db, "x@other.example.com"), ["tenant-b"]);
    assert.deepEqual(await readerTenants(db, "x@sub.other.example.com"), []);
    assert.deepEqual(await readerTenants(db, "alice@example.com@evil.example.net"), []);
    assert.deepEqual(await readerTenants(db, "not-an-email"), []);
    assert.deepEqual(await readerTenants(db, "@other.example.com"), []);
  });

  test("/api responses are never cached", async () => {
    for (const p of ["/api/health", "/api/sessions", "/api/sessions/adw-1", "/api/nope"]) {
      const res = await api(ALICE, p);
      assert.match(res.headers.get("cache-control") ?? "", /no-store/, p);
    }
  });

  test("an unknown /api route is a JSON 404 behind the identity gate, not the SPA", async () => {
    const res = await api(ALICE, "/api/nope");
    assert.equal(res.status, 404);
    assert.ok(typeof res.body.error === "string");
    assert.equal((await site.fetch("/api/nope", { token: null })).status, 401);
  });

  test("the SPA shell and assets are served to an identity; a service token gets neither", async () => {
    const shell = await api(NOBODY, "/");
    assert.equal(shell.status, 200);
    assert.match(shell.body, /PIQUETTE-FIXTURE-MARKER/);
    assert.equal((await api(NOBODY, "/assets/app-abc123.js")).status, 200);
    assert.equal((await site.fetch("/", { token: await signToken({ commonName: SVC_A }) })).status, 403);
    assert.equal((await site.fetch("/", { token: null })).status, 401);
  });

  test("ingest still answers on its own route with the dashboard on", async () => {
    const res = await site.fetch("/ingest/v1", { token: await signToken({ commonName: SVC_A }) });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(((await res.json()) as { supported: number[] }).supported));
  });
});

describe("dashboard module: states", () => {
  test("receipts default to perimeter visibility: any Access identity, no sync or tenant needed", async () => {
    const s = await startSite({ PIQUETTE_MODULES: "receipts,ingest,dashboard", D1: "1" });
    try {
      await s.seed(runObjects("unsynced--repo", "fresh-run"));
      const nobody = await signToken({ email: NOBODY });
      const rec = await s.fetch("/api/receipts/fresh-run", { token: nobody });
      assert.equal(rec.status, 200, await rec.clone().text());
      assert.equal(((await rec.json()) as { repo: string }).repo, "unsynced--repo");
      // Trace data still needs a tenant, and receipts still need an identity.
      assert.equal((await s.fetch("/api/sessions", { token: nobody })).status, 403);
      assert.equal((await s.fetch("/api/receipts/fresh-run", { token: null })).status, 401);
      assert.equal((await s.fetch("/api/receipts/fresh-run", { token: await signToken({ commonName: SVC_A }) })).status, 403);
    } finally {
      await s.dispose();
    }
  });

  test("enabled without a DB: 503 module_unavailable on /api, receipts still served", async () => {
    const s = await startSite({ PIQUETTE_MODULES: "receipts,dashboard" });
    try {
      await s.seed(runObjects("repo-a", "dup-run"));
      const res = await s.fetch("/api/sessions");
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "module_unavailable", module: "dashboard" });
      const rec = await s.fetch("/api/receipts/dup-run");
      assert.equal(rec.status, 200);
      await rec.arrayBuffer();
      const status = (await (await s.fetch("/_piquette/status")).json()) as { modules: Record<string, string> };
      assert.equal(status.modules.dashboard, "missing_binding");
    } finally {
      await s.dispose();
    }
  });

  test("dashboard off: no trace API and no SPA shell outside /r", async () => {
    const s = await startSite({ PIQUETTE_MODULES: "receipts,ingest", D1: "1" });
    try {
      assert.equal((await s.fetch("/api/sessions")).status, 404);
      const shell = await s.fetch("/");
      assert.equal(shell.status, 404);
      assert.doesNotMatch(await shell.text(), /PIQUETTE-FIXTURE-MARKER/);
    } finally {
      await s.dispose();
    }
  });

  test("dashboard without receipts: the receipt API is a 404, never a second mount", async () => {
    const s = await startSite({ PIQUETTE_MODULES: "dashboard", D1: "1", NO_R2: "1" });
    try {
      await (await s.db()).prepare("INSERT INTO reader_grants (tenant, kind, value) VALUES ('tenant-a', 'email', ?)").bind(ALICE).run();
      const res = await s.fetch("/api/receipts/dup-run", { token: await signToken({ email: ALICE }) });
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: string }).error, "no receipt store");
    } finally {
      await s.dispose();
    }
  });

  test("mounted under /piquette: the shell, assets, API and a receipt run are all under the base", async () => {
    const s = await startSite({ PIQUETTE_MODULES: "receipts,ingest,dashboard", D1: "1", BASE_PATH: "/piquette" });
    try {
      const db2 = await s.db();
      await seedCredentials(db2, [{ cn: SVC_A, tenant: "tenant-a" }]);
      await db2.prepare("INSERT INTO reader_grants (tenant, kind, value) VALUES ('tenant-a', 'email', ?)").bind(ALICE).run();
      const ing = await s.fetch("/piquette/ingest/v1", { method: "POST", token: await signToken({ commonName: SVC_A }), headers: { "content-type": "application/json" }, body: JSON.stringify(makeBatch({ factory: FACTORY_A, adw: "adw-1" })) });
      assert.equal(ing.status, 200);
      await ing.arrayBuffer();
      await s.seed(runObjects("acme--api", "dup-run"));
      const t = await signToken({ email: ALICE });
      for (const p of ["/piquette/", "/piquette/index.html", "/piquette/r/dup-run"]) {
        const res = await s.fetch(p, { token: t, redirect: "manual" });
        assert.ok(res.status === 200 || (res.status >= 300 && res.status < 400 && /^\/piquette(\/|$)/.test(res.headers.get("location") ?? "")), `${p} ${res.status}`);
        await res.arrayBuffer();
      }
      assert.match(await (await s.fetch("/piquette/", { token: t })).text(), /PIQUETTE-FIXTURE-MARKER/);
      assert.equal((await s.fetch("/piquette/assets/app-abc123.js", { token: t })).status, 200);
      assert.equal((await s.fetch("/piquette/r/assets/app-abc123.js", { token: t })).status, 200);
      const list = (await (await s.fetch("/piquette/api/sessions", { token: t })).json()) as unknown[];
      assert.equal(list.length, 1);
      assert.equal((await s.fetch("/api/sessions", { token: t })).status, 404);
      assert.equal((await s.fetch("/piquette/api/receipts/dup-run?repo=acme--api", { token: t })).status, 200);
    } finally {
      await s.dispose();
    }
  });
});

describe("one factory, many repos", () => {
  test("health and receipt scope list every repo the factory synced, whichever synced last", async () => {
    const s = await startSite({ PIQUETTE_MODULES: "receipts,ingest,dashboard", D1: "1", RECEIPTS_VISIBILITY: "tenant" });
    try {
      const d = await s.db();
      await seedCredentials(d, [{ cn: SVC_A, tenant: "tenant-a" }]);
      await d.prepare("INSERT INTO reader_grants (tenant, kind, value) VALUES (?, ?, ?)").bind("tenant-a", "email", ALICE).run();
      await s.seed(runObjects("acme--api", "run-api"));
      await s.seed(runObjects("acme--web", "run-web"));
      for (const [adw, repo] of [["a1", "example.com/acme/api"], ["w1", "example.com/acme/web"]] as const) {
        const res = await s.fetch("/ingest/v1", { method: "POST", token: await signToken({ commonName: SVC_A }), headers: { "content-type": "application/json" }, body: JSON.stringify(makeBatch({ factory: FACTORY_A, adw, repo })) });
        assert.equal(res.status, 200, await res.clone().text());
        await res.arrayBuffer();
      }
      const health = await new D1TraceReader(d, { tenants: ["tenant-a"] }).hostedHealth();
      assert.deepEqual(health.repos, ["example.com/acme/api", "example.com/acme/web"]);
      assert.equal(health.factories.length, 1);
      // receipts of BOTH repos stay visible to the tenant (web synced last, api must not vanish)
      for (const [run, repo] of [["run-api", "acme--api"], ["run-web", "acme--web"]]) {
        const res = await s.fetch(`/api/receipts/${run}?repo=${repo}`, { token: await as(ALICE) });
        assert.equal(res.status, 200, run);
        await res.arrayBuffer();
      }
    } finally {
      await s.dispose();
    }
  });
});

describe("dashboard module: one factory, two repos sharing an adw_id (#218)", () => {
  const RA = "example.com/acme/a";
  const RB = "example.com/acme/b";
  const AD = "issue-81";
  let s2: Site;
  let d2: any;
  const get = async (p: string) => {
    const res = await s2.fetch(p, { token: await as(ALICE) });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* html */
    }
    return { status: res.status, body };
  };
  const postJson = async (p: string, b: unknown) => {
    const res = await s2.fetch(p, { method: "POST", token: await as(ALICE), headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    return { status: res.status, body: (await res.json()) as any };
  };

  before(async () => {
    s2 = await startSite({ PIQUETTE_MODULES: "ingest,dashboard", D1: "1", MAX_BODY_BYTES: "200000" });
    d2 = await s2.db();
    await seedCredentials(d2, [{ cn: SVC_A, tenant: "tenant-a" }]);
    await d2.prepare("INSERT INTO reader_grants (tenant, kind, value) VALUES ('tenant-a', 'email', ?)").bind(ALICE).run();
    for (const repo of [RA, RB]) {
      const res = await s2.fetch("/ingest/v1", { method: "POST", token: await signToken({ commonName: SVC_A }), body: JSON.stringify(makeBatch({ factory: FACTORY_A, repo, adw: AD, events: 2, gates: 1, gateBase: 100, level: "full", prompts: true, request: `req ${repo}`, eventName: `ev-${repo}` })) });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    }
  });
  after(() => s2.dispose());

  test("the list shows both, each with its repo; ?factory= alone is a 409 on every session route", async () => {
    const rows = (await get("/api/sessions")).body as any[];
    assert.deepEqual(rows.map((r) => r.repo).sort(), [RA, RB]);
    const candidates = [{ factory_id: FACTORY_A, factory_name: "laptop", repo: RA }, { factory_id: FACTORY_A, factory_name: "laptop", repo: RB }];
    for (const p of ["", "/events", "/gates", "/envelopes", "/agents/planner/prompts"]) {
      const { status, body } = await get(`/api/sessions/${AD}${p}?factory=${FACTORY_A}`);
      assert.equal(status, 409, p);
      assert.deepEqual(body.candidates, candidates, p);
    }
    assert.equal((await postJson(`/api/sessions/${AD}/archive?factory=${FACTORY_A}`, {})).status, 409);
  });

  test("&repo= resolves it: only that repo's events, gates, envelopes and prompts; the repo match ignores case", async () => {
    for (const repo of [RA, RB]) {
      const q = `?factory=${FACTORY_A}&repo=${repo.toUpperCase()}`;
      const detail = await get(`/api/sessions/${AD}${q}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.session.repo, repo);
      assert.equal(detail.body.session.request, `req ${repo}`);
      assert.equal(detail.body.phases.length, 1);
      const ev = (await get(`/api/sessions/${AD}/events${q}`)).body.events;
      assert.equal(ev.length, 2);
      assert.ok(ev.every((e: any) => e.name === `ev-${repo}`));
      assert.equal((await get(`/api/sessions/${AD}/gates${q}`)).body.length, 1);
      assert.equal((await get(`/api/sessions/${AD}/envelopes${q}`)).body.length, 1);
      assert.equal((await get(`/api/sessions/${AD}/agents/planner/prompts${q}`)).body.user, "USER-PROMPT");
    }
    // repo alone also resolves here (one factory), and an unknown repo is a 404
    assert.equal((await get(`/api/sessions/${AD}?repo=${RA}`)).status, 200);
    assert.equal((await get(`/api/sessions/${AD}?repo=example.com/acme/none`)).status, 404);
  });

  test("/api/reviews with a repo archives only that row, and the list hides only that one; a non-string repo is a 400", async () => {
    assert.equal((await postJson("/api/reviews", { adw_id: AD, factory_id: FACTORY_A, repo: 5, archived: true })).status, 400);
    assert.equal((await postJson("/api/reviews", { adw_id: AD, factory_id: FACTORY_A, repo: null, archived: true })).status, 409);
    assert.equal((await postJson("/api/reviews", { adw_id: AD, factory_id: FACTORY_A, repo: RA, archived: true })).status, 200);
    assert.deepEqual(((await get("/api/sessions")).body as any[]).map((r) => r.repo), [RB]);
    assert.deepEqual((await d2.prepare("SELECT repo, archived FROM reviews").all()).results.map((r: any) => ({ ...r })), [{ repo: RA, archived: 1 }]);
    assert.equal((await postJson("/api/reviews", { adw_id: AD, factory_id: FACTORY_A, repo: RA, archived: false })).status, 200);
    assert.equal(((await get("/api/sessions")).body as any[]).length, 2);
  });
});
