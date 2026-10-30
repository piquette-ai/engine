## Verification: write the journeys that will prove this work

This repo verifies work with receipts: before anything is committed, `piquette prove` runs your journeys against the code — once on the code as it is now (they must FAIL), and once after the build (they must PASS) — and records a video of it. Your journeys are the definition of done for this work, so write them before anyone builds anything.

Write them to `{{context_handoff_dir}}/journeys.yaml` and add that path to `artifacts` in your Report.

```yaml
journeys:
  - id: P01                          # letters, digits, _ and - only; unique
    kind: happy                      # happy (default) | unhappy
    criterion: "<the acceptance criterion this proves, in the ticket's words>"
    run: <one shell command, run from the repo root>
    expect:                          # at least one of these
      exit: 0                        # or  exit_nonzero: true
      output_contains: ["<text a person would see>"]
      output_not_contains: ["<text that must not appear>"]
      first_line_matches: "<regular expression>"
      max_lines: 10
```

Rules:

- **One journey per acceptance criterion at least.** Start from the ticket's `Observable check:` lines; each one becomes a journey. A bug's `Repro today:` line becomes the journey that shows the bug.
- **Observable from outside.** A journey runs what a user, operator or API caller runs — the CLI, a request, a script — and checks what they would see: the exit code and the output (stdout and stderr together, as a terminal shows them). Never a unit test run, never "the tests pass": the repo's test suite is checked separately.
- **UI-shaped work needs a UI-capable check, not a stand-in for one.** When what this ticket actually changes is what a person sees or does with a page — a visual state, an element's behavior on click/focus/load, layout, an animation, a rendered attribute like `aria-*`/`class`/style — a journey that only greps served source or a rendered-HTML string proves the code shipped, never that it works. Before writing one of those, look for a proof script this repo already has that can verify it for real: `scripts/proof/` (or wherever this repo's non-negotiables point), package scripts, and this repo's own prompt/config notes, for a browser-automation convention (agent-browser, Playwright, Cypress, or similar) whose exit code and output you can judge directly. Prefer that script's command as the journey's `run:` over a text-match substitute — proof scripts are usually protected files an agent cannot write, so this is about finding and using one, never authoring one. If this repo has no such script yet, say so plainly in your plan instead of silently writing a weaker check in its place.
- **At least one `kind: unhappy` journey.** The builder will only try the path it built. Add the wrong-way checks a real person would hit: bad input, a wrong name, a missing argument, doing it twice. An unhappy journey must fail *inside* the program (exit 126/127 — "command not found" — is treated as "couldn't tell", never as a pass).
- **Red before green.** For what this work adds or fixes, the journey must FAIL on the code as it is now. If a journey would already pass today, it is not proving this work — sharpen it.
- **Repeatable and safe.** Each command must give the same result when run twice and must not touch real services, real data, or secrets; the run is recorded on video.
- **UI evidence (optional).** Each journey runs with `$PIQUETTE_EVIDENCE_DIR`, an empty directory of its own. A journey may write recordings or screenshots of the real UI there (mp4/webm/mov, png/jpg/gif, txt/json/log), using whatever scripts this repo already has (e.g. a browser or simulator capture script). Evidence never decides pass or fail, but the capture runs inside the journey command, so its exit code, output and run time are all seen by the checks. Keep it out of the way: put it BEFORE the command whose result you check, never last, and write it exactly as `[ -n "$PIQUETTE_EVIDENCE_DIR" ] && { <capture> "$PIQUETTE_EVIDENCE_DIR/screen.mp4"; } >/dev/null 2>&1 || true`. The variable can be unset (a run without evidence collection), so the guard is required (never `${PIQUETTE_EVIDENCE_DIR:-.}`, which would write into the repo). Keep captures short, well inside the journey's `timeout_ms`, and never capture secrets or logged-in pages: evidence is uploaded and linked from the PR. When a journey records its own video, the terminal video is skipped.
- **Don't repeat the repo's non-negotiables.** Rules every change must keep (in `.piquette/verify/non-negotiables.yaml`) are added to every proof automatically.
- **Use the commands this repo actually has.** Check the README, package scripts or `--help` output before you write a command; a journey that can't run proves nothing.
