import type {
  Envelope,
  EventRow,
  EventsPage,
  GateResult,
  HealthResponse,
  PromptsResponse,
  ReceiptsRunResponse,
  SessionDetail,
  SessionSummary,
} from './types'
import { archiveRequest, selQuery, sessionsUrl, type ListFilter, type SessionSel } from '@shared/hosted'

export type { SessionSel }
import { apiBase } from '@shared/viewer_base'
import { viewerHref } from '@shared/receipt_links'

/** Every request goes through the mount base, so the app works at `/`, under `/spf/` and on `/spf/r/<id>`. */
const withBase = (url: string): string => apiBase(location.pathname) + url

// Dev server only: `?latency=<ms>` (e.g. `/?latency=2500#/`) holds every API answer that long, so the
// loading tiers (nothing → skeleton → brand loader) can be seen against the mock data. Health is
// exempt so the wait reads as one request. import.meta.env.DEV is false in a build, so this folds away.
const LATENCY_MS = import.meta.env.DEV
  ? Math.min(Math.max(Number(new URLSearchParams(location.search).get('latency')) || 0, 0), 30_000)
  : 0
const lag = (url: string): Promise<void> | undefined =>
  LATENCY_MS && !url.startsWith('/api/health') ? new Promise((r) => setTimeout(r, LATENCY_MS)) : undefined

async function getJson(url: string): Promise<unknown> {
  await lag(url)
  const res = await fetch(withBase(url))
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return res.json()
}

// Hosted mode (set from /api/health by lib/health.ts) changes where archive
// writes go; everything else is the same route table in both modes.
let hostedMode = false
export function setHostedMode(hosted: boolean): void {
  hostedMode = hosted
}

/** Local mode: no filter, so the URL is exactly `/api/sessions`. Hosted: `repo` repeats, `factory` narrows. */
export function fetchSessions(filter?: ListFilter, archived = false): Promise<SessionSummary[]> {
  const base = sessionsUrl(filter)
  // The Reviewed view: only the runs a reader archived.
  const url = archived ? `${base}${base.includes('?') ? '&' : '?'}archived=only` : base
  return getJson(url) as Promise<SessionSummary[]>
}

export async function fetchSession(adwId: string, sel?: SessionSel): Promise<SessionDetail> {
  const detail = (await getJson(
    `/api/sessions/${encodeURIComponent(adwId)}${selQuery(sel)}`,
  )) as SessionDetail
  return {
    session: detail.session,
    usage: detail.usage ?? { read: 0, written: 0 },
    phases: detail.phases ?? [],
    agents: detail.agents ?? [],
  }
}

export async function fetchEvents(
  adwId: string,
  after: number,
  limit = 500,
  sel?: SessionSel,
): Promise<EventsPage> {
  const page = (await getJson(
    `/api/sessions/${encodeURIComponent(adwId)}/events?after=${after}&limit=${limit}${selQuery(sel, '&')}`,
  )) as EventsPage | EventRow[]
  if (Array.isArray(page)) {
    const cursor = page.reduce((max, e) => Math.max(max, e.rowid), after)
    return { events: page, cursor, has_more: page.length === limit }
  }
  return { events: page.events ?? [], cursor: page.cursor ?? after, has_more: page.has_more ?? false }
}

/**
 * Archive a run out of the review list (or restore it with archived=false).
 * Hosted mode keeps this as per-tenant reader state on the reviews route; it
 * is never pushed back to the factory.
 */
export async function archiveSession(
  adwId: string,
  archived = true,
  factory?: string | null,
  repo?: string | null,
): Promise<void> {
  const { url, body } = archiveRequest(hostedMode, adwId, archived, factory, repo)
  const res = await fetch(withBase(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`)
}

/** Hosted mode as last declared by /api/health; the WebMCP archive tool checks it before writing. */
export const isHostedMode = (): boolean => hostedMode

export function fetchHealth(): Promise<HealthResponse> {
  return getJson('/api/health') as Promise<HealthResponse>
}

// PhaseDetail imports the prompts type from here alongside fetchPrompts.
export type { PromptsResponse }

export async function fetchPrompts(
  adwId: string,
  agent: string,
  sel?: SessionSel,
): Promise<PromptsResponse> {
  const res = await fetch(
    withBase(`/api/sessions/${encodeURIComponent(adwId)}/agents/${encodeURIComponent(agent)}/prompts${selQuery(sel)}`),
  )
  // Not recorded (or endpoint not deployed yet) renders as "no prompts", not an error.
  if (res.status === 404) return { system: null, user: null }
  if (!res.ok) throw new Error(`GET prompts → ${res.status}`)
  const data = (await res.json()) as Partial<PromptsResponse>
  return { system: data.system ?? null, user: data.user ?? null }
}

export function fetchEnvelopes(adwId: string, sel?: SessionSel): Promise<Envelope[]> {
  return getJson(`/api/sessions/${encodeURIComponent(adwId)}/envelopes${selQuery(sel)}`) as Promise<Envelope[]>
}

export function fetchGates(adwId: string, sel?: SessionSel): Promise<GateResult[]> {
  return getJson(`/api/sessions/${encodeURIComponent(adwId)}/gates${selQuery(sel)}`) as Promise<GateResult[]>
}

// ── receipts viewer (#202) ──────────────────────────────────────────────────

const enc = encodeURIComponent
const repoQuery = (repo?: string | null, sep = '?') => (repo ? `${sep}repo=${enc(repo)}` : '')

/** Resolves to the run, or throws an Error carrying the HTTP status and, for a 409, the candidate repos. */
export async function fetchReceiptRun(runId: string, repo?: string | null): Promise<ReceiptsRunResponse> {
  const url = `/api/receipts/${enc(runId)}${repoQuery(repo)}`
  await lag(url)
  const res = await fetch(withBase(url))
  if (res.ok) return (await res.json()) as ReceiptsRunResponse
  const body = (await res.json().catch(() => ({}))) as { error?: string; candidates?: string[] }
  throw Object.assign(new Error(body.error ?? `GET ${url} → ${res.status}`), {
    status: res.status,
    candidates: body.candidates ?? [],
  })
}

export function receiptFileUrl(runId: string, key: string, repo?: string | null): string {
  return withBase(`/api/receipts/${enc(runId)}/file?key=${enc(key)}${repoQuery(repo, '&')}`)
}

/** Link to the receipt viewer for a run, under the same mount base as the API. */
export function receiptViewerUrl(runId: string, repo?: string | null, key?: string | null): string {
  return viewerHref(apiBase(location.pathname), runId, repo, key)
}
