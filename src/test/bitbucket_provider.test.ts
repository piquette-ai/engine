import { test } from "node:test";
import assert from "node:assert/strict";
import { BitbucketProvider } from "../core/issues/bitbucket_provider.js";

function mockFetch(responses: Array<{ status?: number; body?: unknown }>): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  let i = 0;
  (globalThis as any).fetch = async (url: string) => {
    urls.push(String(url));
    const resp = responses[Math.min(i++, responses.length - 1)]!;
    const status = resp.status ?? 200;
    return { ok: status < 300, status, text: async () => JSON.stringify(resp.body ?? ""), json: async () => resp.body } as unknown as Response;
  };
  return { urls, restore: () => void (globalThis.fetch = original) };
}

function makeProvider(): BitbucketProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (BitbucketProvider as any)("acme/widgets", "me@example.com", "token");
}

test("findOpenPr: filters open PRs by source branch and returns the first, or null", async () => {
  const { urls, restore } = mockFetch([
    { body: { values: [{ id: 7, links: { html: { href: "https://bitbucket.org/acme/widgets/pull-requests/7" } } }] } },
    { body: { values: [] } },
  ]);
  try {
    const provider = makeProvider();
    assert.deepEqual(await provider.findOpenPr("spf-watch/1-x"), { number: 7, branch: "spf-watch/1-x", url: "https://bitbucket.org/acme/widgets/pull-requests/7" });
    const decoded = decodeURIComponent(urls[0]!);
    assert.match(decoded, /source\.branch\.name="spf-watch\/1-x" AND state="OPEN"/);
    assert.equal(await provider.findOpenPr("none"), null);
  } finally {
    restore();
  }
});

test("a non-2xx response throws an HttpError exposing .status", async () => {
  const { restore } = mockFetch([{ status: 503, body: "unavailable" }]);
  try {
    const err = await makeProvider().findOpenPr("b").catch((e) => e);
    assert.equal(err.status, 503);
  } finally {
    restore();
  }
});
