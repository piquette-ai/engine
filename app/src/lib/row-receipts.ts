import { shallowReactive } from 'vue'
import type { ReceiptsRunResponse, SessionSummary } from './types'
import { fetchReceiptRun } from './api'
import { isProvePhase, loadReceipts, receiptRepoSegment, settledProveKey, summarizeReceipts } from '@shared/receipt_links'
import { sessionKey } from '@shared/hosted'

/**
 * Which listed runs carry a passing receipt, for the Verified mark. The sessions
 * payload does not carry receipts (they live in their own store), so this asks
 * for the receipts of visible runs only: a run that never ran a prove phase is
 * never asked about, and each answer is kept until a prove phase settles again.
 */
export interface RowVerdict {
  passing: number
  total: number
}

const verdicts = shallowReactive(new Map<string, RowVerdict | null>())
const runs = new Map<string, ReceiptsRunResponse>()
const asked = new Set<string>()
let off = false // the receipts module is not served here: stop asking
const MAX_PER_PASS = 40
const PARALLEL = 4

const stamp = (s: SessionSummary) => `${sessionKey(s)}@${settledProveKey(s.phases ?? [])}`

/** The passing verdict of a run, or null when it has none (or none is known yet). */
export function verifiedFor(s: SessionSummary): RowVerdict | null {
  return verdicts.get(stamp(s)) ?? null
}

/** The receipt response already fetched for this run, so the peek need not ask again. */
export function cachedReceiptRun(s: { adw_id: string; repo?: string | null; factory_id?: string | null; phases?: SessionSummary['phases'] }): ReceiptsRunResponse | null {
  return runs.get(stamp(s as SessionSummary)) ?? null
}

/** Fetch receipts for these rows' settled prove phases that have not been asked about. */
export async function loadRowReceipts(rows: SessionSummary[]): Promise<void> {
  if (off) return
  const todo = rows
    .filter((s) => (s.phases ?? []).some((p) => isProvePhase(p.name)) && settledProveKey(s.phases ?? []) && !asked.has(stamp(s)))
    .slice(0, MAX_PER_PASS)
  for (const s of todo) asked.add(stamp(s))
  const next = async (): Promise<void> => {
    const s = todo.shift()
    if (!s || off) return
    try {
      const r = await loadReceipts(fetchReceiptRun, s.adw_id, receiptRepoSegment(s.repo))
      if (r.state === 'off') off = true
      if (r.state === 'ready') runs.set(stamp(s), r.run)
      const after = r.state === 'ready' ? summarizeReceipts(r.run)?.after : null
      verdicts.set(stamp(s), after && after.verdict === 'PASS' ? { passing: after.total - after.failed, total: after.total } : null)
    } catch {
      asked.delete(stamp(s)) // transient: ask again on a later pass
    }
    return next()
  }
  await Promise.all(Array.from({ length: PARALLEL }, next))
}
