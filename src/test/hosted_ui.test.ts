import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveRequest,
  buildHash,
  filterQuery,
  filterSessions,
  isHosted,
  parseHash,
  selFromInputs,
  selQuery,
  repoLabels,
  repoOptions,
  rowsByKeys,
  sessionKey,
  sessionMatchesQuery,
  sessionsQuery,
  sessionsUrl,
  showFactoryFilter,
  showRepoFilter,
  sortSessions,
  syncLabel,
  toggleValue,
} from "../ui/shared/hosted.js";
import { apiBase } from "../ui/shared/viewer_base.js";
import { fixtureHealth, fixtureSessions, mockApi, REPO_API, REPO_WEB, resetMockArchive } from "../ui/shared/hosted_fixtures.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");

describe("hash route parse / serialize", () => {
  test("plain routes parse as before the query existed", () => {
    assert.deepEqual(parseHash(""), { adwId: null, phaseId: null, factory: null, repo: null, filter: { repos: [], factories: [] } });
    assert.deepEqual(parseHash("#/"), parseHash(""));
    const t = parseHash("#/a1b2c3d4/p1");
    assert.equal(t.adwId, "a1b2c3d4");
    assert.equal(t.phaseId, "p1");
    assert.equal(t.factory, null);
  });

  test("trace routes carry factory and repo (slashes readable), and old factory-only hashes still parse", () => {
    const hash = buildHash({ adwId: "issue-81", phaseId: "p1", factory: "f-1", repo: REPO_API });
    assert.equal(hash, `#/issue-81/p1?factory=f-1&repo=${REPO_API}`);
    const r = parseHash(hash);
    assert.deepEqual([r.adwId, r.phaseId, r.factory, r.repo], ["issue-81", "p1", "f-1", REPO_API]);
    assert.deepEqual(r.filter, { repos: [], factories: [] });
    const odd = "gitlab.com/g/sub group/r&x";
    assert.equal(parseHash(buildHash({ adwId: "a", factory: "f", repo: odd })).repo, odd);
    const old = parseHash("#/dead0042?factory=f-9e47");
    assert.deepEqual([old.adwId, old.factory, old.repo], ["dead0042", "f-9e47", null]);
    // list routes still read repo as the filter list, not a single trace repo
    const list = parseHash(`#/?repo=${REPO_API}`);
    assert.equal(list.repo, null);
    assert.deepEqual(list.filter.repos, [REPO_API]);
  });

  test("list filter: repeated values, slashes stay readable, order kept", () => {
    const filter = { repos: [REPO_WEB, REPO_API], factories: ["f-3a1c"] };
    const hash = buildHash({ filter });
    assert.equal(hash, `#/?repo=${REPO_WEB},${REPO_API}&factory=f-3a1c`);
    assert.deepEqual(parseHash(hash).filter, filter);
  });

  test("round trip survives characters that need escaping, including a comma in a value", () => {
    const filter = { repos: ["gitlab.com/g/sub group/r,x", "bitbucket.org/a&b/c"], factories: [] };
    const hash = buildHash({ filter });
    assert.deepEqual(parseHash(hash).filter, filter);
  });

  test("an empty filter serializes to the bare list route", () => {
    assert.equal(buildHash({}), "#/");
    assert.equal(filterQuery({ repos: [], factories: [] }), "");
  });

  test("trace routes carry the factory, and never a list filter", () => {
    const hash = buildHash({ adwId: "dead0042", factory: "f-9e47" });
    assert.equal(hash, "#/dead0042?factory=f-9e47");
    const r = parseHash(hash);
    assert.equal(r.adwId, "dead0042");
    assert.equal(r.factory, "f-9e47");
    assert.deepEqual(r.filter, { repos: [], factories: [] });
    assert.equal(buildHash({ adwId: "x", phaseId: "p 1", factory: "f1" }), "#/x/p%201?factory=f1");
    assert.equal(parseHash("#/x/p%201?factory=f1").phaseId, "p 1");
  });

  test("garbage and duplicates are tolerated", () => {
    assert.deepEqual(parseHash("#/?repo=a,,a, b&repo2=z").filter.repos, ["a", "b"]);
    assert.deepEqual(parseHash("#/?repo=%E0%A4%A").filter.repos, ["%E0%A4%A"]);
  });

  test("toggleValue adds, removes, and keeps selection order", () => {
    assert.deepEqual(toggleValue(["a"], "b"), ["a", "b"]);
    assert.deepEqual(toggleValue(["a", "b"], "a"), ["b"]);
  });

  test("sessionsQuery repeats repo, per the hosted API contract", () => {
    assert.equal(sessionsQuery({ repos: [], factories: [] }), "");
    assert.equal(
      sessionsQuery({ repos: [REPO_API, REPO_WEB], factories: ["f1"] }, 50),
      "?repo=github.com%2Facme%2Fapi&repo=github.com%2Facme%2Fweb&factory=f1&limit=50",
    );
  });
});

describe("hosted detection", () => {
  test("only an explicit hosted mode is hosted; an old or local server is local", () => {
    assert.equal(isHosted(fixtureHealth("hosted", NOW)), true);
    assert.equal(isHosted(fixtureHealth("local", NOW)), false);
    assert.equal(isHosted({ mode: undefined }), false);
    assert.equal(isHosted(null), false);
  });

  test("the repo filter needs a choice: hosted with more than one repo", () => {
    assert.equal(showRepoFilter(fixtureHealth("hosted", NOW)), true);
    assert.equal(showRepoFilter(fixtureHealth("local", NOW)), false);
    assert.equal(showRepoFilter({ ...fixtureHealth("hosted", NOW), repos: [REPO_API] }), true);
    assert.equal(showRepoFilter({ ...fixtureHealth("hosted", NOW), repos: [] }), false);
    assert.equal(showFactoryFilter({ ...fixtureHealth("hosted", NOW), factories: [] }), false);
    assert.equal(showFactoryFilter(fixtureHealth("hosted", NOW)), true);
    assert.equal(showFactoryFilter(fixtureHealth("local", NOW)), false);
  });
});

describe("aggregated list", () => {
  const rows = fixtureSessions(NOW);

  test("fixture shape: two repos, three factories, one adw_id shared by two factories", () => {
    assert.equal(new Set(rows.map((r) => r.repo)).size, 2);
    assert.equal(new Set(rows.map((r) => r.factory_id)).size, 3);
    const shared = rows.filter((r) => r.adw_id === "dead0042");
    assert.equal(shared.length, 2);
    assert.notEqual(shared[0]?.factory_id, shared[1]?.factory_id);
  });

  test("row keys stay unique when adw_ids collide", () => {
    assert.equal(new Set(rows.map(sessionKey)).size, rows.length);
    assert.equal(new Set(rows.map((r) => r.adw_id)).size, rows.length - 1);
  });

  test("repo filter is multi-select; empty means all", () => {
    assert.equal(filterSessions(rows, { repos: [], factories: [] }).length, rows.length);
    const web = filterSessions(rows, { repos: [REPO_WEB], factories: [] });
    assert.ok(web.length > 0 && web.every((r) => r.repo === REPO_WEB));
    assert.equal(filterSessions(rows, { repos: [REPO_WEB, REPO_API], factories: [] }).length, rows.length);
    assert.equal(filterSessions(rows, { repos: ["github.com/none/none"], factories: [] }).length, 0);
  });

  test("repo and factory filters intersect", () => {
    const f = filterSessions(rows, { repos: [REPO_API], factories: ["f-b520"] });
    assert.equal(f.length, 0, "f-b520 is the web factory");
    const both = filterSessions(rows, { repos: [REPO_API], factories: ["f-9e47"] });
    assert.ok(both.length > 0 && both.every((r) => r.factory_id === "f-9e47"));
  });

  test("rows without a repo (local mode) only survive an empty filter", () => {
    const local = rows.map(({ repo: _r, ...rest }) => rest);
    assert.equal(filterSessions(local, { repos: [], factories: [] }).length, local.length);
    assert.equal(filterSessions(local, { repos: [REPO_API], factories: [] }).length, 0);
  });

  test("sorted started_at DESC across factories, deterministically", () => {
    const sorted = sortSessions([...rows].reverse());
    const times = sorted.map((r) => Date.parse(r.started_at ?? ""));
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    assert.deepEqual(sortSessions(rows).map(sessionKey), sorted.map(sessionKey));
    const tied = [
      { ...rows[0]!, adw_id: "b", factory_id: "f", started_at: null },
      { ...rows[0]!, adw_id: "a", factory_id: "f", started_at: null },
    ];
    assert.deepEqual(sortSessions(tied).map((r) => r.adw_id), ["a", "b"]);
  });

  test("repo chips: short names, widened only on collision", () => {
    assert.deepEqual([...repoLabels([REPO_API, REPO_WEB]).values()], ["api", "web"]);
    const l = repoLabels(["github.com/acme/api", "github.com/other/api", REPO_WEB]);
    assert.equal(l.get("github.com/acme/api"), "acme/api");
    assert.equal(l.get("github.com/other/api"), "other/api");
    assert.equal(l.get(REPO_WEB), "web");
  });

  test("repo options keep a selected repo the server no longer lists, and hide counts while filtered", () => {
    const ghost = "github.com/gone/repo";
    const opts = repoOptions([REPO_API, REPO_WEB], [ghost], rows, false);
    assert.deepEqual(opts.map((o) => o.repo), [REPO_API, REPO_WEB, ghost]);
    assert.deepEqual(opts.map((o) => o.selected), [false, false, true]);
    assert.equal(opts.find((o) => o.repo === REPO_API)?.count, rows.filter((r) => r.repo === REPO_API).length);
    assert.ok(repoOptions([REPO_API], [REPO_API], rows, true).every((o) => o.count === null));
  });

  test("freshness reads in seconds, minutes, hours; never when there is no sync", () => {
    const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();
    assert.equal(syncLabel(at(8), NOW), "last synced 8s ago");
    assert.equal(syncLabel(at(190), NOW), "last synced 3m ago");
    assert.equal(syncLabel(at(7300), NOW), "last synced 2h ago");
    assert.equal(syncLabel(at(-5), NOW), "last synced 0s ago", "clock skew never goes negative");
    assert.equal(syncLabel(null, NOW), "never synced");
    assert.equal(syncLabel("not a date", NOW), "never synced");
  });
});

describe("fixture /api", () => {
  const get = (mode: "local" | "hosted", path: string, qs = "") => mockApi(mode, path, new URLSearchParams(qs), NOW);

  test("hosted health declares mode, repos and factories", () => {
    const h = get("hosted", "/api/health")?.body as ReturnType<typeof fixtureHealth>;
    assert.equal(h.mode, "hosted");
    assert.deepEqual(h.repos, [REPO_API, REPO_WEB]);
    assert.equal(h.factories?.length, 3);
  });

  test("hosted list filters on repeated repo params; local ignores them and has no factory columns", () => {
    const hosted = get("hosted", "/api/sessions", `repo=${encodeURIComponent(REPO_WEB)}`)?.body as Array<{ repo: string }>;
    assert.ok(hosted.length > 0 && hosted.every((r) => r.repo === REPO_WEB));
    const local = get("local", "/api/sessions", `repo=${encodeURIComponent(REPO_WEB)}`)?.body as Array<Record<string, unknown>>;
    assert.ok(local.length > 0 && local.every((r) => r.factory_id === undefined && r.repo === undefined));
  });

  test("an ambiguous adw_id is a 409 listing candidates; the factory selector resolves it", () => {
    const amb = get("hosted", "/api/sessions/dead0042");
    assert.equal(amb?.status, 409);
    assert.deepEqual((amb?.body as { candidates: { factory_id: string; repo: string }[] }).candidates.map((c) => [c.repo, c.factory_id]), [
      [REPO_API, "f-9e47"],
      [REPO_WEB, "f-b520"],
    ]);
    const one = get("hosted", "/api/sessions/dead0042", "factory=f-b520");
    assert.equal(one?.status, 200);
    assert.equal((one?.body as { session: { factory_id: string } }).session.factory_id, "f-b520");
    assert.equal(get("hosted", "/api/sessions/nope")?.status, 404);
  });

  test("unmodelled paths return null", () => {
    assert.equal(get("hosted", "/api/receipts/x"), null);
  });
});

describe("search, request wiring and archive contract", () => {
  const rows = () => fixtureSessions(NOW);

  test("searching a colliding adw_id yields both runs, as distinct rows", () => {
    const hits = rows().filter((s) => sessionMatchesQuery("dead0042", s));
    const keys = hits.map(sessionKey);
    assert.equal(new Set(keys).size, 2);
    const resolved = rowsByKeys(keys, rows());
    assert.equal(resolved.length, 2);
    assert.deepEqual(new Set(resolved.map((s) => s.factory_id)).size, 2);
    assert.deepEqual(resolved.map(sessionKey), keys);
  });

  test("rowsByKeys keeps rank order and drops keys that left the list", () => {
    const all = rows();
    const [a, b] = [all[0]!, all[1]!];
    assert.deepEqual(rowsByKeys([sessionKey(b), "gone\u0000x", sessionKey(a)], all).map(sessionKey), [sessionKey(b), sessionKey(a)]);
  });

  test("local list request is the bare route; hosted repeats repo", () => {
    assert.equal(sessionsUrl(), "/api/sessions");
    assert.equal(sessionsUrl({ repos: [REPO_API, REPO_WEB], factories: ["f-3a1c"] }), `/api/sessions?repo=${encodeURIComponent(REPO_API)}&repo=${encodeURIComponent(REPO_WEB)}&factory=f-3a1c`);
  });

  test("sessionKey differs by repo, and local rows (no factory, no repo) keep a stable key", () => {
    const a = { adw_id: "issue-81", factory_id: "f-1", repo: "r/a" };
    assert.notEqual(sessionKey(a), sessionKey({ ...a, repo: "r/b" }));
    assert.equal(sessionKey({ adw_id: "x" } as never), "\u0000\u0000x");
  });

  test("selQuery and selFromInputs name factory and repo, only when set", () => {
    assert.equal(selQuery(), "");
    assert.equal(selQuery({ factory: null, repo: null }), "");
    assert.equal(selQuery({ factory: "f 1", repo: "h/o/n" }), "?factory=f%201&repo=h%2Fo%2Fn");
    assert.equal(selQuery({ repo: "h/o/n" }, "&"), "&repo=h%2Fo%2Fn");
    assert.deepEqual(selFromInputs({ factory_id: "f", repo: "h/o/n" }), { factory: "f", repo: "h/o/n" });
    assert.deepEqual(selFromInputs({ factory_id: "", repo: 3 }), { factory: null, repo: null });
  });

  test("archive goes to the per-session route locally and the reviews route when hosted", () => {
    assert.deepEqual(archiveRequest(false, "a b", true), { url: "/api/sessions/a%20b/archive", body: { archived: true } });
    assert.deepEqual(archiveRequest(true, "dead0042", false, "f-9e47"), {
      url: "/api/reviews",
      body: { adw_id: "dead0042", factory_id: "f-9e47", repo: null, archived: false },
    });
    assert.equal((archiveRequest(true, "x", true).body as { factory_id: string | null }).factory_id, null);
    assert.deepEqual(archiveRequest(true, "dead0042", true, "f-9e47", REPO_API).body, { adw_id: "dead0042", factory_id: "f-9e47", repo: REPO_API, archived: true });
  });

  test("fixture POST /api/reviews: factory resolves a shared id, a bare shared id is a 409", () => {
    const post = (body: unknown) => mockApi("hosted", "/api/reviews", new URLSearchParams(), NOW, { method: "POST", body });
    const ok = archiveRequest(true, "dead0042", true, "f-9e47");
    assert.equal(post(ok.body)?.status, 200);
    assert.equal(post(archiveRequest(true, "dead0042", true).body)?.status, 409);
    assert.equal(post(archiveRequest(true, "nope0000", true, "f-9e47").body)?.status, 404);
    assert.equal(post({ adw_id: 1 })?.status, 400);
    assert.equal(mockApi("local", "/api/reviews", new URLSearchParams(), NOW, { method: "POST", body: ok.body }), null);
  });
});

describe("fixture archive writes", () => {
  const post = (mode: "local" | "hosted" | "demo", path: string, body: unknown, qs = "") => mockApi(mode, path, new URLSearchParams(qs), NOW, { method: "POST", body });
  const ids = (mode: "local" | "demo") => (mockApi(mode, "/api/sessions", new URLSearchParams(), NOW)?.body as Array<{ adw_id: string }>).map((r) => r.adw_id);

  test("local route archives out of the list, keeps the detail, and restores", () => {
    resetMockArchive();
    assert.ok(ids("local").includes("fb1x0042"));
    assert.deepEqual(post("local", "/api/sessions/fb1x0042/archive", { archived: true })?.body, { adw_id: "fb1x0042", archived: true });
    assert.ok(!ids("local").includes("fb1x0042"));
    const detail = mockApi("local", "/api/sessions/fb1x0042", new URLSearchParams(), NOW);
    assert.equal(detail?.status, 200);
    assert.equal((detail?.body as { session: { archived: number } }).session.archived, 1);
    assert.deepEqual(post("local", "/api/sessions/fb1x0042/archive", { archived: false })?.body, { adw_id: "fb1x0042", archived: false });
    assert.ok(ids("local").includes("fb1x0042"));
    assert.equal(post("local", "/api/sessions/nope0000/archive", {})?.status, 404);
    assert.equal(post("local", "/api/sessions/..%2Fx/archive", {})?.status, 400);
    resetMockArchive();
  });

  test("a missing archived flag archives, like the real route; demo mode takes /api/reviews", () => {
    resetMockArchive();
    assert.deepEqual(post("demo", "/api/reviews", { adw_id: "e44d9a10", factory_id: "f-9e47", repo: null })?.body, { adw_id: "e44d9a10", archived: true });
    assert.ok(!ids("demo").includes("e44d9a10"));
    resetMockArchive();
    assert.ok(ids("demo").includes("e44d9a10"));
  });
});

describe("demo fixtures agree with themselves", () => {
  test("a failed phase has one failing gate; passing phases have none; spans fill the run", () => {
    const rows = mockApi("demo", "/api/sessions", new URLSearchParams(), NOW)?.body as Array<{ adw_id: string; status: string; started_at: string; ended_at: string | null; phases: Array<{ status: string; started_at: string | null; ended_at: string | null }> }>;
    for (const r of rows) {
      const gates = mockApi("demo", `/api/sessions/${r.adw_id}/gates`, new URLSearchParams(), NOW)?.body as Array<{ passed: number }>;
      assert.equal(gates.filter((g) => !g.passed).length, r.phases.filter((p) => p.status === "fail").length, r.adw_id);
      if (r.ended_at) {
        const span = Math.max(...r.phases.map((p) => Date.parse(p.ended_at ?? ""))) - Date.parse(r.started_at);
        assert.ok(Math.abs(span - (Date.parse(r.ended_at) - Date.parse(r.started_at))) < 2000, r.adw_id);
      }
    }
  });
});

describe("hosted UI under a mount path (#214)", () => {
  // The app prefixes every fetch with apiBase(location.pathname); the Worker strips the base before routing.
  const under = (base: string, url: string) => apiBase(base) + url;
  const stripped = (full: string, base: string) => full.slice(base.replace(/\/$/, "").length);

  test("every hosted request lands under /piquette and routes to the fixture API once the base is stripped", () => {
    const filter = { repos: [REPO_API], factories: [] };
    const list = under("/piquette/", sessionsUrl(filter));
    assert.ok(list.startsWith("/piquette/api/sessions?repo=github.com%2Facme%2Fapi"), list);
    const [path, query] = stripped(list, "/piquette").split("?");
    assert.equal(mockApi("hosted", path as string, new URLSearchParams(query), NOW)?.status, 200);
    const arch = archiveRequest(true, "dead0042", true, "f-9e47");
    assert.equal(under("/piquette/", arch.url), "/piquette/api/reviews");
    // A receipt link under the mount resolves to the same base.
    assert.equal(under("/piquette/r/run-1", "/api/health"), "/piquette/api/health");
    assert.equal(under("/", "/api/health"), "/api/health");
  });
});
