import { ts } from './format'

/** Local-timezone day bucketing for the departures timetable. Pure so it can
 * be reasoned about (and tested) without a DOM. */

const pad2 = (n: number) => String(n).padStart(2, '0')
const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate())
// Whole local days from d back to now. Round, not floor: a DST day is 23h or 25h long.
const daysAgo = (d: Date, now: Date) => Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86_400_000)

/** Stable local-day key, e.g. "2026-10-09"; '' when the timestamp is unusable. */
export function dayKey(iso: string | null | undefined): string {
  const t = ts(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** "Today", "Yesterday", else "Mon Oct 6" (year appended only if not the current year). */
export function dayLabel(
  iso: string | null | undefined,
  now: Date = new Date(),
  weekday = true,
): string {
  const t = ts(iso)
  if (!Number.isFinite(t)) return 'Unknown date'
  const d = new Date(t)
  const diffDays = daysAgo(d, now)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  const base = d
    .toLocaleDateString('en-US', { ...(weekday ? { weekday: 'short' as const } : {}), month: 'short', day: 'numeric' })
    .replace(',', '')
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`
}

/** 24h local "HH:MM". */
export function fmtHM(iso: string | null | undefined): string {
  const t = ts(iso)
  if (!Number.isFinite(t)) return '—'
  const d = new Date(t)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** "Today 14:32" / "Mon Oct 6 09:05"; a bare '—' when the timestamp is unusable. */
export function fmtDayHM(iso: string | null | undefined, now: Date = new Date()): string {
  if (!Number.isFinite(ts(iso))) return '—'
  return `${dayLabel(iso, now)} ${fmtHM(iso)}`
}

/** Search-mode departed cell: "Today 14:32", "Yesterday 22:10", "Oct 6 14:32"
 * (year appended only if not current). No weekday, so it stays compact. */
export function fmtInlineDay(iso: string | null | undefined, now: Date = new Date()): string {
  if (!Number.isFinite(ts(iso))) return '—'
  return `${dayLabel(iso, now, false)} ${fmtHM(iso)}`
}

/** The short day a pinned row names ahead of its clock: '' for today, "Yest",
 * a weekday within the last week ("Wed"), else "Oct 21" (", 2025" if not the current year). */
export function fmtRelDay(iso: string | null | undefined, now: Date = new Date()): string {
  const t = ts(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const diffDays = daysAgo(d, now)
  if (diffDays <= 0) return ''
  if (diffDays === 1) return 'Yest'
  if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'short' })
  const base = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`
}

/** Full local timestamp for hover titles. */
export function fmtFull(iso: string | null | undefined): string {
  const t = ts(iso)
  if (!Number.isFinite(t)) return ''
  return `${new Date(t).toLocaleString([], { hour12: false })} (${iso})`
}

export type DayItem<T> = { kind: 'head'; key: string; label: string } | { kind: 'row'; item: T }

/** Interleaves day headers into an ordered list, emitting one whenever the
 * local day changes — so it also works for search-ranked (non-chronological) order. */
export function withDayHeaders<T>(
  items: readonly T[],
  getIso: (item: T) => string | null | undefined,
  now: Date = new Date(),
): DayItem<T>[] {
  const out: DayItem<T>[] = []
  // Keyed by day plus how often that day has headed a run so far (search order
  // can revisit a day), not by list position: a new session landing at the top
  // must not re-key (and remount) every header below it.
  const seen = new Map<string, number>()
  let prev: string | undefined
  for (const item of items) {
    const iso = getIso(item)
    const k = dayKey(iso)
    if (k !== prev) {
      const n = seen.get(k) ?? 0
      seen.set(k, n + 1)
      out.push({ kind: 'head', key: `${k}#${n}`, label: dayLabel(iso, now) })
      prev = k
    }
    out.push({ kind: 'row', item })
  }
  return out
}
