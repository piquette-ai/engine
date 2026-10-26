import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { run198, startSite, videoKey, type Site } from "./harness.ts";

describe("base_path: mounted under /piquette", () => {
  let site: Site;
  before(async () => {
    site = await startSite({ BASE_PATH: "/piquette", PIQUETTE_MODULES: "receipts,dashboard" });
    await site.seed(run198());
  });
  after(() => site.dispose());

  test("the bare base redirects to the slash form", async () => {
    const res = await site.fetch("/piquette?x=1", { redirect: "manual", token: null });
    assert.equal(res.status, 308);
    assert.equal(res.headers.get("location"), "/piquette/?x=1");
    await res.arrayBuffer();
  });

  test("api, run page, relocated assets and the dashboard shell are served under the base", async () => {
    let res = await site.fetch("/piquette/api/receipts/issue-198");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { head: { attempt: number } }).head.attempt, 2);
    res = await site.fetch(`/piquette/r/issue-198?key=${encodeURIComponent(videoKey(2))}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /PIQUETTE-FIXTURE-MARKER/);
    res = await site.fetch("/piquette/r/assets/app-abc123.js");
    assert.equal(res.status, 200);
    res = await site.fetch("/piquette/assets/app-abc123.js");
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    res = await site.fetch("/piquette/");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /PIQUETTE-FIXTURE-MARKER/);
  });

  test("an asset-layer redirect stays inside the mount", async () => {
    const res = await site.fetch("/piquette/index.html", { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) assert.match(res.headers.get("location") ?? "", /^\/piquette(\/|$)/);
    else assert.ok(res.status < 500);
    await res.arrayBuffer();
  });

  test("a missing token under the base is 401", async () => {
    const res = await site.fetch("/piquette/api/receipts/issue-198", { token: null });
    assert.equal(res.status, 401);
    await res.arrayBuffer();
  });

  test("outside the base, and prefix tricks, are plain 404", async () => {
    for (const p of ["/r/issue-198", "/api/receipts/issue-198", "/piquettex/r/issue-198", "/piquettex", "/other", "/piquette/%2e%2e/r/x", "/piquette/a%2fb", "/piquette//api/receipts/issue-198"]) {
      const res = await site.fetch(p);
      assert.equal(res.status, 404, p);
      assert.doesNotMatch(await res.text(), /PIQUETTE-FIXTURE-MARKER|head/, p);
    }
  });
});
