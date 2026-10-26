# PIQUETTE Overview

The map, not the procedure — read this once to know how the pieces fit
before touching any of the other cookbooks.

## What PIQUETTE is

PIQUETTE runs **ADWs**: TypeScript chains that own sequencing, retries, and
acceptance, calling bounded agent phases and deterministic code phases in
between. "Agent proposes, code disposes" — an agent's response is a claim,
and code (a gate, a quality check, a permissions check) verifies it before
the chain moves on.

PIQUETTE is a global CLI (`npm i -g @piquette/engine`), not a template stamped into
the target repo. It ships:

- a packaged **default roster** (`piquette.config.yaml`) and **default prompts**,
  usable with zero setup;
- an optional per-repo **`.piquette/` override directory** (`piquette init` seeds it) —
  merged on top of the packaged defaults, field by field;
- an optional per-repo **`.piquette/data/`** runtime home for the sqlite trace and
  session files, created on first run, always gitignored.

There is no `adws/` tree to stamp, no `bun install`. The default
coding-agent backend is **Flue** (`@flue/runtime`), an in-process agent
harness with no subprocess and no separate CLI to have on `PATH`.
`coding_agent: claude_code` is a second backend — it shells out to your own
installed `claude` CLI instead, for repos that want to run agents on
Claude Code (including pointed at a local or cloud Ollama server). See
`roster.md`.

## Layout, once you run something

```
<repo>/
  .piquette/                          # optional — only if you ran `piquette init`
    piquette.config.yaml              # your overrides, merged over the built-in defaults
  .piquette/data/                     # runtime — always gitignored
    piquette.db                       # the trace: sessions, phases, events, envelopes, gates
    flue.db                     # Flue's own conversation store (session resumption)
    sessions/<adw_id>/
      agent_map.json            # agent name -> its Flue conversation id + model
      context_handoff/          # the ONE place agents hand files to each other
      <agent_name>/
        prompts/                # exact system.md + user.md sent, saved before the call
        envelope.json           # the final parsed, validated response
```

`piquette doctor` prints exactly what resolved and from where — config paths,
prompt paths, the trace db path — so "is my override even taking effect" is
always a one-command answer.

## The phase model

Three phase kinds, all run through the one primitive, `run.phase(params, fn)`:

- **`engineer`** — captures human input; no agent, no gate.
- **`agent`** — `ph.call({output_type, prompt, gates})`: sends a prompt,
  gets back a typed envelope, verifies it against every declared gate.
  A parse failure or gate violation triggers a bounded same-session
  correction, never a cold restart.
- **`code`** — deterministic work: running a quality suite, capturing a git
  diff, committing. If you can write down the command, it's `code`, not an
  agent that has to rediscover it every run.

Every phase defaults to `fail`; only a clean exit earns `success`. The chain
calls `run.finish(accepted, reason)` exactly once at the end — separate from
per-phase success, because a red test suite that *ran correctly* is still a
successful phase; whether the whole run is *accepted* is a different
question.

## Envelopes

Every agent call declares a concrete output type — an envelope schema built
with Valibot's `envelopeType()`. The agent's final JSON is parsed against
exactly that type; there are no untyped handoffs. The schema, the JSON shown
in that agent's `user.md` `## Report` section, and the `output_type:` named
at the call site are the same fact in three places — the "synced triad."
Full contract: `references/handoff.md`.

## Running a chain

```bash
piquette list                                        # every chain, its phases, what it needs
piquette <chain-name> "<prompt or path/to/prompt.md>" [--config <path>] [--adw-id <id>] [--cwd <dir>]
piquette doctor                                      # confirm the roster/config/quality all resolve first
piquette sessions                                    # recent runs
piquette phases <adw_id>                             # one run's phase-by-phase status
piquette events <adw_id> --follow                    # the live trace
piquette ui                                          # the visualizer, browser-based
```

`piquette <chain-name> ...` and `piquette run <chain-name> ...` are identical — the bare
form exists because naming the chain *is* choosing what runs.

## When you've finished reading this

Startup discipline still applies: run `piquette list`, don't volunteer more state
than the engineer asked for, and read `how_to_prompt_for_the_eng.md` before
launching anything.

## Where to go next

| Need | Go to |
|---|---|
| Launch a chain, watch it, report on it | `cookbooks/run_adw.md` (after `how_to_prompt_for_the_eng.md`) |
| Retune the roster, add an agent | `cookbooks/roster.md` |
| Add or extend a chain | `cookbooks/authoring_chains.md` |
| Fold a third-party review tool's findings into the reviewer's verdict | `cookbooks/ocr_reviewer.md` |
| Envelope/gate/session contract | `references/handoff.md` |
| Trace schema, spend vs. context | `references/observability.md` |
| Full config field reference | `references/config.md` |
