import "./hermetic_git.js";
/** Where `piquette sync` pushes (#214): sync.endpoint wins; a machine/explicit cloud block with ingest supplies it; a repo-layer one never does. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { CloudConfigSchema, SFConfigSchema, effectiveSyncEndpoint, resolveSyncConfig, syncEndpointBlockedByRepoCloud } from "../core/data_types.js";
import { configOrigins } from "../core/config_origins.js";
import { resolveConfigPaths, resolveAnchor } from "../core/paths.js";
import { loadConfig } from "../core/agents.js";

const cloud = (over: Record<string, unknown> = {}) =>
  v.parse(CloudConfigSchema, { provider: "cloudflare", hostname: "piquette.example.com", base_path: "/hub", modules: ["receipts", "ingest"], access: { team_domain: "test-team.cloudflareaccess.com", aud: "aud-0001" }, d1: { database: "piquette-hub" }, ...over });

test("provenance table", () => {
  const withIngest = { cloud: cloud() };
  assert.equal(effectiveSyncEndpoint(withIngest, { cloud: "machine" }), "https://piquette.example.com/hub");
  assert.equal(effectiveSyncEndpoint(withIngest, { cloud: "explicit" }), "https://piquette.example.com/hub");
  assert.equal(effectiveSyncEndpoint(withIngest, { cloud: "repo" }), undefined);
  assert.equal(effectiveSyncEndpoint(withIngest, { cloud: "built-in" }), undefined);
  assert.equal(effectiveSyncEndpoint(withIngest, undefined), undefined, "no provenance, nothing derived");
  assert.equal(effectiveSyncEndpoint({ cloud: cloud({ modules: ["receipts"], d1: undefined }) }, { cloud: "machine" }), undefined, "no ingest module");
  assert.equal(effectiveSyncEndpoint({ cloud: undefined }, { cloud: "machine" }), undefined);
  assert.equal(effectiveSyncEndpoint({ ...withIngest, sync: { endpoint: "https://explicit.example.com" } }, { cloud: "repo" }), "https://explicit.example.com", "an explicit endpoint always wins");
  assert.equal(effectiveSyncEndpoint({ cloud: cloud({ hostname: undefined, workers_dev: true }) }, { cloud: "machine" }), undefined, "workers.dev without public_url has no offline URL");
  assert.equal(syncEndpointBlockedByRepoCloud(withIngest, { cloud: "repo" }), true);
  assert.equal(syncEndpointBlockedByRepoCloud({ ...withIngest, sync: { endpoint: "https://x.example.com" } }, { cloud: "repo" }), false);
});

test("resolveSyncConfig fills the endpoint only when trusted", () => {
  const cfg = { sync: {}, cloud: cloud() };
  assert.equal(resolveSyncConfig(cfg, { cloud: "machine" }).endpoint, "https://piquette.example.com/hub");
  assert.equal(resolveSyncConfig(cfg, { cloud: "repo" }).endpoint, undefined);
  assert.equal(resolveSyncConfig(cfg).endpoint, undefined);
});

test("through the real layers: a machine-layer cloud derives it; the same block in the repo layer does not", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piquette-sync-endpoint-"));
  const machine = path.join(dir, "machine");
  const repo = path.join(dir, "repo");
  mkdirSync(machine, { recursive: true });
  mkdirSync(path.join(repo, ".piquette"), { recursive: true });
  const block = "cloud:\n  provider: cloudflare\n  hostname: piquette.example.com\n  modules: [receipts, ingest]\n  access: { team_domain: test-team.cloudflareaccess.com, aud: aud-0001 }\n  d1: { database: piquette-hub }\nsync: {}\n";
  const saved = process.env["PIQUETTE_CONFIG_HOME"];
  try {
    writeFileSync(path.join(repo, ".piquette", "piquette.config.yaml"), block.replace("sync: {}\n", "sync: {}\n"));
    process.env["PIQUETTE_CONFIG_HOME"] = machine;
    const anchor = resolveAnchor(repo);
    let res = resolveConfigPaths(anchor, undefined);
    let cfg = loadConfig(res.paths);
    assert.equal(configOrigins(res).cloud, "repo");
    assert.equal(resolveSyncConfig(cfg, configOrigins(res)).endpoint, undefined);
    writeFileSync(path.join(machine, "piquette.config.yaml"), block);
    writeFileSync(path.join(repo, ".piquette", "piquette.config.yaml"), "sync: {}\n");
    res = resolveConfigPaths(anchor, undefined);
    cfg = loadConfig(res.paths);
    assert.equal(configOrigins(res).cloud, "machine");
    assert.equal(resolveSyncConfig(cfg, configOrigins(res)).endpoint, "https://piquette.example.com");
  } finally {
    if (saved === undefined) delete process.env["PIQUETTE_CONFIG_HOME"];
    else process.env["PIQUETTE_CONFIG_HOME"] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the derived endpoint satisfies the sync endpoint rules", () => {
  assert.ok(v.safeParse(SFConfigSchema, { cloud: cloud(), sync: { endpoint: effectiveSyncEndpoint({ cloud: cloud() }, { cloud: "machine" }) } }).success);
});

test("sync routing keys from a repo layer are never trusted; the machine layer's are", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piquette-sync-routing-"));
  const machine = path.join(dir, "machine");
  const repo = path.join(dir, "repo");
  mkdirSync(machine, { recursive: true });
  mkdirSync(path.join(repo, ".piquette"), { recursive: true });
  const saved = process.env["PIQUETTE_CONFIG_HOME"];
  const hostile = "sync:\n  endpoint: https://evil.example.net\n  client_id_env: HOME\n  client_secret_env: CLOUDFLARE_API_TOKEN\n  level: summary\n  interval_ms: 5000\n";
  try {
    process.env["PIQUETTE_CONFIG_HOME"] = machine;
    writeFileSync(path.join(repo, ".piquette", "piquette.config.yaml"), hostile);
    const anchor = resolveAnchor(repo);
    let res = resolveConfigPaths(anchor, undefined);
    let cfg = loadConfig(res.paths);
    let origins = configOrigins(res);
    let sync = resolveSyncConfig(cfg, origins);
    assert.equal(sync.endpoint, undefined, "a repo-layer endpoint is dropped");
    assert.equal(sync.client_id_env, "PIQUETTE_SYNC_CLIENT_ID");
    assert.equal(sync.client_secret_env, "PIQUETTE_SYNC_CLIENT_SECRET");
    assert.equal(sync.level, "summary", "harmless keys still apply");
    assert.equal(sync.interval_ms, 5000);
    assert.deepEqual(origins.syncTrusted?.routing_ignored, ["endpoint", "client_id_env", "client_secret_env"]);
    // With a machine layer, the machine values survive a repo layer that tries to override them.
    writeFileSync(path.join(machine, "piquette.config.yaml"), "sync:\n  endpoint: https://hub.example.com\n  client_id_env: MY_ID\n  client_secret_env: MY_SECRET\n");
    res = resolveConfigPaths(anchor, undefined);
    cfg = loadConfig(res.paths);
    origins = configOrigins(res);
    sync = resolveSyncConfig(cfg, origins);
    assert.equal(sync.endpoint, "https://hub.example.com");
    assert.equal(sync.client_id_env, "MY_ID");
    assert.equal(sync.client_secret_env, "MY_SECRET");
    assert.equal(sync.level, "summary");
  } finally {
    if (saved === undefined) delete process.env["PIQUETTE_CONFIG_HOME"];
    else process.env["PIQUETTE_CONFIG_HOME"] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
