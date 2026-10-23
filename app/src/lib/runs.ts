import type { Phase, SessionSummary } from './types'

/**
 * What a reader scanning the list needs to know about a run. Only the
 * exceptions get a colour: `failed` is the loud one, `recovered` (succeeded
 * after a failed phase) is worth a look but not an alarm, `ok` stays quiet.
 */
export type RunKind = 'running' | 'failed' | 'recovered' | 'ok'

const failedPhases = (s: SessionSummary) => (s.phases ?? []).filter((p) => p.status === 'fail')

export function runKind(s: SessionSummary): RunKind {
  if (s.status === 'running') return 'running'
  if (s.status === 'success') return failedPhases(s).length ? 'recovered' : 'ok'
  // A null/unknown status reads as failed (as the old `status ?? 'fail'` did), so it lands in Needs review.
  return 'failed'
}

/** Failed and recovered runs are what a human still has to sign off on. */
export const needsReview = (s: SessionSummary): boolean => {
  const k = runKind(s)
  return k === 'failed' || k === 'recovered'
}

/**
 * First line of a request as plain text. Requests are often a pasted issue
 * body (headings, fences, bullets), which would read as noise on one line.
 */
const plainCache = new Map<string, string>()
export function plainRequest(raw: string | null | undefined): string {
  if (!raw) return '—'
  const hit = plainCache.get(raw)
  if (hit !== undefined) return hit
  const out = plainRequestUncached(raw.slice(0, 2000))
  if (plainCache.size > 500) plainCache.clear()
  plainCache.set(raw, out)
  return out
}

function plainRequestUncached(raw: string): string {
  let inFence = false
  const texts: { text: string; heading: boolean }[] = []
  for (const line of raw.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const text = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^\w])([*_])(.+?)\2(?=[^\w]|$)/g, '$1$3')
      .replace(/`([^`]+)`/g, '$1')
      .trim()
    if (!text) continue
    texts.push({ text, heading: /^\s{0,3}#{1,6}\s/.test(line) })
    if (texts.length === 2) break
  }
  const [first, second] = texts
  if (!first) return '—'
  // A bare section word ("Problem") says nothing alone: lend it the line under it.
  return first.heading && first.text.length < 24 && second ? `${first.text}: ${second.text}` : first.text
}

/** The short note under a run that is not simply fine: why it needs a look, or where it is. */
export function runNote(s: SessionSummary): string | null {
  const phases = [...(s.phases ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  const kind = runKind(s)
  if (kind === 'failed') {
    const bad = failedPhases(s)
    const at = bad[bad.length - 1]?.name
    return at ? `failed at ${at}` : 'failed'
  }
  if (kind === 'recovered') {
    const bad = failedPhases(s)
    // Only recorded facts: `phases.retries` is the configured budget, not a count of retries that happened.
    const first = bad[0]?.name
    return bad.length === 1 && first ? `recovered after ${first} failed` : `recovered after ${bad.length} failed phases`
  }
  if (kind === 'running') {
    const at = phases.findIndex((p) => p.status === 'running')
    if (at < 0) return null
    return `${phases[at]?.name ?? 'phase'} ${at + 1}/${phases.length}`
  }
  return null
}

/** Screen-reader word for the status glyph. */
export const kindLabel: Record<RunKind, string> = {
  running: 'Running',
  failed: 'Failed',
  recovered: 'Recovered after a failed phase',
  ok: 'Succeeded',
}

/** DOM-safe row identity (the session key itself carries NUL separators). */
export const domKey = (key: string): string => key.replaceAll('\u0000', '/')

/**
 * Why a succeeded run needed a look: the first phase that failed and what the
 * record says happened next. Only recorded facts: a later passing attempt of the
 * same phase, or just that a phase failed and the run still succeeded.
 */
export function recoveryOf(s: SessionSummary): { text: string; phase: Phase } | null {
  if (runKind(s) !== 'recovered') return null
  const phases = [...(s.phases ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  const bad = phases.filter((p) => p.status === 'fail')
  const first = bad[0]
  if (!first) return null
  const name = first.name ?? 'a phase'
  const same = bad.filter((p) => p.name === first.name)
  if (bad.length > same.length) return { text: `${bad.length} phases failed along the way, and the run still succeeded`, phase: first }
  const passed = phases.findLast((p) => p.name === first.name && p.status === 'success')
  const times = same.length === 1 ? 'failed once' : `failed ${same.length} times`
  const text = passed?.attempt && passed.attempt > 1 ? `${name} ${times}, passed on attempt ${passed.attempt}` : `${name} ${times}, then the run succeeded`
  return { text, phase: first }
}
