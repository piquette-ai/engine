# Authoring Proof Scripts

A repo's own `scripts/proof/*.sh` are what a non-negotiable or a ticket's
journey actually runs — durable, hand-maintained infrastructure, not
something an agent generates. This is a human-interactive task, done in a
session like this one, not a chain step: these scripts are typically listed
in `defaults.protected_files`, so an agent inside an automated chain run
cannot write them even if it tried. Reach for this when the planner's plan
says it couldn't find a script to verify a UI-shaped change for real (see
the planner's own `{{verification}}` rule), or when you're adding a new
non-negotiable.

## The contract

A proof script is **one shell command**, judged purely on its exit code and
its merged stdout+stderr, exactly as a terminal would show them
(`core/journeys.ts`'s `ExpectSchema`: `exit`/`exit_nonzero`,
`output_contains`/`output_not_contains`, `first_line_matches`, `max_lines`).
That is the entire surface a journey or non-negotiable can judge — nothing
structural, nothing visual, no DOM tree. So:

- **Exit 0 on pass, non-zero on fail.** Never exit 0 because "it ran" —
  exit 0 only when what you checked is actually true.
- **Print something a person would recognize at a glance** — a success
  line (`output_contains` matches this) and, on failure, enough context to
  debug without re-running it.
- **Exit 126/127 is reserved** for "the command itself couldn't run" (not
  found, not executable) — piquette treats that as CAN'T TELL, never a
  pass or a fail. Don't let a missing dependency produce one of these
  codes by accident; fail loudly with your own message and a real nonzero
  exit instead.
- **Idempotent and self-contained.** Boot whatever it needs on a free
  loopback port, tear it down on exit, never touch real services or data —
  the same discipline `scripts/proof/lib.sh`-style helpers give you for
  free (a port picker, an HTTP-readiness poller, process-group cleanup).
- **`$PIQUETTE_EVIDENCE_DIR`, if set, is yours to write recordings or
  screenshots into** (mp4/webm/mov, png/jpg/gif, txt/json/log) — always
  guarded (`[ -n "$PIQUETTE_EVIDENCE_DIR" ] && { ...; } || true`, never
  `${PIQUETTE_EVIDENCE_DIR:-.}`), and it never decides pass/fail.

## Where it lives, and how it gets run

Two wiring points, same script either way:

- **A repo-wide non-negotiable** (`.piquette/verify/non-negotiables.yaml`):
  merged into *every* proof, whatever the ticket. Good for "the app's core
  UI still loads and responds," not for one ticket's specific behavior.
  ```yaml
  - id: checkout-ui-boots
    criterion: "the checkout page renders and the submit control is present"
    run: bash scripts/proof/checkout-ui.sh
    expect: { exit: 0, output_contains: ["checkout ui proof OK"] }
  ```
- **A ticket's own journey** (written by the planner into
  `journeys.yaml`): names your script directly, often with an argument for
  what this ticket specifically needs checked.
  ```yaml
  run: bash scripts/proof/checkout-ui.sh --assert-aria-busy-toggle
  ```

Either way, the planner only ever *names* the script — the planner's
`{{verification}}` rule tells it to look for one before falling back to a
text-match, never to write one. Writing it is this cookbook.

## A worked pattern: a real browser check with `agent-browser`

`core/recorder.ts` already proves this exact pattern works (it's how
piquette's own receipt videos get recorded) — reuse its CLI shape rather
than guessing at one:

```sh
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"   # proof_free_port, proof_wait_http, cleanup-on-exit, if this repo has one

PORT=$(proof_free_port)
BASE="http://127.0.0.1:$PORT"
SESSION="checkout-ui-proof-$$"
trap 'agent-browser --session "$SESSION" close >/dev/null 2>&1 || true' EXIT

# boot whatever serves the page under test, then wait for it
your_dev_server --port "$PORT" & proof_wait_http "$BASE/" 15

agent-browser --session "$SESSION" open "$BASE/checkout"
agent-browser --session "$SESSION" click "#submit-button"

# read real DOM state back — don't assume, verify
BUSY=$(agent-browser --session "$SESSION" eval \
  'document.querySelector("#submit-button").getAttribute("aria-busy")')

if [ "$BUSY" = '"true"' ]; then
  echo "checkout ui proof OK: aria-busy set on click"
  exit 0
else
  echo "FAIL: aria-busy was $BUSY after click, expected \"true\""
  exit 1
fi
```

The pieces worth keeping from `recorder.ts`'s own usage:
`--session <id>` scopes one browser instance so a script never collides
with a concurrent proof or the recorder itself; `eval <js>` is how you read
real page state (an attribute, computed style, text content — whatever the
ticket is actually about) rather than trusting that a click "probably"
worked; always `close` the session in a trap, since a leaked session is a
leaked browser process.

## Before you finish

- Run the script directly first (`bash scripts/proof/your-script.sh`) and
  confirm it exits 0 on today's code and the message it prints.
- If this is meant to catch a regression, break the behavior on purpose
  and confirm the script actually exits non-zero — a proof script that
  can't fail proves nothing (the same "red before green" discipline
  `core/journeys.ts` asks of every journey).
- Wire it in (a non-negotiable, or tell the engineer running the ticket to
  reference it from their journey) and re-run `piquette prove` or the
  chain so the planner picks it up on the next plan.
