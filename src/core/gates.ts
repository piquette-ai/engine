/**
 * Validation gates: verify the envelope's CLAIMS, never guesses.
 *
 * A gate is `gate(envelope, run) -> GateReport` — one check per item it looked at.
 * Violations are derived from the failed checks and sent back to the SAME agent
 * session as a correction. Every check is recorded either way, so a green gate
 * says WHAT it verified instead of only that it passed.
 *
 * Gates check what is mechanically checkable; plan quality is a reviewer's job.
 *
 * An envelope's artifact/file paths are the AGENT's claims, and the agent runs
 * with `run.repo_root` as its cwd — so a relative claim is resolved against
 * that root, never against this process's own cwd. A claim that resolves
 * outside the repo entirely is reported as a violation rather than silently
 * stat'd (or not found) somewhere unexpected.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_REFINE_MAX_DEPTH,
  DEFAULT_REFINE_MAX_LEAVES,
  DEFAULT_REFINE_MAX_NODES,
  GateReport,
  PRIORITY_RANK,
  type EnvelopeBase,
  type GateFn,
  type RefinedIssue,
  type RefineQuestion,
  type RunContext,
  type SpecSplit,
} from "./data_types.ts";
import { operatorEnv } from "./utils.ts";
import { loadJourneysFile, type JourneySpec } from "./journeys.ts";

const TAIL_CHARS = 1000; // command output kept as evidence on a failure
const MIN_OUTCOME_CHARS = 20; // shortest string that can still be the sentence RefinedIssue.user_outcome asks for
/** A checklist line "- [ ] Observable check: <at least a few words>" anywhere in a leaf body. */
const OBSERVABLE_CHECK = /^\s*[-*]\s*\[[ xX]\]\s*Observable check:\s*\S.{9,}$/m;
/** A checklist line "- [ ] Repro today: <steps and the wrong result>" in a bug body. */
const REPRO_TODAY = /^\s*[-*]\s*\[[ xX]\]\s*Repro today:\s*\S.{9,}$/m;

/**
 * Anchor an envelope-declared path to `run.repo_root`. Absolute paths pass
 * through unchanged (an agent that reports an absolute path meant exactly
 * that path). Returns `null` when the resolved path escapes the repo — a
 * gate should report that as a violation, not silently check outside it.
 */
function resolveClaim(p: string, run: RunContext): string | null {
  const resolved = path.isAbsolute(p) ? p : path.resolve(run.repo_root, p);
  const rel = path.relative(run.repo_root, resolved);
  if (rel === "..") return null;
  if (rel.startsWith(`..${path.sep}`)) return null;
  return resolved;
}

function size(p: string): string {
  const n = statSync(p).size;
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
}

export function artifactsExist(envelope: EnvelopeBase, run: RunContext): GateReport {
  const report = new GateReport();
  for (const a of envelope.artifacts) {
    const resolved = resolveClaim(a, run);
    if (resolved === null) {
      report.check(a, false, `declared artifact resolves outside the repo (${run.repo_root})`);
      continue;
    }
    const exists = existsSync(resolved);
    report.check(a, exists, exists ? `exists, ${size(resolved)}` : "declared artifact does not exist");
  }
  return report;
}

export function filesNonEmpty(envelope: EnvelopeBase, run: RunContext): GateReport {
  const report = new GateReport();
  for (const a of envelope.artifacts) {
    const resolved = resolveClaim(a, run);
    if (resolved === null) continue; // artifactsExist's job to report the escape
    if (!existsSync(resolved) || !statSync(resolved).isFile()) continue; // existence is artifactsExist's job
    const empty = statSync(resolved).size === 0;
    report.check(a, !empty, empty ? "declared artifact is empty" : size(resolved));
  }
  return report;
}

export function jsonParses(envelope: EnvelopeBase, run: RunContext): GateReport {
  const report = new GateReport();
  for (const a of envelope.artifacts) {
    if (!a.endsWith(".json")) continue;
    const resolved = resolveClaim(a, run);
    if (resolved === null || !existsSync(resolved)) continue;
    try {
      const parsed = JSON.parse(readFileSync(resolved, "utf-8"));
      const kind = Array.isArray(parsed) ? "list" : typeof parsed === "object" && parsed !== null ? "dict" : typeof parsed;
      report.check(a, true, `parses, ${kind}`);
    } catch (error) {
      report.check(a, false, `declared JSON artifact does not parse: ${(error as Error).message}`);
    }
  }
  return report;
}

function gitOut(args: string[], cwd: string): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The commit this run's changes are measured from: HEAD's merge-base with the
 * configured `watch.base_branch` (default "main"), preferring `origin/<base>`
 * over a local branch of the same name. The merge-base — not the branch tip —
 * so a base that moved mid-run doesn't make files the run never saw look
 * "tracked at base". `null` when git is unavailable or no base ref resolves.
 */
function resolveBase(run: RunContext): { sha: string; short: string } | null {
  const baseBranch = run.cfg?.watch?.base_branch ?? "main";
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    if (gitOut(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], run.repo_root) === null) continue;
    const sha = gitOut(["merge-base", ref, "HEAD"], run.repo_root);
    if (sha) return { sha, short: sha.slice(0, 7) };
  }
  return null;
}

/** True when `rel` is a tracked FILE (blob) at `sha` — a directory or a submodule is not a claimable file. */
function trackedAtBase(rel: string, sha: string, repoRoot: string): boolean {
  return gitOut(["cat-file", "-t", `${sha}:${rel.split(path.sep).join("/")}`], repoRoot) === "blob";
}

// A trailing " (...)" a builder sometimes appends to a path. Its leading word
// is matched against a closed synonym vocabulary; the rest of the parenthetical
// is a free-form note ("(new, plan-phase spec)"). Any other note is tolerated
// only when the prefix is itself an existing FILE (see diffMatchesClaims), so a
// summary sentence ending in parens never resolves (a directory prefix such as
// "app/ (139 files reformatted)" is still a summary). The split is at the LAST
// parenthetical, so a path that itself contains " (" still resolves.
const CLAIM_ANNOTATION = /^(.+) \(([^()]*)\)$/;
type ClaimStatus = "added" | "modified" | "deleted" | "renamed";
const CLAIM_STATUS_WORDS: Record<string, ClaimStatus> = {
  added: "added",
  new: "added",
  created: "added",
  modified: "modified",
  changed: "modified",
  updated: "modified",
  edited: "modified",
  deleted: "deleted",
  renamed: "renamed",
};

/**
 * Every file claimed changed must exist on disk — or, for a deletion, be
 * confirmed deleted by git: tracked as a file at the run's base and gone now.
 * A deletion is a change the builder must be able to list; a path that was
 * never tracked (a typo, an invented file, a prose summary) still fails.
 */
export function diffMatchesClaims(envelope: EnvelopeBase, run: RunContext): GateReport {
  const report = new GateReport();
  const changedFiles = ((envelope as any).changed_files as string[] | undefined) ?? [];
  let base: ReturnType<typeof resolveBase> | undefined; // lazy: only needed for an absent path
  for (const f of changedFiles) {
    // A real path literally named like "notes (new)" is the claim as written.
    const full = resolveClaim(f, run);
    const m = full !== null && existsSync(full) ? null : CLAIM_ANNOTATION.exec(f);
    let claim = f;
    let annotation: ClaimStatus | null = null;
    if (m) {
      const word = /^[A-Za-z]+/.exec(m[2].trim())?.[0].toLowerCase();
      const status = word ? CLAIM_STATUS_WORDS[word] : undefined;
      const prefix = resolveClaim(m[1], run);
      const prefixIsFile = prefix !== null && existsSync(prefix) && statSync(prefix).isFile();
      // added/modified must name a regular file; an existing non-file (a directory)
      // is a bulk-summary, not a claim. An absent prefix keeps its precise
      // "annotated but does not exist" failure below.
      const prefixIsNonFile = prefix !== null && existsSync(prefix) && !prefixIsFile;
      if (status && !((status === "added" || status === "modified") && prefixIsNonFile)) {
        claim = m[1];
        annotation = status;
      } else if (prefix !== null && existsSync(prefix) && statSync(prefix).isFile()) {
        claim = m[1]; // unrecognized note on a real path: the path is the claim
      }
    }
    const resolved = resolveClaim(claim, run);
    if (resolved === null) {
      report.check(f, false, `claimed changed file resolves outside the repo (${run.repo_root})`);
      continue;
    }
    const exists = existsSync(resolved);
    if (annotation === "deleted" && exists) {
      report.check(f, false, "annotated (deleted) but the file still exists");
      continue;
    }
    if ((annotation === "added" || annotation === "modified") && !exists) {
      report.check(f, false, `annotated (${annotation}) but the file does not exist`);
      continue;
    }
    if (exists) {
      report.check(f, true, `exists, ${size(resolved)}`);
      continue;
    }
    // Absent on disk. A deletion is a legitimate change: accept iff git says
    // the file was tracked at the run's base. Prose never matches a tracked
    // blob, so the lookup cannot launder a summary sentence.
    base ??= resolveBase(run);
    if (base && trackedAtBase(path.relative(run.repo_root, resolved), base.sha, run.repo_root)) {
      report.check(f, true, `deleted (tracked at base ${base.short})`);
      continue;
    }
    const looksLikeProse = /\s/.test(claim);
    // A bulk/mechanical change (a repo-wide formatter, a codemod) tempts an
    // agent to compress many identical edits into one descriptive sentence
    // ("139 files reformatted (app/, components/, ...)") instead of listing
    // each path — that string obviously never resolves, but the plain
    // "does not exist" message gives no hint why, so a retry repeats the
    // same mistake. Whitespace inside an otherwise-nonexistent claim is the
    // cheap, cheap-to-check signal: a real repo-relative path is never a
    // prose fragment. Never suppresses the failure itself, only clarifies it.
    report.check(
      f,
      false,
      looksLikeProse
        ? "claimed changed file does not exist — this looks like a summary sentence, not a path; list every changed file individually, even for a bulk/mechanical change"
        : "claimed changed file does not exist",
    );
  }
  return report;
}

/**
 * A review's verdict must agree with the findings it just wrote down.
 *
 * Nothing here judges the code — that is the reviewer's job. This checks the
 * envelope against itself: an approval that ships blocking items, or a
 * rejection that names no problem, is a claim the harness can refute without
 * reading a line of the diff.
 */
export function verdictConsistent(envelope: EnvelopeBase, _run: RunContext): GateReport {
  const report = new GateReport();
  const approved = Boolean((envelope as any).approved ?? false);
  const blocking = ((envelope as any).blocking as string[] | undefined) ?? [];
  const findings = ((envelope as any).findings as Array<{ met: boolean; requirement: string }> | undefined) ?? [];
  const unmet = findings.filter((f) => !f.met).map((f) => f.requirement);

  report.check(
    "approved vs blocking",
    !(approved && blocking.length > 0),
    blocking.length === 0
      ? "no blocking items"
      : approved
        ? `${blocking.length} blocking item(s) while approved=true`
        : `${blocking.length} blocking item(s), not approved`,
  );
  report.check(
    "approved vs findings",
    !(approved && unmet.length > 0),
    unmet.length === 0
      ? "every requirement met"
      : approved
        ? `${unmet.length} unmet requirement(s) while approved=true`
        : `${unmet.length} unmet requirement(s), not approved`,
  );
  report.check(
    "rejection names a problem",
    approved || blocking.length > 0 || unmet.length > 0,
    approved || blocking.length > 0 || unmet.length > 0
      ? "verdict is supported"
      : "approved=false but no blocking item or unmet requirement was given",
  );
  return report;
}

const CONTAINER_KINDS = new Set(["epic", "feature"]);
const LEAF_KINDS = new Set(["story", "bug", "task"]);

/**
 * The decomposition budget in force for this run: `watch.refine`'s
 * configured ceilings, or the packaged defaults when the caller handed us no
 * `cfg` (see `RunContext.cfg`). Its own function, and exported, so `piquette
 * doctor` can print the three numbers this gate enforces by calling the SAME
 * resolution the gate uses, rather than a second reading of the config that
 * can drift from it — the `clampPriority` pattern.
 */
export interface RefineBudget {
  maxLeaves: number;
  maxNodes: number;
  maxDepth: number;
}

export function refineBudget(run: RunContext): RefineBudget {
  const refine = run.cfg?.watch.refine;
  return {
    maxLeaves: refine?.max_leaves ?? DEFAULT_REFINE_MAX_LEAVES,
    maxNodes: refine?.max_nodes ?? DEFAULT_REFINE_MAX_NODES,
    maxDepth: refine?.max_depth ?? DEFAULT_REFINE_MAX_DEPTH,
  };
}

/**
 * How many containment levels deep `key` sits: a top-level node is 1, a node
 * under a top-level container is 2. Bounded by a `seen` set — the cycle
 * check earlier in this gate already reports a `parent` cycle as its own
 * violation, so this just has to not hang on one, not detect it again.
 */
function containmentDepth(key: string, byKey: Map<string, RefinedIssue>): number {
  let depth = 1;
  const seen = new Set<string>([key]);
  let current = byKey.get(key);
  while (current?.parent) {
    const parent = byKey.get(current.parent);
    if (!parent || seen.has(parent.key)) break;
    seen.add(parent.key);
    depth += 1;
    current = parent;
  }
  return depth;
}

/**
 * The gate that turns `to-tickets`' flat, untyped ticket list into an
 * actually-enforced feature/story-or-bug tree — see `RefinedIssueSchema`'s
 * doc comment in `data_types.ts`. Checks the envelope's `issues` list
 * against itself, never anything already published: `core/refine.ts` never
 * gets a chance to publish a malformed tree in the first place, because a
 * violation here re-prompts the SAME refiner session before `steps.refine()`
 * ever hands off to `steps.publishIssues()`.
 *
 * "Container" and "leaf" are derived from the graph, not asserted by the
 * agent: a node is a container iff some other node names it as `parent`.
 *
 * `issues` / `questions` / `split` (see `RefineQuestionSchema`'s and
 * `SpecSplitSchema`'s doc comments) are three mutually exclusive ways this
 * round can end: an unambiguous tree, material ambiguity to escalate, or a
 * spec too large for one decomposition. A refinement that raises questions
 * or proposes a split must publish NOTHING this round — a partial tree
 * pinned to either is worse than none. When `questions` or `split` is
 * non-empty this gate checks only that shape (never both at once, and never
 * alongside `issues`) and skips every `issues` rule below, since there is no
 * tree to validate.
 */
export function refinementWellFormed(envelope: EnvelopeBase, run: RunContext): GateReport {
  const report = new GateReport();
  const issues = ((envelope as any).issues as RefinedIssue[] | undefined) ?? [];
  const questions = ((envelope as any).questions as RefineQuestion[] | undefined) ?? [];
  const split = ((envelope as any).split as SpecSplit[] | undefined) ?? [];

  if (questions.length > 0 || split.length > 0) {
    report.check(
      "issues empty while escalating",
      issues.length === 0,
      issues.length === 0
        ? "no issues published alongside the escalation"
        : `${issues.length} issue(s) published alongside ${questions.length} question(s)/${split.length} split proposal(s) — escalating means publishing nothing this round`,
    );
    report.check(
      "questions xor split",
      !(questions.length > 0 && split.length > 0),
      questions.length > 0 && split.length > 0
        ? "both questions and split are non-empty — ambiguity (questions) and size (split) are different problems, escalate one at a time"
        : "exactly one escalation shape used",
    );
    if (split.length > 0) {
      report.check(
        "split has at least 2 entries",
        split.length >= 2,
        split.length >= 2
          ? `${split.length} proposed specs`
          : "a split into 1 entry is not a split — it's the same spec renamed. Either propose 2+ standalone specs, or this spec fits after all: emit issues instead",
      );
      split.forEach((s, i) => {
        report.check(`split[${i}].title`, s.title.trim().length > 0, s.title.trim().length > 0 ? "has text" : "blank title");
        report.check(`split[${i}].body`, s.body.trim().length > 0, s.body.trim().length > 0 ? "has text" : "blank body — each proposed spec needs its own complete problem/outcome/scope");
        report.check(
          `split[${i}].rationale`,
          s.rationale.trim().length > 0,
          s.rationale.trim().length > 0 ? "has text" : "blank rationale — say why this is a coherent standalone spec and roughly how many leaves you expect it to decompose into",
        );
      });
    } else {
      const seenIds = new Set<string>();
      for (const q of questions) {
        const blank = !q.id.trim();
        const dup = !blank && seenIds.has(q.id);
        seenIds.add(q.id);
        report.check(
          `question ${JSON.stringify(q.id)}`,
          !blank && !dup,
          blank ? "question id is blank" : dup ? "duplicate question id — every question needs a unique id within this round" : "id ok",
        );
        report.check(`question ${JSON.stringify(q.id)}.question`, q.question.trim().length > 0, q.question.trim().length > 0 ? "has text" : "question text is blank");
      }
    }
    return report;
  }

  if (issues.length === 0) {
    report.check("issues", false, "a refinement produced no issues at all and raised no questions or split — decompose the spec into at least one leaf, escalate what's ambiguous, or propose a split if it's too large");
    return report;
  }

  const byKey = new Map<string, RefinedIssue>();
  for (const issue of issues) {
    if (byKey.has(issue.key)) {
      report.check(`key ${JSON.stringify(issue.key)}`, false, "duplicate key — every node needs a unique key within this refinement");
    } else {
      byKey.set(issue.key, issue);
    }
  }

  const childKeys = new Set<string>(); // keys named as some OTHER node's parent -> that node is a container
  const childCount = new Map<string, number>(); // and HOW MANY name it — a container of exactly 1 is a violation below
  for (const issue of issues) {
    if (!issue.parent) continue;
    if (!byKey.has(issue.parent)) {
      report.check(`${issue.key}.parent`, false, `parent ${JSON.stringify(issue.parent)} does not match any issue's key`);
      continue;
    }
    childKeys.add(issue.parent);
    childCount.set(issue.parent, (childCount.get(issue.parent) ?? 0) + 1);
  }
  for (const issue of issues) {
    for (const blocker of issue.blocked_by) {
      if (!byKey.has(blocker)) {
        report.check(`${issue.key}.blocked_by`, false, `blocked_by ${JSON.stringify(blocker)} does not match any issue's key`);
      }
    }
  }

  // Cycle check over the union of parent + blocked_by edges — both mean
  // "must exist before this node" from core/refine.ts's own topological
  // publish order, so a cycle in either (or across both) would hang it.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  let cyclic = false;
  const edgesFrom = (key: string): string[] => {
    const issue = byKey.get(key);
    if (!issue) return [];
    const out: string[] = [];
    if (issue.parent && byKey.has(issue.parent)) out.push(issue.parent);
    for (const b of issue.blocked_by) if (byKey.has(b)) out.push(b);
    return out;
  };
  const visit = (key: string): void => {
    if (cyclic) return;
    color.set(key, GRAY);
    for (const next of edgesFrom(key)) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        cyclic = true;
        return;
      }
      if (c === WHITE) visit(next);
    }
    color.set(key, BLACK);
  };
  for (const issue of issues) {
    if ((color.get(issue.key) ?? WHITE) === WHITE) visit(issue.key);
  }
  report.check("dependency graph", !cyclic, cyclic ? "parent/blocked_by edges form a cycle — nothing to publish first" : "acyclic");

  for (const issue of issues) {
    const isContainer = childKeys.has(issue.key);
    if (isContainer && !CONTAINER_KINDS.has(issue.kind)) {
      report.check(`${issue.key}.kind`, false, `has children but kind is ${JSON.stringify(issue.kind)} — a container must be "epic" or "feature"`);
    } else if (!isContainer && !LEAF_KINDS.has(issue.kind)) {
      report.check(`${issue.key}.kind`, false, `has no children but kind is ${JSON.stringify(issue.kind)} — a leaf must be "story", "bug", or "task"`);
    } else {
      report.check(`${issue.key}.kind`, true, isContainer ? "container" : "leaf");
    }
  }

  const leafCount = issues.filter((i) => !childKeys.has(i.key)).length;
  report.check(
    "has leaves",
    leafCount > 0,
    leafCount > 0 ? `${leafCount} leaf issue(s)` : "every node is a container — nothing here is independently workable",
  );

  // ── the decomposition budget ────────────────────────────────────────────
  //
  // The first CARDINALITY rules this gate has ever had, and the reason they
  // are gate rules rather than one more paragraph of prompt: a prompt-only
  // version was tried (c9a4471, "tests are not their own leaf") and the model
  // kept the ticket and renamed it around the banned noun. A count is not a
  // noun — there is nothing to rename.
  //
  // BOTH MESSAGES NAME THE ESCALATION BRANCH EXPLICITLY, and that is
  // load-bearing rather than decorative. `core/agents.ts`'s correction prompt
  // is generic ("Your previous response failed validation: ... Fix these
  // problems, then re-emit ONLY your Report JSON"), so a violation's own
  // `note` is the ONLY channel through which the refiner learns that
  // proposing a `split` is a legal way out. Without that sentence, the
  // correction round `steps.refine()`'s `retries` buys gets spent producing a
  // smaller WRONG tree instead of a split proposal.
  //
  // The leaf message also forecloses the other cheap escape: satisfying a
  // leaf cap by MERGING unrelated slices into a few oversized ones. That
  // passes every check here and violates the one rule no gate can measure
  // ("sized to fit what a reviewer can hold in their head" —
  // assets/prompts/refiner/system.md). Saying so is the only lever available.
  const budget = refineBudget(run);
  report.check(
    "leaf budget",
    leafCount <= budget.maxLeaves,
    leafCount <= budget.maxLeaves
      ? `${leafCount} leaf/leaves, within the budget of ${budget.maxLeaves}`
      : `${leafCount} leaves exceeds the budget of ${budget.maxLeaves}. Every leaf becomes its own branch, its own build run and its own pull request a person reads, so this spec as decomposed costs ${leafCount} human reviews. Take exactly one of two paths: (1) re-emit a tree of at most ${budget.maxLeaves} leaves, dropping slices that are process rather than product and combining slices that are genuinely one vertical slice — do NOT merge unrelated slices to hit the number, an oversized leaf is a worse outcome than a large tree; or (2) if this spec honestly cannot be built in ${budget.maxLeaves} slices, publish NOTHING: emit an empty "issues" and a "split" entry proposing 2 or more standalone specs to cut it into, each with your expected leaf count.`,
  );
  report.check(
    "node budget",
    issues.length <= budget.maxNodes,
    issues.length <= budget.maxNodes
      ? `${issues.length} node(s), within the budget of ${budget.maxNodes}`
      : `${issues.length} nodes exceeds the budget of ${budget.maxNodes} — drop containers that only group, or publish nothing and propose a "split" into separate specs instead`,
  );

  // ── no singleton container ──────────────────────────────────────────────
  //
  // A container with exactly one child buys nothing and costs twice: a
  // second tracker issue to create, link, label and roll up, and a second
  // place the same acceptance criteria are written down. A container's only
  // job is to GROUP (see `assets/prompts/refiner/system.md`'s "The tree"),
  // and one child is nothing to group. It is also the cheapest way an
  // over-decomposed tree pads its node count, which is why this sits beside
  // the budget rather than with the kind checks above.
  for (const issue of issues) {
    const children = childCount.get(issue.key) ?? 0;
    if (children === 0) continue; // a leaf — not this check's business
    report.check(
      `${issue.key}.children`,
      children >= 2,
      children >= 2
        ? `${children} children`
        : `container has exactly 1 child — a container exists only to group, and one child is nothing to group. Delete ${JSON.stringify(issue.key)} and re-parent its child to ${issue.parent ? JSON.stringify(issue.parent) : `top level (parent "")`}, folding anything ${JSON.stringify(issue.key)} said into the child's own body`,
    );
  }

  // ── depth cap ───────────────────────────────────────────────────────────
  //
  // Two levels by default: one top-level container, and the leaves directly
  // under it. Deeper nesting is exactly how "6 features and 14 stories" gets
  // built — an epic over features over stories READS as organization and
  // COSTS three tiers of tracker issue for one spec.
  //
  // It is also a live bug fix for the Jira provider, not only a scoping rule.
  // `jira.issue_types` maps both `epic` and `feature` to Jira's Epic type by
  // default, and Jira has no Epic-under-Epic nesting (see
  // `core/issues/jira_provider.ts`'s accepted-limitation note) — so a
  // `feature` parented under an `epic`/`feature` reaches `linkChild` and
  // returns a raw Atlassian API error PARTWAY THROUGH a publish that is
  // deliberately not transactional, leaving whatever was already created
  // stranded on the board. At the default `max_depth: 2`, that tree is now
  // refused before a single issue is created. See `WatchRefineConfigSchema`
  // for why raising this above 2 is unsafe on Jira specifically.
  for (const issue of issues) {
    const depth = containmentDepth(issue.key, byKey);
    report.check(
      `${issue.key}.depth`,
      depth <= budget.maxDepth,
      depth <= budget.maxDepth
        ? `level ${depth} of ${budget.maxDepth}`
        : `nested ${depth} levels deep, past the limit of ${budget.maxDepth} — the shape is one top-level container with its leaves directly under it, not an epic over features over stories. Re-parent ${JSON.stringify(issue.key)} onto a top-level container, or delete the intermediate container entirely`,
    );
  }

  // ── every leaf states a user-observable outcome ─────────────────────────
  //
  // A required SLOT, not a banned-word list. A leaf must say in one sentence
  // what someone can do once it lands that they could not before — see
  // `RefinedIssueSchema.user_outcome`. "Cross-browser testing" has no such
  // sentence that isn't obviously a restatement of a slice that already
  // exists, and a model made to write one tends to notice that itself. A word
  // list only renames the ticket (c9a4471); an empty slot has nowhere to
  // hide.
  //
  // This is a BACKSTOP TO THE BUDGET, not a substitute for it: a determined
  // model CAN write a plausible outcome for a process leaf ("an on-call
  // engineer can revert in under 5 minutes"). What actually kills a process
  // leaf is that it must beat a real product slice for one of `maxLeaves`
  // slots. If process leaves reappear despite this check, lower the budget —
  // do not add words to a list.
  //
  // Checked on LEAVES only (a container's outcome is the union of its
  // children's) and for SHAPE only — non-blank, long enough to be a sentence,
  // not the title again. Whether the sentence is TRUE is a reviewer's
  // judgment, not a mechanical fact, and a gate that tried to grade it would
  // be the word list under another name.
  for (const issue of issues) {
    if (childKeys.has(issue.key)) continue;
    const outcome = issue.user_outcome.trim();
    const blank = outcome.length === 0;
    const tooShort = !blank && outcome.length < MIN_OUTCOME_CHARS;
    const echoesTitle = !blank && outcome.toLowerCase() === issue.title.trim().toLowerCase();
    report.check(
      `${issue.key}.user_outcome`,
      !blank && !tooShort && !echoesTitle,
      blank
        ? `blank — every leaf must state, in ONE sentence, what someone can do once it lands that they could not before (e.g. "A workspace owner can invite a teammate by email and see the invite listed as pending."). A slice with no such sentence is process, not product: fold it into the slice whose behavior it actually serves, or drop it`
        : tooShort
          ? `${JSON.stringify(outcome)} is too short to be that sentence — name who, and what they can now do`
          : echoesTitle
            ? `repeats the title verbatim — the title NAMES the slice; this sentence says what changes for a person once it lands`
            : "states a user-observable outcome",
    );
  }

  // ── every leaf names an observable check (#159 ticket C) ────────────────
  //
  // Only when `receipts:` is configured — the epic's promise is that a repo
  // without it behaves exactly as before. With it, the planner turns each
  // leaf's "Observable check:" line into a journey a proof can run, and a
  // bug's "Repro today:" line into the journey that must FAIL on the base
  // revision (red before green). Shape only, like `user_outcome`: whether
  // the check is the RIGHT one is the reviewer's judgment.
  if (run.cfg?.receipts) {
    for (const issue of issues) {
      if (childKeys.has(issue.key)) continue;
      const observable = OBSERVABLE_CHECK.test(issue.body);
      report.check(
        `${issue.key}.observable_check`,
        observable,
        observable
          ? "has an Observable check"
          : 'no "- [ ] Observable check: <actor> runs/opens <what> and sees <result>" line in ## Acceptance criteria — every leaf needs one check a person (or a proof) can run from OUTSIDE the code, e.g. "Observable check: an operator runs `piquette nope` and sees `unknown chain: nope` on the first line"',
      );
      if (issue.kind === "bug") {
        const repro = REPRO_TODAY.test(issue.body);
        report.check(
          `${issue.key}.repro_today`,
          repro,
          repro
            ? "has a Repro today line"
            : 'bug has no "- [ ] Repro today: <steps> → <the wrong result you see now>" line — the proof must show the bug failing on the current code before the fix can show it passing',
        );
      }
    }
  }

  // Monotonicity: no node may be MORE urgent than its own parent — p0 < p1 <
  // p2 < p3, so "more urgent" is a lower rank. Only checked against `parent`
  // (the containment edge), never `blocked_by` (a real dependency can easily
  // be less urgent than the thing it blocks — a p3 prefactor gating a p0
  // feature is normal, not a mistake). A violation here is a decomposition
  // mistake worth a correction round-trip (this gate's `retries: 1` —
  // steps.ts's `refine()`), not a hard block: a p0 story wearing a p3
  // feature's parent almost always means the feature was mis-scored, not the
  // story. The spec's OWN priority ceiling is enforced separately, in
  // `core/refine.ts`'s `publish()` — this gate only knows about the tree,
  // never the spec issue it came from.
  for (const issue of issues) {
    if (!issue.parent) continue;
    const parent = byKey.get(issue.parent);
    if (!parent) continue; // already reported above as an unresolved parent
    const childRank = PRIORITY_RANK[issue.priority] ?? 2;
    const parentRank = PRIORITY_RANK[parent.priority] ?? 2;
    report.check(
      `${issue.key}.priority`,
      childRank >= parentRank,
      childRank >= parentRank
        ? `${issue.priority} — no more urgent than parent ${JSON.stringify(issue.parent)} (${parent.priority})`
        : `${issue.priority} is more urgent than parent ${JSON.stringify(issue.parent)}'s ${parent.priority} — a container's priority is a ceiling for everything under it`,
    );
  }

  return report;
}

/** The plan's declared journeys file (`…/journeys.yaml` or `.yml`), or null. Exported for the prove step (#159 ticket D). */
export function journeysArtifact(envelope: EnvelopeBase): string | null {
  return envelope.artifacts.find((a) => /(^|[\\/])journeys\.ya?ml$/.test(a)) ?? null;
}

/**
 * The plan's journeys are the definition of done (#159 ticket C): a
 * `journeys.yaml` that parses (core/journeys.ts), with at least one unhappy
 * path, and none of the repo's non-negotiables restated (prove() merges
 * those into every proof). OFF unless `receipts:` is configured — an empty
 * report, so a repo without receipts sees no new check at all.
 *
 * Shape only: whether each journey proves the RIGHT thing, and whether every
 * criterion is covered, is the reviewer's judgment — prose criteria can't be
 * matched to commands mechanically. The red-on-base run (ticket D) is what
 * catches a journey that would pass on unchanged code.
 */
export function journeysCover(envelope: EnvelopeBase, run: RunContext): GateReport {
  const report = new GateReport();
  if (!run.cfg?.receipts) return report;

  const declared = journeysArtifact(envelope);
  report.check(
    "journeys.yaml declared",
    declared !== null,
    declared ?? "no journeys.yaml in artifacts — write <context_handoff_dir>/journeys.yaml as your Verification instructions describe, and list its path in artifacts",
  );
  if (declared === null) return report;
  const resolved = resolveClaim(declared, run);
  if (resolved === null || !existsSync(resolved)) {
    report.check(declared, false, resolved === null ? `declared journeys file resolves outside the repo (${run.repo_root})` : "declared journeys file does not exist");
    return report;
  }

  let specs: JourneySpec[];
  try {
    specs = loadJourneysFile(resolved);
  } catch (error) {
    report.check(`${declared} parses`, false, `${(error as Error).message}\nFix the file to match the format in your Verification instructions.`);
    return report;
  }
  const unhappy = specs.filter((s) => s.kind === "unhappy").length;
  report.check(`${declared} parses`, true, `${specs.length} journey(s): ${specs.length - unhappy} happy, ${unhappy} unhappy`);
  report.check(
    "has an unhappy journey",
    unhappy > 0,
    unhappy > 0
      ? `${unhappy} unhappy journey(s)`
      : "every journey is a happy path — the builder only ever tries the path it built. Add at least one `kind: unhappy` journey: bad input, a wrong name, a missing argument, or doing it twice, failing INSIDE the program",
  );
  const restated = specs.filter((s) => s.kind === "non_negotiable" || s.id.startsWith("NN-")).map((s) => s.id);
  report.check(
    "no non-negotiables restated",
    restated.length === 0,
    restated.length === 0
      ? "plan journeys only"
      : `${restated.join(", ")} look like non-negotiables — those are merged into every proof automatically; drop them from the plan (and don't use kind: non_negotiable or an NN- id)`,
  );
  return report;
}

/** Gate factory: the given shell command must exit 0, run from run.repo_root. */
export function testsPass(command: string): GateFn {
  const gate: GateFn = (_envelope, run) => {
    const result = spawnSync(command, { shell: true, encoding: "utf-8", cwd: run.repo_root, env: operatorEnv() });
    const ok = result.status === 0;
    let note = `exit ${result.status}`;
    if (!ok) {
      note += "\n" + ((result.stdout || "") + (result.stderr || "")).slice(-TAIL_CHARS);
    }
    return new GateReport().check(command, ok, note);
  };
  Object.defineProperty(gate, "name", { value: `tests_pass(${command})` });
  return gate;
}
