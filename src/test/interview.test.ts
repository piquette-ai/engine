/**
 * `piquette init`'s interactive interview (`cli/interview.ts`) — driven through
 * the `Asker` seam with a scripted fake (`./fake_asker.ts`), never a real
 * TTY. Covers the three things a wrong answer would actually break:
 *   1. the pinned-roster trap (planner/reviewer/documenter overridden
 *      whenever the backend switches to claude_code — see agent_cc.ts/
 *      agents.ts's back-fill comment),
 *   2. the generated config is a genuine override — validating it requires
 *      merging with the packaged built-in roster first, exactly like
 *      `piquette doctor` does, never the raw document alone,
 *   3. each `piquette watch` combination collects exactly the credentials
 *      `cli/commands/watch.ts`'s resolveIssueProvider/resolveCodeHostProvider
 *      actually read — no more, no less.
 */
import "./hermetic_git.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runInterview, gatherContext } from "../cli/interview.js";
import { loadConfig, validate } from "../core/agents.js";
import { BUILTIN_CONFIG_PATH } from "../core/paths.js";
import { createFakeAsker } from "./fake_asker.js";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "piquette-interview-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: dir });
  // -c user.*, not a global git config: this must pass in a fresh CI runner
  // with no git identity configured at all (same reasoning as ui_server.test.ts).
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=piquette tests", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: dir },
  );
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Merge with the real packaged roster and validate — the same pipeline `piquette doctor` runs, and the only honest way to check a partial override document. */
function mergedConfigPath(): string {
  const configPath = join(dir, `piquette.config.${Math.random().toString(36).slice(2)}.yaml`);
  return configPath;
}

test("claude_code + watch(github/github): overrides the three pinned agents and merges cleanly", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "github",
      "Code host": "github",
      "Chain to run": "plan-build-test",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": true,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { GITHUB_TOKEN: "ghp_abcdefghijklmnop" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.defaults.coding_agent, "claude_code");
  assert.equal(config.defaults.model, "sonnet");

  const overrides = config.agents;
  assert.deepEqual(
    overrides.map((a: any) => a.name).sort(),
    ["documenter", "planner", "reviewer"],
  );
  for (const a of overrides) assert.equal(a.model, "sonnet");

  assert.equal(config.watch.repo, "acme/widgets"); // detected from origin
  assert.equal(result!.env.GITHUB_TOKEN, "ghp_abcdefghijklmnop");
  assert.ok(result!.envExampleKeys.includes("GITHUB_TOKEN"));

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.defaults.coding_agent, "claude_code");
  assert.equal(cfg.agents.find((a) => a.name === "planner")!.model, "sonnet");
  assert.equal(cfg.agents.find((a) => a.name === "builder")!.model, "sonnet"); // inherits defaults.model, needed no override
  validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), dir); // throws on any problem
});

// Regression for a real production bug: PIQUETTE_CLAUDE_CMD="ollama launch
// claude --model <fixed-tag>" baked one model into the whole process, so
// every claude_code agent's own model: field was inert regardless of what
// it said. Picking "ollama" here must write the {model}-templated wrapper
// (agent_cc.ts substitutes it per call) and ask for a real Ollama tag —
// never Claude Code's own sonnet/opus/haiku vocabulary, which `ollama
// launch`'s own --model flag (the one that actually selects the served
// model) would not understand.
test("claude_code + ollama launcher: writes the {model}-templated PIQUETTE_CLAUDE_CMD and asks for an Ollama tag, not Claude Code's alias vocabulary", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Launch command for the `claude` CLI": "ollama",
    },
    text: { "Ollama model tag": "kimi-k2.7-code:cloud" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.env.PIQUETTE_CLAUDE_CMD, "ollama launch claude --model {model}");
  assert.equal(config.defaults.model, "kimi-k2.7-code:cloud");
  for (const a of config.agents) assert.equal(a.model, "kimi-k2.7-code:cloud");
  assert.equal(result!.env.PIQUETTE_CLAUDE_CMD, undefined, "declarative, not a secret — belongs in config.env, not .env");

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.env.PIQUETTE_CLAUDE_CMD, "ollama launch claude --model {model}");
  validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), dir);
});

// opencode's own model vocabulary is provider/model-id (same shape flue
// speaks), asked via a free-text prompt rather than claude_code's
// sonnet/opus/haiku select — and, like the claude_code branches above, the
// packaged roster's planner/reviewer/documenter pin their own model and must
// be overridden to match, plus a non-default launch command must be written
// to config.env.PIQUETTE_OPENCODE_CMD (declarative, not a secret — same
// PIQUETTE_CLAUDE_CMD treatment above).
test("opencode + custom launch command: writes PIQUETTE_OPENCODE_CMD, defaults.model from opencode's provider/model-id vocabulary, and pins planner/reviewer/documenter", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "opencode",
    },
    text: {
      "Launch command for the `opencode`": "opencode-wrapper",
      "provider/model-id": "ollama/qwen3-coder:30b",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.defaults.coding_agent, "opencode");
  assert.equal(config.defaults.model, "ollama/qwen3-coder:30b");
  assert.equal(config.env.PIQUETTE_OPENCODE_CMD, "opencode-wrapper");

  const overrides = config.agents;
  assert.deepEqual(
    overrides.map((a: any) => a.name).sort(),
    ["documenter", "planner", "reviewer"],
  );
  for (const a of overrides) assert.equal(a.model, "ollama/qwen3-coder:30b");

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.defaults.coding_agent, "opencode");
  assert.equal(cfg.env.PIQUETTE_OPENCODE_CMD, "opencode-wrapper");
  assert.equal(cfg.agents.find((a) => a.name === "planner")!.model, "ollama/qwen3-coder:30b");
  // Full roster, same as the claude_code tests above: agent_opencode.ts's
  // TOOL_NAME_MAP includes "webfetch" (scout/refiner's tool), so this is
  // also the regression test for that mapping — deleting it from
  // TOOL_NAME_MAP would fail validation here.
  validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), dir);
});

test("claude_code + plain claude: no PIQUETTE_CLAUDE_CMD written, Model stays Claude Code's own alias vocabulary", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Launch command for the `claude` CLI": "claude",
      "Model (Claude": "opus",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.env, undefined, "no launcher chosen -> nothing to write into env:");
  assert.equal(config.defaults.model, "opus");
});

test("flue + openrouter: no pinned-agent overrides needed, provider key collected", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "flue", Provider: "openrouter" },
    text: { "Model id": "moonshotai/kimi-k2.7" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { OPENROUTER_API_KEY: "sk-or-v1-test" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.defaults.coding_agent, "flue");
  assert.equal(config.defaults.model, "openrouter/moonshotai/kimi-k2.7");
  assert.equal(config.agents, undefined, "flue never needs the pinned-roster fix — agents' own models are already valid Flue ids");
  assert.equal(result!.env.OPENROUTER_API_KEY, "sk-or-v1-test");
  assert.ok(!("watch" in config));
});

test("flue + ollama: keyless provider skips PROVIDER_ENV_KEYS' key prompt, but still asks for OLLAMA_BASE_URL and the optional OLLAMA_API_KEY gateway prompt", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "flue", Provider: "ollama" },
    text: { "Model id": "llama3" }, // deliberately no "OLLAMA_BASE_URL" entry — the fake asker falls back to its default
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    // Deliberately no `secret` entries: PROVIDER_ENV_KEYS.ollama is `[]`, so
    // its own keyed-provider prompt (indexing envKeys[0]) is skipped for
    // ollama. MINOR-F's own OLLAMA_API_KEY prompt (asked separately, inside
    // the "keyless" branch — see interview.ts) IS still asked, but left
    // blank here (the fake asker's default for an unlisted `secret` label is
    // "") to prove it's genuinely optional: a bare local Ollama server needs
    // no key, so leaving it blank must not fail this interview or invent one.
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.defaults.coding_agent, "flue");
  assert.equal(config.defaults.model, "ollama/llama3");
  assert.deepEqual(
    result!.env,
    { OLLAMA_BASE_URL: "http://localhost:11434/v1" },
    "no API key answered -> OLLAMA_API_KEY is never written to env, only the base URL prompt's default",
  );
  assert.deepEqual(
    result!.envExampleKeys,
    ["OLLAMA_BASE_URL", "OLLAMA_API_KEY"],
    "OLLAMA_API_KEY is still RECORDED as an example key (so .env.example documents it as optional) even though it was left blank",
  );
  // Unlike the openrouter case above, ollama DOES need the pinned-roster
  // fix: planner/reviewer/documenter pin their own fireworks/gemini/openai
  // model strings in the packaged roster, which would otherwise always win
  // over defaults.model and leave three agents needing keys this interview
  // never asked for.
  assert.deepEqual(
    config.agents,
    [
      { name: "planner", model: "ollama/llama3" },
      { name: "reviewer", model: "ollama/llama3" },
      { name: "documenter", model: "ollama/llama3" },
    ],
    "planner/reviewer/documenter are pinned to the chosen ollama model, same fix as the claude_code branch",
  );
});

test("flue + ollama: an answered OLLAMA_API_KEY is written to env — the gateway-bearer case (MINOR-F)", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "flue", Provider: "ollama" },
    text: { "Model id": "llama3" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { OLLAMA_API_KEY: "gateway-client-key-123" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  assert.equal(result!.env.OLLAMA_API_KEY, "gateway-client-key-123");
  assert.equal(result!.env.OLLAMA_BASE_URL, "http://localhost:11434/v1");
  assert.deepEqual(result!.envExampleKeys, ["OLLAMA_BASE_URL", "OLLAMA_API_KEY"]);
});

test("flue + ollama: a custom OLLAMA_BASE_URL answer is written verbatim", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "flue", Provider: "ollama" },
    text: { "Model id": "llama3", OLLAMA_BASE_URL: "http://gpu-box.local:11434/v1" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  assert.equal(result!.env.OLLAMA_BASE_URL, "http://gpu-box.local:11434/v1");
});

test("flue + cloudflare: collects token + account id, overrides the pinned roster, validates cleanly", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "flue", Provider: "cloudflare" },
    text: { "Model id": "@cf/zai-org/glm-5.3-flash", CLOUDFLARE_ACCOUNT_ID: "abcd1234" },
    confirm: {
      "explicit base URL": false, // derive from account id, not a custom URL
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { CLOUDFLARE_API_TOKEN: "cf-test-token" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.defaults.coding_agent, "flue");
  // Slashed model id survives the provider/model-id assembly verbatim.
  assert.equal(config.defaults.model, "cloudflare/@cf/zai-org/glm-5.3-flash");
  assert.deepEqual(result!.env, {
    CLOUDFLARE_API_TOKEN: "cf-test-token",
    CLOUDFLARE_ACCOUNT_ID: "abcd1234",
  });
  assert.deepEqual(result!.envExampleKeys, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
  // Same pinned-roster fix as ollama: a Workers AI account can't serve the
  // fireworks/openai models planner/reviewer/documenter are pinned to.
  assert.deepEqual(
    config.agents,
    [
      { name: "planner", model: "cloudflare/@cf/zai-org/glm-5.3-flash" },
      { name: "reviewer", model: "cloudflare/@cf/zai-org/glm-5.3-flash" },
      { name: "documenter", model: "cloudflare/@cf/zai-org/glm-5.3-flash" },
    ],
  );

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.agents.find((a) => a.name === "planner")!.model, "cloudflare/@cf/zai-org/glm-5.3-flash");
  validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), dir);
});

test("flue + cloudflare: an explicit CLOUDFLARE_AI_BASE_URL is written instead of an account id", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "flue", Provider: "cloudflare" },
    text: { "Model id": "@cf/meta/llama-3.1-8b-instruct", CLOUDFLARE_AI_BASE_URL: "https://gateway.example.com/ai/v1" },
    confirm: {
      "explicit base URL": true,
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { CLOUDFLARE_API_TOKEN: "cf-test-token" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  assert.equal(result!.env.CLOUDFLARE_AI_BASE_URL, "https://gateway.example.com/ai/v1");
  assert.ok(!("CLOUDFLARE_ACCOUNT_ID" in result!.env), "account id is not collected when an explicit base URL is given");
});

test("claude_code + Cloudflare AI Gateway: writes base URL, api key placeholder, and the cf-aig-authorization custom header", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "claude_code", "Model (Claude": "sonnet", Authentication: "aig" },
    text: { ANTHROPIC_BASE_URL: "https://gateway.ai.cloudflare.com/v1/acme/gw1/anthropic" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { "CF_AIG_TOKEN": "cf-aig-test-token" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  assert.equal(result!.env.ANTHROPIC_BASE_URL, "https://gateway.ai.cloudflare.com/v1/acme/gw1/anthropic");
  // Claude Code requires ANTHROPIC_API_KEY set; the gateway ignores it, so
  // the interview reuses the gateway token as the placeholder (per the CF doc).
  assert.equal(result!.env.ANTHROPIC_API_KEY, "cf-aig-test-token");
  assert.equal(result!.env.ANTHROPIC_CUSTOM_HEADERS, "cf-aig-authorization: Bearer cf-aig-test-token");
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS"]) {
    assert.ok(result!.envExampleKeys.includes(k), `${k} recorded in .env.example keys`);
  }

  // Validates cleanly once merged with the packaged roster — the same
  // pipeline `piquette doctor` runs (claude_code agents need no provider key).
  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(result!.config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), dir);
});

test("watch(jira/bitbucket): collects exactly JIRA_* + BITBUCKET_*, never GITHUB_TOKEN", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "jira",
      "Code host": "bitbucket",
      "Chain to run": "plan-build-test",
    },
    text: {
      "Repo (workspace/repo_slug)": "acme/widgets-repo",
      "Jira base URL": "https://acme.atlassian.net/",
      "Jira project key": "proj",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": true,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { JIRA_API_TOKEN: "jira-token", BITBUCKET_API_TOKEN: "bb-token" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.watch.issue_provider, "jira");
  assert.equal(config.watch.code_host, "bitbucket");
  assert.equal(config.watch.jira.base_url, "https://acme.atlassian.net"); // trailing slash stripped
  assert.equal(config.watch.jira.project_key, "PROJ"); // upper-cased

  assert.equal(result!.env.JIRA_API_TOKEN, "jira-token");
  assert.equal(result!.env.BITBUCKET_API_TOKEN, "bb-token");
  assert.equal(result!.env.GITHUB_TOKEN, undefined, "neither provider needs GitHub — must not ask for or write GITHUB_TOKEN");
});

test("watch(jira): the refine-lane question is now reachable on Jira too, not just GitHub", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "jira",
      "Code host": "bitbucket",
      // "Chain to run per spec" must be checked before the shorter "Chain to
      // run" — both are substrings of the "per spec" question's own label,
      // and fake_asker.ts's firstMatch() returns whichever key it finds
      // first in this object's own key order, not the most specific one.
      "Chain to run per spec": "refine",
      "Chain to run": "plan-build-test",
    },
    text: {
      "Repo (workspace/repo_slug)": "acme/widgets-repo",
      "Jira base URL": "https://acme.atlassian.net/",
      "Jira project key": "proj",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": true,
      "Also enable the refine lane": true,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { JIRA_API_TOKEN: "jira-token", BITBUCKET_API_TOKEN: "bb-token" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.watch.refine.enabled, true);
  assert.equal(config.watch.refine.chain, "refine");
});

test("watch(github-projects): writes watch.github_projects with project_number and the five required Status options, and collects GITHUB_TOKEN", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "github-projects",
      "Code host": "github",
      "Chain to run": "plan-build-test",
    },
    text: {
      'Status option for "ready"': "Todo",
      'Status option for "working"': "In Progress",
      'Status option for "review"': "In Review",
      'Status option for "done"': "Done",
      'Status option for "blocked"': "Blocked",
      "Projects v2 board number": "3",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": true,
      "Also enable the refine lane": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { GITHUB_TOKEN: "ghp_abcdefghijklmnop" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.watch.issue_provider, "github-projects");
  assert.equal(config.watch.github_projects.project_number, 3);
  assert.deepEqual(config.watch.github_projects.status_map, {
    ready: "Todo",
    working: "In Progress",
    review: "In Review",
    done: "Done",
    blocked: "Blocked",
  });
  assert.equal(result!.env.GITHUB_TOKEN, "ghp_abcdefghijklmnop");

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.watch.issue_provider, "github-projects");
  validate(cfg, cfg.agents.map((a: { name: string }) => a.name), Object.keys(cfg.quality.suites), dir); // throws on any problem
});

test("watch(github issues + bitbucket code): asks two repo questions and writes issue_repo separately from repo", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "github",
      "Code host": "bitbucket",
      "Chain to run": "plan-build-test",
    },
    text: {
      "Code repo, where PRs open (workspace/repo_slug)": "acme-workspace/widgets-code",
      "Issue repo, where piquette:ready issues live (owner/name)": "acme/widgets-issues",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": true,
      "Also enable the refine lane": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { GITHUB_TOKEN: "ghp_x", BITBUCKET_API_TOKEN: "bb-token" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.watch.issue_provider, "github");
  assert.equal(config.watch.code_host, "bitbucket");
  assert.equal(config.watch.repo, "acme-workspace/widgets-code", "repo is the CODE HOST's repo");
  assert.equal(config.watch.issue_repo, "acme/widgets-issues", "issue_repo overrides repo for the issue tracker side");

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.watch.repo, "acme-workspace/widgets-code");
  assert.equal(cfg.watch.issue_repo, "acme/widgets-issues");
});

test("watch(github issues + github code): a single repo answers both, issue_repo stays unset", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "github",
      "Code host": "github",
      "Chain to run": "plan-build-test",
    },
    text: { "Repo (owner/name)": "acme/widgets" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": true,
      "Also enable the refine lane": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { GITHUB_TOKEN: "ghp_x" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.watch.repo, "acme/widgets");
  assert.equal(config.watch.issue_repo, undefined, "the single-repo case never writes issue_repo at all");
});

test("declining the final confirm returns null — nothing to write", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({ defaultConfirm: false }); // every confirm, including the final one, says no
  const result = await runInterview(asker, ctx);
  assert.equal(result, null);
});

test("notifications: declining the gate leaves config.notifications undefined", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "claude_code", "Model (Claude": "sonnet", Authentication: "login" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Send notifications": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.notifications, undefined);
});

test("notifications: accepting collects the scope, a channel, and its webhook env key", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Notify on": "all",
      Channel: "slack",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Send notifications": true,
      "Add another channel": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/XXXX" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.notifications.events, "all");
  assert.deepEqual(config.notifications.channels, [{ kind: "slack", webhook_url_env: "SLACK_WEBHOOK_URL" }]);
  assert.equal(result!.env.SLACK_WEBHOOK_URL, "https://hooks.slack.com/services/T000/B000/XXXX");
  assert.ok(result!.envExampleKeys.includes("SLACK_WEBHOOK_URL"));

  // The written document must still merge and validate cleanly, same
  // pipeline `piquette doctor` runs.
  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.notifications.events, "all");
  assert.equal(cfg.notifications.channels[0]!.kind, "slack");
});

test("customize models per agent: declining keeps today's behavior — only the three pinned agents, all matching defaults.model", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "claude_code", "Model (Claude": "opus", Authentication: "login" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Customize models per agent": false,
      "Send notifications": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.deepEqual(
    config.agents.map((a: any) => a.name).sort(),
    ["documenter", "planner", "reviewer"],
  );
  for (const a of config.agents) assert.equal(a.model, "opus");
});

test("customize models per agent: accepting patches the pinned three and appends builder/scout/refiner", async () => {
  const ctx = gatherContext(dir, new Map());
  assert.deepEqual(ctx.rosterNames.slice().sort(), ["builder", "documenter", "planner", "refiner", "reviewer", "scout"]);
  const asker = createFakeAsker({
    select: { "backend runs": "claude_code", "Model (Claude": "sonnet", Authentication: "login" },
    text: {
      "  planner": "opus",
      "  builder": "sonnet",
      "  scout": "haiku",
      "  refiner": "opus",
      "  reviewer": "opus",
      "  documenter": "sonnet",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Customize models per agent": true,
      "Send notifications": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  const byName = Object.fromEntries(config.agents.map((a: any) => [a.name, a.model]));
  assert.deepEqual(byName, { planner: "opus", reviewer: "opus", documenter: "sonnet", builder: "sonnet", scout: "haiku", refiner: "opus" });

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), dir); // throws on any problem
  assert.equal(cfg.agents.find((a) => a.name === "scout")!.model, "haiku");
});

test("advanced: declining the D1 question (the default) writes nothing under observability — today's local-only behavior, unchanged", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "claude_code", "Model (Claude": "sonnet", Authentication: "login" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Send notifications": false,
      "Configure advanced": true,
      "Write .piquette": true,
    },
    // No "Store trace data" entry in `select` — the fake asker falls back to
    // its default, "local", same as a real user hitting Enter.
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.observability, undefined, "local sqlite at its default path/poll_ms writes nothing at all — same as before this question existed");
  assert.equal(result!.env.CLOUDFLARE_ACCOUNT_ID, undefined);
  assert.equal(result!.env.CLOUDFLARE_API_TOKEN, undefined);
});

test("advanced: choosing D1 collects database_id + fresh CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN, writes a terse {kind:d1} object, and validates cleanly", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Store trace data locally or remotely": "d1",
    },
    text: { "Cloudflare D1 database_id": "prod-traces-db", CLOUDFLARE_ACCOUNT_ID: "acct-fresh" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Send notifications": false,
      "Configure advanced": true,
      "Write .piquette": true,
    },
    secret: { CLOUDFLARE_API_TOKEN: "token-fresh" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.deepEqual(config.observability.db, { kind: "d1", database_id: "prod-traces-db" }, "account_id_env/api_token_env match the schema's own defaults — omitted to keep the config terse");
  assert.equal(result!.env.CLOUDFLARE_ACCOUNT_ID, "acct-fresh");
  assert.equal(result!.env.CLOUDFLARE_API_TOKEN, "token-fresh");
  assert.ok(result!.envExampleKeys.includes("CLOUDFLARE_ACCOUNT_ID"));
  assert.ok(result!.envExampleKeys.includes("CLOUDFLARE_API_TOKEN"));

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.deepEqual(cfg.observability.db, {
    kind: "d1",
    database_id: "prod-traces-db",
    account_id_env: "CLOUDFLARE_ACCOUNT_ID",
    api_token_env: "CLOUDFLARE_API_TOKEN",
  });
  validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), dir);
});

test("advanced: D1 + flue/cloudflare provider reuses the CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN already collected for Workers AI — never asks a second time", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "flue",
      Provider: "cloudflare",
      "Store trace data locally or remotely": "d1",
    },
    text: {
      "Model id": "@cf/zai-org/glm-5.3-flash",
      CLOUDFLARE_ACCOUNT_ID: "acct-shared", // answers the Workers AI branch's asker.text prompt
      "Cloudflare D1 database_id": "shared-traces-db",
    },
    confirm: {
      "explicit base URL": false,
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": false,
      "Send notifications": false,
      "Configure advanced": true,
      "Write .piquette": true,
    },
    secret: { CLOUDFLARE_API_TOKEN: "cf-shared-token" }, // answers the Workers AI branch's asker.secret prompt
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.deepEqual(config.observability.db, { kind: "d1", database_id: "shared-traces-db" });
  // Exactly one collection of each — envExampleKeys has no duplicate entries,
  // which it WOULD if the D1 branch asked a second time instead of reusing.
  assert.deepEqual(
    result!.envExampleKeys.filter((k) => k === "CLOUDFLARE_ACCOUNT_ID"),
    ["CLOUDFLARE_ACCOUNT_ID"],
  );
  assert.deepEqual(
    result!.envExampleKeys.filter((k) => k === "CLOUDFLARE_API_TOKEN"),
    ["CLOUDFLARE_API_TOKEN"],
  );
  assert.equal(result!.env.CLOUDFLARE_ACCOUNT_ID, "acct-shared");
  assert.equal(result!.env.CLOUDFLARE_API_TOKEN, "cf-shared-token");
});

test("an existing .env value is offered back as the default when a secret is left blank", async () => {
  const ctx = gatherContext(dir, new Map([["GITHUB_TOKEN", "ghp_existingvalue"]]));
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "github",
      "Code host": "github",
      "Chain to run": "plan-build-test",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable piquette watch": true,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    // no GITHUB_TOKEN entry in `secret` — the fake leaves it blank, same as a real user hitting Enter to keep the current value
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  assert.equal(result!.env.GITHUB_TOKEN, undefined, "a blank secret answer must not overwrite the existing value with empty");
});

// ── verification receipts ───────────────────────────────────────────────────

test("receipts: declining the gate leaves config.receipts undefined", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "claude_code", "Model (Claude": "sonnet", Authentication: "login" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Capture verification receipts": false,
      "Enable piquette watch": false,
      "Send notifications": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.receipts, undefined);
});

test("receipts: local store accepts the default path with no path field written", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "claude_code", "Model (Claude": "sonnet", Authentication: "login", "Where do receipts": "local" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Capture verification receipts": true,
      "Enable piquette watch": false,
      "Send notifications": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.deepEqual(config.receipts, { store: { kind: "local" } });

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.receipts?.store.kind, "local");
});

test("receipts: the R2 preset collects bucket/endpoint/region and the R2_* secret env vars", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Where do receipts": "s3",
      Service: "r2",
    },
    text: {
      "Bucket name": "piquette-receipts",
      "R2 endpoint": "https://abc123.r2.cloudflarestorage.com",
      Region: "auto",
      "Key prefix": "",
      "access key id": "R2_ACCESS_KEY_ID",
      "secret access key": "R2_SECRET_ACCESS_KEY",
      "Viewer URL": "",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Capture verification receipts": true,
      "Enable piquette watch": false,
      "Send notifications": false,
      "Configure advanced": false,
      "Write .piquette": true,
    },
    secret: { R2_ACCESS_KEY_ID: "AKIA_FAKE", R2_SECRET_ACCESS_KEY: "secret_fake" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.receipts.store.kind, "s3");
  assert.equal(config.receipts.store.bucket, "piquette-receipts");
  assert.equal(config.receipts.store.endpoint, "https://abc123.r2.cloudflarestorage.com");
  assert.equal(config.receipts.store.region, "auto");
  // R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are the schema defaults for neither kind
  // (those are AWS_*) so the non-default env var names must be written explicitly —
  // otherwise a real run would silently look for AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.
  assert.equal(config.receipts.store.access_key_id_env, "R2_ACCESS_KEY_ID");
  assert.equal(config.receipts.store.secret_access_key_env, "R2_SECRET_ACCESS_KEY");
  assert.equal(result!.env.R2_ACCESS_KEY_ID, "AKIA_FAKE");
  assert.equal(result!.env.R2_SECRET_ACCESS_KEY, "secret_fake");

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.receipts?.store.kind, "s3");
});

// ── `--partial` reconfiguration (`runInterview`'s `partial` option) ────────────

test("partial: an unselected block's value carries through into the result unchanged", async () => {
  const ctx = gatherContext(dir, new Map());
  const existing = {
    defaults: { coding_agent: "claude_code", model: "sonnet" },
    agents: [{ name: "planner", model: "sonnet" }],
    watch: { issue_provider: "github", code_host: "github", repo: "acme/widgets", label_prefix: "piquette", chain: "plan-build-test", base_branch: "main" },
  };
  // Only "quality" is selected — coding_agent/watch ask nothing, so a fake asker that
  // answers every confirm with its own default would otherwise fail loudly on an
  // unexpected prompt; scripting it bare like this doubles as proof nothing else is asked.
  const asker = createFakeAsker({
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': true,
      "Write .piquette": true,
    },
  });

  const result = await runInterview(asker, ctx, { only: new Set(["quality"]), existing });
  assert.ok(result);
  const config = result!.config as any;
  assert.deepEqual(config.watch, existing.watch); // carried forward, not re-asked
  assert.deepEqual(config.agents, existing.agents);
  assert.equal(config.defaults.coding_agent, "claude_code");
  assert.deepEqual(config.quality.suites.all, ["test"]);
});

test("partial: reconfiguring advanced back to its defaults clears a stale override instead of leaving it in place", async () => {
  const ctx = gatherContext(dir, new Map());
  const existing = {
    defaults: { coding_agent: "claude_code", model: "sonnet", thinking: "high", data_dir: ".piquette/data" },
    observability: { poll_ms: 250 },
  };
  const asker = createFakeAsker({
    select: { "defaults.thinking": "medium" }, // explicitly choosing the default value, not leaving it unscripted
    text: { "observability.poll_ms": "500" },
    confirm: { "Configure advanced": true, "Write .piquette": true },
  });

  const result = await runInterview(asker, ctx, { only: new Set(["advanced"]), existing });
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.defaults.thinking, undefined, "reverting to the default must delete the stale override, not just skip re-setting it");
  assert.equal(config.observability, undefined);
});

test("partial: declining receipts in a re-run clears a previously-configured receipts: block", async () => {
  const ctx = gatherContext(dir, new Map());
  const existing = {
    defaults: { coding_agent: "claude_code", model: "sonnet" },
    receipts: { store: { kind: "local" } },
  };
  const asker = createFakeAsker({
    confirm: { "Capture verification receipts": false, "Write .piquette": true },
  });

  const result = await runInterview(asker, ctx, { only: new Set(["receipts"]), existing });
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.receipts, undefined);
});
