/**
 * Regression guard for `spf init`'s non-interactive paths — `--yes`,
 * `--template <name>`, and (implicitly, since the test runner's stdin/stdout
 * are never a TTY) plain `spf init` with no flags. All three must keep
 * writing the exact same content they always have, byte for byte, and must
 * never touch stdin — a scripted `spf init` in CI must not hang.
 *
 * The interactive interview itself is covered directly against `Asker`
 * in `interview.test.ts`; `initCommand`'s interactive branch always calls
 * the real `createAsker()` (backed by `node:readline` on `process.stdin`),
 * which has nothing to read in a test process — exercising it here would
 * just hang, so it isn't.
 */
import "./hermetic_git.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { initCommand, EXAMPLE_CHAIN_YAML, EXAMPLE_REVIEW_FIX_CHAIN_YAML } from "../cli/commands/init.js";
import { loadRepoChains } from "../chains/repo_chains.js";
import { resolveAnchor, BUILTIN_CONFIG_PATH, TEMPLATES_DIR } from "../core/paths.js";
import { loadConfig, validate } from "../core/agents.js";
import { CHAINS, resolveRequiredAgents, resolveRequiredSuites } from "../chains/index.js";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spf-init-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("--yes writes the plain starter config, all commented out, with no interview", async () => {
  const code = await initCommand(["--cwd", dir, "--yes"]);
  assert.equal(code, 0);
  const content = readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8");
  assert.match(content, /merged ON TOP of spf's packaged built-in defaults/);
  assert.match(content, /^# quality:/m); // every real section stays commented out
  assert.doesNotMatch(content, /^defaults:/m);
});

test("plain `spf init` (no TTY in a test process) falls through to the same starter config as --yes", async () => {
  const code = await initCommand(["--cwd", dir]);
  assert.equal(code, 0);
  const content = readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8");
  assert.match(content, /merged ON TOP of spf's packaged built-in defaults/);
});

test("--template writes the named template as-is, skipping the interview even without --yes", async () => {
  const code = await initCommand(["--cwd", dir, "--template", "ts-cc"]);
  assert.equal(code, 0);
  const content = readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8");
  assert.match(content, /Claude Code backend, pointed at Ollama/);
});

test("an existing config is left alone without --force, even for --yes", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  const before = readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8");
  const code = await initCommand(["--cwd", dir, "--template", "ts-cc"]); // no --force
  assert.equal(code, 0);
  assert.equal(readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8"), before);
});

test("--force overwrites an existing config non-interactively", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  await initCommand(["--cwd", dir, "--template", "ts-cc", "--force"]);
  const content = readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8");
  assert.match(content, /Claude Code backend, pointed at Ollama/);
});

test("never writes .env or .env.example on the non-interactive paths", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  assert.equal(existsSync(join(dir, ".env")), false);
  assert.equal(existsSync(join(dir, ".env.example")), false);
});

test("also installs the repo-local Claude Code skill by default, on every non-interactive path", async () => {
  const code = await initCommand(["--cwd", dir, "--yes"]);
  assert.equal(code, 0);
  assert.ok(existsSync(join(dir, ".claude", "skills", "spf", "SKILL.md")), "spf init should install the skill unless --no-skills is passed");
});

test("--no-skills skips the skill install", async () => {
  const code = await initCommand(["--cwd", dir, "--yes", "--no-skills"]);
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, ".claude", "skills", "spf")), false);
});

test("scaffolds .spf/chains/example.yaml, fully commented out (registers nothing)", async () => {
  const code = await initCommand(["--cwd", dir, "--yes"]);
  assert.equal(code, 0);
  const examplePath = join(dir, ".spf", "chains", "example.yaml");
  assert.ok(existsSync(examplePath), "spf init should scaffold .spf/chains/example.yaml");
  const content = readFileSync(examplePath, "utf-8");
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    assert.ok(line.startsWith("#"), `every non-blank line in the scaffolded example must be commented out: ${JSON.stringify(line)}`);
  }
});

test("never adds .spf/chains to .gitignore — chain files must stay tracked for protected_files to cover them", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
  assert.doesNotMatch(gitignore, /\.spf\/chains/);
});

test("the scaffolded example.yaml loads clean — zero chains, zero problems (it must not report a problem against spf's own scaffold)", async () => {
  const code = await initCommand(["--cwd", dir, "--yes"]);
  assert.equal(code, 0);
  const anchor = resolveAnchor(dir);
  const { chains, problems } = loadRepoChains(anchor);
  assert.deepEqual(chains, []);
  assert.deepEqual(problems, []);
});

test("EXAMPLE_CHAIN_YAML's commented-out template, uncommented verbatim, is a chain the loader accepts", async () => {
  const lines = EXAMPLE_CHAIN_YAML.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("# name: example"));
  assert.ok(startIdx !== -1, "expected a `# name: example` line to anchor the template block");
  const uncommented = lines
    .slice(startIdx)
    .map((l) => l.replace(/^#\s?/, ""))
    .join("\n");

  const chainsDir = join(dir, ".spf", "chains");
  execFileSync("mkdir", ["-p", chainsDir]);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(chainsDir, "uncommented.yaml"), uncommented);

  const anchor = resolveAnchor(dir);
  const { chains, problems } = loadRepoChains(anchor);
  assert.deepEqual(problems, [], `expected zero problems, got: ${JSON.stringify(problems)}`);
  assert.equal(chains.length, 1);
  assert.equal(chains[0]?.name, "example");
});

test("scaffolds .spf/chains/review-fix.yaml, fully commented out, and it loads clean", async () => {
  const code = await initCommand(["--cwd", dir, "--yes"]);
  assert.equal(code, 0);
  const content = readFileSync(join(dir, ".spf", "chains", "review-fix.yaml"), "utf-8");
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    assert.ok(line.startsWith("#"), `every non-blank line in the review-fix scaffold must be commented out: ${JSON.stringify(line)}`);
  }
  const { chains, problems } = loadRepoChains(resolveAnchor(dir));
  assert.deepEqual(chains, []);
  assert.deepEqual(problems, []);
});

test("EXAMPLE_REVIEW_FIX_CHAIN_YAML's commented-out chain, uncommented verbatim, is a chain the loader accepts", async () => {
  const lines = EXAMPLE_REVIEW_FIX_CHAIN_YAML.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("# name: build-review-fix"));
  assert.ok(startIdx !== -1, "expected a `# name: build-review-fix` line to anchor the template block");
  const uncommented = lines
    .slice(startIdx)
    .map((l) => l.replace(/^#\s?/, ""))
    .join("\n");

  const chainsDir = join(dir, ".spf", "chains");
  execFileSync("mkdir", ["-p", chainsDir]);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(chainsDir, "uncommented.yaml"), uncommented);

  const { chains, problems } = loadRepoChains(resolveAnchor(dir));
  assert.deepEqual(problems, [], `expected zero problems, got: ${JSON.stringify(problems)}`);
  assert.equal(chains.length, 1);
  assert.equal(chains[0]?.name, "build-review-fix");
});

test("re-running spf init doesn't overwrite an already-scaffolded example.yaml", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  const examplePath = join(dir, ".spf", "chains", "example.yaml");
  const before = readFileSync(examplePath, "utf-8");
  await initCommand(["--cwd", dir, "--template", "ts-cc"]); // no --force
  assert.equal(readFileSync(examplePath, "utf-8"), before);
});

test("re-running spf init doesn't re-copy an unchanged skill install (install-skill's own idempotency)", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  const manifestPath = join(dir, ".claude", "skills", "spf", ".spf-skill-version");
  const before = readFileSync(manifestPath, "utf-8");
  await initCommand(["--cwd", dir, "--template", "ts-cc"]); // no --force: config write is a no-op, skill install still runs
  assert.equal(readFileSync(manifestPath, "utf-8"), before);
});

// ── packaged templates parse against the real config schema ─────────────────

/** Layer a template over the packaged defaults exactly as a real repo's `.spf/spf.config.yaml` would be. */
function loadTemplateConfig(name: string) {
  return loadConfig([BUILTIN_CONFIG_PATH, join(TEMPLATES_DIR, `${name}.spf.config.yaml`)]);
}

test("`tiered` and `jira-bitbucket` are writable via --template, byte for byte", async () => {
  for (const name of ["tiered", "jira-bitbucket"]) {
    const code = await initCommand(["--cwd", dir, "--template", name, "--force"]);
    assert.equal(code, 0);
    const written = readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8");
    assert.equal(written, readFileSync(join(TEMPLATES_DIR, `${name}.spf.config.yaml`), "utf-8"));
  }
});

test("tiered: cheap models on scout/planner/builder, a frontier model on the reviewer, and a run-cost cap", () => {
  const cfg = loadTemplateConfig("tiered");
  const model = (name: string) => cfg.agents.find((a) => a.name === name)?.model;
  const cheap = "ollama/qwen3-coder:30b";
  for (const name of ["scout", "planner", "builder", "refiner", "documenter"]) assert.equal(model(name), cheap, name);
  assert.match(model("reviewer") ?? "", /^anthropic\//);
  assert.match(cfg.agents.find((a) => a.name === "reviewer")?.purpose ?? "", /[Aa]dversarial/);
  assert.ok((cfg.defaults.max_run_cost ?? 0) > 0);
  assert.equal(cfg.tiering.enabled, false); // plain per-agent overrides, not the risk-routed ladder
  validate(cfg, ["scout", "planner", "builder", "reviewer"], [], dir);
});

// validate() only checks a flue model's provider/id SHAPE; Flue's own
// resolveModel does an exact catalog lookup at dispatch and throws "Unknown
// model ID" for anything pi-ai doesn't declare (ollama/* is exempt: it's
// registered on the fly, any tag). A priced entry is also what lets
// max_run_cost trip at all.
test("tiered: the frontier reviewer's model is one Flue's catalog actually declares, with a price", () => {
  const cfg = loadTemplateConfig("tiered");
  const reviewer = cfg.agents.find((a) => a.name === "reviewer")!.model;
  const slash = reviewer.indexOf("/");
  const [provider, id] = [reviewer.slice(0, slash), reviewer.slice(slash + 1)];
  assert.ok((getBuiltinProviders() as string[]).includes(provider), provider);
  const entry = getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0]).find((m) => m.id === id);
  assert.ok(entry, `${reviewer} is not in pi-ai's catalog — it would fail at the first reviewer dispatch`);
  assert.ok(entry.cost.input > 0 && entry.cost.output > 0);
});

test("jira-bitbucket: split provider/code_host pairing with jira + bitbucket coordinates, no issue_repo", () => {
  const cfg = loadTemplateConfig("jira-bitbucket");
  assert.equal(cfg.watch.issue_provider, "jira");
  assert.equal(cfg.watch.code_host, "bitbucket");
  assert.match(cfg.watch.repo, /^[^/\s]+\/[^/\s]+$/); // workspace/repo_slug
  assert.equal(cfg.watch.issue_repo, ""); // never read for jira
  assert.ok(cfg.watch.jira.base_url && cfg.watch.jira.project_key);
  assert.equal(cfg.watch.refine.enabled, false);
  const chain = CHAINS.find((c) => c.name === cfg.watch.chain)!;
  validate(cfg, resolveRequiredAgents(chain, {}), resolveRequiredSuites(chain, {}), dir);
});

test("jira-bitbucket documents its env keys and the refine-lane provider requirement", () => {
  const text = readFileSync(join(TEMPLATES_DIR, "jira-bitbucket.spf.config.yaml"), "utf-8");
  for (const key of ["JIRA_EMAIL", "JIRA_API_TOKEN", "BITBUCKET_EMAIL", "BITBUCKET_API_TOKEN"]) assert.match(text, new RegExp(key));
  assert.match(text, /issue_provider: jira, github, or github-projects/);
});

test("every packaged template parses against the config schema and validates for every built-in chain", () => {
  for (const f of readdirSync(TEMPLATES_DIR).filter((n) => n.endsWith(".spf.config.yaml"))) {
    const cfg = loadConfig([BUILTIN_CONFIG_PATH, join(TEMPLATES_DIR, f)]);
    for (const chain of CHAINS) {
      assert.doesNotThrow(
        () => validate(cfg, resolveRequiredAgents(chain, {}), resolveRequiredSuites(chain, {}), dir),
        `${f} / ${chain.name}`,
      );
    }
  }
});
