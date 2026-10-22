/**
 * `core/journeys.ts` (#159, ticket B / #174): every expectation against real
 * shell commands, merged stdout/stderr order, the automatic no-crash check,
 * "couldn't run" as CAN'T TELL, file validation, and the non-negotiables merge.
 */
import "./hermetic_git.js"; // house rule for any test that spawns processes in a repo context
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { JourneySpecSchema, loadJourneysFile, mergeJourneys, runJourney, runJourneys, type JourneySpec } from "../core/journeys.js";

const spec = (over: Record<string, unknown>): JourneySpec => v.parse(JourneySpecSchema, { id: "P01", criterion: "c", run: "true", expect: { exit: 0 }, ...over });
const cwd = tmpdir();
const byName = (checks: { name: string; pass: boolean }[]) => Object.fromEntries(checks.map((c) => [c.name, c.pass]));

test("exit / exit_nonzero / output_contains / output_not_contains / max_lines all become checks", () => {
  const run = runJourney(
    spec({
      run: "printf 'hello\\nworld\\n'; exit 3",
      expect: { exit_nonzero: true, output_contains: ["hello", "nope"], output_not_contains: ["world"], max_lines: 1 },
    }),
    { cwd },
  );
  assert.deepEqual(run.cantTell, []);
  assert.deepEqual(byName(run.checks), {
    "exits non-zero": true,
    'output contains "hello"': true,
    'output contains "nope"': false,
    'output does not contain "world"': false,
    "at most 1 lines": false,
    "no crash in output": true,
  });
  assert.equal(run.journey.steps[0].exit, 3);
  assert.ok(run.checks.find((c) => c.name === "at most 1 lines")?.hint?.includes("printed 2 lines"));
});

test("output is stdout and stderr merged IN ORDER, as a terminal shows it — the first line can come from stderr", () => {
  const run = runJourney(spec({ run: "echo 'unknown chain: x' 1>&2; echo 'usage: …'", expect: { first_line_matches: "^unknown chain" } }), { cwd });
  assert.equal(byName(run.checks)["first line matches /^unknown chain/"], true);
  assert.match(run.output, /^unknown chain: x\nusage/);
});

test("an uncaught stack trace fails the automatic no-crash check; an expected error message does not; allow_crash turns it off", () => {
  const crash = "node -e 'throw new Error(\"boom\")'";
  const crashed = runJourney(spec({ run: crash, expect: { exit_nonzero: true } }), { cwd });
  assert.equal(byName(crashed.checks)["no crash in output"], false);

  const clean = runJourney(spec({ run: "echo 'error: unknown chain' >&2; exit 1", expect: { exit_nonzero: true } }), { cwd });
  assert.equal(byName(clean.checks)["no crash in output"], true);

  const allowed = runJourney(spec({ run: crash, expect: { exit_nonzero: true }, allow_crash: true }), { cwd });
  assert.equal(byName(allowed.checks)["no crash in output"], undefined);
});

test("a command that could not run is CAN'T TELL with no checks — a missing binary can never satisfy exit_nonzero", () => {
  const run = runJourney(spec({ run: "spf-definitely-not-installed-xyz probe", expect: { exit_nonzero: true } }), { cwd });
  assert.deepEqual(run.checks, []);
  assert.match(run.cantTell[0], /could not run \(exit 127/);
});

test("a timeout is CAN'T TELL", () => {
  const run = runJourney(spec({ run: "sleep 5", timeout_ms: 200 }), { cwd });
  assert.match(run.cantTell[0], /timed out after 200ms/);
});

test("runJourneys counts coverage by kind", () => {
  const out = runJourneys([spec({ id: "a" }), spec({ id: "b", kind: "unhappy" }), spec({ id: "c", kind: "unhappy" })], { cwd });
  assert.deepEqual(out.coverage, { happy: 1, unhappy: 2, non_negotiable: 0 });
  assert.equal(out.checks.length, 6);
});

test("JourneySpecSchema refuses a journey with no expectations, or exit together with exit_nonzero", () => {
  assert.equal(v.safeParse(JourneySpecSchema, { id: "a", criterion: "c", run: "true", expect: {} }).success, false);
  assert.equal(v.safeParse(JourneySpecSchema, { id: "a", criterion: "c", run: "true", expect: { exit: 0, exit_nonzero: true } }).success, false);
  assert.equal(v.safeParse(JourneySpecSchema, { id: "a b", criterion: "c", run: "true", expect: { exit: 0 } }).success, false);
});

test("loadJourneysFile names the file and every problem; forceKind marks non-negotiables", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-journeys-file-test-"));
  try {
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "journeys:\n  - id: P01\n    run: true\n    expect: {}\n  - id: P01\n    criterion: c\n    run: 'true'\n    expect: { exit: 0 }\n");
    assert.throws(() => loadJourneysFile(bad), (e: Error) => e.message.includes(bad) && /criterion/.test(e.message) && /at least one expectation/.test(e.message));

    const dup = join(dir, "dup.yaml");
    writeFileSync(dup, "journeys:\n  - { id: P01, criterion: c, run: 'true', expect: { exit: 0 } }\n  - { id: P01, criterion: c, run: 'true', expect: { exit: 0 } }\n");
    assert.throws(() => loadJourneysFile(dup), /unique/);

    const nn = join(dir, "nn.yaml");
    writeFileSync(nn, "journeys:\n  - { id: help, criterion: 'spf --help works', run: 'true', expect: { exit: 0 } }\n");
    assert.equal(loadJourneysFile(nn, "non_negotiable")[0].kind, "non_negotiable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeJourneys namespaces non-negotiables as NN-<id> and refuses a collision", () => {
  const merged = mergeJourneys([spec({ id: "P01" })], [spec({ id: "help" })]);
  assert.deepEqual(merged.map((j) => [j.id, j.kind]), [["P01", "happy"], ["NN-help", "non_negotiable"]]);
  assert.throws(() => mergeJourneys([spec({ id: "NN-help" })], [spec({ id: "help" })]), /used by both/);
});
