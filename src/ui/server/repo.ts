/**
 * Repo slug ("owner/repo") for the dashboard breadcrumb, derived from the
 * target repo's `origin` remote. Best-effort: any failure yields undefined so
 * the UI simply omits the crumb.
 */
import { execFileSync } from "node:child_process";
import { parseRemote } from "../../core/sync/identity.ts";

/** Parses https/ssh/scp-style git remote URLs (GitHub, Bitbucket, GitLab...) into "owner/repo" — the host-less half of `core/sync/identity.ts`'s `parseRemote`. */
export function parseRepoSlug(remoteUrl: string): string | undefined {
  return parseRemote(remoteUrl)?.path;
}

export function detectRepoSlug(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_DIR: undefined },
    });
    return parseRepoSlug(out);
  } catch {
    return undefined;
  }
}
