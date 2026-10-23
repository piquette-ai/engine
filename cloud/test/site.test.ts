import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { VIDEO } from "../../src/test/receipt_fixture.ts";
import { run198, startSite, videoKey, type Site } from "./harness.ts";

const file = (key: string) => `/api/receipts/issue-198/file?key=${encodeURIComponent(key)}`;
const bytes = async (r: { arrayBuffer(): Promise<ArrayBuffer> }) => new Uint8Array(await r.arrayBuffer());

describe("site: receipts through the Worker", () => {
  let site: Site;
  before(async () => {
    site = await startSite();
    await site.seed(run198());
  });
  after(() => site.dispose());

  test("run endpoint: head is attempt 2, base is attempt 1", async () => {
    const res = await site.fetch("/api/receipts/issue-198");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const body = (await res.json()) as { head: { attempt: number }; base: { attempt: number } };
    assert.equal(body.head.attempt, 2);
    assert.equal(body.base.attempt, 1);
  });

  test("file route serves ranges from R2 with the PR-link key format", async () => {
    const key = videoKey(2);
    let res = await site.fetch(file(key), { headers: { range: "bytes=0-99" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 0-99/256");
    assert.deepEqual(await bytes(res), VIDEO.slice(0, 100));

    res = await site.fetch(file(key), { headers: { range: "bytes=-100" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 156-255/256");
    assert.deepEqual(await bytes(res), VIDEO.slice(156));

    res = await site.fetch(file(key), { headers: { range: "bytes=200-" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 200-255/256");

    res = await site.fetch(file(key), { headers: { range: "bytes=256-" } });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get("content-range"), "bytes */256");
    await res.arrayBuffer();

    res = await site.fetch(file(key), { method: "HEAD", headers: { range: "bytes=0-99" } });
    assert.equal(res.status, 206);
    assert.equal((await bytes(res)).byteLength, 0);
    assert.equal(res.headers.get("content-length"), "100");
    assert.equal(res.headers.get("content-range"), `bytes 0-99/${VIDEO.byteLength}`);

    res = await site.fetch(file(key));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(await bytes(res), VIDEO);
  });

  test("a key the receipts do not list is 404", async () => {
    const res = await site.fetch(file("issue-198/attempts/issue-198/2/secret.txt"));
    assert.equal(res.status, 404);
    await res.arrayBuffer();
  });

  test("an /api miss is JSON, never the SPA", async () => {
    const res = await site.fetch("/api/nope");
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.match(((await res.json()) as { error: string }).error, /no route/);
  });

  test("SPA: run page, relocated assets, deep route fallback", async () => {
    let res = await site.fetch(`/r/issue-198?key=${encodeURIComponent(videoKey(2))}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /SPF-FIXTURE-MARKER/);

    res = await site.fetch("/r/assets/app-abc123.js");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    assert.match(await res.text(), /fixture-app/);

    res = await site.fetch("/r/some/deep/route");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /SPF-FIXTURE-MARKER/);
  });

  test("the dashboard SPA is not served outside /r/ (its poll loop would burn the Workers quota)", async () => {
    for (const p of ["/", "/some/deep/route", "/sessions"]) {
      const res = await site.fetch(p);
      assert.equal(res.status, 404, p);
      assert.doesNotMatch(await res.text(), /SPF-FIXTURE-MARKER/);
    }
  });
});

test("site: RECEIPTS_PREFIX namespaces the bucket", async () => {
  const site = await startSite({ RECEIPTS_PREFIX: "spf" });
  try {
    await site.seed(run198(), "spf/");
    const res = await site.fetch("/api/receipts/issue-198");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { head: { attempt: number } }).head.attempt, 2);
  } finally {
    await site.dispose();
  }
});

describe("site: shell chrome and CSP", () => {
  test("no chrome: the shell is served byte-identical with a strict CSP and no-store", async () => {
    const site = await startSite();
    try {
      const res = await site.fetch("/r/issue-198");
      const html = await res.text();
      // Receipts-only: the shell carries only the "no dashboard" flag (so the SPA does not link to a root that 404s).
      const fixture = readFileSync(path.join(import.meta.dirname, "fixtures", "web", "index.html"), "utf8");
      assert.equal(html, fixture.replace("</head>", '<script type="application/json" id="spf-brand">{"dashboard":false}</script></head>'));
      assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; frame-src 'none'/);
      assert.equal(res.headers.get("cache-control"), "private, no-store");
    } finally {
      await site.dispose();
    }
  });

  test("chrome URLs are injected and their origins allowed; an http URL is ignored", async () => {
    const site = await startSite({
      CHROME_STYLESHEET_URL: "https://host.example.com/site.css",
      CHROME_HEADER_URL: "https://host.example.com/header?a=1&b=2",
      CHROME_HOME_URL: "http://insecure.example.com/",
    });
    try {
      const res = await site.fetch("/r/issue-198");
      const html = await res.text();
      assert.match(html, /<link rel="stylesheet" href="https:\/\/host\.example\.com\/site\.css" crossorigin="anonymous">/);
      assert.match(html, /<iframe class="spf-host-header" src="https:\/\/host\.example\.com\/header\?a=1&amp;b=2"/);
      assert.match(html, /sandbox="allow-scripts allow-popups allow-top-navigation-by-user-activation"/);
      assert.doesNotMatch(html, /allow-same-origin|insecure\.example|spf-home-url/);
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/host\.example\.com;/);
      assert.match(csp, /frame-src https:\/\/host\.example\.com;/);
      assert.doesNotMatch(csp, /insecure/);
    } finally {
      await site.dispose();
    }
  });

  test("brand: dashboard on, no brand is byte-identical; a brand injects style + JSON, title, favicon, and img-src only when configured", async () => {
    const plain = await startSite({ SPF_MODULES: "receipts,dashboard" });
    try {
      const html = await (await plain.fetch("/r/issue-198")).text();
      assert.equal(html, readFileSync(path.join(import.meta.dirname, "fixtures", "web", "index.html"), "utf8"));
    } finally {
      await plain.dispose();
    }
    const brand = {
      name: "Acme </title><script>x</script> Factory",
      logo_url: "https://cdn.example.com/logo.svg",
      favicon_url: "data:image/svg+xml,%3Csvg%2F%3E",
      home_url: "https://www.example.com/",
      colors: { accent: { light: "#0a7a5c", dark: "#5eead4" } },
    };
    const site = await startSite({ SPF_MODULES: "receipts,dashboard", BRAND_JSON: JSON.stringify(brand), CHROME_HOME_URL: "https://chrome.example.com/" });
    try {
      const res = await site.fetch("/r/issue-198");
      const html = await res.text();
      assert.match(html, /<style id="spf-brand-style">body\{--accent:#0a7a5c\}body\.board\{--accent:#5eead4\}<\/style>/);
      // The name is dropped (markup), so the title stays; the rest is delivered as a non-executable JSON blob.
      const blob = /<script type="application\/json" id="spf-brand">([^]*?)<\/script>/.exec(html);
      assert.ok(blob, "json blob present");
      assert.doesNotMatch(blob![1]!, /</);
      const parsed = JSON.parse(blob![1]!) as { brand: Record<string, unknown>; dashboard?: boolean };
      assert.equal(parsed.brand["name"], undefined);
      assert.equal(parsed.brand["home_url"], "https://www.example.com/");
      assert.equal(parsed.dashboard, undefined);
      assert.equal(parsed.brand["favicon_url"], "data:image/svg+xml,%3Csvg%2F%3E");
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.match(csp, /img-src 'self' data: https:\/\/cdn\.example\.com;/);
      assert.match(csp, /script-src 'self';/);
    } finally {
      await site.dispose();
    }
  });

  test("brand: a name and the chrome home link fall back; a bad var is ignored, never an error", async () => {
    const site = await startSite({ SPF_MODULES: "receipts,dashboard", BRAND_JSON: JSON.stringify({ name: "Acme Factory" }), CHROME_HOME_URL: "https://chrome.example.com/" });
    try {
      const html = await (await site.fetch("/r/issue-198")).text();
      assert.match(html, /<title>Acme Factory<\/title>/);
      assert.match(html, /"home_url":"https:\/\/chrome\.example\.com\/"/);
    } finally {
      await site.dispose();
    }
    const bad = await startSite({ SPF_MODULES: "receipts,dashboard", BRAND_JSON: "{not json" });
    try {
      const res = await bad.fetch("/r/issue-198");
      assert.equal(res.status, 200);
      assert.equal(await res.text(), readFileSync(path.join(import.meta.dirname, "fixtures", "web", "index.html"), "utf8"));
      assert.doesNotMatch(res.headers.get("content-security-policy") ?? "", /cdn\.example/);
    } finally {
      await bad.dispose();
    }
  });

  test("CSP and chrome apply to the HTML shell only, not to scripts", async () => {
    const site = await startSite();
    try {
      const res = await site.fetch("/r/assets/app-abc123.js");
      assert.equal(res.headers.get("content-security-policy"), null);
      await res.arrayBuffer();
    } finally {
      await site.dispose();
    }
  });
});
