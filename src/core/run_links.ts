/**
 * The tracker issue and the pull request a run belongs to, as the trace
 * records them on its `sessions` row (`issue_label`/`issue_url`,
 * `pr_label`/`pr_url`). Only `piquette watch` knows either: it claims the issue
 * and opens the PR, so an interactive `piquette <chain> "..."` run never has
 * them and its columns stay NULL.
 *
 * A link is a display label plus an optional URL, never a bare number: a
 * Jira key (`BT-1221`) is not a number, and a Bitbucket PR's number means
 * nothing without its host. The label is what the UI prints (`#216`,
 * `BT-1221`); the URL is only ever an absolute http(s) address, so a reader
 * can render it as a link without re-checking it for a `javascript:` scheme.
 *
 * No node imports: the UI's shared code and the Worker may import this.
 */

export interface RunLink {
  /** What a reader sees: `#216`, `BT-1221`. */
  label: string;
  /** Absolute http(s) URL, or null when the tracker/host did not report one. */
  url: string | null;
}

export interface RunLinks {
  issue?: RunLink | null;
  pr?: RunLink | null;
}

const MAX_LABEL = 100;
const MAX_URL = 2000;

/**
 * An absolute http(s) URL, trimmed and capped, or null for anything else (a
 * relative path, `javascript:`, an empty string). A URL carrying credentials
 * in its authority (`https://user:token@host/…`, say from a misconfigured
 * tracker base_url) is null too: links are synced to the hub and shown in the
 * browser, so they must never carry a secret.
 */
export function safeLinkUrl(url: string | null | undefined): string | null {
  const u = (url ?? "").trim();
  const authority = /^https?:\/\/([^\s/?#]+)/i.exec(u)?.[1];
  if (!authority || u.length > MAX_URL || authority.includes("@") || /\s/.test(u)) return null;
  return u;
}

/** A link fit to store: a non-empty single-line label (capped) and a safe URL. `null` when there is no label. */
export function cleanLink(link: RunLink | null | undefined): RunLink | null {
  if (!link) return null;
  const label = String(link.label ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  if (!label) return null;
  return { label, url: safeLinkUrl(link.url) };
}

/** A tracker issue's label: `#42` for a GitHub number, the key itself for Jira (`PROJ-123`). */
export function issueLabel(id: string): string {
  const bare = id.trim().replace(/^#/, "");
  return /^\d+$/.test(bare) ? `#${bare}` : bare;
}

export function issueLink(issue: { id: string; url?: string | null }): RunLink {
  return { label: issueLabel(issue.id), url: safeLinkUrl(issue.url) };
}

/** A PR's label is always `#<number>` (GitHub and Bitbucket both number PRs per repo). An empty URL (a revision pushed to a PR known only by number) is null. */
export function prLink(pr: { number: number; url?: string | null }): RunLink {
  return { label: `#${pr.number}`, url: safeLinkUrl(pr.url) };
}
