/**
 * Journeys (#159, ticket B / #174): what a proof drives, and the checks each
 * one produces. Console journeys only for now — one shell command per
 * journey, judged on its exit code and on its output as a person would see
 * it in a terminal (stdout and stderr merged, in order).
 *
 * Three kinds, from the Vercel lessons the design doc builds on:
 *
 *  - `happy`: the path the change was built for.
 *  - `unhappy`: the paths a builder never thinks to try — bad input, a wrong
 *    name, a repeat, a missing argument. An agent tests its own work the way
 *    it built it, so a proof with only happy journeys is the agent grading
 *    itself. Ticket C's gate requires at least one per leaf.
 *  - `non_negotiable`: the repo's must-not-trade-off rules, each one with a
 *    check. They live in one repo-level file and are merged into EVERY
 *    proof, whatever the ticket; a failing one fails the receipt.
 *
 * Every journey also gets an automatic "no crash" check (an uncaught stack
 * trace in the output), the console form of "error-free sessions": an
 * expected error message is fine, a crash never is. A journey that expects
 * a crash can turn it off with `allow_crash: true`.
 *
 * A command that could not run at all (exit 126/127, a spawn error, a
 * timeout) is CAN'T TELL, never a check result — otherwise a missing binary
 * would satisfy "exits non-zero". So 126/127 are reserved: an unhappy
 * journey must fail INSIDE the program under test (a bad argument, a wrong
 * name), not by running something that doesn't exist.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";
import type { Check, Journey } from "./receipt.ts";
import { operatorEnv } from "./utils.ts";

export const JOURNEY_KINDS = ["happy", "unhappy", "non_negotiable"] as const;
export type JourneyKind = (typeof JOURNEY_KINDS)[number];

const DEFAULT_TIMEOUT_MS = 60_000;
/** Output kept per journey for the receipt — enough to read, bounded so a runaway log can't swamp it. */
const OUTPUT_TAIL_CHARS = 2_000;
/** A journey that prints more than this is stopped and CAN'T TELL. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export const ExpectSchema = v.pipe(
  v.object({
    exit: v.optional(v.pipe(v.number(), v.integer())),
    exit_nonzero: v.optional(v.literal(true)),
    output_contains: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
    output_not_contains: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
    /** A regular expression the first non-empty output line must match. */
    first_line_matches: v.optional(v.pipe(v.string(), v.minLength(1))),
    max_lines: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  }),
  v.check((e) => !(e.exit !== undefined && e.exit_nonzero), "expect: use exit OR exit_nonzero, not both"),
  v.check(
    (e) => Object.values(e).some((x) => x !== undefined),
    "expect: needs at least one expectation (exit, exit_nonzero, output_contains, output_not_contains, first_line_matches, max_lines)",
  ),
);
export type Expect = v.InferOutput<typeof ExpectSchema>;

export const JourneySpecSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/, "journey id: letters, digits, _ and - only")),
  /** The acceptance criterion (or non-negotiable rule) this journey proves, in words. */
  criterion: v.pipe(v.string(), v.minLength(1)),
  kind: v.optional(v.picklist(JOURNEY_KINDS), "happy"),
  run: v.pipe(v.string(), v.minLength(1)),
  expect: ExpectSchema,
  allow_crash: v.optional(v.boolean(), false),
  timeout_ms: v.optional(v.pipe(v.number(), v.integer(), v.minValue(100)), DEFAULT_TIMEOUT_MS),
});
export type JourneySpec = v.InferOutput<typeof JourneySpecSchema>;

export const JourneysFileSchema = v.pipe(
  v.object({
    journeys: v.pipe(v.array(JourneySpecSchema), v.minLength(1, "a journeys file needs at least one journey")),
  }),
  v.check((f) => new Set(f.journeys.map((j) => j.id)).size === f.journeys.length, "journey ids must be unique"),
);
export type JourneysFile = v.InferOutput<typeof JourneysFileSchema>;

/** Parse a journeys file; errors name the file and every problem, never a bare valibot dump. */
export function loadJourneysFile(file: string, forceKind?: JourneyKind): JourneySpec[] {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf-8"));
  } catch (error) {
    throw new Error(`journeys file ${file}: ${(error as Error).message}`);
  }
  const parsed = v.safeParse(JourneysFileSchema, raw);
  if (!parsed.success) {
    const problems = parsed.issues.map((i) => {
      const where = i.path?.map((p) => p.key).join(".");
      return where ? `${where}: ${i.message}` : i.message;
    });
    throw new Error(`journeys file ${file} is invalid:\n- ${problems.join("\n- ")}`);
  }
  return parsed.output.journeys.map((j) => (forceKind ? { ...j, kind: forceKind } : j));
}

/** Non-negotiables are merged into every proof; their ids are namespaced so they can't collide with a ticket's. */
export function mergeJourneys(ticket: JourneySpec[], nonNegotiables: JourneySpec[]): JourneySpec[] {
  const nn = nonNegotiables.map((j) => ({ ...j, kind: "non_negotiable" as const, id: j.id.startsWith("NN-") ? j.id : `NN-${j.id}` }));
  const ids = new Set(ticket.map((j) => j.id));
  for (const j of nn) {
    if (ids.has(j.id)) throw new Error(`journey id ${j.id} is used by both the ticket and the non-negotiables`);
  }
  return [...ticket, ...nn];
}

// ── running ─────────────────────────────────────────────────────────────────

/** An uncaught JS stack frame, a Python traceback, or Node's unhandled-rejection banner. */
const CRASH = /^\s+at .+[:(]\d+:\d+\)?$|^Traceback \(most recent call last\):|UnhandledPromiseRejection|^panic: /m;

export interface JourneyRun {
  spec: JourneySpec;
  journey: Journey;
  checks: Check[];
  /** Why this journey couldn't be observed at all; empty when it ran. */
  cantTell: string[];
  output: string;
  ms: number;
  /** The directory this journey got as `$PIQUETTE_EVIDENCE_DIR` (#235); null when the proof gave it none. */
  evidenceDir: string | null;
  /** The whole merged output as it arrived, with when (#238): the recorder renders the video from this, never by running the command again. */
  transcript: OutputChunk[];
  /** The command's exit code; null when it never exited on its own (timeout, signal, spawn error). */
  exit: number | null;
}

export interface OutputChunk {
  /** Milliseconds since the command started. */
  t: number;
  text: string;
}

interface Captured {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
  chunks: OutputChunk[];
  ms: number;
}

/**
 * Run a bash script once, keeping every stdout chunk with its arrival time.
 * The script merges stderr into stdout itself, so one stream is the order a
 * terminal would show. Like spawnSync, it waits for the pipe to close, so a
 * background child's later output is kept and a `server &` that never lets go
 * runs into the timeout (CAN'T TELL). Timeout and output cap are an error, no
 * status; the shell runs in its own process group and the whole group is
 * killed then, so nothing outlives a journey that was cut off.
 */
const KILL_GRACE_MS = 500;

function capture(script: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<Captured> {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks: OutputChunk[] = [];
    const decoder = new StringDecoder("utf8");
    let bytes = 0;
    let error: NodeJS.ErrnoException | undefined;
    let exited: { status: number | null; signal: NodeJS.Signals | null } | undefined;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const rest = decoder.end();
      if (rest) chunks.push({ t: Date.now() - started, text: rest });
      child.stdout?.destroy();
      resolve({ status: error ? null : (exited?.status ?? null), signal: exited?.signal ?? null, error, chunks, ms: Date.now() - started });
    };
    const fail = (e: NodeJS.ErrnoException) => {
      error ??= e;
      killGroup();
      // a descendant that left the group (setsid, double-fork) can still hold the pipe, so 'close' may never come: bound the wait
      setTimeout(finish, KILL_GRACE_MS);
    };
    const child = spawn("bash", ["-c", script], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "ignore"], detached: true });
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL"); // group already gone
      }
    };
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > MAX_OUTPUT_BYTES) return fail(Object.assign(new Error(`output over ${MAX_OUTPUT_BYTES} bytes`), { code: "ENOBUFS" }));
      const text = decoder.write(data);
      if (text) chunks.push({ t: Date.now() - started, text });
    });
    child.on("error", (e) => {
      error ??= e;
      finish();
    });
    child.on("exit", (status, signal) => {
      exited = { status, signal };
    });
    child.on("close", finish);
    timer = setTimeout(() => fail(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), options.timeoutMs);
  });
}

export interface RunJourneysOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** When set, each journey gets `<evidenceRoot>/<id>` (new, empty) as `$PIQUETTE_EVIDENCE_DIR` (#235). */
  evidenceRoot?: string;
}

/** The lines a person sees: leading/trailing blank lines dropped, blank lines in between kept (they take screen space too). */
function outputLines(output: string): string[] {
  const trimmed = output.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  return trimmed === "" ? [] : trimmed.split("\n");
}

export async function runJourney(spec: JourneySpec, options: RunJourneysOptions): Promise<JourneyRun> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? operatorEnv()) };
  let evidenceDir: string | null = null;
  if (options.evidenceRoot) {
    evidenceDir = path.join(options.evidenceRoot, spec.id);
    try {
      mkdirSync(evidenceDir);
    } catch (error) {
      // ids differing only by case collide on a case-insensitive filesystem (macOS APFS): take a unique sibling instead
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      evidenceDir = mkdtempSync(path.join(options.evidenceRoot, `${spec.id.toLowerCase()}-`));
    }
    env.PIQUETTE_EVIDENCE_DIR = evidenceDir;
  } else {
    delete env.PIQUETTE_EVIDENCE_DIR; // an outer value (piquette running inside a journey) never leaks in
  }
  // `{ …; } 2>&1` merges stderr into stdout IN ORDER, as a terminal shows it, and keeps the command's own exit code.
  // never bare process.env: a journey command is planner-authored, and must not inherit the `piquette sync` credentials (#33)
  const result = await capture(`{ ${spec.run}\n} 2>&1`, { cwd: options.cwd, env, timeoutMs: spec.timeout_ms });
  const ms = result.ms;
  const output = result.chunks.map((c) => c.text).join("");
  const run: JourneyRun = {
    spec,
    journey: { id: spec.id, criterion: spec.criterion, steps: [{ name: spec.run, ms, exit: result.status }] },
    checks: [],
    cantTell: [],
    output: output.length > OUTPUT_TAIL_CHARS ? `…${output.slice(-OUTPUT_TAIL_CHARS)}` : output,
    ms,
    evidenceDir,
    transcript: result.chunks,
    exit: result.status,
  };

  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    run.cantTell.push(timedOut ? `${spec.id}: timed out after ${spec.timeout_ms}ms` : `${spec.id}: could not run: ${result.error.message}`);
    return run;
  }
  if (result.status === 126 || result.status === 127) {
    run.cantTell.push(`${spec.id}: \`${spec.run}\` could not run (exit ${result.status}: ${output.trim().split("\n")[0] || "command not found"})`);
    return run;
  }
  if (result.status === null) {
    run.cantTell.push(`${spec.id}: killed by signal ${result.signal}`);
    return run;
  }

  const check = (name: string, actual: unknown, expected: unknown, pass: boolean, hint?: string) =>
    run.checks.push({ journey: spec.id, name, expected, actual, pass, ...(hint && !pass ? { hint: `${spec.id}: ${hint}` } : {}) });
  const e = spec.expect;
  const lines = outputLines(output);

  if (e.exit !== undefined) check("exit code", result.status, e.exit, result.status === e.exit, `\`${spec.run}\` exited ${result.status}, expected ${e.exit}`);
  if (e.exit_nonzero) check("exits non-zero", result.status, "non-zero", result.status !== 0, `\`${spec.run}\` exited 0 but should fail`);
  for (const s of e.output_contains ?? []) {
    check(`output contains ${JSON.stringify(s)}`, output.includes(s), true, output.includes(s), `output is missing ${JSON.stringify(s)}`);
  }
  for (const s of e.output_not_contains ?? []) {
    check(`output does not contain ${JSON.stringify(s)}`, output.includes(s), false, !output.includes(s), `output must not contain ${JSON.stringify(s)}`);
  }
  if (e.first_line_matches !== undefined) {
    const first = lines.find((l) => l.trim() !== "") ?? "";
    let ok = false;
    try {
      ok = new RegExp(e.first_line_matches).test(first);
    } catch (error) {
      run.cantTell.push(`${spec.id}: first_line_matches is not a valid regular expression: ${(error as Error).message}`);
    }
    check(`first line matches /${e.first_line_matches}/`, first, `/${e.first_line_matches}/`, ok, `the first line was ${JSON.stringify(first)}`);
  }
  if (e.max_lines !== undefined) {
    check(`at most ${e.max_lines} lines`, lines.length, `<= ${e.max_lines}`, lines.length <= e.max_lines, `printed ${lines.length} lines, at most ${e.max_lines} allowed`);
  }
  if (!spec.allow_crash) {
    const crash = output.match(CRASH);
    check("no crash in output", crash ? crash[0].trim() : null, null, !crash, `crashed instead of failing cleanly: ${crash?.[0].trim()}`);
  }
  return run;
}

export interface JourneysOutcome {
  runs: JourneyRun[];
  journeys: Journey[];
  checks: Check[];
  cantTell: string[];
  /** Counts by kind, recorded on the receipt so a gate can see whether unhappy paths were tried at all. */
  coverage: Record<JourneyKind, number>;
}

/** One after another, never in parallel: journeys share the repo, and each one's output timing is its own. */
export async function runJourneys(specs: JourneySpec[], options: RunJourneysOptions): Promise<JourneysOutcome> {
  const runs: JourneyRun[] = [];
  for (const s of specs) runs.push(await runJourney(s, options));
  const coverage = { happy: 0, unhappy: 0, non_negotiable: 0 } as Record<JourneyKind, number>;
  for (const s of specs) coverage[s.kind]++;
  return {
    runs,
    journeys: runs.map((r) => r.journey),
    checks: runs.flatMap((r) => r.checks),
    cantTell: runs.flatMap((r) => r.cantTell),
    coverage,
  };
}
