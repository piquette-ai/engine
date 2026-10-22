## Verification: write the journeys that will prove this work

This repo verifies work with receipts: before anything is committed, `spf prove` runs your journeys against the code — once on the code as it is now (they must FAIL), and once after the build (they must PASS) — and records a video of it. Your journeys are the definition of done for this work, so write them before anyone builds anything.

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
- **At least one `kind: unhappy` journey.** The builder will only try the path it built. Add the wrong-way checks a real person would hit: bad input, a wrong name, a missing argument, doing it twice. An unhappy journey must fail *inside* the program (exit 126/127 — "command not found" — is treated as "couldn't tell", never as a pass).
- **Red before green.** For what this work adds or fixes, the journey must FAIL on the code as it is now. If a journey would already pass today, it is not proving this work — sharpen it.
- **Repeatable and safe.** Each command must give the same result when run twice and must not touch real services, real data, or secrets; the run is recorded on video.
- **Don't repeat the repo's non-negotiables.** Rules every change must keep (in `.spf/verify/non-negotiables.yaml`) are added to every proof automatically.
- **Use the commands this repo actually has.** Check the README, package scripts or `--help` output before you write a command; a journey that can't run proves nothing.
