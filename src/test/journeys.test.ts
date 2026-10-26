/**
 * `core/journeys.ts` (#159, ticket B / #174): every expectation against real
 * shell commands, merged stdout/stderr order, the automatic no-crash check,
 * "couldn't run" as CAN'T TELL, file validation, and the non-negotiables merge.
 */
import "./hermetic_git.js"; // house rule for any test that spawns processes in a repo context
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { JourneySpecSchema, loadJourneysFile, mergeJourneys, runJourney, runJourneys, type JourneySpec } from "../core/journeys.js";

const spec = (over: Record<string, unknown>): JourneySpec => v.parse(JourneySpecSchema, { id: "P01", criterion: "c", run: "true", expect: { exit: 0 }, ...over });
const cwd = tmpdir();
const byName = (checks: { name: string; pass: boolean }[]) => Object.fromEntries(checks.map((c) => [c.name, c.pass]));

test("exit / exit_nonzero / output_contains / output_not_contains / max_lines all become checks", async () => {
  const run = await runJourney(
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

test("output is stdout and stderr merged IN ORDER, as a terminal shows it — the first line can come from stderr", async () => {
  const run = await runJourney(spec({ run: "echo 'unknown chain: x' 1>&2; echo 'usage: …'", expect: { first_line_matches: "^unknown chain" } }), { cwd });
  assert.equal(byName(run.checks)["first line matches /^unknown chain/"], true);
  assert.match(run.output, /^unknown chain: x\nusage/);
});

test("an uncaught stack trace fails the automatic no-crash check; an expected error message does not; allow_crash turns it off", async () => {
  const crash = "node -e 'throw new Error(\"boom\")'";
  const crashed = await runJourney(spec({ run: crash, expect: { exit_nonzero: true } }), { cwd });
  assert.equal(byName(crashed.checks)["no crash in output"], false);

  const clean = await runJourney(spec({ run: "echo 'error: unknown chain' >&2; exit 1", expect: { exit_nonzero: true } }), { cwd });
  assert.equal(byName(clean.checks)["no crash in output"], true);

  const allowed = await runJourney(spec({ run: crash, expect: { exit_nonzero: true }, allow_crash: true }), { cwd });
  assert.equal(byName(allowed.checks)["no crash in output"], undefined);
});

test("a command that could not run is CAN'T TELL with no checks — a missing binary can never satisfy exit_nonzero", async () => {
  const run = await runJourney(spec({ run: "piquette-definitely-not-installed-xyz probe", expect: { exit_nonzero: true } }), { cwd });
  assert.deepEqual(run.checks, []);
  assert.match(run.cantTell[0], /could not run \(exit 127/);
});

test("a timeout is CAN'T TELL", async () => {
  const run = await runJourney(spec({ run: "sleep 5", timeout_ms: 200 }), { cwd });
  assert.match(run.cantTell[0], /timed out after 200ms/);
});

test("runJourneys counts coverage by kind", async () => {
  const out = await runJourneys([spec({ id: "a" }), spec({ id: "b", kind: "unhappy" }), spec({ id: "c", kind: "unhappy" })], { cwd });
  assert.deepEqual(out.coverage, { happy: 1, unhappy: 2, non_negotiable: 0 });
  assert.equal(out.checks.length, 6);
});

test("JourneySpecSchema refuses a journey with no expectations, or exit together with exit_nonzero", () => {
  assert.equal(v.safeParse(JourneySpecSchema, { id: "a", criterion: "c", run: "true", expect: {} }).success, false);
  assert.equal(v.safeParse(JourneySpecSchema, { id: "a", criterion: "c", run: "true", expect: { exit: 0, exit_nonzero: true } }).success, false);
  assert.equal(v.safeParse(JourneySpecSchema, { id: "a b", criterion: "c", run: "true", expect: { exit: 0 } }).success, false);
});

test("loadJourneysFile names the file and every problem; forceKind marks non-negotiables", () => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-journeys-file-test-"));
  try {
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "journeys:\n  - id: P01\n    run: true\n    expect: {}\n  - id: P01\n    criterion: c\n    run: 'true'\n    expect: { exit: 0 }\n");
    assert.throws(() => loadJourneysFile(bad), (e: Error) => e.message.includes(bad) && /criterion/.test(e.message) && /at least one expectation/.test(e.message));

    const dup = join(dir, "dup.yaml");
    writeFileSync(dup, "journeys:\n  - { id: P01, criterion: c, run: 'true', expect: { exit: 0 } }\n  - { id: P01, criterion: c, run: 'true', expect: { exit: 0 } }\n");
    assert.throws(() => loadJourneysFile(dup), /unique/);

    const nn = join(dir, "nn.yaml");
    writeFileSync(nn, "journeys:\n  - { id: help, criterion: 'piquette --help works', run: 'true', expect: { exit: 0 } }\n");
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

test("a journey command never sees the `piquette sync` credentials (#33), even when the caller passes no env", async () => {
  const saved = [process.env.PIQUETTE_SYNC_CLIENT_ID, process.env.PIQUETTE_SYNC_CLIENT_SECRET];
  process.env.PIQUETTE_SYNC_CLIENT_ID = "journey-env-id-0123456789";
  process.env.PIQUETTE_SYNC_CLIENT_SECRET = "journey-env-secret-0123456789";
  try {
    const run = await runJourney(spec({ run: 'echo "id=[$PIQUETTE_SYNC_CLIENT_ID] secret=[$PIQUETTE_SYNC_CLIENT_SECRET] path=[${PATH:+set}] leaked=$(env | grep -c journey-env)"', expect: { exit: 0 } }), { cwd });
    assert.ok(run.output.includes("id=[] secret=[] path=[set] leaked=0"), run.output);
  } finally {
    for (const [i, name] of ["PIQUETTE_SYNC_CLIENT_ID", "PIQUETTE_SYNC_CLIENT_SECRET"].entries()) {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    }
  }
});

test("PIQUETTE_EVIDENCE_DIR is set, exists, empty and per journey when there is an evidenceRoot (#235)", async () => {
  const root = mkdtempSync(join(tmpdir(), "piquette-evroot-"));
  try {
    const run = (id: string) => runJourney(spec({ id, run: 'test -d "$PIQUETTE_EVIDENCE_DIR" && [ -z "$(ls -A "$PIQUETTE_EVIDENCE_DIR")" ] && echo "dir=$PIQUETTE_EVIDENCE_DIR"' }), { cwd, evidenceRoot: root });
    const a = await run("P01");
    const b = await run("P02");
    assert.equal(a.evidenceDir, join(root, "P01"));
    assert.equal(b.evidenceDir, join(root, "P02"));
    assert.match(a.output, /dir=.*P01/);
    assert.match(b.output, /dir=.*P02/);
    assert.ok(existsSync(join(root, "P01")));
    assert.deepEqual(readdirSync(join(root, "P01")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PIQUETTE_EVIDENCE_DIR is unset without an evidenceRoot, even when process.env and the passed env have it (#235)", async () => {
  process.env.PIQUETTE_EVIDENCE_DIR = "/outer";
  try {
    const viaDefault = await runJourney(spec({ run: 'echo "[${PIQUETTE_EVIDENCE_DIR-unset}]"' }), { cwd });
    assert.match(viaDefault.output, /\[unset\]/);
    const viaEnv = await runJourney(spec({ run: 'echo "[${PIQUETTE_EVIDENCE_DIR-unset}]"' }), { cwd, env: { ...process.env, PATH: process.env.PATH } });
    assert.match(viaEnv.output, /\[unset\]/);
    assert.equal(viaEnv.evidenceDir, null);
  } finally {
    delete process.env.PIQUETTE_EVIDENCE_DIR;
  }
});

test("the run is captured once with its timing and exit code (#238) — what the recorder plays back", async () => {
  const run = await runJourney(spec({ run: "printf 'first\\n'; sleep 0.4; echo second >&2; exit 4", expect: { exit: 4 } }), { cwd });
  assert.equal(run.exit, 4);
  assert.equal(run.transcript.map((c) => c.text).join(""), "first\nsecond\n");
  assert.equal(run.output, "first\nsecond\n");
  const first = run.transcript.find((c) => c.text.includes("first"))!;
  const second = run.transcript.find((c) => c.text.includes("second"))!;
  assert.ok(second.t - first.t >= 300, `the pause between the two lines is kept (${first.t} → ${second.t})`);
  assert.ok(run.ms >= second.t);
});

test("a background child's later output is kept, as with spawnSync: the run waits for the pipe to close", async () => {
  const run = await runJourney(spec({ run: "(sleep 1.5; echo late) & echo early", expect: { output_contains: ["late"] } }), { cwd });
  assert.equal(run.cantTell.length, 0);
  assert.equal(run.output, "early\nlate\n");
});

test("a backgrounded process that holds the pipe is CAN'T TELL on timeout and does not outlive the journey", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piquette-bg-"));
  const pidfile = join(dir, "pid");
  try {
    const run = await runJourney(spec({ run: `sleep 30 & echo $! > ${JSON.stringify(pidfile)}; echo started`, timeout_ms: 600 }), { cwd });
    assert.match(run.cantTell[0], /timed out after 600ms/);
    const pid = Number(readFileSync(pidfile, "utf-8").trim());
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "the backgrounded sleep was killed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a grandchild that left the process group and holds the pipe cannot hang the journey: timeout still resolves", async () => {
  const started = Date.now();
  const run = await runJourney(
    spec({ run: `python3 -c 'import os,time; os.setsid(); time.sleep(20)' & echo hi`, timeout_ms: 500 }),
    { cwd },
  );
  assert.match(run.cantTell[0], /timed out after 500ms/);
  assert.match(run.output, /hi/);
  assert.ok(Date.now() - started < 5000, "resolved within the grace window, not when the grandchild exits");
});

test("the output cap also resolves when a setsid'd grandchild holds the pipe", async () => {
  const started = Date.now();
  const run = await runJourney(
    spec({ run: `python3 -c 'import os,time; os.setsid(); time.sleep(20)' & head -c 100000000 /dev/zero | tr '\\0' x`, timeout_ms: 15000 }),
    { cwd },
  );
  assert.match(run.cantTell[0], /could not run/);
  assert.ok(Date.now() - started < 8000);
});
