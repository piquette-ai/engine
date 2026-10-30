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

## A worked pattern: a fixture page, no dev server required (Node)

Sometimes there's no cheap way to boot the real app on a port — or the page
under test needs a backend/third-party SDK (payments, auth) that has no
throwaway local instance. If the app exposes its own render function (server
templates, a component-to-HTML renderer, anything that returns markup) and
ships its client behavior as a separate script, you can render a minimal
fixture with that *real* render function, serve it alongside the *real*
client script on a loopback port, and mock only the handful of things that
script reaches outside the page — all in one Node proof script, no server
process to boot or tear down separately.

`core/ui_fixture.ts` ships exactly this (`@piquette/engine/dist/core/ui_fixture.js`
— the `./dist/*` export): an async loopback static-file server
(`startFixtureServer`) and an async `agent-browser` session wrapper
(`agentBrowserSession`) with the same `--session`/`eval`/`close` discipline as
the shell pattern above, plus a `waitFor` poll for a page's own async init
(a fetch, an SDK load) instead of a fixed `wait` guessing how long that takes.

```js
import { startFixtureServer, agentBrowserSession } from "@piquette/engine/dist/core/ui_fixture.js";
import { writeFileSync } from "node:fs";
import { renderCheckoutPage } from "../../src/render.js"; // the app's own real renderer

const { html } = renderCheckoutPage({ /* minimal realistic props */ });

// Mock what the page reaches outside itself, same-origin, before serving it:
// (1) a data-* attribute the client script reads for its API base, pointed
//     back at this fixture's own server; (2) a global the client script
//     checks for before loading the real SDK, defined in an inline <script>
//     BEFORE the client script's own <script src> tag — most client code
//     either reads config off data-* attributes or short-circuits its own
//     init when a global is already present, so both hooks are usually
//     already there without the app needing to change anything for this.
const server = await startFixtureServer(fixtureDir, {
  onRequest(req, res) {
    if (req.method === "POST" && req.url === "/api/checkout-session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ clientSecret: "fixture-only, never a real one" }));
      return true;
    }
    return false; // falls through to serving the real files below
  },
});
const stub = `<script>window.PaymentsSdk = function () { return { confirm: () => new Promise(() => {}) }; };</script>`;
writeFileSync(
  `${fixtureDir}/index.html`,
  html
    .replace("<html>", `<html data-api-base-url="${server.url}">`)
    .replace("<script src=\"/checkout.js\">", `${stub}\n<script src="/checkout.js">`),
);

const session = agentBrowserSession();
try {
  await session.run(["open", `${server.url}/`], "open");
  await session.waitFor("document.querySelector('#submit').disabled", "false", "wait for init", 5_000);
  await session.run(["click", "#submit"], "click");
  const busy = await session.run(["eval", "document.querySelector('#submit').getAttribute('aria-busy')"], "read aria-busy");
  if (busy !== JSON.stringify("true")) throw new Error(`expected aria-busy=true, got ${busy}`);
  console.log("PASS checkout-submit-busy");
} finally {
  await session.close();
  await server.close();
}
```

> **Pitfall: never call `agent-browser` with a synchronous spawn from the
> same process that's running the fixture's own server.** `spawnSync`
> blocks that process's one thread entirely, so an in-process HTTP server
> can never answer the browser's request while the sync call sits there
> waiting for the browser to finish — a one-process deadlock (confirmed the
> hard way: the exact same server answered `curl` and a standalone
> `agent-browser` call fine on their own, and only hung once both ran in one
> `spawnSync`-driven process). This does *not* apply to `recorder.ts`'s own
> (synchronous) agent-browser calls against `ttyd` — ttyd is a separate OS
> process there, so blocking this thread never stops it answering. The rule
> is specific to a server living in the **same process and event loop** as
> the agent-browser call, which is exactly the fixture-server case above;
> `agentBrowserSession`/`spawnCapture` already use async `spawn` for this
> reason, so you get the safe behavior for free by using them rather than
> shelling out yourself.

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
