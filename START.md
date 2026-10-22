# START.md — set up spf in this repo (written for an AI agent)

You are an AI coding agent. The human pasted this file to have you install
**spf** (Super Portable Factory, `@gr8ful/spf`), configure it for their repo,
and do the first real runs. spf is a global CLI that runs repeatable
agents-plus-code chains (plan, build, test, commit...) against a repo: TypeScript
owns the sequencing and gates, coding agents are bounded steps inside it.

Rules for you:

- Do the sections in order. Each ends with a **Gate**. Run the gate command and
  read the output; do not continue on a failure and do not assume success.
- Never invent a flag. If unsure, run `spf --help` or `spf list`.
- Never write secrets into committed files. API keys and tokens go in `.env`
  at the repo root, which every spf command auto-loads and which `spf init`
  adds to `.gitignore`. Ask the human for them; do not guess or reuse keys
  from elsewhere.
- Ask the human before anything that costs money (real chain runs) or touches
  a remote (`spf watch`, which labels issues and opens PRs).
- If you are Claude Code: after section 1, run `spf install-skill` (or
  `spf init`, which does it) and defer to the installed skill
  (`.claude/skills/spf/SKILL.md`; read the file directly if this session
  does not list the skill yet) for how to orchestrate spf. Do not re-derive
  orchestration rules from this file.

Canonical docs (reference only; nothing below depends on you being able to read
them). Paths like `assets/skill/references/config.md` below are relative to
any of:

- the spf repo: https://github.com/seesharpguy/super-portable-software-factory
- the installed package: `$(npm root -g)/@gr8ful/spf/` (README.md, `assets/`)
- after `spf init` or `spf install-skill`, this repo's `.claude/skills/spf/`,
  which holds a copy of `assets/skill/` (so `references/config.md`,
  `cookbooks/authoring_chains.md`, ... without the `assets/skill/` prefix)

---

## 1. Install and verify

Requires Node >= 22.19.0 and a git repository (run everything from the repo root).

```bash
node --version                 # must be >= 22.19.0
npm i -g @gr8ful/spf
spf version                    # prints the installed version
spf doctor                     # checks everything that otherwise fails silently
```

`spf doctor` prints one line per check: `✓` ok, `ℹ` informational, `⚠`
warning, `✗` hard failure, and exits non-zero if any line is `✗`. It works
with zero config. Fix every `✗`; read each `⚠`. What the common lines mean:

| Line | Meaning and fix |
|---|---|
| `node version` fails | Upgrade Node to >= 22.19.0. |
| `git repository: no` | `git init`, or `cd` to the repo root. |
| `.spf/ not gitignored: WARNING` | `.gitignore` ignores `.spf/` itself, which defeats `protected_files`. Ignore `.spf/data/` instead. (`good` is the expected value.) |
| `agent "<name>" provider key: none of ... is set` | The agent's model provider needs a key in `.env`. **Expected on a fresh repo:** the packaged roster runs on flue with Fireworks, Gemini, and OpenAI models, so you will see these until section 2 picks the human's own models. For `claude_code` agents this line is always `✓`; `ANTHROPIC_API_KEY` is optional if the human ran `claude login`. |
| `claude CLI` / `opencode CLI` not found on PATH | Only shown when an agent uses that backend. Install the CLI, or pick another backend in section 2. |
| `opencode auth` | Informational. Have the human run `opencode auth login` if it reports nothing configured. |
| `quality check "<x>"`: NOT found on PATH | A configured lint/test command's binary is missing. Install it or fix the check's `argv`. |
| `quality suite "<x>"`: names unknown check(s) | A suite lists a check name that `quality.checks` does not define. |
| `protected_files pattern ... matches nothing` | Informational on a clean tree. |
| `GITHUB_TOKEN`, `JIRA_EMAIL / JIRA_API_TOKEN`, `BITBUCKET_EMAIL / BITBUCKET_API_TOKEN` | Only shown once a `watch:` block is configured, and then required. Put them in `.env`. |
| `config parses` / `roster + suites validate` fails | The config is invalid; the line names the field. Fix it in `.spf/spf.config.yaml`. |

Use `spf doctor --json` if you want to parse results.

**Gate:** `node version`, `git repository`, `config parses`, and
`roster + suites validate` are all `✓`. Provider-key `✗` lines are expected
at this point (see the table); section 2 clears them.

---

## 2. Interview the user, then configure

Ask these questions in conversation (batch them). They mirror what `spf init`
asks on a terminal.

1. **Coding agent backend.** `claude_code` (shells out to the `claude` CLI),
   `flue` (spf's own runtime; many model providers, incl. local Ollama and
   Cloudflare Workers AI), or `opencode`. The packaged default roster is `flue`.
2. **Model(s).** One model for the whole roster, or a different one per agent
   (`planner`, `builder`, `scout`, `refiner`, `reviewer`, `documenter`). For
   flue and opencode, models are `provider/model-id` (e.g.
   `google/gemini-3.6-flash`, `ollama/<tag>`); for `claude_code`, a Claude
   Code alias (`sonnet`, `opus`, ...). Ask which provider keys they have. The
   flue provider prefix decides the `.env` key: `anthropic` →
   `ANTHROPIC_API_KEY`, `openai` → `OPENAI_API_KEY`, `google` →
   `GEMINI_API_KEY`, `openrouter` → `OPENROUTER_API_KEY`, `fireworks` →
   `FIREWORKS_API_KEY` (also `groq`, `mistral`, `xai`, `deepseek`,
   `together`, `cerebras` as `<NAME>_API_KEY`), `cloudflare` →
   `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID`. `ollama` needs no key
   (set `OLLAMA_BASE_URL` if the server is not local).
3. **Quality commands.** What proves a change is good: test, lint, typecheck,
   build. Inspect the repo (`package.json` scripts, Makefile, CI config),
   propose, then confirm. No quality checks ship by default, and chains that
   need one fail loudly until you add some.
4. **`spf watch`.** Should spf poll an issue tracker for `spf:ready` issues and
   open PRs automatically? If yes: tracker (`github`, `github-projects`, or
   `jira`), code host (`github` or `bitbucket`), and the `owner/name` repo.
   Optional; skip it for a first setup.
5. **Notifications.** Push run results to Slack, Teams, or a webhook? Optional.

### Apply the answers

`spf init --answers <file>`, which would take these answers non-interactively,
is upcoming (issue #43) and does not exist yet. Until then use the fallback:

```bash
spf init --yes                      # non-interactive: commented, all-defaults starter .spf/spf.config.yaml
# or start from the packaged template closest to the answers:
spf init --template <name>
```

| Template | Backend and models |
|---|---|
| `ts` | `claude_code` on Anthropic (`sonnet`) |
| `ts-cc` | `claude_code` pointed at Ollama via `ANTHROPIC_BASE_URL` |
| `ts-opencode` | `opencode` CLI |
| `ts-flue-ollama` | flue on a local Ollama server (tiering on) |
| `ts-flue-openrouter` | flue through OpenRouter |
| `ts-flue-cloudflare` | flue on Cloudflare Workers AI |

All templates assume an npm TypeScript project (`npm test`, `npm run lint`,
`npm run typecheck`, `npm run build`); fix the `quality.checks` argv to match
the repo. `--yes` and `--template` skip the interview (so does a non-TTY
stdin), scaffold `.spf/chains/`, add `.spf/data/`, `.spf/engine/`, and `.env`
to `.gitignore`, and install the Claude Code skill unless you pass
`--no-skills`. If `.spf/spf.config.yaml` already exists, init leaves it
alone unless you add `--force`; ask the human before overwriting. Then edit
by hand:

- **`.spf/spf.config.yaml`**: write only what differs from the packaged
  defaults. Sections merge key by key, `quality.checks` replaces the whole
  list, and `agents` entries patch the packaged roster by `name`. **The
  packaged roster pins `planner`, `reviewer`, and `documenter` to their own
  models, and those pins win over `defaults.model`.** Whenever you change the
  model or backend, set those three explicitly too, or they keep running the
  packaged Fireworks/OpenAI models (and on `claude_code` they fail at the
  first dispatch, which `spf doctor` does not catch). Example for Claude
  Code with one model everywhere:

  ```yaml
  defaults:
    coding_agent: claude_code
    model: sonnet
  agents:
    - {name: planner, model: sonnet}
    - {name: reviewer, model: sonnet}
    - {name: documenter, model: sonnet}
  quality:
    checks:
      - {name: test, operation: build, argv: ["npm", "test"], timeout_seconds: 600}
      - {name: lint, operation: lint, argv: ["npx", "eslint", "."], timeout_seconds: 120}
    suites:
      test: [test]
      all: [test, lint]
  ```

  `operation` is one of `lint`, `typecheck`, `build` (use `build` for
  tests). The `test` suite is what `plan-build-test` and `build-test` run;
  `all` is what `plan-build-test-quality` and `quality` run.

  Only if they said yes to watch:

  ```yaml
  watch:
    issue_provider: github
    code_host: github
    repo: owner/name
    chain: plan-build-test
  ```

  Jira also needs a `watch.jira` block (`base_url`, `project_key`), and a
  Bitbucket `repo` is `workspace/repo_slug`; see config.md's "watch" table.

  Only if they want notifications (the URL itself is a secret and goes in
  `.env`, never in this file):

  ```yaml
  notifications:
    events: attention          # off | errors | attention | all
    channels:
      - kind: slack            # slack | teams | webhook
        webhook_url_env: SLACK_WEBHOOK_URL   # TEAMS_WEBHOOK_URL / SPF_WEBHOOK_URL for the others
  ```

- **`.env`**: provider keys and tokens, e.g. `FIREWORKS_API_KEY=...`.
  For watch: `GITHUB_TOKEN=...` (classic PAT, `repo` scope, `public_repo` for
  a public-only repo, plus `project` for `github-projects`), or
  `JIRA_EMAIL`/`JIRA_API_TOKEN`, or `BITBUCKET_EMAIL`/`BITBUCKET_API_TOKEN`.
  Ask the human for each secret, and mirror the key *names* (not values) into
  a committable `.env.example` (non-interactive init does not write one).
- If they chose watch: `spf watch init` (idempotent; seeds the `spf:*` labels),
  then confirm `spf doctor` shows the watch lines green.

Full field reference: `assets/skill/references/config.md` (see the doc
locations at the top).

**Gate:** `spf doctor` exits 0, or every remaining `✗` is something the
human explicitly chose not to use. It must show `quality suite "test"` (and
`quality suite "all"` if they want `plan-build-test-quality`), because
`spf doctor` does not flag a chain whose suite is missing; that chain just
refuses to start. Show the human the final `.spf/spf.config.yaml` and get a
yes before committing it.

---

## 3. First runs

Always from the repo root. Each run prints an `adw_id` (the run/session id).

```bash
# 3a. Zero risk: read-only recon, changes nothing.
spf scout "describe this repo: layout, entry points, how tests are run"

# 3b. See the chains and pick by the shape of the work.
spf list
```

Pick a chain by work-shape (`spf list` is authoritative):

| Work | Chain |
|---|---|
| Recon, no changes | `scout` |
| Want the spec before any code | `plan` |
| Small, well-understood change | `plan-build` |
| There is a test suite to satisfy | `build-test` |
| The standard choice | `plan-build-test` |
| Also gate on lint/typecheck/build | `plan-build-test-quality` |
| "Is this what was asked for" matters | `build-review` |
| Real work, unclear shape | `simple-sdlc` |

`simple-sdlc` has a human sign-off before its build commit. Your shell is
usually not a TTY, so nobody gets asked: by default it commits on the AI
reviewer's verdict alone (with a warning), and with
`review.require_human_signoff: true` it fails closed instead. Tell the human
which one applies before you run it.

```bash
# 3c. Optional: projected model routing and cost from past runs (read-only;
#     exits 3 when there is no history yet, which is normal on a fresh repo).
spf estimate plan-build-test "add a /health endpoint"

# 3d. A real run. Ask the human for a small, low-stakes task first.
#     Chains commit on the CURRENT branch, so branch off first.
git switch -c spf/first-run
spf plan-build-test "add a /health endpoint that returns 200 and {status: 'ok'}"
```

Chain options: `--cwd <dir>`, `--agent <name>`, `--base <ref>`, `--issue <id>`,
`--priority p0|p1|p2|p3`, `--suite <name>` (only on chains `spf list` marks
"--suite overrides"), `--adw-id <id>` (join an existing session; agents
resume their context). Cost guards: `defaults.max_run_cost` /
`defaults.max_run_tokens` in the config.

### Read the run back

```bash
spf sessions                  # recent runs
spf phases <adw_id>           # the run's phases and each outcome
spf events <adw_id>           # trace events (add --follow to tail a live run)
spf ui                        # browser trace visualizer (loopback only)
spf abort <adw_id>            # stop a run that is going wrong
```

`sessions`, `phases`, and `events` accept `--json`. spf never merges anything:
review the result (`git log`, `git diff`) and tell the human what changed.

**Gate:** `spf phases <adw_id>` shows every phase finished successfully and the
quality suite passed. If a phase failed, read `spf events <adw_id>`, fix the
cause (usually config, a missing key, or an unclear prompt), and rerun; do not
paper over it.

---

## 4. Build things

Pointers only. Read the canonical doc before changing anything non-trivial.

- **Repo-local chains.** Drop a YAML file in `.spf/chains/*.yaml` to compose your
  own chain from the same step factories (agents, quality-suite steps, git
  commit, external CLIs). It then appears in `spf list` and runs as
  `spf <name> "<prompt>"`. `spf init` scaffolds two fully commented-out
  examples, `.spf/chains/example.yaml` and `.spf/chains/review-fix.yaml`.
  See `assets/skill/cookbooks/authoring_chains.md`.
- **Roster and prompt overrides.** Each agent in the roster has a model, tools,
  and write permissions (patch them under `agents:` by `name`), and a
  system/user prompt pair that a repo overrides by placing files under
  `.spf/prompt_engineering/<agent>/` (start from the packaged ones in
  `assets/prompts/<agent>/`). `spf eject` copies the compiled engine out for
  reading; it has no config surface and is not how you customize. See
  `assets/skill/cookbooks/roster.md` and `assets/skill/references/config.md`.
- **Templates.** `spf init --template <name>` seeds a filled-in config for common
  setups (Claude Code, opencode, flue with Ollama/OpenRouter/Cloudflare). Browse
  `assets/templates/` for the exact files.
- **Watch.** `spf watch` polls the tracker for `spf:ready` issues, runs
  `watch.chain` on each in its own worktree, opens a PR, and tracks it to
  done/blocked. Start with `spf watch --dry-run --once`. Set
  `watch.allowed_authors` before pointing it at a repo that takes outside
  issues. See the README's "spf watch" section and `config.md`.
- **Also worth knowing.** `spf fanout <chain> "<prompt>" --n 3` (best-of-N; you
  merge the winner), `spf loop <chain> "<goal>" --until-suite <name> --max N`
  (repeat until a suite passes), `spf migrate` (old `adws/` tree to `.spf/`).

Run `spf --help` for the full command list.
