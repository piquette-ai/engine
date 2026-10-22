/**
 * #159 ticket E / #177: where the PR's evidence links point —
 * `evidenceLinksFor` in cli/commands/watch.ts. A viewer link when
 * `receipts.viewer_url` is set; a presigned, expiring URL for an S3/R2
 * store (signed locally — no network); a real path for a local store.
 */
import "./hermetic_git.js"; // house rule
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { evidenceLinksFor } from "../cli/commands/watch.js";
import { SFConfigSchema } from "../core/data_types.js";
import type { VerificationOutcome } from "../core/verification.js";

const KEY = "repo/attempts/run-1/2/receipt.json";
const VIDEO = "repo/attempts/run-1/2/video.mp4";
const outcome: VerificationOutcome = {
  status: "verified",
  reasons: [],
  journeys: "/h/journeys.yaml",
  base: null,
  head: { key: KEY, stage: "head", attempt: 2, verdict: "PASS", reason: "ok", tree: "a".repeat(40), video: VIDEO },
  failed_proofs: 0,
  max_failed_proofs: 3,
};

test("a viewer link never expires and names the run and the key", async () => {
  const cfg = v.parse(SFConfigSchema, { receipts: { viewer_url: "https://receipts.example.com/" } });
  const links = await evidenceLinksFor(cfg, tmpdir(), outcome);
  assert.deepEqual(links[KEY], { url: `https://receipts.example.com/r/run-1?key=${encodeURIComponent(KEY)}` });
  assert.equal("expires" in links[VIDEO]!, false);
});

test("an S3/R2 store gets presigned URLs that say when they expire (7 days)", async () => {
  process.env.SPF_TEST_LINKS_KEY = "AKIDTEST";
  process.env.SPF_TEST_LINKS_SECRET = "secret";
  try {
    const cfg = v.parse(SFConfigSchema, {
      receipts: {
        store: { kind: "s3", bucket: "spf-receipts", endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto", access_key_id_env: "SPF_TEST_LINKS_KEY", secret_access_key_env: "SPF_TEST_LINKS_SECRET" },
      },
    });
    const links = await evidenceLinksFor(cfg, tmpdir(), outcome);
    const link = links[VIDEO]! as { url: string; expires: string };
    assert.match(link.url, /^https:\/\/acct\.r2\.cloudflarestorage\.com\/spf-receipts\/repo\/attempts\/run-1\/2\/video\.mp4\?X-Amz-Algorithm=AWS4-HMAC-SHA256&/);
    assert.match(link.url, /X-Amz-Expires=604800/);
    const days = (Date.parse(link.expires) - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days <= 7, `expires in ~7 days (${days.toFixed(2)})`);
  } finally {
    delete process.env.SPF_TEST_LINKS_KEY;
    delete process.env.SPF_TEST_LINKS_SECRET;
  }
});

test("a local store links to the real path of evidence that exists, and the plain path of evidence that doesn't", async () => {
  const repo = mkdtempSync(join(tmpdir(), "spf-links-repo-"));
  try {
    const cfg = v.parse(SFConfigSchema, { receipts: { store: { kind: "local", path: "store" } } });
    mkdirSync(join(repo, "store", "repo", "attempts", "run-1", "2"), { recursive: true });
    writeFileSync(join(repo, "store", ...KEY.split("/")), "{}");
    const links = await evidenceLinksFor(cfg, repo, outcome);
    assert.deepEqual(links[KEY], { local: realpathSync(join(repo, "store", ...KEY.split("/"))) });
    assert.deepEqual(links[VIDEO], { local: join(realpathSync(repo), "store", ...VIDEO.split("/")) });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
