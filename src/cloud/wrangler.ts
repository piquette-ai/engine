/**
 * Runs a pinned wrangler against a generated config (#214). wrangler is not an
 * piquette dependency (it and workerd are far too large): it runs through `npx`.
 * The config holds no secret; credentials reach the child through its
 * environment only, never argv or a file.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Asserted equal to cloud/package.json's wrangler devDependency in a test. */
export const WRANGLER_VERSION = "4.149.0";

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  /** Written to the child's stdin and then closed (for `wrangler secret put`). Never put on argv. */
  input?: string;
}
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => Promise<{ code: number }>;

export const defaultSpawn: SpawnFn = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, { cwd: options.cwd, env: options.env, stdio: [options.input === undefined ? "ignore" : "pipe", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1 }));
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

export interface WranglerNames {
  account_id_env: string;
  api_token_env: string;
}

/** `process.env` (minus the git plumbing vars) plus the Cloudflare credentials under the names wrangler reads. */
export function wranglerEnv(env: NodeJS.ProcessEnv, names: WranglerNames): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string" && k !== "GIT_DIR" && k !== "GIT_WORK_TREE") out[k] = v;
  const account = env[names.account_id_env];
  const token = env[names.api_token_env];
  if (account) out["CLOUDFLARE_ACCOUNT_ID"] = account;
  if (token) out["CLOUDFLARE_API_TOKEN"] = token;
  out["WRANGLER_SEND_METRICS"] = "false";
  return out;
}

/** The argv after `npx`, with the config path as given (a placeholder in a dry run). */
export function wranglerArgv(args: string[], configPath: string): string[] {
  return ["--yes", `wrangler@${WRANGLER_VERSION}`, ...args, "--config", configPath];
}

export interface RunWranglerOptions {
  cfgJson: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  names: WranglerNames;
  spawn?: SpawnFn;
  /** Non-secret extras for the child (e.g. `CI=1` so a migration never prompts). */
  extraEnv?: Record<string, string>;
}

/** Writes the config to a private temp dir, spawns wrangler there, and always removes the dir. */
export async function runWrangler(args: string[], options: RunWranglerOptions): Promise<{ code: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "piquette-cloud-deploy-"));
  try {
    const file = path.join(dir, "wrangler.json");
    await writeFile(file, JSON.stringify(options.cfgJson, null, 2), { mode: 0o600 });
    return await (options.spawn ?? defaultSpawn)("npx", wranglerArgv(args, file), { cwd: dir, env: { ...wranglerEnv(options.env, options.names), ...(options.extraEnv ?? {}) } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
