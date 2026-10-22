/**
 * Decision-layer `diff_risk`: ONE batched decision call over the finished diff,
 * run in `simple_sdlc` after the suite is green and the review approved but
 * BEFORE the signoff/commit, whose only possible effect is to ADD a
 * `require_human_signoff` and risk labels. The pure half (floor, clipping,
 * action table) is `core/diff_risk.ts`; read its header for the additive-only
 * argument. This module owns the git read, the decision call and the trace.
 *
 * OFF IS A TOTAL NO-OP: `resolveDiffRisk` returns `null` unless
 * `decisions.enabled` and the kind's mode is not `off`. Then `simple_sdlc` runs
 * no phase, reads no diff, parses no extras, calls no model and records
 * nothing. That includes the code-owned floor: with no `decisions:` block the
 * floor does NOT run either, so an existing run never gains a signoff
 * requirement it did not have.
 *
 * SHADOW vs ACT: both run the floor and ask the model, and both record the
 * decisions and one `decision_diff_risk` event. Only act applies the flags
 * (`outcome.applied`); shadow records what act WOULD have done. In act, a
 * failing, timing-out or unsure model leaves exactly the floor's flags.
 *
 * WHERE THE FLAGS GO: into `decideSignoff`'s `requireHumanSignoff` (via
 * `mergeSignoff`, an OR with `review.require_human_signoff`) and the signoff
 * phase's log, plus the `decision_diff_risk` event. Attended, a human is asked
 * anyway; unattended, the existing fail-closed branch applies. The labels are
 * recorded, not pushed to a code host: `CodeHostProvider` has no PR-label call
 * today, and adding one across three hosts is a separate change.
 *
 * READING THE DIFF: this module reads git itself (NUL-separated, `core.quotePath=false`
 * so non-ASCII paths are real paths, a large `maxBuffer`, a per-file retry when the
 * whole diff is too big) rather than through `run.git.diffText`, whose 1 MiB buffer
 * made any large diff throw. The path floor needs only the file lists, so it runs
 * even when no diff text can be read. A file too large to scan is listed in
 * `unscanned` (path still checked, trace and state say so). If git cannot be read at
 * all the outcome is `unreadable` and, in act mode, FAILS CLOSED: it requires human
 * signoff with that reason. It never fails open, and it never fails the run itself.
 * A trace-write failure is warned about once and ignored, like `decision` rows.
 */
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { makeEventRecord } from "../core/data_types.ts";
import { parseDecisionExtras, type Decision, type DecisionBatchItem, type Decider } from "../core/decisions.ts";
import { DIFF_RISK_KEYS, DIFF_RISK_KIND } from "../core/decision_kinds.ts";
import {
  DIFF_RISK_OPTIONS,
  buildDiffRiskState,
  diffRiskDecisionKey,
  diffRiskFloor,
  diffRiskInstructions,
  emptyFloor,
  floorChoice,
  resolveDiffRiskOutcome,
  splitDiff,
  type DiffChunk,
  type DiffRiskChoice,
  type DiffRiskInput,
  type DiffRiskKey,
  type DiffRiskOutcome,
} from "../core/diff_risk.ts";
import type { Run } from "../core/runner.ts";

/** The `log` event name for one outcome — a `log` row, not a new `EventRecordType`. */
export const DIFF_RISK_EVENT = "decision_diff_risk";

/**
 * Untracked files are absent from `git diff`; they are read so a new migration or
 * `.env` is still seen. The FLOOR scans each whole file up to the per-file cap and
 * the total budget below; only what goes into the model's state is clipped (by
 * `max_diff_chars`, in `buildDiffRiskState`). Past a cap the file is `unscanned`.
 */
export const MAX_UNTRACKED_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_UNTRACKED_TOTAL_BYTES = 64 * 1024 * 1024;
/** `git diff` of the whole tree is read with this buffer; past it, file by file with the per-file one. */
export const GIT_DIFF_MAX_BUFFER = 256 * 1024 * 1024;
export const GIT_FILE_DIFF_MAX_BUFFER = 16 * 1024 * 1024;

export interface DiffRiskSettings {
  max_diff_chars: number;
}

/**
 * This kind's settings, or `null` when it is off (`decisions.enabled: false`,
 * the default, or `decisions.kinds.diff_risk.mode: off`). While off nothing is
 * parsed. `startRun` has already validated the extras for a live kind, so the
 * parse here is the backstop for a `Run` built some other way.
 */
export function resolveDiffRisk(run: Pick<Run, "decider">): DiffRiskSettings | null {
  const decider = run.decider as Decider | undefined;
  if (!decider || decider.policy(DIFF_RISK_KIND.kind).mode === "off") return null;
  return parseDecisionExtras(decider.config, DIFF_RISK_KIND);
}

type GitRead = { ok: true; out: string } | { ok: false; tooBig: boolean; error: string };

function gitRead(cwd: string, args: string[], maxBuffer: number): GitRead {
  // quotePath=false: non-ASCII paths come back verbatim, not C-quoted; literal pathspecs: a file named `*.ts` is not a glob.
  const result = spawnSync("git", ["-c", "core.quotePath=false", "--literal-pathspecs", ...args], { cwd, encoding: "utf-8", maxBuffer });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return { ok: false, tooBig: code === "ENOBUFS", error: `git ${args.join(" ")} failed: ${result.error.message}` };
  }
  if (result.status !== 0) return { ok: false, tooBig: false, error: `git ${args.join(" ")} failed: ${(result.stderr || "").trim()}` };
  return { ok: true, out: result.stdout };
}

const nulList = (out: string): string[] => out.split("\0").filter(Boolean);

/** First bytes of a file, to sniff for NUL (binary). */
function looksBinary(abs: string, size: number): boolean {
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, 8000));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the diff of the run's work against `baseline`: tracked changes
 * (including deletions) from git, plus untracked files (the builder's new
 * files stay untracked until `commit_build`). NEVER throws: whatever cannot be
 * read is reported on the result (`unscanned` per file, `unreadable` when git
 * itself failed) so the caller can fail closed instead of skipping the floor.
 * The path lists are read first and are all the path floor needs, so they
 * survive any failure to read diff TEXT. A binary file is listed by name only.
 */
export function collectDiff(run: Pick<Run, "repo_root">, baseline: string): DiffRiskInput {
  const cwd = run.repo_root;
  const unscanned: string[] = [];
  const problems: string[] = [];

  const trackedRead = gitRead(cwd, ["diff", "--name-only", "-z", baseline], GIT_DIFF_MAX_BUFFER);
  const tracked = trackedRead.ok ? nulList(trackedRead.out) : [];
  if (!trackedRead.ok) problems.push(trackedRead.error);
  const untrackedRead = gitRead(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], GIT_DIFF_MAX_BUFFER);
  const untracked = untrackedRead.ok ? nulList(untrackedRead.out) : [];
  if (!untrackedRead.ok) problems.push(untrackedRead.error);

  let chunks: DiffChunk[] = [];
  if (trackedRead.ok) {
    const whole = gitRead(cwd, ["diff", "--no-color", "--no-ext-diff", baseline], GIT_DIFF_MAX_BUFFER);
    if (whole.ok) {
      chunks = splitDiff(whole.out);
    } else if (whole.tooBig) {
      // Too big as one: file by file, skipping only a file that is itself too big (its path was still checked).
      for (const rel of tracked) {
        const one = gitRead(cwd, ["diff", "--no-color", "--no-ext-diff", baseline, "--", rel], GIT_FILE_DIFF_MAX_BUFFER);
        if (one.ok) {
          chunks.push({ path: rel, text: one.out });
        } else if (one.tooBig) {
          unscanned.push(rel);
        } else {
          problems.push(one.error);
        }
      }
    } else {
      problems.push(whole.error);
    }
  }

  let budget = MAX_UNTRACKED_TOTAL_BYTES;
  for (const rel of untracked) {
    const abs = path.join(cwd, rel);
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > MAX_UNTRACKED_FILE_BYTES || st.size > budget) {
        unscanned.push(rel);
        continue;
      }
      if (looksBinary(abs, st.size)) {
        chunks.push({ path: rel, text: `diff --git a/${rel} b/${rel}\nBinary file` }); // by name only
        continue;
      }
      budget -= st.size;
      const text = readFileSync(abs, "utf8");
      const body = text
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n");
      chunks.push({ path: rel, text: `diff --git a/${rel} b/${rel}\nnew untracked file\n+++ b/${rel}\n${body}` });
    } catch {
      unscanned.push(rel); // vanished or unreadable: its NAME still counts, and the gap is reported
    }
  }
  return { files: [...tracked, ...untracked], chunks, unscanned, unreadable: problems.length > 0 ? problems.join("; ") : null };
}

/** Runs whose `decision_diff_risk` write already failed once — warn once per run, like `Decider.record`. */
const outcomeWriteWarned = new WeakSet<object>();

/**
 * Decide the seven risks over one shared state in ONE `decideBatch` call and
 * resolve the additive outcome. Call it from inside the `diff_risk` phase,
 * passing that phase's `ph.phase_id`, only when `resolveDiffRisk` returned
 * settings. `decideBatch` never throws for a runtime failure (every key then
 * falls back to the floor); the trace writes are advisory.
 */
export async function decideDiffRisk(
  run: Run,
  input: DiffRiskInput,
  opts: { settings: DiffRiskSettings; phase_id: string },
): Promise<DiffRiskOutcome> {
  const floor = diffRiskFloor(input);
  const { state, clipped } = buildDiffRiskState(input, opts.settings.max_diff_chars);
  const items: DecisionBatchItem<DiffRiskChoice>[] = DIFF_RISK_KEYS.map((key) => ({
    kind: DIFF_RISK_KIND.kind,
    key: diffRiskDecisionKey(key),
    options: DIFF_RISK_OPTIONS,
    fallback: floorChoice(floor, key),
    phase_id: opts.phase_id,
    instructions: diffRiskInstructions(key),
  }));
  const decisions: Decision<DiffRiskChoice>[] = await run.decider.decideBatch(state, items);
  const choices: Partial<Record<DiffRiskKey, DiffRiskChoice>> = {};
  // Only the model's ACTED answers: a decision that used the fallback (shadow, error, low confidence)
  // contributes nothing beyond the floor, so a flag's `source` never credits a model that did not act.
  DIFF_RISK_KEYS.forEach((key, i) => {
    const d = decisions[i]!;
    if (!d.used_fallback) choices[key] = d.choice;
  });
  const mode = run.decider.policy(DIFF_RISK_KIND.kind).mode;
  const outcome = resolveDiffRiskOutcome(floor, choices, { clipped, applied: mode === "act", unscanned: input.unscanned, unreadable: input.unreadable });

  await traceOutcome(run, opts.phase_id, outcome, {
    // What the model would add in act mode on top of the floor, for shadow-mode hit-rate analysis.
    model_would_add: DIFF_RISK_KEYS.filter((key, i) => {
      const d = decisions[i]!;
      return d.would_act && d.model_choice === "touches" && floor[key].length === 0;
    }),
    files: input.files.length,
  });
  return outcome;
}

/**
 * The phase could not even attempt the decision (an unexpected throw). Advisory
 * for the run, but never fail-OPEN: in act mode the outcome requires human
 * signoff with the reason, and a `decision_diff_risk` event records the degraded
 * case in either mode. Shadow applies nothing.
 */
export async function diffRiskFailure(run: Run, error: unknown, phase_id: string): Promise<DiffRiskOutcome> {
  const mode = run.decider.policy(DIFF_RISK_KIND.kind).mode;
  const outcome = resolveDiffRiskOutcome(emptyFloor(), {}, { clipped: false, applied: mode === "act", unreadable: `diff_risk could not run: ${(error as Error).message}` });
  await traceOutcome(run, phase_id, outcome, { model_would_add: [], files: 0 });
  return outcome;
}

/** Record the `decision_diff_risk` event and the console line. Advisory: a failure is warned about once. */
async function traceOutcome(run: Run, phase_id: string, outcome: DiffRiskOutcome, extra: { model_would_add: string[]; files: number }): Promise<void> {
  const mode = run.decider.policy(DIFF_RISK_KIND.kind).mode;
  try {
    await run.tracer.event(
      makeEventRecord({
        adw_id: run.adw_id,
        phase_id,
        type: "log",
        name: DIFF_RISK_EVENT,
        payload: {
          mode,
          applied: outcome.applied,
          clipped: outcome.clipped,
          require_human_signoff: outcome.require_human_signoff,
          labels: outcome.labels,
          flags: outcome.flags,
          unscanned: outcome.unscanned.slice(0, 50),
          unreadable: outcome.unreadable,
          ...extra,
        },
      }),
    );
    const degraded = outcome.unreadable !== null;
    if (outcome.flags.length > 0 || outcome.clipped || degraded || outcome.unscanned.length > 0) {
      await run.console.note(
        `decision diff_risk (${mode}): ` +
          (outcome.flags.length > 0 ? `flagged ${outcome.flags.map((f) => f.key).join(", ")}` : "nothing flagged") +
          (outcome.require_human_signoff ? (outcome.applied ? " — human signoff required" : " — shadow, nothing applied") : "") +
          (degraded ? `; the diff could not be fully read (${outcome.unreadable})${outcome.applied ? ", failing closed" : ""}` : "") +
          (outcome.unscanned.length > 0 ? `; ${outcome.unscanned.length} file(s) too large to scan (paths still checked)` : "") +
          (outcome.clipped ? "; the diff was clipped for the decision model" : ""),
      );
    }
  } catch (error) {
    if (!outcomeWriteWarned.has(run)) {
      outcomeWriteWarned.add(run);
      process.stderr.write(`[spf] decisions: could not record the diff_risk outcome (${(error as Error).message}) — continuing\n`);
    }
  }
}
