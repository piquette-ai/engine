import "./hermetic_git.js";

/** PR evidence links (#214): the viewer comes from `receipts.viewer_url` or the cloud block, under any path, and always names the repo segment. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import * as v from "valibot";
import { evidenceLinksFor } from "../cli/commands/watch.js";
import { SFConfigSchema } from "../core/data_types.js";
import type { VerificationOutcome } from "../core/verification.js";

const KEY = "acme--api/attempts/run-1/2/receipt.json";
const outcome: VerificationOutcome = {
  status: "verified",
  reasons: [],
  journeys: "/h/journeys.yaml",
  base: null,
  head: { key: KEY, stage: "head", attempt: 2, verdict: "PASS", reason: "ok", tree: "a".repeat(40) },
  failed_proofs: 0,
  max_failed_proofs: 3,
};
const ACCESS = { team_domain: "test-team.cloudflareaccess.com", aud: "aud-1" };
const link = async (cfg: Record<string, unknown>) => (await evidenceLinksFor(v.parse(SFConfigSchema, cfg), tmpdir(), outcome))[KEY];
const expected = (base: string) => `${base}/r/run-1?key=${encodeURIComponent(KEY)}&repo=acme--api`;

test("a viewer under a path keeps the path and appends &repo=<segment>", async () => {
  assert.deepEqual(await link({ receipts: { viewer_url: "https://example.com/receipts/" } }), { url: expected("https://example.com/receipts") });
});

test("derived from the cloud block: hostname, hostname with a base path, a route", async () => {
  const cloud = (c: Record<string, unknown>) => ({ cloud: { provider: "cloudflare", access: ACCESS, ...c } });
  assert.deepEqual(await link(cloud({ hostname: "piquette.example.com" })), { url: expected("https://piquette.example.com") });
  assert.deepEqual(await link(cloud({ hostname: "piquette.example.com", base_path: "/piquette" })), { url: expected("https://piquette.example.com/piquette") });
  assert.deepEqual(await link(cloud({ route: "example.com/piquette*", zone: "example.com" })), { url: expected("https://example.com/piquette") });
  assert.deepEqual(await link(cloud({ public_url: "https://piquette.acct.workers.dev" })), { url: expected("https://piquette.acct.workers.dev") });
});

test("an explicit viewer_url beats the cloud block", async () => {
  assert.deepEqual(await link({ receipts: { viewer_url: "https://viewer.example.com" }, cloud: { provider: "cloudflare", hostname: "piquette.example.com", access: ACCESS } }), { url: expected("https://viewer.example.com") });
});

test("a cloud with no offline URL (workers.dev, no public_url) falls back to the presigned link", async () => {
  process.env.PIQUETTE_TEST_EVID_KEY = "AKIDTEST";
  process.env.PIQUETTE_TEST_EVID_SECRET = "secret";
  try {
    const l = (await link({
      cloud: { provider: "cloudflare", access: ACCESS },
      receipts: { store: { kind: "s3", bucket: "piquette-receipts", endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto", access_key_id_env: "PIQUETTE_TEST_EVID_KEY", secret_access_key_env: "PIQUETTE_TEST_EVID_SECRET" } },
    })) as { url: string; expires: string };
    assert.match(l.url, /^https:\/\/acct\.r2\.cloudflarestorage\.com\/piquette-receipts\/acme--api\/attempts\/run-1\/2\/receipt\.json\?X-Amz-Algorithm=/);
    assert.ok(l.expires);
  } finally {
    delete process.env.PIQUETTE_TEST_EVID_KEY;
    delete process.env.PIQUETTE_TEST_EVID_SECRET;
  }
});

test("without the receipts module the cloud is not a viewer", async () => {
  const l = (await link({ cloud: { provider: "cloudflare", hostname: "piquette.example.com", modules: ["ingest"], d1: { database: "piquette-hub" }, access: ACCESS } })) as { local?: string };
  assert.ok(l.local, "a local store path, not a viewer URL");
});
