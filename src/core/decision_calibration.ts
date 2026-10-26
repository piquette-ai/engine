/**
 * Decision calibration (#151) — the PURE half of `piquette decisions calibrate`.
 *
 * No I/O, no model call, no clock: it takes already-read decision rows and
 * already-read run facts and returns a report. The readers live in
 * `core/decision_calibration_db.ts`; the command in
 * `cli/commands/decisions.ts`. Nothing here (or there) writes config, a
 * trace row, or anything else — the report only SUGGESTS a threshold.
 *
 * THE QUESTION: for each (kind, backend, provider, model), how did the
 * model's stated confidence relate to an outcome code can OBSERVE in what
 * piquette already stored, and which confidence threshold would have reached a
 * target precision?
 *
 * HOW A ROW BECOMES A LABEL — the "baseline ran" rule. A recorded decision
 * is labelled only when the deterministic FALLBACK is what actually acted
 * (`choice === fallback`: every shadow row, every act row that fell back or
 * happened to agree). Then the observed outcome is the BASELINE's outcome,
 * and a model answer is scored against it:
 *
 *   - the model AGREED with the fallback  -> correct iff the baseline did well
 *   - the model DISSENTED from the fallback -> correct iff the baseline did badly
 *
 * A row where the model's answer itself acted (`choice !== fallback`) has no
 * observable counterfactual — the outcome was shaped by the answer being
 * scored — so it is EXCLUDED and counted, never labelled. The dissent half is
 * generous (the alternative might have failed too), so precision here is an
 * optimistic proxy for dissent and an honest one for agreement; the docs say
 * so. Which outcome counts as "did well" is per kind, built in CODE below
 * (`OUTCOME_RULES`); a kind with no observable outcome is reported as
 * "no outcome signal" — never invented, never modelled.
 *
 * ACT MODE ONLY CHANGES BEHAVIOUR ON A CONFIDENT DISSENT (an agreeing answer
 * acts exactly like the fallback). So the suggested threshold is derived from
 * the DISSENT rows alone (`model_choice !== fallback`), never from agreements
 * pooled in — agreements are scored right whenever the baseline did well,
 * which would let them carry a tail over the target while every dissent in it
 * is wrong. The pooled reliability table is still shown, and so is the
 * dissent-only one. Rows with `reason: not_permitted` can never act at any
 * threshold and are excluded. Shadow and act rows are separate groups (act rows
 * are a biased sample: confident dissents acted and are excluded).
 *
 * Other exclusions (all counted in the report): replayed rows (a re-judged
 * copy of an earlier answer, not an independent sample), rows with no valid
 * model answer or no confidence, rows superseded by a later decision of the
 * same (run, kind, key) (a re-claim — the run's final outcome belongs to the
 * latest), rows whose outcome is not known yet or is ambiguous by definition,
 * and rows whose run was followed by a LATER run of the same adw_id (a
 * revision, a blocked->ready re-claim): `sessions` holds one row per adw_id,
 * so its status is the LAST run's and cannot be attributed to this decision.
 */
import {
  CHAIN_EDGE_KIND,
  CHAIN_ROUTER_KIND,
  DIFF_RISK_KIND,
  FINDING_TRIAGE_KIND,
  INTAKE_FEEDBACK_KIND,
  INTAKE_READINESS_KIND,
  LOOP_CONTROL_KIND,
  RISK_TIER_KIND,
} from "./decision_kinds.ts";
import type { Decision } from "./decisions.ts";

// ── inputs ──────────────────────────────────────────────────────────────────

/** One recorded decision with where it was recorded — `Decision` itself carries no run id. */
export interface RecordedDecisionRow {
  adw_id: string;
  phase_id: string;
  /** The event's `started_at` (when the decision was recorded), or `null`. */
  started_at: string | null;
  decision: Decision;
}

/** What the trace db says about one run, read once per adw_id. */
export interface RunFacts {
  adw_id: string;
  /** `null` when no `sessions` row exists for this adw_id. */
  session: { status: string | null; ended_at: string | null } | null;
  /** `processes.started_at` of every `adw` (workflow) process recorded for this adw_id — one per run started under it. A revision or re-claim adds one. */
  run_starts: Array<string | null>;
  /**
   * `started_at` of every phase that never closed (`phases.ended_at IS NULL`). piquette never
   * writes an `aborted` status: Ctrl-C, SIGTERM and `piquette abort` end the session as `fail`.
   * A kill that lands mid-write, or before the drain, leaves the in-flight phase open — so
   * an open phase of a `fail` run is read as a kill (the fallback for runs recorded before
   * `kills` existed, and for a kill whose marker could not be written).
   */
  open_phases: Array<string | null>;
  /**
   * Timestamps of the `run_killed` marker events (`RUN_KILLED_EVENT`). The signal handler
   * writes one synchronously, before the killed child's exit can let the phase's catch close
   * the in-flight phase as an ordinary `fail` — the durable record of a kill that
   * `open_phases` alone misses when an otel/notify/D1 drain gives that catch time to run.
   */
  kills: Array<string | null>;
  /** Every gate verdict recorded as failed (`gate_results.passed = 0`). */
  failed_gates: Array<{ created_at: string | null }>;
  /** The run's phases in `seq` order. `verdict` is set only for phases the reader was asked to resolve (loop rounds). */
  phases: Array<{ phase_id: string; seq: number; name: string; started_at: string | null; verdict: boolean | null }>;
}

export interface CalibrationOptions {
  /** The precision a suggested threshold must reach. */
  target_precision: number;
  /** Fewer labelled rows than this in a group and the group is "insufficient". */
  min_samples: number;
}

export const DEFAULT_TARGET_PRECISION = 0.9;
export const DEFAULT_MIN_SAMPLES = 30;
/** Reliability buckets are equal-width over [0, 1]; the last bucket includes 1.0. */
export const RELIABILITY_BUCKETS = 5;
/** 95% two-sided. */
const WILSON_Z = 1.96;

// ── statistics ──────────────────────────────────────────────────────────────

export interface Interval {
  lo: number;
  hi: number;
}

/** Wilson score interval for `correct` of `n`. `null` when `n` is 0 (no interval exists). */
export function wilsonInterval(correct: number, n: number, z = WILSON_Z): Interval | null {
  if (n <= 0) return null;
  const p = correct / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

/** Round UP to 2 decimals (so a suggested threshold never admits a row the measured tail did not). */
function ceil2(x: number): number {
  return Math.ceil(x * 100 - 1e-9) / 100;
}

// ── outcome rules ───────────────────────────────────────────────────────────

/** What a rule says about one row. `good`/`bad` is how the BASELINE (fallback) path did; the rest are skips. */
export type BaselineOutcome = "good" | "bad" | "unresolved" | "ambiguous";

interface RuleContext {
  row: RecordedDecisionRow;
  /** Live (non-replayed) rows recorded AFTER this one for the same adw_id and kind, oldest first. */
  later: readonly RecordedDecisionRow[];
  /** `undefined` when the reader found nothing for this run. */
  facts: RunFacts | undefined;
}

export interface OutcomeRule {
  /** One line: what is observed, and what counts as the baseline doing well. Printed in the report. */
  basis: string;
  /** Whether `RunFacts.phases[].verdict` is needed (the reader resolves it only for runs that ask). */
  needs_verdicts?: boolean;
  /** How the baseline path did for this row, from stored data only. */
  baseline(ctx: RuleContext): BaselineOutcome;
  /**
   * Whether the model's answer was right given how the baseline did. Default
   * (omitted): agreement with the fallback is right iff the baseline did
   * well, dissent iff it did badly.
   */
  score?(decision: Decision, baseline: "good" | "bad"): boolean;
}

function at(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/** True when `timestamp` is at or after `since`; an unknown timestamp on either side is treated as "after" (the benefit of the doubt, never a drop). */
function notBefore(timestamp: string | null, since: number | null): boolean {
  const t = at(timestamp);
  return t === null || since === null || t >= since;
}

/**
 * The decision's OWN run, as a window over `run_starts` (one `adw` process row per
 * run started under an adw_id; a revision or re-claim adds one). `preClaim` kinds
 * (`chain_router`, `intake_readiness`) are recorded BEFORE the run's `session.ensure`,
 * so their run is the earliest start after the decision; every other kind is recorded
 * inside its run, so it is the latest start at or before it. The window ends where the
 * next run starts. `start` is `null` when the run cannot be located (no process rows,
 * or an unknown timestamp): then nothing is excluded, which only ever errs towards
 * "unresolved".
 */
function ownRun(ctx: RuleContext, allowed: 0 | 1): { start: number | null; end: number | null } {
  const decidedAt = at(ctx.row.started_at);
  const starts = (ctx.facts?.run_starts ?? [])
    .map(at)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  if (decidedAt === null || starts.length === 0) return { start: null, end: null };
  const i = allowed === 1 ? starts.findIndex((t) => t > decidedAt) : starts.findLastIndex((t) => t <= decidedAt);
  if (i < 0) return { start: null, end: null };
  return { start: starts[i]!, end: starts[i + 1] ?? null };
}

/** True when `timestamp` falls inside the run window; an unknown timestamp is inside (never excluded). */
function inRun(timestamp: string | null, run: { start: number | null; end: number | null }): boolean {
  const t = at(timestamp);
  if (t === null || run.start === null) return true;
  return t >= run.start && (run.end === null || t < run.end);
}

/**
 * True when the decision's own run was killed: it carries a `run_killed` marker,
 * or (the fallback for a kill with no marker) its `fail` session has a phase of
 * that run that never closed. Only the OWN run counts: an earlier killed run of
 * the same adw_id leaves its phase open forever, and reading that against a later
 * clean run would hide only that run's failures while its successes stay labelled
 * (one-sided censoring that inflates precision).
 */
function runKilled(ctx: RuleContext, allowed: 0 | 1): boolean {
  const run = ownRun(ctx, allowed);
  if ((ctx.facts?.kills ?? []).some((k) => inRun(k, run))) return true;
  return ctx.facts?.session?.status === "fail" && (ctx.facts?.open_phases ?? []).some((p) => inRun(p, run));
}

/**
 * The run's verdict AFTER this decision: `success`/`fail` only when the run
 * finished at or after the decision was recorded. `running`, a missing
 * session, a status left over from an earlier run of the same adw_id (ended
 * before this decision), and a KILLED run are all "not known". piquette records a
 * kill (Ctrl-C, SIGTERM, `piquette abort`) as session `fail`, never `aborted`; a
 * killed run is recognised by its `run_killed` marker (see `runKilled`) — an
 * abort is a human's call, not a quality signal. `allowed` is the same run
 * boundary as `laterRunStarted`'s.
 */
function finishedRun(ctx: RuleContext, allowed: 0 | 1): "success" | "fail" | null {
  const session = ctx.facts?.session;
  if (!session || (session.status !== "success" && session.status !== "fail")) return null;
  const decidedAt = at(ctx.row.started_at);
  const endedAt = at(session.ended_at);
  if (decidedAt !== null && endedAt !== null && endedAt < decidedAt) return null;
  if (runKilled(ctx, allowed)) return null;
  return session.status;
}

/**
 * True when the run's session status cannot be this decision's outcome
 * because another run of the same adw_id started after it. `allowed` is how
 * many run starts after the decision are its OWN run: 1 for a decision made
 * before the run's `session.ensure` (chain_router, intake_readiness: recorded
 * pre-claim), 0 for one made inside the run (risk_tier, loop_control). More
 * than that means a revision / re-claim reused the adw_id and overwrote the
 * session status (`sessionStart` upserts), so the label would belong to the
 * later run.
 */
function laterRunStarted(ctx: RuleContext, allowed: 0 | 1): boolean {
  const decidedAt = at(ctx.row.started_at);
  if (decidedAt === null) return false;
  const after = (ctx.facts?.run_starts ?? []).filter((s) => {
    const t = at(s);
    return t !== null && t > decidedAt;
  }).length;
  return after > allowed;
}

const RUN_ACCEPTED: OutcomeRule["baseline"] = (ctx) => {
  if (laterRunStarted(ctx, 1)) return "unresolved";
  const status = finishedRun(ctx, 1);
  return status === null ? "unresolved" : status === "success" ? "good" : "bad";
};

/** `fix_2` / `revise_1` — a repair round, evidence the run needed one. */
const REPAIR_PHASE = /^(fix|revise)_\d+$/;

const TIER_RANK: Readonly<Record<string, number>> = { low: 0, standard: 1, high: 2 };

const RULE_RISK_TIER: OutcomeRule = {
  basis:
    "run finished clean (success, no failed gate, no fix/revise round) vs troubled; scored only where the model's tier differs from the fallback tier that ran: `low` is right iff clean, `high` iff troubled; `standard`, agreement with the fallback, and a downgrade (a tier below the fallback's) on a clean run are not falsifiable (a clean run on a stronger tier is partly that tier's doing; only a troubled run shows the downgrade was wrong)",
  baseline(ctx) {
    if (laterRunStarted(ctx, 0)) return "unresolved";
    const status = finishedRun(ctx, 0);
    if (status === null) return "unresolved";
    // Agreement is ambiguous: the tier that ran was the fallback's, so a clean run
    // cannot be credited to (or held against) the model's claim — most of all
    // when both said `high` and the strong tier is why it came out clean.
    if (ctx.row.decision.model_choice === "standard" || ctx.row.decision.model_choice === ctx.row.decision.fallback) return "ambiguous";
    const since = at(ctx.row.started_at);
    const troubled =
      status === "fail" ||
      (ctx.facts?.failed_gates ?? []).some((g) => notBefore(g.created_at, since)) ||
      (ctx.facts?.phases ?? []).some((p) => REPAIR_PHASE.test(p.name) && notBefore(p.started_at, since));
    // A downgrade (model tier below the fallback's) on a clean run is the same confound:
    // the stronger tier ran, so nothing measured whether the weaker one would have stayed
    // clean. Only a troubled run is evidence about a downgrade (it was wrong).
    if (!troubled && TIER_RANK[ctx.row.decision.model_choice ?? ""] !== undefined && TIER_RANK[ctx.row.decision.fallback] !== undefined && TIER_RANK[ctx.row.decision.model_choice!]! < TIER_RANK[ctx.row.decision.fallback]!) return "ambiguous";
    // good = clean, bad = troubled. Scored on the model's own claim (`score`),
    // not on agreement: agreeing with a `standard` fallback claims nothing.
    return troubled ? "bad" : "good";
  },
  score: (decision, baseline) => (decision.model_choice === "low" ? baseline === "good" : baseline === "bad"),
};

const LOOP_KEY = /^(?:fix|revise)(?:#\d+)?:(.+)$/;
const ROUND_NAME = /^(.*)_(\d+)$/;

/** `fix#2:test_2` -> `fix#2:test` — the loop a round belongs to, whatever its round number; the loop ordinal stays, so two loops over one suite are two loops. `null` when the key is not a loop key. */
function loopIdentity(key: string): string | null {
  const m = /^((?:fix|revise)(?:#\d+)?):(.+)$/.exec(key);
  const round = m ? ROUND_NAME.exec(m[2]!) : null;
  return m && round ? `${m[1]}:${round[1]}` : null;
}

const RULE_LOOP_CONTROL: OutcomeRule = {
  basis: "after a failed round, did a later round of the same loop pass (fix: suite passed; revise: review approved)? `continue` is right iff it did; `stop_blocked`/`escalate_tier` iff it did not; unresolved when a later decision in the loop acted",
  needs_verdicts: true,
  baseline(ctx) {
    // A later decision in this loop that ACTED (act mode: stop_blocked / escalate_tier) shaped
    // whether this round "recovered" — the baseline did not run on its own.
    const loop = loopIdentity(ctx.row.decision.key);
    if (loop !== null && ctx.later.some((l) => l.decision.choice !== l.decision.fallback && loopIdentity(l.decision.key) === loop)) return "unresolved";
    if (laterRunStarted(ctx, 0) || runKilled(ctx, 0)) return "unresolved";
    const key = LOOP_KEY.exec(ctx.row.decision.key);
    const failedRound = key ? ROUND_NAME.exec(key[1]!) : null;
    const phases = ctx.facts?.phases ?? [];
    const failed = phases.find((p) => p.phase_id === ctx.row.phase_id);
    if (!failedRound || !failed) return "unresolved";
    const stem = failedRound[1]!;
    let round = Number(failedRound[2]);
    let recovered = false;
    for (const p of phases) {
      if (p.seq <= failed.seq) continue;
      const m = ROUND_NAME.exec(p.name);
      if (!m || m[1] !== stem) continue;
      const r = Number(m[2]);
      if (r <= round) break; // a later loop over the same suite restarted its numbering
      round = r;
      if (p.verdict === true) recovered = true;
    }
    if (recovered) return "good";
    return finishedRun(ctx, 0) === null ? "unresolved" : "bad";
  },
};

/**
 * Per-kind outcome rules. A kind absent here is "no outcome signal" (see
 * `NO_OUTCOME_SIGNAL`); `decision_calibration.test.ts` fails when a registered
 * kind is in neither, so adding a kind forces this decision.
 */
export const OUTCOME_RULES: Readonly<Record<string, OutcomeRule>> = Object.freeze({
  [CHAIN_ROUTER_KIND.kind]: {
    basis: "did the run the router's fallback chain started finish successfully (session status)? the model's agreement is right iff it did",
    baseline: RUN_ACCEPTED,
  },
  [INTAKE_READINESS_KIND.kind]: {
    basis: "did the build run `issue-<id>` started from an un-routed `ready` issue finish successfully (session status)? the model's `build` is right iff it did; `refine`/`needs_human` iff it did not",
    baseline: RUN_ACCEPTED,
  },
  [LOOP_CONTROL_KIND.kind]: RULE_LOOP_CONTROL,
  [RISK_TIER_KIND.kind]: RULE_RISK_TIER,
});

/** Kinds whose outcome the trace db cannot tell us, with why. Printed in the report. */
export const NO_OUTCOME_SIGNAL: Readonly<Record<string, string>> = Object.freeze({
  [CHAIN_EDGE_KIND.kind]: "no stored result ties one branch choice to an outcome; whole-run success is too coarse to score an edge",
  [DIFF_RISK_KIND.kind]: "whether a diff really touched a risk is never recorded; the human signoff that follows answers whether to commit, not which risks the diff touched",
  [FINDING_TRIAGE_KIND.kind]: "whether a finding was real is never recorded; later review rounds re-judge the work, they do not label earlier findings",
  [INTAKE_FEEDBACK_KIND.kind]: "what a human did after a feedback batch (relabel, PR comments, merge) lives in the tracker, not the trace db",
});

const NO_RULE_REASON = "no outcome rule is defined for this kind";

export function noOutcomeReason(kind: string): string {
  return NO_OUTCOME_SIGNAL[kind] ?? NO_RULE_REASON;
}

// ── report ──────────────────────────────────────────────────────────────────

export interface ReliabilityBucket {
  lo: number;
  hi: number;
  n: number;
  mean_confidence: number | null;
  correct: number;
  precision: number | null;
  wilson: Interval | null;
}

export interface TailStat {
  /** Confidence floor: rows with `confidence >= threshold`. */
  threshold: number;
  n: number;
  correct: number;
  precision: number | null;
  wilson: Interval | null;
}

export interface Exclusions {
  /** The model's answer itself acted — no baseline outcome to score it against. */
  acted: number;
  /** A later decision of the same (run, kind, key) replaced it. */
  superseded: number;
  /** The outcome is not known yet (run still going, no session, no later round) or cannot be attributed to this decision (a later run reused the adw_id). */
  unresolved: number;
  /** The kind's rule cannot score this answer (e.g. risk `standard`). */
  ambiguous: number;
  /** The model answered but reported no confidence. */
  no_confidence: number;
  /** `reason: not_permitted` — the answer could never act at any threshold. */
  not_permitted: number;
}

export type OutcomeStatus = "ok" | "insufficient" | "no_outcome_signal";

export interface GroupOutcome {
  status: OutcomeStatus;
  /** What is observed (`ok`/`insufficient`) or why nothing can be (`no_outcome_signal`). */
  basis: string;
  labeled: number;
  correct: number;
  excluded: Exclusions;
  /** The `threshold` most often in force across the group's rows; `null` when there are none. */
  threshold_in_use: number | null;
  /** Only when `status` is `ok`. Pooled: every labelled row, agreements and dissents. */
  buckets: ReliabilityBucket[];
  /** Pooled, like `buckets`. */
  at_threshold_in_use: TailStat | null;
  /** The labelled rows where the model dissented from the fallback — the only ones act mode would change behaviour on. `ok` only. */
  dissent: DissentOutcome | null;
  /** Derived from the DISSENT tail alone. */
  suggested: TailStat | null;
  /** Why there is no suggestion (`ok` only, when `suggested` is null). */
  suggestion_note: string | null;
}

export interface DissentOutcome {
  labeled: number;
  correct: number;
  precision: number | null;
  wilson: Interval | null;
  buckets: ReliabilityBucket[];
  at_threshold_in_use: TailStat | null;
}

export interface CalibrationGroup {
  kind: string;
  /** Shadow and act rows are separate groups: act rows are a biased sample. */
  mode: string;
  backend: string | null;
  provider: string | null;
  model: string | null;
  /** Non-replayed rows recorded for this group. */
  n: number;
  /** Rows where the model gave a valid in-set answer. */
  answered: number;
  /** Of `answered`: model_choice === fallback. */
  agree_rate: number | null;
  /** Of `n`: act mode would have used the model's answer. */
  would_act_rate: number | null;
  outcome: GroupOutcome;
}

export interface CalibrationReport {
  target_precision: number;
  min_samples: number;
  rows: number;
  replayed_skipped: number;
  groups: CalibrationGroup[];
}

function emptyExclusions(): Exclusions {
  return { acted: 0, superseded: 0, unresolved: 0, ambiguous: 0, no_confidence: 0, not_permitted: 0 };
}

function rate(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

function tail(labeled: Labeled[], threshold: number): TailStat {
  const rows = labeled.filter((l) => l.confidence >= threshold);
  const correct = rows.filter((l) => l.correct).length;
  return { threshold, n: rows.length, correct, precision: rate(correct, rows.length), wilson: wilsonInterval(correct, rows.length) };
}

function buckets(labeled: Labeled[]): ReliabilityBucket[] {
  const out: ReliabilityBucket[] = [];
  for (let i = 0; i < RELIABILITY_BUCKETS; i++) {
    const lo = i / RELIABILITY_BUCKETS;
    const hi = (i + 1) / RELIABILITY_BUCKETS;
    const rows = labeled.filter((l) => Math.min(RELIABILITY_BUCKETS - 1, Math.floor(l.confidence * RELIABILITY_BUCKETS)) === i);
    const correct = rows.filter((l) => l.correct).length;
    out.push({
      lo,
      hi,
      n: rows.length,
      mean_confidence: rows.length === 0 ? null : rows.reduce((s, l) => s + l.confidence, 0) / rows.length,
      correct,
      precision: rate(correct, rows.length),
      wilson: wilsonInterval(correct, rows.length),
    });
  }
  return out;
}

/**
 * The LOWEST threshold (candidates: each observed confidence, rounded up to
 * 2 decimals) whose tail — labelled rows at or above it — reaches
 * `target` with at least `minTail` rows behind it. Lowest = widest coverage
 * that still meets the bar. A tail smaller than `minTail` is never suggested
 * however clean it looks.
 */
export function suggestThreshold(
  labeled: Labeled[],
  target: number,
  minTail: number,
  what = "labelled",
): { suggested: TailStat | null; note: string | null } {
  const candidates = [...new Set(labeled.map((l) => ceil2(l.confidence)))].sort((a, b) => a - b);
  let best: TailStat | null = null;
  for (const candidate of candidates) {
    const stat = tail(labeled, candidate);
    if (stat.n < minTail) break; // candidates ascend, so every later tail is smaller still
    if (stat.precision !== null && stat.precision >= target) return { suggested: stat, note: null };
    if (best === null || (stat.precision ?? 0) > (best.precision ?? 0)) best = stat;
  }
  const bestNote = best === null || best.precision === null ? "" : ` (best seen: ${(best.precision * 100).toFixed(1)}% at >= ${best.threshold.toFixed(2)}, n=${best.n})`;
  return { suggested: null, note: `no threshold with at least ${minTail} ${what} rows reaches ${(target * 100).toFixed(0)}% precision${bestNote}` };
}

export interface Labeled {
  confidence: number;
  correct: boolean;
  /** The model's answer differed from the fallback. */
  dissent?: boolean;
}

function modeThreshold(rows: RecordedDecisionRow[]): number | null {
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.decision.threshold, (counts.get(r.decision.threshold) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [t, c] of counts) {
    if (c > bestCount || (c === bestCount && best !== null && t > best)) {
      best = t;
      bestCount = c;
    }
  }
  return best;
}

/** `adw_id` + kind + key — what "the same decision, asked again" means. */
function repeatKey(row: RecordedDecisionRow): string {
  return JSON.stringify([row.adw_id, row.decision.kind, row.decision.key]);
}

/**
 * The whole report. `rows` must be in recording order (oldest first — what
 * the readers return); `facts` is keyed by adw_id. Deterministic: the same
 * inputs always give the same report, byte for byte.
 */
export function buildCalibrationReport(
  rows: readonly RecordedDecisionRow[],
  facts: ReadonlyMap<string, RunFacts>,
  options: CalibrationOptions,
): CalibrationReport {
  const live = rows.filter((r) => !r.decision.replayed);
  const replayedSkipped = rows.length - live.length;

  // The latest row of each (run, kind, key) wins the outcome; earlier ones are superseded.
  const latest = new Map<string, RecordedDecisionRow>();
  for (const row of live) latest.set(repeatKey(row), row);

  // Live rows per (adw_id, kind), in recording order, so a rule can see what was decided AFTER a row.
  const byRun = new Map<string, RecordedDecisionRow[]>();
  for (const row of live) {
    const k = JSON.stringify([row.adw_id, row.decision.kind]);
    const list = byRun.get(k);
    if (list) list.push(row);
    else byRun.set(k, [row]);
  }

  const groups = new Map<string, RecordedDecisionRow[]>();
  for (const row of live) {
    const d = row.decision;
    const key = JSON.stringify([d.kind, d.mode, d.backend, d.provider, d.model]);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const minTail = Math.max(1, Math.ceil(options.min_samples / 2));
  const out: CalibrationGroup[] = [];
  for (const members of groups.values()) {
    const first = members[0]!.decision;
    const answeredRows = members.filter((r) => r.decision.model_choice !== null);
    const agreed = answeredRows.filter((r) => r.decision.model_choice === r.decision.fallback).length;
    const wouldAct = members.filter((r) => r.decision.would_act).length;
    const rule = OUTCOME_RULES[first.kind];

    const excluded = emptyExclusions();
    const labeled: Labeled[] = [];
    if (rule) {
      for (const row of answeredRows) {
        const d = row.decision;
        if (d.confidence === null) {
          excluded.no_confidence++;
        } else if (d.reason === "not_permitted") {
          excluded.not_permitted++;
        } else if (d.choice !== d.fallback) {
          excluded.acted++;
        } else if (latest.get(repeatKey(row)) !== row) {
          excluded.superseded++;
        } else {
          const siblings = byRun.get(JSON.stringify([row.adw_id, d.kind])) ?? [];
          const outcome = rule.baseline({ row, later: siblings.slice(siblings.indexOf(row) + 1), facts: facts.get(row.adw_id) });
          if (outcome === "unresolved") excluded.unresolved++;
          else if (outcome === "ambiguous") excluded.ambiguous++;
          else {
            const right = rule.score ? rule.score(d, outcome) : (d.model_choice === d.fallback) === (outcome === "good");
            labeled.push({ confidence: d.confidence, correct: right, dissent: d.model_choice !== d.fallback });
          }
        }
      }
    }

    const correct = labeled.filter((l) => l.correct).length;
    const thresholdInUse = modeThreshold(members);
    let outcome: GroupOutcome;
    if (!rule) {
      outcome = {
        status: "no_outcome_signal",
        basis: noOutcomeReason(first.kind),
        labeled: 0,
        correct: 0,
        excluded,
        threshold_in_use: thresholdInUse,
        buckets: [],
        at_threshold_in_use: null,
        dissent: null,
        suggested: null,
        suggestion_note: null,
      };
    } else if (labeled.length < options.min_samples) {
      outcome = {
        status: "insufficient",
        basis: rule.basis,
        labeled: labeled.length,
        correct,
        excluded,
        threshold_in_use: thresholdInUse,
        buckets: [],
        at_threshold_in_use: null,
        dissent: null,
        suggested: null,
        suggestion_note: null,
      };
    } else {
      // Act mode only changes behaviour on a dissent, so the suggestion comes from the dissent tail alone.
      const dissents = labeled.filter((l) => l.dissent);
      const dissentCorrect = dissents.filter((l) => l.correct).length;
      // An act group's confident dissents acted and are excluded, so its dissent tail holds only
      // rows BELOW the threshold that acted: a suggestion from it would describe rows that never acted.
      const actGroup = first.mode === "act";
      const { suggested, note } = actGroup
        ? { suggested: null, note: "act-mode rows cannot calibrate the threshold that acted (its confident dissents acted and are excluded); run the kind in shadow" }
        : suggestThreshold(dissents, options.target_precision, minTail, "labelled dissenting");
      outcome = {
        status: "ok",
        basis: rule.basis,
        labeled: labeled.length,
        correct,
        excluded,
        threshold_in_use: thresholdInUse,
        buckets: buckets(labeled),
        at_threshold_in_use: thresholdInUse === null ? null : tail(labeled, thresholdInUse),
        dissent: {
          labeled: dissents.length,
          correct: dissentCorrect,
          precision: rate(dissentCorrect, dissents.length),
          wilson: wilsonInterval(dissentCorrect, dissents.length),
          buckets: buckets(dissents),
          at_threshold_in_use: thresholdInUse === null ? null : tail(dissents, thresholdInUse),
        },
        suggested,
        suggestion_note: note,
      };
    }

    out.push({
      kind: first.kind,
      mode: first.mode,
      backend: first.backend,
      provider: first.provider,
      model: first.model,
      n: members.length,
      answered: answeredRows.length,
      agree_rate: rate(agreed, answeredRows.length),
      would_act_rate: rate(wouldAct, members.length),
      outcome,
    });
  }

  const cmp = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);
  out.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.backend, b.backend) || cmp(a.provider, b.provider) || cmp(a.model, b.model) || cmp(a.mode, b.mode));
  return { target_precision: options.target_precision, min_samples: options.min_samples, rows: rows.length, replayed_skipped: replayedSkipped, groups: out };
}

// ── rendering ───────────────────────────────────────────────────────────────

const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const ci = (i: Interval | null): string => (i === null ? "" : `  95% CI ${(i.lo * 100).toFixed(1)}-${(i.hi * 100).toFixed(1)}%`);
const label = (x: string | null): string => x ?? "-";

function tailLine(prefix: string, t: TailStat): string {
  return `${prefix} ${t.threshold.toFixed(2)}: n=${t.n}, precision ${pct(t.precision)}${ci(t.wilson)}`;
}

function pushBuckets(lines: string[], list: ReliabilityBucket[]): void {
  lines.push("    bucket        n   mean conf   precision");
  for (const b of list) {
    lines.push(
      `    ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${String(b.n).padStart(6)}   ${b.mean_confidence === null ? "     n/a" : b.mean_confidence.toFixed(3).padStart(8)}   ${pct(b.precision).padStart(7)}${ci(b.wilson)}`,
    );
  }
}

/** The human table. Plain text, no color, stable across runs. */
export function formatCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = [];
  lines.push(
    `piquette decisions calibrate — ${report.rows} decision row(s)` +
      (report.replayed_skipped > 0 ? `, ${report.replayed_skipped} replayed skipped` : "") +
      `, ${report.groups.length} group(s)`,
  );
  lines.push(`target precision ${report.target_precision}, min samples ${report.min_samples}. Read-only: nothing is written, thresholds are suggestions only.`);
  if (report.groups.length === 0) {
    lines.push("", "no recorded decisions (decisions.enabled is off by default; shadow-mode rows appear once a kind runs).");
    return lines.join("\n");
  }
  for (const g of report.groups) {
    lines.push("", `${g.kind}  backend=${label(g.backend)} provider=${label(g.provider)} model=${label(g.model)} mode=${g.mode}`);
    lines.push(`  n=${g.n}  answered=${g.answered}  agree-with-fallback=${pct(g.agree_rate)}  would_act=${pct(g.would_act_rate)}`);
    const o = g.outcome;
    if (o.status === "no_outcome_signal") {
      lines.push(`  no outcome signal: ${o.basis}`);
      continue;
    }
    lines.push(`  outcome: ${o.basis}`);
    const x = o.excluded;
    lines.push(
      `  labelled=${o.labeled} correct=${o.correct}  (excluded: acted ${x.acted}, superseded ${x.superseded}, unresolved ${x.unresolved}, ambiguous ${x.ambiguous}, no confidence ${x.no_confidence}, not permitted ${x.not_permitted})`,
    );
    if (o.status === "insufficient") {
      lines.push(`  insufficient: ${o.labeled} labelled row(s) < --min-samples ${report.min_samples}; no table, thresholds left alone`);
      continue;
    }
    if (g.mode === "act") {
      lines.push("  note: act-mode rows are a biased sample (confident dissents acted and are excluded); calibrate from shadow rows where you can");
    }
    lines.push("  reliability, all labelled rows (agreements + dissents):");
    pushBuckets(lines, o.buckets);
    if (o.at_threshold_in_use) lines.push(`  ${tailLine("threshold in use (all rows)", o.at_threshold_in_use)}`);
    const d = o.dissent;
    if (d) {
      lines.push(`  dissents only (the rows act mode would change behaviour on): labelled=${d.labeled} correct=${d.correct}, precision ${pct(d.precision)}${ci(d.wilson)}`);
      if (d.labeled > 0) {
        lines.push("  reliability, dissents only:");
        pushBuckets(lines, d.buckets);
      }
      if (d.at_threshold_in_use) lines.push(`  ${tailLine("threshold in use (dissents)", d.at_threshold_in_use)}`);
    }
    if (o.suggested) lines.push(`  ${tailLine("suggested threshold (from dissents)", o.suggested)}`);
    else if (o.suggestion_note) lines.push(`  no suggested threshold: ${o.suggestion_note}`);
  }
  return lines.join("\n");
}
