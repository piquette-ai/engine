/** `cloud:` through the layer merge (#214): the whole block survives, and is replaced whole, never half-merged. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/agents.js";
import { BUILTIN_CONFIG_PATH } from "../core/paths.js";

const MACHINE = `
cloud:
  provider: cloudflare
  name: machine-app
  hostname: piquette.example.com
  modules: [receipts]
  access: { team_domain: test-team.cloudflareaccess.com, aud: [machine-aud-1] }
  r2: { bucket: machine-bucket }
receipts:
  store:
    kind: s3
    bucket: machine-bucket
    region: auto
    endpoint: https://acct.r2.cloudflarestorage.com
sync: {}
`;

function layers(machine: string, repo: string): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), "piquette-cloud-merge-"));
  try {
    writeFileSync(join(dir, "machine.yaml"), machine);
    writeFileSync(join(dir, "repo.yaml"), repo);
    return loadConfig([BUILTIN_CONFIG_PATH, join(dir, "machine.yaml"), join(dir, "repo.yaml")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("built-in -> machine (cloud + receipts.store + sync:{}) -> repo (receipts.record:false): all survive", () => {
  const cfg = layers(MACHINE, "receipts:\n  record: false\n");
  assert.equal(cfg.cloud?.name, "machine-app");
  assert.equal(cfg.cloud?.hostname, "piquette.example.com");
  assert.deepEqual(cfg.cloud?.access.aud, ["machine-aud-1"]);
  assert.equal(cfg.receipts?.store.kind, "s3");
  assert.equal(cfg.receipts?.record, false);
  assert.ok(cfg.sync, "sync: {} turns sync on");
});

test("a repo cloud block replaces the machine's whole: no field of the machine's survives", () => {
  const cfg = layers(MACHINE, "cloud:\n  provider: cloudflare\n  access: { team_domain: other-team.cloudflareaccess.com, aud: [repo-aud] }\n");
  assert.equal(cfg.cloud?.name, "piquette", "name is the default, not the machine's");
  assert.equal(cfg.cloud?.hostname, undefined);
  assert.equal(cfg.cloud?.r2, undefined);
  assert.deepEqual(cfg.cloud?.access.aud, ["repo-aud"]);
  assert.equal(cfg.cloud?.access.team_domain, "other-team.cloudflareaccess.com");
});

test("no layer declares cloud: absent, not an empty block", () => {
  assert.equal(layers("sync: {}\n", "defaults: {}\n").cloud, undefined);
});
