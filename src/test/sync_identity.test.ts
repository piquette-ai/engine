import "./hermetic_git.js";

/** Factory id + repo slug identity for `spf sync` (#135). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "../core/agents.js";
import { configOrigins } from "../core/config_origins.js";
import { resolveAnchor, resolveConfigPaths } from "../core/paths.js";
import { hostname } from "node:os";
import { adoptableLegacyDir, defaultFactoryName, loadOrCreateFactoryId, normalizeRepoSlug, parseRemote, peekFactoryId, resolveFactory, resolveRepoSlug } from "../core/sync/identity.js";

const execFileP = promisify(execFile);

test("parseRemote: https, ssh, scp and ssh:// with a port all give host + path", () => {
  const cases: Array<[string, { host: string; path: string } | undefined]> = [
    ["https://github.com/acme/api.git", { host: "github.com", path: "acme/api" }],
    ["git@github.com:acme/api.git", { host: "github.com", path: "acme/api" }],
    ["github.com:acme/api", { host: "github.com", path: "acme/api" }],
    ["ssh://git@git.example.com:2222/acme/api.git/", { host: "git.example.com", path: "acme/api" }],
    ["https://GitHub.COM/Acme/Api/", { host: "github.com", path: "Acme/Api" }],
    ["https://git.corp.example.com/platform/api.git", { host: "git.corp.example.com", path: "platform/api" }],
    ["https://gitlab.com/group/sub/deep/api.git", { host: "gitlab.com", path: "group/sub/deep/api" }],
    ["https://dev.azure.com/org/proj/_git/api", { host: "dev.azure.com", path: "org/proj/api" }],
    ["https://org@dev.azure.com/org/proj/_git/api", { host: "dev.azure.com", path: "org/proj/api" }],
    ["git@ssh.dev.azure.com:v3/org/proj/api", { host: "dev.azure.com", path: "org/proj/api" }],
    ["org@vs-ssh.visualstudio.com:v3/org/proj/api", { host: "dev.azure.com", path: "org/proj/api" }],
    ["git@github.com-work:acme/api.git", { host: "github.com", path: "acme/api" }],
    ["ssh://git@ssh.github.com:443/acme/api.git", { host: "github.com", path: "acme/api" }],
    ["file:///srv/git/api.git", undefined],
    ["/srv/git/api.git", undefined],
    ["C:/src/api", undefined],
    ["C:\\src\\api", undefined],
    ["", undefined],
  ];
  for (const [input, want] of cases) assert.deepEqual(parseRemote(input), want, input);
});

test("parseRemote: a token in the userinfo never appears in the output", () => {
  const out = parseRemote("https://user:ghp_SECRETTOKEN123@github.com/acme/api.git");
  assert.deepEqual(out, { host: "github.com", path: "acme/api" });
  assert.ok(!JSON.stringify(out).includes("SECRETTOKEN"));
});

test("normalizeRepoSlug: lowercase host/owner/name; a dotted first segment is the host", () => {
  assert.equal(normalizeRepoSlug("Acme/API", "github.com"), "github.com/acme/api");
  assert.equal(normalizeRepoSlug("gitlab.com/g/sub/x.git", "github.com"), "gitlab.com/g/sub/x");
  assert.equal(normalizeRepoSlug("acme/api", "Bitbucket.org"), "bitbucket.org/acme/api");
});

function gitRepo(remotes: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "spf-identity-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, url] of Object.entries(remotes)) execFileSync("git", ["remote", "add", name, url], { cwd: dir });
  return dir;
}

function cfgWith(yaml: string): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), "spf-identity-cfg-"));
  try {
    const file = join(dir, "spf.config.yaml");
    writeFileSync(file, yaml);
    return loadConfig([file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveRepoSlug: sync.repo > watch.repo > upstream > origin > local/<basename>", () => {
  const forkOf = gitRepo({ origin: "git@github.com:me/api.git", upstream: "https://github.com/acme/api.git" });
  const onlyOrigin = gitRepo({ origin: "git@github.com-work:Acme/Api.git" });
  const none = gitRepo();
  try {
    const bare = cfgWith("defaults: {}\n");
    assert.equal(resolveRepoSlug(bare, { repo_root: forkOf }), "github.com/acme/api", "a fork collapses onto its upstream");
    assert.equal(resolveRepoSlug(bare, { repo_root: onlyOrigin }), "github.com/acme/api", "origin, alias and case normalized");
    assert.equal(resolveRepoSlug(bare, { repo_root: none }), `local/${none.split("/").pop()!.toLowerCase()}`);

    const watch = cfgWith("watch:\n  repo: Acme/Widgets\n");
    assert.equal(resolveRepoSlug(watch, { repo_root: forkOf }), "github.com/acme/widgets", "watch.repo beats the remotes");
    const bitbucket = cfgWith("watch:\n  code_host: bitbucket\n  repo: acme/widgets\n");
    assert.equal(resolveRepoSlug(bitbucket, { repo_root: none }), "bitbucket.org/acme/widgets");

    const explicit = cfgWith("watch:\n  repo: acme/widgets\nsync:\n  repo: gitlab.com/Team/Sub/Thing\n");
    assert.equal(resolveRepoSlug(explicit, { repo_root: forkOf }), "gitlab.com/team/sub/thing", "sync.repo beats everything");
    const bareSync = cfgWith("sync:\n  repo: Acme/Api\n");
    assert.equal(resolveRepoSlug(bareSync, { repo_root: gitRepo({ origin: "git@gitlab.com:x/y.git" }) }), "gitlab.com/acme/api", "a bare sync.repo takes the origin's host");
  } finally {
    for (const d of [forkOf, onlyOrigin, none]) rmSync(d, { recursive: true, force: true });
  }
});

test("resolveRepoSlug: a remote URL with a token is never in the result or an error", () => {
  const repo = gitRepo({ origin: "https://user:ghp_TOKENVALUE@github.com/acme/api.git" });
  try {
    assert.equal(resolveRepoSlug(cfgWith("defaults: {}\n"), { repo_root: repo }), "github.com/acme/api");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("factory.json: created once in the machine home, stable, and a corrupt file throws instead of re-minting", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-factory-"));
  try {
    const home = join(dir, "home");
    const id = loadOrCreateFactoryId(undefined, home);
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(loadOrCreateFactoryId(undefined, home), id);
    assert.equal(JSON.parse(readFileSync(join(home, "factory.json"), "utf-8")).factory_id, id);
    writeFileSync(join(home, "factory.json"), "{not json");
    assert.throws(() => loadOrCreateFactoryId(undefined, home), /factory\.json is corrupt; delete it to mint a new factory/);
    writeFileSync(join(home, "factory.json"), JSON.stringify({ factory_id: "not-a-uuid" }));
    assert.throws(() => loadOrCreateFactoryId(undefined, home), /corrupt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two repos on one machine share one factory id", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-factory-"));
  try {
    const home = join(dir, "home");
    const a = loadOrCreateFactoryId(join(dir, "repo-a", "data"), home);
    const b = loadOrCreateFactoryId(join(dir, "repo-b", "data"), home);
    assert.equal(a, b);
    assert.equal(peekFactoryId(join(dir, "repo-c", "data"), home), a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a per-repo factory.json is adopted into the machine home once; later ones are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-factory-"));
  try {
    const home = join(dir, "home");
    const legacyA = join(dir, "a");
    const legacyB = join(dir, "b");
    mkdirSync(legacyA);
    mkdirSync(legacyB);
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";
    writeFileSync(join(legacyA, "factory.json"), JSON.stringify({ factory_id: idA }));
    writeFileSync(join(legacyB, "factory.json"), JSON.stringify({ factory_id: idB }));
    assert.equal(peekFactoryId(legacyA, home), idA);
    assert.equal(loadOrCreateFactoryId(legacyA, home), idA);
    assert.equal(JSON.parse(readFileSync(join(home, "factory.json"), "utf-8")).factory_id, idA);
    assert.equal(loadOrCreateFactoryId(legacyB, home), idA);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factory.json: concurrent first runs in separate processes agree on ONE id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-factory-race-"));
  try {
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    const mod = fileURLToPath(new URL("../core/sync/identity.js", import.meta.url));
    const script = `import(${JSON.stringify(mod)}).then(m => console.log(m.loadOrCreateFactoryId(undefined, ${JSON.stringify(data)})))`;
    const outs = await Promise.all(Array.from({ length: 6 }, () => execFileP(process.execPath, ["-e", script])));
    const ids = new Set(outs.map((o) => o.stdout.trim()));
    assert.equal(ids.size, 1, `got ${[...ids].join(", ")}`);
    assert.equal(loadOrCreateFactoryId(undefined, data), [...ids][0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFactory: default name is the short hostname; sync.factory_name overrides it", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-factory-name-"));
  try {
    const home = join(dir, "home");
    const none = cfgWith("defaults: {}\n");
    const name = resolveFactory(none, { repo_root: dir }, join(dir, "d"), undefined, home).name;
    assert.equal(name, hostname().split(".")[0] || "factory");
    assert.ok(!name.includes("@") && !name.endsWith(".local"));
    const named = cfgWith("sync:\n  factory_name: build-box\n");
    assert.equal(resolveFactory(named, { repo_root: dir }, join(dir, "d"), undefined, home).name, "build-box");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultFactoryName: no username, no .local or domain suffix", () => {
  assert.equal(defaultFactoryName("Jds-MacBook-Pro.local"), "Jds-MacBook-Pro");
  assert.equal(defaultFactoryName("box1.corp.example.com"), "box1");
  assert.equal(defaultFactoryName(""), "factory");
});

test("a repo layer cannot set the factory name (the machine layer can); the id never comes from config", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-factory-layers-"));
  const saved = process.env["SPF_CONFIG_HOME"];
  try {
    const machine = join(dir, "machine");
    const repo = join(dir, "repo");
    mkdirSync(machine, { recursive: true });
    mkdirSync(join(repo, ".spf"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    process.env["SPF_CONFIG_HOME"] = machine;
    const load = (): { cfg: ReturnType<typeof loadConfig>; origins: ReturnType<typeof configOrigins>; anchor: ReturnType<typeof resolveAnchor> } => {
      const anchor = resolveAnchor(repo);
      const resolution = resolveConfigPaths(anchor, undefined);
      return { cfg: loadConfig(resolution.paths), origins: configOrigins(resolution), anchor };
    };
    writeFileSync(join(repo, ".spf", "spf.config.yaml"), "sync:\n  factory_name: evil-name\n  level: summary\n");
    let r = load();
    assert.equal(resolveFactory(r.cfg, r.anchor, join(repo, "d"), r.origins, machine).name, defaultFactoryName());
    assert.deepEqual(r.origins.syncTrusted?.routing_ignored, ["factory_name"]);
    assert.equal(r.cfg.sync?.level, "summary");
    writeFileSync(join(machine, "spf.config.yaml"), "sync:\n  factory_name: build-box\n");
    r = load();
    assert.equal(resolveFactory(r.cfg, r.anchor, join(repo, "d"), r.origins, machine).name, "build-box");
    // a factory_id key in a repo config is not a schema key and never reaches the identity
    writeFileSync(join(repo, ".spf", "spf.config.yaml"), "sync:\n  factory_id: 33333333-3333-4333-8333-333333333333\n");
    r = load();
    assert.notEqual(resolveFactory(r.cfg, r.anchor, join(repo, "d"), r.origins, machine).factory_id, "33333333-3333-4333-8333-333333333333");
  } finally {
    if (saved === undefined) delete process.env["SPF_CONFIG_HOME"];
    else process.env["SPF_CONFIG_HOME"] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bitbucket Server https (scm/) and ssh remotes give one slug", () => {
  assert.deepEqual(parseRemote("https://bb.corp/scm/proj/repo.git"), { host: "bb.corp", path: "proj/repo" });
  assert.deepEqual(parseRemote("ssh://git@bb.corp:7999/proj/repo.git"), { host: "bb.corp", path: "proj/repo" });
  assert.deepEqual(parseRemote("https://github.com/scm/tools"), { host: "github.com", path: "scm/tools" }, "a real owner named scm on a public host is untouched");
});

test("a configured repo given as a clone URL is parsed, and a bare one takes origin's host", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-slug-cfg-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@ghe.corp.com:other/thing.git"]);
    const cfg = (extra: Record<string, unknown>) => ({ ...loadConfig([]), ...extra }) as ReturnType<typeof loadConfig>;
    const watch = (repo: string) => ({ watch: { ...loadConfig([]).watch, repo } });
    assert.equal(resolveRepoSlug(cfg({ sync: { repo: "https://github.com/acme/api.git" } as never }), { repo_root: dir }), "github.com/acme/api");
    assert.equal(resolveRepoSlug(cfg({ sync: { repo: "git@github.com:acme/api" } as never }), { repo_root: dir }), "github.com/acme/api");
    assert.equal(resolveRepoSlug(cfg(watch("acme/api")), { repo_root: dir }), "ghe.corp.com/acme/api", "a bare watch.repo follows origin's host");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a legacy factory.json is adopted only from the default data dir and only when git does not track it", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-factory-adopt-"));
  try {
    const repo = join(dir, "repo");
    const data = join(repo, ".spf", "data");
    mkdirSync(data, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const evil = "deadbeef-0000-4000-8000-000000000001";
    writeFileSync(join(data, "factory.json"), JSON.stringify({ factory_id: evil }));
    // untracked, default dir: this machine's own file, adoptable
    assert.equal(adoptableLegacyDir(repo, data), data);
    // a repo-chosen data_dir is never adopted from
    const other = join(repo, "elsewhere");
    mkdirSync(other);
    writeFileSync(join(other, "factory.json"), JSON.stringify({ factory_id: evil }));
    assert.equal(adoptableLegacyDir(repo, other), undefined);
    // committed by the repo: not this machine's identity
    execFileSync("git", ["add", "-f", ".spf/data/factory.json"], { cwd: repo });
    assert.equal(adoptableLegacyDir(repo, data), undefined);
    const home = join(dir, "home");
    const id = resolveFactory(cfgWith("defaults: {}\n"), { repo_root: repo }, data, undefined, home).factory_id;
    assert.notEqual(id, evil);
    assert.equal(JSON.parse(readFileSync(join(home, "factory.json"), "utf-8")).factory_id, id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
