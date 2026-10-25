/**
 * What an agent may CHANGE, enforced in code after the fact.
 *
 * `tools:` is a capability list, not a sandbox, and two holes make it
 * unenforceable on its own:
 *
 *   * `bash` runs anything. A builder handed bash to run a test suite can also
 *     run `git checkout adws/` — which is not hypothetical: one did, discarding
 *     uncommitted changes to the very quality check it was about to be judged by.
 *   * `write` reaches any path, not just the one report file an agent was given
 *     it for. A reviewer configured with "no edit, so it cannot quietly fix"
 *     could still rewrite the code it was reviewing.
 *
 * So permission is verified the way every other claim in this system is —
 * after the fact, against the repo itself. `snapshot()` fingerprints the working
 * tree's change-set before an agent runs; `enforce()` compares it afterwards and
 * fails the phase if the agent touched anything outside its allowlist.
 *
 * Comparing change-sets, rather than watching for writes, is what catches the
 * `git checkout` case: a path that was modified before the agent ran and is clean
 * afterwards has been reverted, and a reversion is a modification. Appearing,
 * disappearing, and changing all count.
 *
 * A breach is NOT a gate violation. Gates are for work an agent can be asked to
 * redo; a breach cannot be corrected by re-prompting, because the write already
 * happened. It aborts the phase and names every offending path.
 *
 * Two keys drive it, both in spf.config.yaml:
 *     defaults.protected_files   paths no agent may touch unless it names them itself
 *     agents[].writes      undefined = unrestricted · [] = read-only · [...] = only these
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { AgentConfig, SFConfig } from "./data_types.ts";

export class PermissionBreach extends Error {}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return result.status === 0 ? result.stdout : "";
}

interface RunLike {
  repo_root: string;
  cfg: SFConfig;
}

/** HEAD sha at `snapshot()` time, keyed by the snapshot object (keeps its `Record<path, fingerprint>` shape and every caller's signature intact). */
const startHeads = new WeakMap<Record<string, string>, string>();

/**
 * Paths changed by commits made since `startSha` — `git diff --name-only
 * <startSha> HEAD`, a tree-to-tree diff, so it is correct whether HEAD is a
 * descendant of `startSha` or was rewritten (reset, amend, rebase).
 * `--no-renames` reports a rename as delete + add, so BOTH the old and the
 * new path are checked. Only tracked content can appear here, so gitignored
 * paths (data_dir) stay excluded.
 */
function committedPaths(run: RunLike, startSha: string): string[] {
  const out = git(["diff", "--name-only", "--no-renames", "-z", startSha, "HEAD"], run.repo_root);
  return out.split("\0").filter(Boolean);
}

/**
 * Fingerprint every path the working tree currently differs on.
 *
 * Tracked files carry their numstat counts, so an edit to an already-dirty
 * file still registers as a change. Untracked files are listed by name.
 * Gitignored paths never appear, which is why the session runtime under
 * `data_dir` — where handoff files legitimately land — needs no special case.
 *
 * `--no-renames`: with rename detection on, a staged rename's numstat path is
 * `{old => new}.ts`, which names neither file. `commitEnvelope` hands these
 * keys to `git add` as literal pathspecs, so every key must be a real path —
 * a rename is reported as the old path vanishing and the new one appearing.
 * `-z` for the same reason: without it `core.quotePath` C-quotes any name
 * with a non-ASCII byte, tab, quote or backslash (`"caf\303\251.md"`),
 * which names no file either. NUL-separated output is never quoted.
 */
export function snapshot(run: RunLike): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  // The working-tree diff is taken against HEAD, so a COMMIT made during the
  // turn moves HEAD and erases its own change from both snapshots. Remember
  // where HEAD was; `enforce()` diffs it against the new HEAD to catch that.
  const head = git(["rev-parse", "--verify", "-q", "HEAD"], run.repo_root).trim();
  if (head) startHeads.set(fingerprints, head);
  // -z numstat (no renames): "<added>\t<deleted>\t<path>\0" per file.
  for (const record of git(["diff", "HEAD", "--numstat", "--no-renames", "-z"], run.repo_root).split("\0")) {
    const match = /^([^\t]*)\t([^\t]*)\t(.+)$/s.exec(record);
    if (match) fingerprints[match[3]!] = `${match[1]},${match[2]}`;
  }
  for (const p of git(["ls-files", "--others", "--exclude-standard", "-z"], run.repo_root).split("\0")) {
    if (p) fingerprints[p] = "untracked";
  }
  return fingerprints;
}

/**
 * `snapshot()` with each path's working-tree CONTENT folded into its
 * fingerprint — what explicit staging (`commitEnvelope`, against the
 * baseline `startRun` records) compares. The permission check's numstat
 * fingerprints are too coarse for it: every untracked file is the constant
 * "untracked", every binary is "-,-", and rewriting a human's dirty line
 * with another one keeps the same counts, so a run's edit to a file the
 * human already had dirty would read as untouched — left unstaged instead
 * of refused as mixed. Kept separate so `enforce()`/`rollBack()` still see
 * the plain "untracked" marker they key on.
 */
export function stagingSnapshot(run: RunLike, ignore: string[] = []): Record<string, string> {
  const fingerprints = snapshot(run);
  for (const p of Object.keys(fingerprints)) {
    const abs = path.join(run.repo_root, p);
    if (ignore.some((i) => abs === i || abs.startsWith(i + path.sep))) delete fingerprints[p];
    else fingerprints[p] = `${fingerprints[p]}:${contentHash(abs)}`;
  }
  return fingerprints;
}

/**
 * The absolute paths spf itself writes while a run is live — the data dir,
 * the sessions dir, the sqlite trace db and its journal files — for
 * `stagingSnapshot`'s `ignore`. Normally gitignored (and so invisible to
 * `snapshot()` anyway); when a repo has not ignored them, they change under
 * every run, and would otherwise read as a run edit to a file that was
 * already dirty — refusing every commit — or get committed as the run's
 * work. The baseline and the commit-time snapshot must pass the same list.
 */
export function stagingRuntimePaths(data: { data_dir: string; sessions_dir: string; db_path: string | null }): string[] {
  const db = data.db_path ? [data.db_path, `${data.db_path}-wal`, `${data.db_path}-shm`, `${data.db_path}-journal`] : [];
  return [data.data_dir, data.sessions_dir, ...db];
}

/** sha1 of a file's bytes (a symlink's target), or a marker for a path that is not a plain file. */
function contentHash(file: string): string {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return `link:${readlinkSync(file)}`;
    if (!stat.isFile()) return "not-a-file";
    return createHash("sha1").update(readFileSync(file)).digest("hex");
  } catch {
    return "missing";
  }
}

/** Every path whose state differs — appeared, vanished, or was rewritten. */
export function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...all].filter((p) => before[p] !== after[p]).sort();
}

/**
 * Translate a pattern, with `*` stopping at a path separator.
 *
 * A naive glob-to-regex would let `*` cross `/`, which quietly widens every
 * pattern: `adws/adw_*.ts` would match `adws/adw_data/sessions/x/y.ts` as well
 * as the ADW scripts it means. `**` is the way to say "cross directories".
 */
function globToRegex(pattern: string): RegExp {
  let out = "";
  let i = 0;
  // A LEADING "**/" is the common "any depth, including the repo root"
  // idiom (gitignore, npm, ...) — "**/package-lock.json" must match both a
  // root-level "package-lock.json" and a nested "a/b/package-lock.json".
  // The plain "**" -> ".*" rule below (still applied to a "**" anywhere else
  // in a pattern) cannot express that alone: ".*" still requires the
  // literal "/" that follows it in the pattern text, so a root-level file
  // with no directory prefix would never match. Only this one leading shape
  // gets the optional-prefix translation; `defaults.read_only_ignore`'s own
  // default patterns are exactly this shape.
  if (pattern.startsWith("**/")) {
    out += "(?:.*/)?";
    i = 3;
  }
  while (i < pattern.length) {
    const char = pattern[i];
    if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (char === "*") {
      out += "[^/]*";
      i += 1;
    } else if (char === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

function matches(p: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return p.startsWith(pattern); // directory prefix
  if (pattern.includes("*") || pattern.includes("?")) return globToRegex(pattern).test(p);
  return p === pattern;
}

/**
 * The session runtime, which EVERY agent must be able to write.
 *
 * `context_handoff/` is the one place agents hand work to each other, and an
 * agent's own prompts, raw_output.jsonl, and envelope.json land beside it.
 * Scout writes its findings there, the reviewer its review, the planner its
 * plan — a read-only agent is read-only with respect to the REPO, never with
 * respect to its own report.
 *
 * This is granted from `data_dir` rather than left to .gitignore. The runtime
 * is normally ignored, so it never even appears in a snapshot — but an agent's
 * ability to record its work must not hang on a gitignore entry that someone
 * can delete or that a changed `data_dir` can outgrow.
 */
export function alwaysWritable(cfg: SFConfig): string[] {
  return [cfg.defaults.data_dir.replace(/\/+$/, "") + "/"];
}

/** Session runtime first, then the agent's own list, then what is protected. */
export function permitted(p: string, agent: AgentConfig, cfg: SFConfig): boolean {
  if (alwaysWritable(cfg).some((pattern) => matches(p, pattern))) return true;
  if ((agent.writes || []).some((pattern) => matches(p, pattern))) return true; // naming a path is what unlocks a protected one
  if (cfg.defaults.protected_files.some((pattern) => matches(p, pattern))) return false;
  return agent.writes === undefined || agent.writes === null; // unrestricted = undefined/null, [] = no repo writes
}

/**
 * Undo one unauthorized change. Returns a word describing what happened.
 *
 * Only changes the agent INTRODUCED are undone. A path that was already dirty
 * when the agent started is left exactly as it is: the operator had
 * uncommitted work there, and discarding it to tidy up would be the same harm
 * this module exists to prevent, committed by the cleanup instead of the agent.
 */
function rollBack(
  run: RunLike,
  p: string,
  before: Record<string, string>,
  after: Record<string, string>,
  committed: Map<string, string>,
): string {
  // Committed breaches that were clean before the turn are reverted in ONE batch by `enforce()`.
  if (committed.has(p) && p in before) {
    // Already dirty beforehand AND committed by the agent: the operator's
    // uncommitted content went into the agent's commit, so nothing was lost,
    // but the protected change now sits in HEAD. Restoring the start-sha
    // content would destroy that pre-turn work (snapshot() keeps no content),
    // so it is deliberately left in place — and reported as such.
    return "COMMITTED-BY-AGENT (was already modified before the turn; included in the agent's commit and left in HEAD, not reverted)";
  }
  if (p in before) {
    // Already dirty beforehand. If it is gone from the diff now, the agent
    // reverted an engineer's uncommitted work and the content is not ours
    // to reconstruct — say so loudly rather than pretend it was handled.
    return !(p in after)
      ? "REVERTED-BY-AGENT (uncommitted work lost, cannot restore)"
      : "left as-is (was already modified)";
  }
  if (after[p] === "untracked") {
    try {
      unlinkSync(path.join(run.repo_root, p));
      return "deleted";
    } catch (error) {
      return `could not delete (${(error as Error).message})`;
    }
  }
  const result = spawnSync("git", ["checkout", "--", p], { cwd: run.repo_root, encoding: "utf-8" });
  return result.status === 0 ? "rolled back" : "could not roll back";
}

/**
 * Undo COMMITTED changes to `paths`: put each back to its content at
 * `startSha` (or remove it if it did not exist then) and record that in ONE
 * new commit. A new commit rather than a reset/amend, deliberately: the agent
 * may have made other, legitimate commits around the bad one, and rewriting
 * history would discard them (and would break any phase that already pushed).
 * The branch's net diff against its base ends up clean; the audit trail of
 * what happened stays in history.
 */
function restoreCommitted(run: RunLike, paths: string[], startSha: string): boolean {
  const opts = { cwd: run.repo_root, encoding: "utf-8" as const };
  // Put index + worktree for exactly `paths` back to HEAD (used when the
  // restore cannot be completed, so the repo is not left half-restored).
  const undoStagedRestore = () => {
    for (const p of paths) {
      const inHead = spawnSync("git", ["cat-file", "-e", `HEAD:${p}`], opts).status === 0;
      if (inHead) spawnSync("git", ["checkout", "HEAD", "--", p], opts);
      else {
        spawnSync("git", ["rm", "-f", "-q", "--cached", "--ignore-unmatch", "--", p], opts);
        try {
          unlinkSync(path.join(run.repo_root, p));
        } catch {
          /* already gone */
        }
      }
    }
  };
  for (const p of paths) {
    const existed = spawnSync("git", ["cat-file", "-e", `${startSha}:${p}`], opts).status === 0;
    const r = existed
      ? spawnSync("git", ["checkout", startSha, "--", p], opts)
      : spawnSync("git", ["rm", "-f", "-q", "--ignore-unmatch", "--", p], opts);
    if (r.status !== 0) {
      undoStagedRestore();
      return false;
    }
  }
  // `-c` identity only as a fallback so a bare CI checkout can still commit.
  const hasIdent = spawnSync("git", ["config", "user.email"], opts).stdout.trim() !== "";
  const ident = hasIdent ? [] : ["-c", "user.name=spf", "-c", "user.email=spf@localhost"];
  const result = spawnSync(
    "git",
    [...ident, "commit", "-q", "--no-verify", "-m", "spf: revert unauthorized change to protected/out-of-scope paths", "--", ...paths],
    opts,
  );
  // "nothing to commit" (status 1) means the tree already matches — still restored.
  if (result.status === 0 || /nothing (to commit|added)|no changes/i.test(`${result.stdout}${result.stderr}`)) return true;
  undoStagedRestore(); // commit failed (signing, mid-merge/rebase, ...): leave the repo consistent
  return false;
}

/**
 * True when `p` matches one of `defaults.read_only_ignore`'s patterns —
 * dependency-manager bookkeeping (a lockfile), not the repo's intent. See
 * that field's own doc comment (`data_types.ts`) for why it exists and what
 * rolling one back "silently" means. Necessary but not sufficient — see
 * `isSafeToIgnore`, which is what `enforce()` actually gates on, and which
 * ALSO requires the path not match `defaults.protected_files`:
 * `read_only_ignore` is a narrow "this churn is incidental, not intent"
 * carve-out, and must never be read as a backdoor around a path an operator
 * explicitly locked down. `protected_files` always wins — a path listed
 * there is never ignorable via `read_only_ignore`, regardless of role.
 */
function isIgnorableChurn(p: string, cfg: SFConfig): boolean {
  return (cfg.defaults.read_only_ignore ?? []).some((pattern) => matches(p, pattern));
}

/**
 * Whether an ignorable-churn path is actually safe to ignore for THIS phase.
 * Both conditions are required, and either one failing means: real breach,
 * `rollBack`'s own honest outcome string, no silent "ignored".
 *
 *  - The agent is a TRUE read-only role (`writes: []`), not merely
 *    write-restricted (`writes: [...]`). A write-restricted agent that
 *    changes `package.json` and its lockfile together left an
 *    INCONSISTENT tree, not incidental dependency-manager bookkeeping —
 *    `read_only_ignore` exists for the read-only case this module's header
 *    describes (a read that happens to rewrite a lockfile), never as a
 *    blanket exemption for one specific file pattern regardless of role.
 *  - The path was CLEAN before this phase started (`!(p in before)`). Only
 *    then does `rollBack` below actually take the "not in before" branch
 *    and restore it (delete the untracked file, or `git checkout --` the
 *    tracked one back to HEAD). A path that was ALREADY dirty when the
 *    agent started hits `rollBack`'s OTHER branch instead — "left as-is"
 *    or, if the agent discarded that uncommitted work, "REVERTED-BY-AGENT
 *    (uncommitted work lost, cannot restore)" — and neither of those is a
 *    restore. Calling that "ignored" would report a repair that never
 *    happened; it must fail the phase like any other breach instead.
 *  - The path does NOT match `defaults.protected_files`. `protected_files`
 *    is what made this a breach in the first place (`permitted()` above);
 *    `read_only_ignore` matching the SAME path too is not a stronger claim
 *    that the write was safe, it just means an operator's lockfile-churn
 *    pattern happens to overlap a path they explicitly protected. Without
 *    this check a `read_only_ignore` entry could silently exempt a
 *    read-only agent from `protected_files` — the very thing `protected_files`
 *    exists to prevent regardless of an agent's `writes` role. So a
 *    protected path is never ignorable: it always falls through to the
 *    real-breach path below, still rolled back, but failing the phase.
 */
function isSafeToIgnore(p: string, agent: AgentConfig, cfg: SFConfig, before: Record<string, string>): boolean {
  const isTrueReadOnlyAgent = Array.isArray(agent.writes) && agent.writes.length === 0;
  const isProtected = cfg.defaults.protected_files.some((pattern) => matches(p, pattern));
  return isTrueReadOnlyAgent && isIgnorableChurn(p, cfg) && !(p in before) && !isProtected;
}

/**
 * Compare the tree against `before`; undo and raise if the agent overstepped.
 *
 * Returns the paths it legitimately changed, so the trace records what an
 * agent actually touched rather than only what it claimed in its envelope.
 *
 * Detection alone would leave the repo holding the unauthorized change while
 * reporting a failure, so anything the agent introduced outside its allowlist
 * is rolled back before the phase dies. What it cannot undo, it names.
 *
 * `defaults.read_only_ignore` carves out one exception to "names, fails" —
 * but only where `isSafeToIgnore` says restoring is actually possible (see
 * its own doc comment): a TRUE read-only agent (`writes: []`) that churned
 * a lockfile that was CLEAN before this phase. That one case is STILL
 * rolled back unconditionally like any other breach — an ignored path is
 * never left standing — it just does not, on its own, fail the phase.
 * Everything else `isIgnorableChurn` alone would have matched (a dirty-before
 * path, an agent that reverted uncommitted work, a write-restricted rather
 * than read-only agent) falls through to the real-breach path below instead.
 * `onIgnored`, when given, is called once with every safely-ignored path
 * before returning, so a caller with a logger (`agents.ts`'s `execute()`)
 * can print the one required info line — this module has no logger of its
 * own to call (`RunLike` is only `repo_root`/`cfg`), so the caller does the
 * printing.
 */
export function enforce(
  run: RunLike,
  _phase: unknown,
  agent: AgentConfig,
  before: Record<string, string>,
  onIgnored?: (paths: string[]) => void,
): string[] {
  const after = snapshot(run);
  const startSha = startHeads.get(before);
  const committed = new Map<string, string>();
  if (startSha && startSha !== startHeads.get(after)) {
    for (const p of committedPaths(run, startSha)) committed.set(p, startSha);
  }
  const touched = [...new Set([...changedPaths(before, after), ...committed.keys()])].sort();
  const breaches = touched.filter((p) => !permitted(p, agent, run.cfg));
  if (breaches.length === 0) return touched;

  const ignored = breaches.filter((p) => isSafeToIgnore(p, agent, run.cfg, before));
  const realBreaches = breaches.filter((p) => !ignored.includes(p));

  // Roll back EVERY breach, ignored ones included — restoring the tree is
  // unconditional; only whether it fails the PHASE differs below.
  const outcomes = new Map<string, string>();
  // ONE revert commit for every committed breach that was clean before the turn.
  const toRevert = breaches.filter((p) => committed.has(p) && !(p in before));
  if (toRevert.length > 0 && startSha) {
    const label = restoreCommitted(run, toRevert, startSha)
      ? "reverted (committed change undone in a new commit)"
      : "could not revert committed change";
    for (const p of toRevert) outcomes.set(p, label);
  }
  for (const p of breaches) if (!outcomes.has(p)) outcomes.set(p, rollBack(run, p, before, after, committed));

  if (ignored.length > 0) onIgnored?.(ignored);
  if (realBreaches.length === 0) return touched; // nothing left but ignored churn — rolled back, phase still passes

  const scope =
    agent.writes && agent.writes.length === 0
      ? "read-only"
      : agent.writes
        ? `limited to ${JSON.stringify(agent.writes)}`
        : `barred from ${JSON.stringify(run.cfg.defaults.protected_files)}`;
  const detail = realBreaches.map((p) => `  - ${p} — ${outcomes.get(p)}`).join("\n");
  throw new PermissionBreach(
    `${agent.name} is ${scope} but modified ${realBreaches.length} path(s):\n${detail}`,
  );
}
