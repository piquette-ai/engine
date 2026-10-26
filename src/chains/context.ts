import type { RunObserver } from "../core/console.ts";
import type { RunLinks } from "../core/run_links.ts";

/**
 * What every chain's `main()` receives. The CLI (or, later, the chain
 * registry) resolves every path here — a chain never has its own opinion
 * about where the config file or the working directory are, and none of the
 * historical per-chain hardcoded config-path defaults survive this.
 */
export interface ChainContext {
  prompt: string;
  /**
   * Absolute paths, in load order (agents.loadConfig merges them: later
   * overrides earlier). The built-in packaged default, then an optional
   * discovered `.piquette/piquette.config.yaml` — or just the one explicit `--config`
   * path, standalone, with no built-in underneath it.
   */
  config_paths: string[];
  adw_id: string | null;
  /** Absolute. The anchor session.ensure() resolves repo_root and data_dir from. */
  cwd: string;
  /** The CLI name (`"plan-build-test"`), for session.ensure()'s trace record — see core/session.ts. */
  chain_name: string;
  /**
   * The originating tracker issue's id, only meaningful to the `refine`
   * chain — `steps.publishIssues()` renders it as a `## Parent: #<id>`
   * back-reference on every issue it creates (`core/refine.ts`'s
   * `renderBody`). `null`/omitted for a manual run with no source issue
   * (a bare `piquette refine "<spec text>"`, no `--issue`). Every other chain
   * ignores this field.
   */
  issue_id?: string | null;
  /**
   * The tracker issue (and, rarely this early, the PR) this run is for —
   * `piquette watch` sets it from the issue it claimed, and `steps.startRun()`
   * records it on the session row right after `session.ensure()` (see
   * `core/run_links.ts`). Omitted by every interactive dispatch, whose
   * session row keeps NULL links.
   */
  links?: RunLinks;
  /**
   * True when no human is at the keyboard for this run — `piquette watch`'s
   * daemon lane, a cron/CI invocation — false for an interactive
   * `piquette <chain> "..."`.
   *
   * REQUIRED, deliberately: it is not a flag a call site may forget. Every
   * ChainContext construction site has to state which lane it is, because
   * "unattended" is what makes several safety rules non-negotiable rather
   * than merely advisable — most concretely, a repo-local chain
   * (`.piquette/chains/*.yaml`) may only ADD gates, never drop a built-in one
   * (see `steps.ts`'s GATE_ALLOWLIST comment): there is nobody watching the
   * console to notice that `diffMatchesClaims` was quietly turned off. A
   * boolean that defaults to `false` would make the dangerous lane the one
   * you get by accident.
   */
  unattended: boolean;
  /**
   * `piquette run --allow-protected-branch`: this run may commit onto a branch in
   * `git.protected_branches` (#97). Per run, never persisted; `steps.commitEnvelope`
   * records the override in the trace when it actually uses it. Omitted = guarded.
   */
  allow_protected_branch?: boolean;
  /**
   * Absolute path of the YAML file this chain was loaded from, when it is a
   * repo-local chain (`.piquette/chains/<name>.yaml` — see
   * `chains/repo_chains.ts`). `undefined` for a built-in chain, which has no
   * file: it IS piquette's own code.
   *
   * `steps.startRun()` writes this into the trace as a single
   * `chain_source` log event, so a session in the UI or in `piquette trace` can
   * always answer "whose chain definition ran this?" — the answer stops
   * being obvious the moment a target repo can ship its own chains, and the
   * trace is the only durable record (the YAML file itself may have been
   * edited by the time anyone reads the run back).
   */
  chain_source?: string;
  /**
   * The tree's state before the work this run belongs to started, as
   * `stagingSnapshot()` fingerprints it. `steps.startRun()` records it as
   * the run's staging baseline instead of snapshotting the tree itself.
   * Set only by `piquette loop`, which mints a new adw_id every iteration but
   * never cleans the tree between them: without it, an unaccepted
   * iteration's uncommitted edits would be baselined as the human's, and
   * the next iteration that touched them again would be refused as mixed.
   * Omitted everywhere else: a lone run's baseline is the tree it starts on
   * (`piquette watch` passes `{}` explicitly: its worktree is piquette's own, and
   * `watch.setup` output is not a human's work).
   */
  baseline_tree?: Record<string, string>;
  /**
   * A live TTY view's hook into this run's `Console` — see `RunObserver`'s
   * doc comment (`core/console.ts`). Optional and omitted by every
   * construction site except an interactive `cli/commands/run.ts`
   * dispatch: `piquette watch`'s per-issue runs, `piquette fanout`'s per-attempt
   * runs, the `refine` chain, and every test all continue to build a
   * plain, unobserved `Console` exactly as before this field existed.
   */
  render_hooks?: {
    sink?: (line: string) => void;
    observer?: RunObserver | null;
    /**
     * The live dashboard's own handoff pair — call `pause()` before a
     * chain shows its own competing prompt (today, only `simple_sdlc.ts`'s
     * human sign-off gate) and `resume()` once it's done, symmetrically,
     * in a `finally`. Ink refuses a second `render()` on the same stdout
     * while a prior instance is still live, so this isn't optional
     * politeness — skipping `pause()` before mounting another Ink surface
     * (or even a plain `readline` prompt sharing the same stdin/stdout,
     * given the dashboard's own live-updating timer keeps writing to it)
     * corrupts both.
     */
    pause?: () => void | Promise<void>;
    resume?: () => void;
  };
}
