import { receiptRepoSegment } from '@shared/receipt_links'
import { health, hosted } from './health'

function ownerName(slug: string): string {
  const parts = slug.split('/')
  return parts.length > 2 && parts[0].includes('.') ? parts.slice(1).join('/') : slug
}

/**
 * The repository a receipt belongs to, as the slug people write (`owner/name`; the host
 * of a `host/owner/name` hosted row is dropped). The store's segment is not
 * always a repo: local receipts written before the store keyed by repo used the
 * run id as the segment (and as the receipt's own `repo` field), so a value equal
 * to the run id is not a repo. A local `spf ui` serves exactly one repo, so that
 * repo is the honest answer there; anything else is unknown (null, shown as '—').
 */
export function receiptRepoSlug(segment: string | null | undefined, runId: string): string | null {
  const seg = segment && segment !== runId ? segment : null
  if (hosted.value) {
    if (!seg) return null
    const slug = health.value?.repos?.find((r) => receiptRepoSegment(r) === seg)
    return ownerName(slug ?? seg.replaceAll('--', '/'))
  }
  if (seg?.includes('--')) return ownerName(seg.replaceAll('--', '/'))
  return health.value?.repo || null
}
