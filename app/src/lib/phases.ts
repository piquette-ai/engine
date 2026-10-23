import type { AgentSession, Phase, Session } from './types'
import { ts } from './format'

/**
 * The engineer's ask opens every run. It is the run's title, not a step: only
 * the earliest phase counts, so a later engineer phase (a human review) stays
 * in the list.
 */
export function requestPhaseOf(phases: Phase[]): Phase | null {
  const first = phases
    .filter((p) => Number.isFinite(ts(p.started_at)))
    .reduce<Phase | null>((a, p) => (!a || ts(p.started_at) < ts(a.started_at) ? p : a), null)
  return first?.kind === 'engineer' ? first : null
}

/** The phases the step list and timeline show: in the order they started, the request left out. */
export function stepPhasesOf(phases: Phase[]): Phase[] {
  const reqId = requestPhaseOf(phases)?.phase_id
  return phases
    .filter((p) => p.phase_id !== reqId)
    .map((p, i) => ({ p, i, s: ts(p.started_at) }))
    .toSorted((a, b) => {
      const as = Number.isFinite(a.s) ? a.s : Number.MAX_SAFE_INTEGER
      const bs = Number.isFinite(b.s) ? b.s : Number.MAX_SAFE_INTEGER
      return as - bs || a.i - b.i
    })
    .map((x) => x.p)
}

/**
 * One time axis for every phase view: from the first step's start to the last
 * end (or now, while running).
 */
export function phaseAxis(steps: Phase[], session: Session | null, nowMs: number): { t0: number; span: number } {
  let t0 = Infinity
  let t1 = -Infinity
  for (const p of steps) {
    const a = ts(p.started_at)
    const b = ts(p.ended_at)
    if (Number.isFinite(a)) {
      t0 = Math.min(t0, a)
      t1 = Math.max(t1, a)
    }
    if (Number.isFinite(b)) t1 = Math.max(t1, b)
    if (p.status === 'running') t1 = Math.max(t1, nowMs)
  }
  if (!Number.isFinite(t0)) {
    const s = ts(session?.started_at)
    t0 = Number.isFinite(s) ? s : nowMs
    t1 = t0
  }
  if (session?.status === 'running') t1 = Math.max(t1, nowMs)
  return { t0, span: Math.max(t1 - t0, 1000) }
}

/** The recorded model per agent owner, from the run's agent rows. */
export function modelsByOwner(phases: Phase[], agents: AgentSession[]): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const p of phases) {
    if (p.kind !== 'agent' || !p.owner || p.owner in out) continue
    out[p.owner] = agents.find((a) => a.agent === p.owner)?.model ?? null
  }
  return out
}

/** Wall-clock runtime of a run: to now while it runs, NaN when it never recorded a start. */
export function runDurationMs(s: Session | null, nowMs: number): number {
  if (!s) return NaN
  const start = ts(s.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = s.status === 'running' ? nowMs : ts(s.ended_at)
  return (Number.isFinite(end) ? end : nowMs) - start
}
