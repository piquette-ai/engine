import type { GateResult, SessionSummary } from './types'
import { fetchGates } from './api'
import { sessionKey } from '@shared/hosted'

/**
 * The list's run peek reads almost everything from the row the list already
 * polls (phases, agents, cost, tokens). The one thing the row lacks is the
 * gate record, which names the gate that stopped a failed run. It is fetched
 * when a failed run is peeked, once per settled state of the run, and kept in
 * a small cache so j / k back and forth costs nothing. Nothing here polls.
 */
const MAX = 24
const cache = new Map<string, Promise<GateResult[]>>()

// A failed run's gates only change while it runs; once failed, the phase
// statuses pin the record.
const stamp = (s: SessionSummary) =>
  `${sessionKey(s)}@${s.status}:${s.ended_at ?? ''}:${(s.phases ?? []).map((p) => p.status ?? '').join(',')}`

export function peekGates(s: SessionSummary): Promise<GateResult[]> {
  if (s.status !== 'fail') return Promise.resolve([])
  const k = stamp(s)
  const hit = cache.get(k)
  if (hit) {
    // Refresh recency: Map keeps insertion order, so the oldest entry is first.
    cache.delete(k)
    cache.set(k, hit)
    return hit
  }
  const p = fetchGates(s.adw_id, { factory: s.factory_id ?? null, repo: s.repo ?? null })
  // A failed fetch must not stick: the next peek asks again.
  p.catch(() => cache.delete(k))
  cache.set(k, p)
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return p
}
