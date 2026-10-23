export function ts(iso: string | null | undefined): number {
  if (!iso) return NaN
  return new Date(iso).getTime()
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  if (m < 60) return `${m}m ${String(rem).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtClock(iso: string | null | undefined): string {
  const t = ts(iso)
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleTimeString([], { hour12: false })
}

export function fmtDate(iso: string | null | undefined): string {
  const t = ts(iso)
  if (!Number.isFinite(t)) return '—'
  const d = new Date(t)
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtClock(iso)}`
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/**
 * Dollars for a run. The tracer defaults `total_cost` to 0 and it only grows
 * when an agent reports, so an exact 0 means "no per-token cost recorded"
 * (nothing reported yet, a free or flat-rate model, a code-only chain), not
 * "it cost nothing": render it as '—'. Two decimals normally; four only under a cent, where
 * "$0.00" would hide a real figure.
 */
export function fmtCost(n: number | null | undefined): string {
  if (n == null || n === 0) return '—'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

/** Tooltip that explains a '—' cost; undefined when the figure speaks for itself. */
export function costTitle(n: number | null | undefined): string | undefined {
  if (n === 0) return 'No per-token cost recorded (free or flat-rate model, or no agent has reported yet)'
  if (n == null) return 'No cost recorded'
  return undefined
}

// Compact offset label for time axes: 0s, 30s, 1m, 1m30s, 2m, 1h05m.
export function fmtOffset(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) {
    const rem = s % 60
    return rem ? `${m}m${String(rem).padStart(2, '0')}s` : `${m}m`
  }
  const h = Math.floor(m / 60)
  const mrem = m % 60
  return mrem ? `${h}h${String(mrem).padStart(2, '0')}m` : `${h}h`
}

const TICK_STEPS_MS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 21600, 43200, 86400,
].map((s) => s * 1000)

/** Evenly-stepped time-axis ticks over a span, ≤ maxTicks of them. */
export function axisTicks(spanMs: number, maxTicks = 8): { pct: number; label: string }[] {
  const span = Math.max(spanMs, 1)
  // Off-ladder spans (multi-day runs) fall back to even division — a 1h raster
  // over a 95h span would smear into an unreadable edge of labels.
  const step = TICK_STEPS_MS.find((s) => span / s <= maxTicks) ?? span / (maxTicks - 1)
  const out: { pct: number; label: string }[] = []
  for (let t = 0; t <= span; t += step) {
    out.push({ pct: (t / span) * 100, label: fmtOffset(t) })
  }
  return out
}

// New-tracer tool_call payloads carry ok:false on tool errors; older payloads
// have no ok key and count as ok.
export function payloadOk(raw: string | null | undefined): boolean {
  if (!raw) return true
  try {
    const p: unknown = JSON.parse(raw)
    if (p && typeof p === 'object' && 'ok' in p) return (p as { ok?: unknown }).ok !== false
  } catch {
    /* not JSON — treat as ok */
  }
  return true
}

export function prettyJson(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** Plain words for a phase or run status, for labels and screen readers. */
export const STATUS_WORD: Record<string, string> = {
  success: 'succeeded',
  fail: 'failed',
  running: 'running',
  queued: 'queued',
}

export function statusWord(status: string | null | undefined): string {
  return STATUS_WORD[status ?? 'queued'] ?? status ?? 'queued'
}

/** Coarse relative time ("just now", "4h ago", "3d ago"); '—' when the stamp is missing or unparseable. */
export function fmtAgo(iso: string | null | undefined, nowMs: number = Date.now()): string {
  const t = ts(iso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.round((nowMs - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 45) return `${d}d ago`
  return new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}
