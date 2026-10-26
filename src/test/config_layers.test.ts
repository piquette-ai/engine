import "./hermetic_git.js";

/** The layered config (#214): built-in -> machine -> repo, `--config` standalone, dedupe, doctor lines, and where `cloud:` came from. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { doctorCommand } from "../cli/commands/doctor.js";
import { configOrigins } from "../core/config_origins.js";
import { BUILTIN_CONFIG_PATH, machineConfigPath, resolveConfigPaths, type RepoAnchor } from "../core/paths.js";

function scratch(): { root: string; home: string; repo: string; anchor: RepoAnchor } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piquette-layers-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".piquette"), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home, repo, anchor: { cwd: repo, repo_root: repo, piquette_dir: join(repo, ".piquette") } };
}
const CLOUD = (name: string) => `cloud:\n  provider: cloudflare\n  name: ${name}\n  hostname: ${name}.example.com\n  access: { team_domain: test-team.cloudflareaccess.com, aud: [aud-${name}] }\n`;

test("layer order is built-in -> machine -> repo, and a missing machine file is not listed", () => {
  const { root, home, repo, anchor } = scratch();
  try {
    writeFileSync(join(repo, ".piquette", "piquette.config.yaml"), "defaults: {}\n");
    let r = resolveConfigPaths(anchor, undefined, {}, home);
    assert.deepEqual(r.layers.map((l) => l.kind), ["built-in", "repo"], "no machine file yet");
    mkdirSync(join(home, ".piquette"), { recursive: true });
    writeFileSync(join(home, ".piquette", "piquette.config.yaml"), "defaults: {}\n");
    r = resolveConfigPaths(anchor, undefined, {}, home);
    assert.deepEqual(r.layers.map((l) => l.kind), ["built-in", "machine", "repo"]);
    assert.deepEqual(r.paths, [BUILTIN_CONFIG_PATH, join(home, ".piquette", "piquette.config.yaml"), join(repo, ".piquette", "piquette.config.yaml")]);
    assert.equal(r.source, "layered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PIQUETTE_CONFIG_HOME wins over home; an empty one counts as unset", () => {
  const { root, home, anchor } = scratch();
  try {
    const cfgHome = join(root, "cfg-home");
    mkdirSync(cfgHome);
    writeFileSync(join(cfgHome, "piquette.config.yaml"), "defaults: {}\n");
    mkdirSync(join(home, ".piquette"), { recursive: true });
    writeFileSync(join(home, ".piquette", "piquette.config.yaml"), "defaults: {}\n");
    assert.equal(machineConfigPath({ PIQUETTE_CONFIG_HOME: cfgHome }, home), join(cfgHome, "piquette.config.yaml"));
    assert.equal(machineConfigPath({ PIQUETTE_CONFIG_HOME: "" }, home), join(home, ".piquette", "piquette.config.yaml"));
    assert.equal(resolveConfigPaths(anchor, undefined, { PIQUETTE_CONFIG_HOME: cfgHome }, home).layers[1]!.path, join(cfgHome, "piquette.config.yaml"));
    assert.equal(resolveConfigPaths(anchor, undefined, {}, home).layers[1]!.path, join(home, ".piquette", "piquette.config.yaml"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--config stays standalone: no built-in, no machine layer", () => {
  const { root, home, repo, anchor } = scratch();
  try {
    mkdirSync(join(home, ".piquette"), { recursive: true });
    writeFileSync(join(home, ".piquette", "piquette.config.yaml"), "defaults: {}\n");
    writeFileSync(join(repo, "mine.yaml"), "defaults: {}\n");
    const r = resolveConfigPaths(anchor, "mine.yaml", {}, home);
    assert.deepEqual(r.paths, [join(repo, "mine.yaml")]);
    assert.deepEqual(r.layers, [{ kind: "explicit", path: join(repo, "mine.yaml") }]);
    assert.equal(r.source, "explicit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the machine file that is also the repo file (same path or a symlink) loads once, as machine", () => {
  const { root, home, anchor } = scratch();
  try {
    const machineDir = join(root, "machine");
    mkdirSync(machineDir);
    writeFileSync(join(machineDir, "piquette.config.yaml"), "defaults: {}\n");
    // Same file through the repo's .piquette (a symlink)
    symlinkSync(join(machineDir, "piquette.config.yaml"), join(anchor.piquette_dir!, "piquette.config.yaml"));
    const r = resolveConfigPaths(anchor, undefined, { PIQUETTE_CONFIG_HOME: machineDir }, home);
    assert.deepEqual(r.layers.map((l) => l.kind), ["built-in", "machine"]);
    // Same path, no symlink
    const same = resolveConfigPaths({ cwd: root, repo_root: root, piquette_dir: machineDir }, undefined, { PIQUETTE_CONFIG_HOME: machineDir }, home);
    assert.deepEqual(same.layers.map((l) => l.kind), ["built-in", "machine"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configOrigins: the last layer that declares cloud wins; a null block does not count", () => {
  const { root, home, repo, anchor } = scratch();
  try {
    mkdirSync(join(home, ".piquette"), { recursive: true });
    writeFileSync(join(home, ".piquette", "piquette.config.yaml"), CLOUD("machine"));
    writeFileSync(join(repo, ".piquette", "piquette.config.yaml"), "defaults: {}\n");
    assert.deepEqual(configOrigins(resolveConfigPaths(anchor, undefined, {}, home)), { cloud: "machine", cloudPath: join(home, ".piquette", "piquette.config.yaml"), syncTrusted: { values: {}, routing_ignored: [] }, uiBrandTrusted: { values: {}, urls_ignored: [] } });
    writeFileSync(join(repo, ".piquette", "piquette.config.yaml"), CLOUD("repo"));
    assert.equal(configOrigins(resolveConfigPaths(anchor, undefined, {}, home)).cloud, "repo");
    writeFileSync(join(repo, ".piquette", "piquette.config.yaml"), "cloud:\n");
    assert.equal(configOrigins(resolveConfigPaths(anchor, undefined, {}, home)).cloud, "machine");
    writeFileSync(join(home, ".piquette", "piquette.config.yaml"), "defaults: {}\n");
    writeFileSync(join(repo, ".piquette", "piquette.config.yaml"), "defaults: {}\n");
    assert.equal(configOrigins(resolveConfigPaths(anchor, undefined, {}, home)).cloud, undefined);
    assert.equal(configOrigins(resolveConfigPaths(anchor, "nope.yaml", {}, home)).cloud, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function doctorJson(dir: string, env: Record<string, string>): Promise<Array<{ name: string; detail: string }>> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const logs: string[] = [];
  const [log, err, warn] = [console.log, console.error, console.warn];
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = () => {};
  console.warn = () => {};
  try {
    await doctorCommand(["--cwd", dir, "--json", "--no-probe"]);
  } finally {
    [console.log, console.error, console.warn] = [log, err, warn];
    for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return (JSON.parse(logs.join("\n")) as { checks: Array<{ name: string; detail: string }> }).checks;
}

test("doctor lists the layers, notes an empty PIQUETTE_CONFIG_HOME, and prints a static cloud line", async () => {
  const { root, repo } = scratch();
  try {
    const cfgHome = join(root, "cfg-home");
    mkdirSync(cfgHome);
    let checks = await doctorJson(repo, { PIQUETTE_CONFIG_HOME: cfgHome });
    const layers = checks.find((c) => c.name === "config resolution")!;
    assert.match(layers.detail, /^config layers: built-in \S+$/);
    assert.doesNotMatch(layers.detail, /machine/);
    assert.match(checks.find((c) => c.name === "machine config")!.detail, /has no piquette\.config\.yaml/);

    writeFileSync(join(cfgHome, "piquette.config.yaml"), CLOUD("machine"));
    checks = await doctorJson(repo, { PIQUETTE_CONFIG_HOME: cfgHome });
    assert.match(checks.find((c) => c.name === "config resolution")!.detail, /built-in .* -> machine .*piquette\.config\.yaml/);
    assert.equal(checks.find((c) => c.name === "cloud")!.detail, "machine → https://machine.example.com (probe: piquette cloud status)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor never probes a repo-layer sync endpoint and never sends it an env var", async () => {
  const { root, home, repo } = scratch();
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url} ${req.headers["cf-access-client-id"] ?? ""} ${req.headers["cf-access-client-secret"] ?? ""}`);
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(repo, ".piquette", "piquette.config.yaml"), `sync:\n  endpoint: http://127.0.0.1:${port}\n  client_id_env: HOME\n  client_secret_env: PIQUETTE_TEST_FAKE_TOKEN\n`);
  const saved = { ...process.env };
  process.env["PIQUETTE_CONFIG_HOME"] = home;
  process.env["PIQUETTE_TEST_FAKE_TOKEN"] = "fake-token-xyz";
  const logs: string[] = [];
  const [log, err, warn] = [console.log, console.error, console.warn];
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = () => {};
  console.warn = () => {};
  try {
    await doctorCommand(["--cwd", repo, "--json"]);
  } finally {
    [console.log, console.error, console.warn] = [log, err, warn];
    for (const k of ["PIQUETTE_CONFIG_HOME", "PIQUETTE_TEST_FAKE_TOKEN"]) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(hits, [], "nothing was sent to the repo's endpoint");
  const checks = (JSON.parse(logs.join("\n")) as { checks: Array<{ name: string; detail: string }> }).checks;
  assert.match(checks.find((c) => c.name === "sync routing")!.detail, /sync\.endpoint, sync\.client_id_env, sync\.client_secret_env ignored/);
  assert.match(checks.find((c) => c.name === "sync hub")!.detail, /not taken from a repo layer/);
});
