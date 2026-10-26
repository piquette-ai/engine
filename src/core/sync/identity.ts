/**
 * Factory and repo identity for `piquette sync` (#135).
 *
 *  - A FACTORY is one MACHINE (a laptop, a build box serving many repos) running piquette: a random
 *    UUID minted once into `{machine config home}/factory.json`, shared by every repo and worktree on it. It is never re-minted
 *    silently — a new id would orphan the factory's whole synced history.
 *  - A REPO is a normalized `host/owner/name` slug, so a fork, or the same
 *    repo cloned by two engineers, collapses onto one repo with factories
 *    underneath (design doc §8.3).
 *
 * A raw remote URL is NEVER logged or put in an error message: an https
 * remote can carry a token in its userinfo.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SFConfig, SyncRoutingTrustShape } from "../data_types.ts";
import { machineConfigPath, type RepoAnchor } from "../paths.ts";

export interface FactoryIdentity {
  factory_id: string;
  name: string;
  repo: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The machine config home (`$PIQUETTE_CONFIG_HOME`, default `~/.piquette`): where this machine's factory identity lives. */
export function machineHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.dirname(machineConfigPath(env, home));
}

function readFactoryId(file: string): string | undefined {
  try {
    const id = (JSON.parse(readFileSync(file, "utf-8")) as { factory_id?: unknown } | null)?.factory_id;
    return typeof id === "string" && UUID_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The legacy per-repo dir whose `factory.json` may be adopted as the machine's id, or undefined. A repo controls its own
 * `data_dir` and what it commits, so adoption is limited to the DEFAULT `{repo_root}/.piquette/data` and to a file git does not
 * track: a cloned repo can therefore never hand the machine an identity (only a file this machine itself minted survives).
 */
export function adoptableLegacyDir(repoRoot: string, dataDir: string): string | undefined {
  if (path.resolve(dataDir) !== path.resolve(repoRoot, ".piquette", "data")) return undefined;
  const file = path.join(dataDir, "factory.json");
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", file], {
      cwd: repoRoot,
      stdio: "ignore",
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    });
    return undefined; // tracked: it came from the repo, not from this machine
  } catch {
    return dataDir; // untracked, or not a git repo at all
  }
}

/**
 * The machine's factory id, from `{machine home}/factory.json`: one id for every repo and worktree on this machine.
 * Created once with `wx` (a concurrent first run loses the race and re-reads the winner's id). When none exists yet, a
 * valid legacy per-repo `{legacyDataDir}/factory.json` (the pre-machine-identity location; callers pass it only via `adoptableLegacyDir`) is adopted as the machine's
 * id, so an existing factory keeps its synced history; later checkouts' files are then ignored. A corrupt machine file
 * throws rather than re-minting (a new id would orphan the factory's history).
 */
export function loadOrCreateFactoryId(legacyDataDir?: string, configHome: string = machineHome()): string {
  const file = path.join(configHome, "factory.json");
  const read = (): string => {
    const id = readFactoryId(file);
    if (!id) throw new Error(`${file} is corrupt; delete it to mint a new factory`);
    return id;
  };
  mkdirSync(configHome, { recursive: true });
  const legacy = legacyDataDir ? readFactoryId(path.join(legacyDataDir, "factory.json")) : undefined;
  const id = legacy ?? randomUUID();
  try {
    writeFileSync(file, JSON.stringify({ factory_id: id, created_at: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return read();
  }
}

/** The factory id if one already exists (machine file, else a legacy per-repo file about to be adopted) — never mints (for `piquette doctor`). */
export function peekFactoryId(legacyDataDir?: string, configHome: string = machineHome()): string | undefined {
  return readFactoryId(path.join(configHome, "factory.json")) ?? (legacyDataDir ? readFactoryId(path.join(legacyDataDir, "factory.json")) : undefined);
}

/** The short hostname: no domain suffix (`.local`, `.lan`, an FQDN's domain), no username. */
export function defaultFactoryName(hostname: string = os.hostname()): string {
  return hostname.trim().split(".")[0] || "factory";
}

// ── remote URL parsing ───────────────────────────────────────────────────────

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/]*@)?([^/]+)\/(.+)$/i;
// The scp host must be 2+ chars so a Windows drive path ("C:/src/repo") is not read as a remote, and its path must not start with "//" so "file:///..." is not either.
const SCP_RE = /^(?:[^/@\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/;

const HOST_ALIASES: Record<string, string> = {
  "ssh.github.com": "github.com",
  "ssh.dev.azure.com": "dev.azure.com",
  "vs-ssh.visualstudio.com": "dev.azure.com",
};
const PUBLIC_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];

function canonicalHost(raw: string): string {
  let host = raw.toLowerCase().replace(/:\d+$/, "");
  host = HOST_ALIASES[host] ?? host;
  // An ssh alias like `github.com-work` (a per-key Host block in ~/.ssh/config) is still github.com.
  for (const known of PUBLIC_HOSTS) {
    if (host.startsWith(`${known}-`)) return known;
  }
  return host;
}

/** https/ssh/scp-style git remote -> `{host, path}`. Host lowercased, userinfo and port stripped; path keeps its case and full namespace (GitLab subgroups). */
export function parseRemote(remoteUrl: string): { host: string; path: string } | undefined {
  const url = remoteUrl.trim();
  if (/^file:/i.test(url)) return undefined;
  const m = SCHEME_RE.exec(url) ?? SCP_RE.exec(url);
  if (!m) return undefined;
  const host = canonicalHost(m[1]!);
  const parts = m[2]!
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((p) => p && p !== "_git");
  // Azure DevOps SSH remotes carry a protocol-version segment before the org.
  if (parts[0] === "v3" && host === "dev.azure.com") parts.shift();
  // Bitbucket Server's https clone path is `scm/<project>/<repo>`; its ssh path has no `scm`.
  if (parts[0]?.toLowerCase() === "scm" && parts.length >= 3 && !PUBLIC_HOSTS.includes(host)) parts.shift();
  if (parts.length < 2) return undefined;
  return { host, path: parts.join("/") };
}

/** `host/owner/name`, lowercase. A first segment containing a "." is the host; otherwise `defaultHost` is. */
export function normalizeRepoSlug(input: string, defaultHost: string): string {
  const parts = input
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  if (parts.length > 0 && parts[0]!.includes(".")) return [canonicalHost(parts[0]!), ...parts.slice(1)].join("/");
  return [defaultHost.toLowerCase(), ...parts].join("/");
}

function remoteUrl(cwd: string, remote: string): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", remote], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_DIR: undefined },
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The main worktree's directory name, so a linked worktree (`issue-198` of repo `alpha`) names the repo
 * `alpha`, not itself. `git rev-parse --path-format=absolute --git-common-dir` is the main repo's `.git`
 * (or the bare dir). Undefined when git cannot say.
 */
export function mainWorktreeName(repoRoot: string): string | undefined {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    }).trim();
    if (!common) return undefined;
    const base = path.basename(common);
    const name = base === ".git" ? path.basename(path.dirname(common)) : base.replace(/\.git$/i, "");
    return name || undefined;
  } catch {
    return undefined;
  }
}

const CODE_HOST_DOMAIN: Record<string, string> = { github: "github.com", bitbucket: "bitbucket.org" };

/**
 * The repo this factory belongs to, first match wins:
 *   1. `sync.repo`   2. `watch.repo`   3. the `upstream` remote (how a fork
 *   collapses onto the repo it was forked from)   4. `origin`
 *   5. `local/<basename of the repo root>`
 * A bare `owner/name` in (1) or (2) takes the origin's host (`watch.code_host`'s when origin does not parse).
 * `upstream` outranks `origin` on purpose: a fork files its sessions under the repo it was forked from.
 */
/** A configured repo may be a full clone URL (https, ssh, scp-style): parse those like a remote instead of treating the scheme as a path. */
function configuredSlug(value: string, defaultHost: string): string {
  const parsed = /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) || /^[^/@\s]+@[^:/\s]+:/.test(value.trim()) ? parseRemote(value) : undefined;
  return parsed ? normalizeRepoSlug(`${parsed.host}/${parsed.path}`, parsed.host) : normalizeRepoSlug(value, defaultHost);
}

export function resolveRepoSlug(cfg: Pick<SFConfig, "sync" | "watch">, anchor: Pick<RepoAnchor, "repo_root">): string {
  const originHost = parseRemote(remoteUrl(anchor.repo_root, "origin") ?? "")?.host;
  if (cfg.sync?.repo) return configuredSlug(cfg.sync.repo, originHost ?? "github.com");
  // origin's host wins over `code_host`: a GHE `acme/api` must match a teammate whose slug comes from origin
  if (cfg.watch?.repo) return configuredSlug(cfg.watch.repo, originHost ?? CODE_HOST_DOMAIN[cfg.watch.code_host] ?? "github.com");
  for (const remote of ["upstream", "origin"]) {
    const parsed = parseRemote(remoteUrl(anchor.repo_root, remote) ?? "");
    if (parsed) return normalizeRepoSlug(`${parsed.host}/${parsed.path}`, parsed.host);
  }
  return `local/${(mainWorktreeName(anchor.repo_root) ?? path.basename(anchor.repo_root)).toLowerCase()}`;
}

/**
 * `name` is the machine layer's `sync.factory_name` (a repo layer's is dropped when `origins` carries provenance), else the
 * short hostname. Identity is machine-owned: neither the id nor the name comes from a repo.
 */
export function resolveFactory(
  cfg: Pick<SFConfig, "sync" | "watch">,
  anchor: Pick<RepoAnchor, "repo_root">,
  dataDir: string,
  origins?: { syncTrusted?: SyncRoutingTrustShape | undefined },
  configHome?: string,
): FactoryIdentity {
  const named = origins?.syncTrusted ? origins.syncTrusted.values.factory_name : cfg.sync?.factory_name;
  return {
    factory_id: loadOrCreateFactoryId(adoptableLegacyDir(anchor.repo_root, dataDir), configHome),
    name: named ?? defaultFactoryName(),
    repo: resolveRepoSlug(cfg, anchor),
  };
}
