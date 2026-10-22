/**
 * Repo slug ("owner/repo") for the dashboard breadcrumb, derived from the
 * target repo's `origin` remote. Best-effort: any failure yields undefined so
 * the UI simply omits the crumb.
 */
import { execFileSync } from "node:child_process";

/** Parses https/ssh/scp-style git remote URLs (GitHub, Bitbucket, GitLab...) into "owner/repo". */
export function parseRepoSlug(remoteUrl: string): string | undefined {
  const url = remoteUrl.trim();
  // A local-path remote has no owner/repo to show.
  if (/^file:/i.test(url)) return undefined;
  // scheme://[user@]host/path, or scp-style [user@]host:path. The scp host must
  // be 2+ chars so a Windows drive path ("C:/src/repo") is not read as a remote,
  // and its path must not start with "//" so "file:///..." is not either.
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?[^/]+\/|(?:[^/@\s]+@)?[^:/\s]{2,}:(?!\/\/))(.+?)(?:\.git)?\/?$/i.exec(url);
  if (!m) return undefined;
  // Azure DevOps puts a literal "_git" between project and repo.
  const parts = m[1]!.split("/").filter((p) => p && p !== "_git");
  // Azure DevOps SSH remotes carry a protocol-version segment before the org
  // ("ssh.dev.azure.com:v3/org/proj/repo"); it is not part of the repo path.
  if (parts[0] === "v3" && /(?:^|[@.])(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]/i.test(url)) {
    parts.shift();
  }
  if (parts.length < 2) return undefined;
  // Keep the full namespace path (GitLab subgroups, Azure org/project); the UI shows only the last segment.
  return parts.join("/");
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
