/** Pure shell helpers (#214): base stripping, chrome injection and escaping, CSP origins, apiBase, and no inline script in the app shell. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromeFromVars, injectShell, shellCsp, stripBase } from "../cloud/shell.js";
import { apiBase } from "../ui/shared/viewer_base.js";

test("stripBase table", () => {
  const cases: Array<[string, string, string | null]> = [
    ["/r/x", "/", "/r/x"],
    ["/", "/", "/"],
    ["/spf/r/x", "/spf", "/r/x"],
    ["/spf/", "/spf", "/"],
    ["/spf", "/spf", "/"],
    ["/spfx/r/x", "/spf", null],
    ["/spfx", "/spf", null],
    ["/r/x", "/spf", null],
    ["/spf//x", "/spf", null],
    ["//x", "/", null],
    ["/spf/a/../b", "/spf", null],
    ["/spf/%2e%2e/b", "/spf", null],
    ["/spf/a%2Fb", "/spf", null],
    ["/spf/a%5cb", "/spf", null],
    ["/a/b/r/x", "/a/b", "/r/x"],
    ["/a/br/x", "/a/b", null],
    ["spf/r", "/spf", null],
  ];
  for (const [p, base, want] of cases) assert.equal(stripBase(p, base), want, `${p} under ${base}`);
});

test("apiBase table", () => {
  const cases: Array<[string, string]> = [
    ["/", ""],
    ["", ""],
    ["/index.html", ""],
    ["/spf/", "/spf"],
    ["/spf", "/spf"],
    ["/spf/index.html", "/spf"],
    ["/r/run-1", ""],
    ["/r/run-1/", ""],
    ["/spf/r/run-1", "/spf"],
    ["/a/b/r/run-1", "/a/b"],
    ["/a/b/", "/a/b"],
    ["/r/assets/x", "/r/assets/x"],
    ["//evil.example/", "/evil.example"],
    ["///", ""],
    ["//r/run-1", ""],
  ];
  for (const [p, want] of cases) assert.equal(apiBase(p), want, p);
});

const HTML = '<!doctype html><html><head><title>t</title></head><body><div id="app"></div></body></html>';

test("a shell with no chrome is byte-identical", () => {
  assert.equal(injectShell(HTML, chromeFromVars({})), HTML);
  assert.equal(injectShell(HTML, { header_height: 80 }), HTML);
});

test("injectShell escapes every attribute and never allows same-origin", () => {
  const out = injectShell(HTML, { stylesheet_url: 'https://h.example.com/a.css?x="><script>', header_url: "https://h.example.com/h?a=1&b='2'", home_url: "https://h.example.com/?q=<b>", header_height: 64 });
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /href="https:\/\/h\.example\.com\/a\.css\?x=&quot;&gt;&lt;script&gt;"/);
  assert.match(out, /src="https:\/\/h\.example\.com\/h\?a=1&amp;b=&#39;2&#39;"/);
  assert.match(out, /<meta name="spf-home-url" content="https:\/\/h\.example\.com\/\?q=&lt;b&gt;">/);
  assert.match(out, /height:64px/);
  assert.doesNotMatch(out, /allow-same-origin/);
  assert.ok(out.indexOf("spf-host-header") < out.indexOf('<div id="app">'));
  assert.ok(out.indexOf("rel=\"stylesheet\"") < out.indexOf("</head>"));
});

test("chromeFromVars drops non-https and clamps the height", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const c = chromeFromVars({ CHROME_STYLESHEET_URL: "http://x.example.com/a.css", CHROME_HEADER_URL: "https://u:p@x.example.com/", CHROME_HOME_URL: "https://x.example.com/", CHROME_HEADER_HEIGHT: "9999" });
    assert.equal(c.stylesheet_url, undefined);
    assert.equal(c.header_url, undefined);
    assert.equal(c.home_url, "https://x.example.com/");
    assert.equal(c.header_height, 56);
  } finally {
    console.warn = warn;
  }
});

test("shellCsp: self only, plus the chrome origins", () => {
  const none = shellCsp({ header_height: 56 });
  assert.match(none, /^default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'$/);
  const some = shellCsp({ stylesheet_url: "https://css.example.com/a/b.css", header_url: "https://hdr.example.com/h", header_height: 56 });
  assert.match(some, /style-src 'self' 'unsafe-inline' https:\/\/css\.example\.com;/);
  assert.match(some, /img-src 'self' data: https:\/\/css\.example\.com;/);
  assert.match(some, /font-src 'self' https:\/\/css\.example\.com;/);
  assert.match(some, /frame-src https:\/\/hdr\.example\.com;/);
  assert.doesNotMatch(some, /script-src[^;]*example/);
});

test("app/index.html has no inline script body (the shell CSP is script-src 'self')", () => {
  const html = readFileSync(new URL("../../app/index.html", import.meta.url), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 2);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs ?? "", /\bsrc=/);
    assert.equal((body ?? "").trim(), "");
  }
  assert.match(html, /<script src="\.\/theme-boot\.js"><\/script>/);
});
