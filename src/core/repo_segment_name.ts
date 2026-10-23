/**
 * The pure half of the receipt store's repo segment (#214): a repo slug
 * (`host/owner/name`) without its host, parts sanitized and joined with `--`
 * (`acme--api`). Node-free, so the hosted app derives the same segment from a
 * factory's synced repo that `spf prove` wrote under. Empty when nothing is left.
 */
const MAX_SEGMENT = 200;

export const cleanSegmentPart = (s: string): string => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "");

export function segmentFromSlug(slug: string): string {
  return slug
    .split("/")
    .slice(1)
    .map(cleanSegmentPart)
    .filter(Boolean)
    .join("--")
    .slice(0, MAX_SEGMENT)
    .replace(/-+$/, "");
}
