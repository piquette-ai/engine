import type { GateResult, Phase } from './types'

/**
 * Why a phase failed, in the words the record holds, for the surfaces a reader
 * meets first (the Failed band, the step annotation, the list's run peek).
 *
 * - `violations`: what the failing gate reported (a test case, a protected
 *   path), the latest attempt's failing gates only, one line each.
 * - `error`: no gate recorded a violation, so the phase's own error message.
 * - `count`: neither, but a gate row says the gate failed: how many did.
 *
 * Nothing here invents text: with no record at all the answer is null.
 */
export interface FailureCause {
  /** At most `max` lines, each one line of recorded text. */
  lines: string[]
  /** How many more lines the record holds beyond `lines`. */
  more: number
  source: 'violations' | 'error' | 'count'
}

/** A gate row's violations as strings; a malformed column is shown raw rather than dropped. */
export function gateViolations(g: GateResult): string[] {
  try {
    const v: unknown = JSON.parse(g.violations_json ?? '[]')
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
  } catch {
    /* keep raw below */
  }
  return g.violations_json ? [g.violations_json] : []
}

// One line of text: a multi-line violation (a command-output tail) keeps its first non-empty line.
const firstLine = (s: string): string => s.split('\n').map((l) => l.trim()).find(Boolean) ?? ''

function capped(all: string[], max: number, source: FailureCause['source']): FailureCause {
  const lines = [...new Set(all)]
  return { lines: lines.slice(0, max), more: Math.max(0, lines.length - max), source }
}

export function failureCause(phase: Phase | null | undefined, gates: readonly GateResult[] | null | undefined, max = 3): FailureCause | null {
  if (!phase) return null
  const failing = (gates ?? []).filter((g) => g.phase_id === phase.phase_id && !g.passed)
  // The latest attempt is the one that stopped the phase; earlier attempts were retried.
  const last = failing.reduce((n, g) => Math.max(n, g.attempt ?? 0), 0)
  const stopping = failing.filter((g) => (g.attempt ?? 0) === last).toSorted((a, b) => a.id - b.id)

  const violations = stopping.flatMap((g) => gateViolations(g).map(firstLine)).filter(Boolean)
  if (violations.length) return capped(violations, max, 'violations')

  // A gate-failure error reads "builder failed gates after 2 attempt(s):\n- one\n- two": each line counts.
  // When "- " bullets follow, the header line only restates the count, so the bullets alone are the cause.
  const raw = (phase.error ?? '').split('\n').filter((l) => l.trim())
  const bullets = raw.filter((l) => /^\s*-\s+/.test(l))
  const error = (bullets.length ? bullets : raw).map((l) => l.replace(/^\s*-\s+/, '').trim().replace(/:$/, '')).filter(Boolean)
  if (error.length) return capped(error, max, 'error')

  if (stopping.length) return capped([`${stopping.length} ${stopping.length === 1 ? 'gate' : 'gates'} failed`], max, 'count')
  return null
}
