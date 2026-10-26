/** `piquette cloud deploy` (#214) with a fake spawn and a fake fetch: argv, env mapping, temp-dir hygiene, no secret anywhere. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { SFConfigSchema, type SFConfig } from "../core/data_types.js";
import { WORKER_COMPATIBILITY_DATE, wranglerConfigFor } from "../cloud/config.js";
import { CloudDeployError, deployCloud, resolveBucket } from "../cloud/deploy.js";
import { WRANGLER_VERSION, runWrangler, type SpawnFn } from "../cloud/wrangler.js";

const ACCESS = { team_domain: "test-team.cloudflareaccess.com", aud: ["aud-reader-0001", "aud-ingest-0002"] };
const SECRETS = { token: "tok-SECRET-aaaa1111", s3: "s3secret-SECRET-bbbb2222", client: "svc-SECRET-cccc3333" };
const ENV: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"],
  MY_ACCT: "acct-fake-0001",
  MY_TOKEN: SECRETS.token,
  CF_ACCESS_CLIENT_SECRET: SECRETS.client,
  AWS_SECRET_ACCESS_KEY: SECRETS.s3,
  GIT_DIR: "/should/not/leak",
  GIT_WORK_TREE: "/should/not/leak",
};

const cfgOf = (cloud: Record<string, unknown>, receipts?: Record<string, unknown>): SFConfig =>
  v.parse(SFConfigSchema, { cloud: { provider: "cloudflare", access: ACCESS, account_id_env: "MY_ACCT", api_token_env: "MY_TOKEN", r2: { bucket: "piquette-receipts" }, ...cloud }, ...(receipts ? { receipts } : {}) });

function packageRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "piquette-cloud-pkg-"));
  mkdirSync(path.join(root, "dist", "worker"), { recursive: true });
  mkdirSync(path.join(root, "web"), { recursive: true });
  writeFileSync(path.join(root, "dist", "worker", "index.js"), "export default {}");
  writeFileSync(path.join(root, "web", "index.html"), "<html></html>");
  return root;
}

interface Call {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  config: Record<string, any>;
  dirExistedDuringRun: boolean;
}

function fakeSpawn(code = 0): { spawn: SpawnFn; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    spawn: async (command, args, o) => {
      const file = args[args.indexOf("--config") + 1]!;
      calls.push({ command, args, cwd: o.cwd, env: o.env, config: JSON.parse(readFileSync(file, "utf8")), dirExistedDuringRun: existsSync(o.cwd) });
      return { code };
    },
  };
}

function fakeFetch(handlers: Record<string, (init?: RequestInit) => Response>): { fetch: (url: string, init?: RequestInit) => Promise<Response>; log: string[] } {
  const log: string[] = [];
  return {
    log,
    fetch: async (url, init) => {
      const key = `${init?.method ?? "GET"} ${url.replace("https://api.cloudflare.com/client/v4", "")}`;
      log.push(key);
      const h = handlers[key];
      return h ? h(init) : new Response(JSON.stringify({ errors: [{ message: "unexpected" }] }), { status: 500 });
    },
  };
}
const json = (status: number, body: unknown = {}) => () => new Response(JSON.stringify(body), { status });
const BUCKET = "GET /accounts/acct-fake-0001/r2/buckets/piquette-receipts";

test("deploy: bucket exists -> no create; exact argv, cwd and env mapping; temp dir removed; no secret in config, argv or output", async () => {
  const root = packageRoot();
  const out: string[] = [];
  const sp = fakeSpawn();
  const api = fakeFetch({ [BUCKET]: json(200, { result: {} }) });
  try {
    const code = await deployCloud(cfgOf({ hostname: "piquette.example.com" }), { cloud: "machine" }, { env: ENV, spawn: sp.spawn, fetch: api.fetch, out: (l) => out.push(l), packageRoot: root });
    assert.equal(code, 0);
    assert.deepEqual(api.log, [BUCKET], "no bucket create when it exists");
    assert.equal(sp.calls.length, 1);
    const call = sp.calls[0]!;
    assert.equal(call.command, "npx");
    assert.deepEqual(call.args.slice(0, 4), ["--yes", `wrangler@${WRANGLER_VERSION}`, "deploy", "--config"]);
    assert.equal(call.args[4], path.join(call.cwd, "wrangler.json"));
    assert.equal(call.args.length, 5);
    assert.ok(call.cwd.startsWith(tmpdir()) || call.cwd.includes("piquette-cloud-deploy-"));
    assert.equal(call.env["CLOUDFLARE_ACCOUNT_ID"], "acct-fake-0001");
    assert.equal(call.env["CLOUDFLARE_API_TOKEN"], SECRETS.token);
    assert.equal("GIT_DIR" in call.env, false);
    assert.equal("GIT_WORK_TREE" in call.env, false);
    assert.equal(call.dirExistedDuringRun, true);
    assert.equal(existsSync(call.cwd), false, "temp dir removed on success");

    const serialized = JSON.stringify(call.config) + JSON.stringify(call.args) + out.join("\n");
    for (const s of Object.values(SECRETS)) assert.ok(!serialized.includes(s), `leaked ${s}`);
    assert.ok(!JSON.stringify(call.config).includes("acct-fake-0001"), "no account id in the file either");
    assert.match(out.join("\n"), /deployed piquette: https:\/\/piquette\.example\.com/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy: the bucket is created only on 404; any other failure is an error naming status, not secrets", async () => {
  const root = packageRoot();
  try {
    let api = fakeFetch({ [BUCKET]: json(404), "POST /accounts/acct-fake-0001/r2/buckets": (init) => (assert.deepEqual(JSON.parse(String(init?.body)), { name: "piquette-receipts" }), new Response("{}", { status: 200 })) });
    const out: string[] = [];
    await deployCloud(cfgOf({ hostname: "piquette.example.com" }), {}, { env: ENV, spawn: fakeSpawn().spawn, fetch: api.fetch, out: (l) => out.push(l), packageRoot: root });
    assert.deepEqual(api.log, [BUCKET, "POST /accounts/acct-fake-0001/r2/buckets"]);
    assert.match(out.join("\n"), /created R2 bucket piquette-receipts/);

    api = fakeFetch({ [BUCKET]: json(403, { errors: [{ message: "forbidden by policy" }] }) });
    const sp = fakeSpawn();
    await assert.rejects(deployCloud(cfgOf({ hostname: "piquette.example.com" }), {}, { env: ENV, spawn: sp.spawn, fetch: api.fetch, out: () => {}, packageRoot: root }), (e: Error) => e instanceof CloudDeployError && /HTTP 403: forbidden by policy/.test(e.message) && !e.message.includes(SECRETS.token));
    assert.equal(sp.calls.length, 0, "no deploy after a failed provision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy: the temp dir is removed when wrangler fails, and the failure says only the exit code", async () => {
  const root = packageRoot();
  const sp = fakeSpawn(3);
  try {
    await assert.rejects(
      deployCloud(cfgOf({ hostname: "piquette.example.com" }), {}, { env: ENV, spawn: sp.spawn, fetch: fakeFetch({ [BUCKET]: json(200) }).fetch, out: () => {}, packageRoot: root }),
      (e: Error) => /wrangler deploy exited 3/.test(e.message),
    );
    assert.equal(existsSync(sp.calls[0]!.cwd), false);
    const throwing: SpawnFn = async (_c, _a, o) => {
      sp.calls.push({ cwd: o.cwd } as Call);
      throw new Error("spawn exploded");
    };
    await assert.rejects(runWrangler(["deploy"], { cfgJson: {}, env: ENV, names: { account_id_env: "MY_ACCT", api_token_env: "MY_TOKEN" }, spawn: throwing }), /spawn exploded/);
    assert.equal(existsSync(sp.calls.at(-1)!.cwd), false, "removed when spawn throws");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy: missing env names are named, never valued; missing build says how to fix it", async () => {
  const root = packageRoot();
  try {
    await assert.rejects(deployCloud(cfgOf({ hostname: "piquette.example.com" }), {}, { env: { PATH: ENV["PATH"] }, spawn: fakeSpawn().spawn, fetch: fakeFetch({}).fetch, out: () => {}, packageRoot: root }), /set MY_ACCT and MY_TOKEN in the environment/);
    rmSync(path.join(root, "dist"), { recursive: true });
    await assert.rejects(deployCloud(cfgOf({ hostname: "piquette.example.com" }), {}, { env: ENV, spawn: fakeSpawn().spawn, fetch: fakeFetch({}).fetch, out: () => {}, packageRoot: root }), /Worker bundle .* is missing: reinstall/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--dry-run prints the config and argv, and makes no fetch and no spawn", async () => {
  const out: string[] = [];
  let touched = false;
  const trap = async (): Promise<never> => {
    touched = true;
    throw new Error("must not be called");
  };
  const code = await deployCloud(cfgOf({ hostname: "piquette.example.com", base_path: "/piquette" }), { cloud: "repo", cloudPath: "/r/.piquette/piquette.config.yaml" }, { env: {}, spawn: trap as never, fetch: trap as never, out: (l) => out.push(l), dryRun: true, allowRepoCloud: true });
  assert.equal(code, 0);
  assert.equal(touched, false);
  const text = out.join("\n");
  assert.match(text, /cloud block from \/r\/\.piquette\/piquette\.config\.yaml \(repo layer\)/);
  assert.match(text, new RegExp(`npx --yes wrangler@${WRANGLER_VERSION} deploy --config <tmp>/wrangler\\.json`));
  assert.match(text, /"BASE_PATH": "\/piquette"/);
});

test("wranglerConfigFor: every var present, comma lists, hardening flags, hostname/route/workers.dev", () => {
  const input = { workerPath: "/pkg/dist/worker/index.js", webDir: "/pkg/web", bucket: "piquette-receipts", prefix: "" };
  const host = wranglerConfigFor(cfgOf({ hostname: "piquette.example.com", modules: ["receipts", "ingest"], d1: { database: "piquette-hub" } }), input) as Record<string, any>;
  assert.deepEqual(Object.keys(host.vars).sort(), ["ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "BASE_PATH", "BRAND_JSON", "CHROME_HEADER_HEIGHT", "CHROME_HEADER_URL", "CHROME_HOME_URL", "CHROME_STYLESHEET_URL", "PIQUETTE_MODULES", "RECEIPTS_PREFIX", "RECEIPTS_VISIBILITY", "RETENTION_DAYS"]);
  assert.equal(host.vars.ACCESS_AUD, "aud-reader-0001,aud-ingest-0002");
  assert.equal(host.vars.PIQUETTE_MODULES, "receipts,ingest");
  assert.equal(host.vars.CHROME_STYLESHEET_URL, "");
  assert.equal(host.vars.BRAND_JSON, "", "no brand: the var is present and empty");
  const branded = wranglerConfigFor(cfgOf({ hostname: "piquette.example.com", brand: { name: "Acme Factory", colors: { accent: { light: "#0a7" } } } }), input) as Record<string, any>;
  assert.deepEqual(JSON.parse(branded.vars.BRAND_JSON), { name: "Acme Factory", colors: { accent: { light: "#0a7" } } });
  assert.equal(host.vars.CHROME_HEADER_HEIGHT, "56");
  assert.deepEqual([host.keep_vars, host.preview_urls, host.no_bundle, host.workers_dev], [false, false, true, false]);
  assert.equal(host.assets.run_worker_first, true);
  assert.equal(host.assets.not_found_handling, "single-page-application");
  assert.deepEqual(host.routes, [{ pattern: "piquette.example.com", custom_domain: true }]);
  assert.deepEqual(host.r2_buckets, [{ binding: "RECEIPTS", bucket_name: "piquette-receipts" }]);

  const route = wranglerConfigFor(cfgOf({ route: "example.com/piquette*", zone: "example.com" }), input) as Record<string, any>;
  assert.deepEqual(route.routes, [{ pattern: "example.com/piquette*", zone_name: "example.com" }]);
  assert.equal(route.vars.BASE_PATH, "/piquette");
  assert.equal(route.workers_dev, false);

  const wd = wranglerConfigFor(cfgOf({}), input) as Record<string, any>;
  assert.deepEqual(wd.routes, []);
  assert.equal(wd.workers_dev, true, "no hostname or route: workers.dev");
  assert.equal(wd.name, "piquette");

  const chrome = wranglerConfigFor(cfgOf({ hostname: "piquette.example.com", chrome: { stylesheet_url: "https://example.com/a.css", header_height: 80 } }), input) as Record<string, any>;
  assert.equal(chrome.vars.CHROME_STYLESHEET_URL, "https://example.com/a.css");
  assert.equal(chrome.vars.CHROME_HEADER_HEIGHT, "80");
});

test("resolveBucket: r2.bucket, the s3 store's bucket, mismatch and neither", () => {
  const s3 = (bucket: string, prefix = "") => ({ store: { kind: "s3", bucket, endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto", prefix } });
  assert.deepEqual(resolveBucket(cfgOf({ r2: { bucket: "bucket-one" } })), { bucket: "bucket-one", prefix: "" });
  assert.deepEqual(resolveBucket(cfgOf({ r2: {} }, s3("bucket-two", "pre"))), { bucket: "bucket-two", prefix: "pre" });
  assert.deepEqual(resolveBucket(cfgOf({ r2: { bucket: "bucket-two" } }, s3("bucket-two", "pre"))), { bucket: "bucket-two", prefix: "pre" });
  assert.throws(() => resolveBucket(cfgOf({ r2: { bucket: "bucket-one" } }, s3("bucket-two"))), /differ/);
  assert.throws(() => resolveBucket(cfgOf({ r2: { bucket: "bucket-two", prefix: "x" } }, s3("bucket-two", "y"))), /prefix/);
  assert.throws(() => resolveBucket(cfgOf({ r2: undefined })), /no R2 bucket/);
  assert.throws(() => resolveBucket(cfgOf({ r2: undefined }, { store: { kind: "local" } })), /no R2 bucket/);
});

test("invariants: WRANGLER_VERSION equals cloud/package.json; compatibility_date equals cloud/wrangler.jsonc", () => {
  const cloudDir = path.resolve(import.meta.dirname, "..", "..", "cloud");
  const pkg = JSON.parse(readFileSync(path.join(cloudDir, "package.json"), "utf8"));
  assert.equal(WRANGLER_VERSION, pkg.devDependencies.wrangler);
  const w = JSON.parse(readFileSync(path.join(cloudDir, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(WORKER_COMPATIBILITY_DATE, w.compatibility_date);
  assert.equal(w.assets.run_worker_first, true);
  assert.equal(w.assets.not_found_handling, "single-page-application");
  for (const key of Object.keys(w.vars)) assert.ok(key in (wranglerConfigFor(cfgOf({}), { workerPath: "x", webDir: "y", bucket: "b", prefix: "" }) as any).vars, `${key} is in the generated config`);
});

test("a repo-layer cloud block (or repo-layer bucket) refuses to deploy unless --allow-repo-cloud", async () => {
  const trap = async (): Promise<never> => {
    throw new Error("must not be called");
  };
  const base = { env: {}, spawn: trap as never, fetch: trap as never, out: () => {}, dryRun: true };
  await assert.rejects(deployCloud(cfgOf({ hostname: "piquette.example.com" }), { cloud: "repo", cloudPath: "/r/.piquette/piquette.config.yaml" }, base), /refusing to deploy: the cloud block comes from \/r\/\.piquette\/piquette\.config\.yaml/);
  const viaStore = cfgOf({ hostname: "piquette.example.com", r2: undefined });
  (viaStore as any).receipts = { store: { kind: "s3", bucket: "org-receipts", prefix: "" } };
  await assert.rejects(deployCloud(viaStore, { cloud: "machine", receiptsStore: "repo" }, base), /receipts\.store/);
  assert.equal(await deployCloud(cfgOf({ hostname: "piquette.example.com" }), { cloud: "machine" }, base), 0);
});
