/**
 * Inline poster for the PR (#203, part of #197): the recorded head proof's
 * `poster.gif`, committed to an orphan `piquette-receipts` branch and embedded in
 * the Verification section so it animates on the PR itself.
 *
 * Git plumbing only — `hash-object -w`, a throwaway index (`read-tree` /
 * `update-index` / `write-tree`), `commit-tree`, and a non-force `push` of the
 * commit to the branch ref. Nothing is ever checked out, so it cannot touch
 * the worktree it runs from. The new commit's parent is the remote's current
 * `piquette-receipts` tip (none on the first run, which makes the branch an
 * orphan). A push rejected as non-fast-forward (someone else landed a poster
 * first) refetches and retries once; any other failure gives up at once. The
 * push skips client hooks (`--no-verify`): the branch carries only images, and
 * the repo's pre-push suite would be pure cost on it. Network calls have a
 * timeout so a stalled remote cannot freeze the watch daemon.
 *
 * BEST-EFFORT, like all verification: every failure — no poster, over the
 * size cap, no remote, push refused — returns `undefined` with a logged
 * reason, and the PR keeps its links-only receipt. Nothing here throws.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReceiptStore } from "./receipt_store.ts";

export const RECEIPTS_BRANCH = "piquette-receipts";
export const DEFAULT_POSTER_MAX_MB = 5;

export interface PosterPublishParams {
  store: ReceiptStore;
  /** Store key of the poster: `<repo>/attempts/<run_id>/<attempt>/poster.gif`. */
  key: string;
  /** Any directory inside the repo whose `remote` should receive the branch. */
  cwd: string;
  remote?: string;
  maxBytes: number;
  log: (message: string) => void;
}

/** `<run_id>/<attempt>/poster.gif` — where the poster lives on the branch — or `undefined` for a key that isn't shaped like a proof's. */
export function posterBranchPath(key: string): string | undefined {
  const [, , runId, attempt, file] = key.split("/");
  return runId && attempt && file === "poster.gif" ? `${runId}/${attempt}/${file}` : undefined;
}

/**
 * The GitHub URL that serves the committed poster as an image (works inline in a private repo's PR for a signed-in viewer).
 * `ref` should be the commit that holds the poster, so the URL is immutable: a later poster at the same path can't change an older PR's image.
 */
export function posterBlobUrl(repo: string, branchPath: string, ref: string = RECEIPTS_BRANCH): string {
  return `https://github.com/${repo}/blob/${ref}/${branchPath.split("/").map(encodeURIComponent).join("/")}?raw=true`;
}

const NETWORK_TIMEOUT_MS = 120_000;

function git(cwd: string, args: string[], opts: { input?: Uint8Array; env?: NodeJS.ProcessEnv; timeout?: number } = {}): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, input: opts.input, env: opts.env ?? process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(opts.timeout ? { timeout: opts.timeout } : {}) });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.error?.message || "").trim() };
}

/** The line of a failed push that says why: the `! [rejected]` / `! [remote rejected]` / `fatal:` line, else the first. */
function rejectionLine(stderr: string): string {
  const lines = stderr.split("\n");
  return (lines.find((l) => /^\s*!|^(fatal|error):/.test(l)) ?? lines[0] ?? "").trim();
}

/** Commits the poster to `piquette-receipts` and returns its path on the branch and the commit that holds it, or `undefined` (reason logged) when it didn't land. */
export async function publishPoster(p: PosterPublishParams): Promise<{ path: string; commit: string } | undefined> {
  const remote = p.remote ?? "origin";
  let scratch: string | undefined;
  try {
    const branchPath = posterBranchPath(p.key);
    if (!branchPath) {
      p.log(`receipts: poster not published — ${JSON.stringify(p.key)} is not a <repo>/attempts/<run_id>/<attempt>/poster.gif key`);
      return undefined;
    }
    const bytes = await p.store.get(p.key);
    if (!bytes) {
      p.log(`receipts: poster not published — ${p.key} is not in the receipt store`);
      return undefined;
    }
    if (bytes.byteLength > p.maxBytes) {
      p.log(`receipts: poster not published — ${p.key} is ${(bytes.byteLength / 1048576).toFixed(1)} MB, over the ${(p.maxBytes / 1048576).toFixed(1)} MB cap (receipts.poster_max_mb)`);
      return undefined;
    }

    const blob = git(p.cwd, ["hash-object", "-w", "--stdin"], { input: bytes });
    if (!blob.ok || !blob.out) throw new Error(`git hash-object failed: ${blob.err}`);
    scratch = mkdtempSync(path.join(tmpdir(), "piquette-poster-"));
    const ref = `refs/heads/${RECEIPTS_BRANCH}`;
    let lastError = "";

    for (let attempt = 1; attempt <= 2; attempt++) {
      // The remote's current tip, fetched so its tree is readable here. Absent
      // (first run) means the new commit has no parent: an orphan branch.
      const ls = git(p.cwd, ["ls-remote", remote, ref], { timeout: NETWORK_TIMEOUT_MS });
      if (!ls.ok) throw new Error(`git ls-remote ${remote} failed: ${ls.err}`);
      const tip = ls.out.split(/\s+/)[0] || undefined;
      if (tip) {
        const fetched = git(p.cwd, ["fetch", "--no-tags", remote, ref], { timeout: NETWORK_TIMEOUT_MS });
        if (!fetched.ok) throw new Error(`git fetch ${remote} ${ref} failed: ${fetched.err}`);
      }

      // A throwaway index: the branch's tree plus this one file, written
      // without a checkout and without touching the real index.
      const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, `index-${attempt}`) };
      if (tip && !git(p.cwd, ["read-tree", tip], { env }).ok) throw new Error(`git read-tree ${tip} failed`);
      const added = git(p.cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob.out},${branchPath}`], { env });
      if (!added.ok) throw new Error(`git update-index failed: ${added.err}`);
      const tree = git(p.cwd, ["write-tree"], { env });
      if (!tree.ok) throw new Error(`git write-tree failed: ${tree.err}`);

      // Already there with these exact bytes (a re-run of the same attempt): nothing to commit.
      if (tip && git(p.cwd, ["rev-parse", `${tip}^{tree}`]).out === tree.out) return { path: branchPath, commit: tip };

      const identity: string[] = [];
      for (const [key, fallback] of [["user.name", "piquette"], ["user.email", "piquette@users.noreply.github.com"]] as const) {
        if (!git(p.cwd, ["config", key]).out) identity.push("-c", `${key}=${fallback}`);
      }
      const commit = git(
        p.cwd,
        [...identity, "commit-tree", tree.out, ...(tip ? ["-p", tip] : []), "-m", `receipts: poster for ${branchPath.split("/").slice(0, 2).join("/")}`],
      );
      if (!commit.ok || !commit.out) throw new Error(`git commit-tree failed: ${commit.err}`);

      // Non-force: a ref that moved under us is rejected, never overwritten.
      const pushed = git(p.cwd, ["push", "--no-verify", remote, `${commit.out}:${ref}`], { timeout: NETWORK_TIMEOUT_MS });
      if (pushed.ok) return { path: branchPath, commit: commit.out };
      lastError = pushed.err;
      // Only a ref that moved under us is worth a retry: non-fast-forward, a failed ref update, or a lease that lost ("stale info" locally, "incorrect old value provided" from the server — which one depends on the git version). Auth, network and server-hook failures won't change.
      if (!/non-fast-forward|fetch first|failed to update ref|stale info|incorrect old value/i.test(lastError)) {
        p.log(`receipts: poster not published — push to ${remote} ${RECEIPTS_BRANCH} failed (${rejectionLine(lastError)})`);
        return undefined;
      }
    }
    p.log(`receipts: poster not published — push to ${remote} ${RECEIPTS_BRANCH} was rejected twice (${rejectionLine(lastError)})`);
    return undefined;
  } catch (error) {
    p.log(`receipts: poster not published — ${(error as Error).message}`);
    return undefined;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
