/**
 * The store-key segment a repo's receipts live under (#214). Node (it asks git).
 *
 * The new segment is the repo's identity without the host (`acme--api` for
 * `github.com/acme/api`), so two clones, a fork and every worktree of one repo
 * share a segment and a shared bucket never holds the same repo twice. The old
 * segment was the checkout directory's name; `segmentForRun` keeps a run that
 * already wrote under it on it, so one run is never split across two segments.
 */
import path from "node:path";
import { cleanSegmentPart, segmentFromSlug } from "./repo_segment_name.ts";
import type { SFConfig } from "./data_types.ts";
import type { ReceiptStore } from "./receipt_store.ts";
import { mainWorktreeName, resolveRepoSlug } from "./sync/identity.ts";

const clean = cleanSegmentPart;

/** The old segment: a lowercased directory name, `[a-z0-9._-]`, never empty. Kept verbatim so existing receipts stay readable. */
export function legacyRepoSegment(repoRoot: string): string {
  const s = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "");
  return s || "repo";
}

/** `resolveRepoSlug` minus the host, parts sanitized and joined with `--`. Never throws. */
export function repoSegment(repoRoot: string, cfg?: Pick<SFConfig, "sync" | "watch">): string {
  try {
    const slug = resolveRepoSlug((cfg ?? {}) as Pick<SFConfig, "sync" | "watch">, { repo_root: repoRoot });
    const segment = segmentFromSlug(slug);
    if (segment) return segment;
    const main = mainWorktreeName(repoRoot);
    return (main && clean(main)) || legacyRepoSegment(repoRoot);
  } catch {
    return legacyRepoSegment(repoRoot);
  }
}

/** The segment a run writes under: the legacy one when that run already has attempts there, else the repo's. */
export async function segmentForRun(store: Pick<ReceiptStore, "list">, repoRoot: string, runId: string, cfg?: Pick<SFConfig, "sync" | "watch">): Promise<string> {
  const fresh = repoSegment(repoRoot, cfg);
  const legacy = legacyRepoSegment(repoRoot);
  if (legacy === fresh) return fresh;
  try {
    if ((await store.list(`${legacy}/attempts/${runId}/`)).length > 0) return legacy;
  } catch {
    /* an unreadable store is no reason to guess legacy */
  }
  return fresh;
}
