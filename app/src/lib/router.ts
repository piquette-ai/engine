import { ref } from 'vue'
import { buildHash, parseHash, type ListFilter, type ParsedHash } from '@shared/hosted'

// Hash routes: #/ → sessions · #/<adw_id> → waterfall · #/<adw_id>/<phase_id> → phase panel open
// plus a query (#133 §4.5): #/?repo=a,b&factory=x filters the list, #/<adw_id>?factory=<id>&repo=<slug>
// names the factory and repo a trace belongs to (a factory serves many repos). The grammar lives in @shared/hosted so it is tested.
export type Route = ParsedHash

// Dev-only reference pages (#/_/loaders): `_` is a segment no run id takes, so
// they never shadow a run. Only the dev server (including SPF_MOCK modes)
// routes there; in a production build DEV is false and the hash parses as usual.
// Only known pages route; any other #/_/<name> parses as a normal hash.
const DEV_PAGES = new Set(['loaders'])
function devPageOf(hash: string): string | null {
  if (!import.meta.env.DEV) return null
  const name = /^#\/_\/([\w-]+)\/?(?:\?.*)?$/.exec(hash)?.[1]
  return name && DEV_PAGES.has(name) ? name : null
}
export const devPage = ref<string | null>(devPageOf(window.location.hash))

const route = ref<Route>(parseHash(devPage.value ? '#/' : window.location.hash))

// The filter of the list the reader last saw, so "back to the list" from a
// trace (breadcrumb, brand) returns to the same filtered view.
export const lastListFilter = ref<ListFilter>(route.value.filter)

function sync(next: Route) {
  route.value = next
  if (!next.adwId) lastListFilter.value = next.filter
}

window.addEventListener('hashchange', () => {
  devPage.value = devPageOf(window.location.hash)
  if (devPage.value) route.value = parseHash('#/')
  else sync(parseHash(window.location.hash))
})

export function useRoute() {
  return route
}

// Display name for the phase crumb — set by the trace view once phases load,
// since the phase_id in the URL is not the display name.
export const phaseCrumb = ref<string | null>(null)

// Repo of the open trace in hosted mode, where the masthead cannot know it
// from /api/health (many repos). Set by the trace view once the session loads.
export const traceRepo = ref<string | null>(null)

export interface TraceSel {
  factory?: string | null
  repo?: string | null
}

export function hrefFor(adwId?: string | null, phaseId?: string | null, sel?: TraceSel): string {
  return buildHash({ adwId, phaseId, factory: sel?.factory, repo: sel?.repo })
}

/** The list route carrying a filter, for crumbs that return to it. */
export function listHref(filter?: ListFilter): string {
  return buildHash({ filter })
}

export function navigate(adwId?: string | null, phaseId?: string | null, sel?: TraceSel, opts?: { replace?: boolean }): void {
  const hash = hrefFor(adwId, phaseId, sel)
  if (!opts?.replace) {
    window.location.hash = hash
    return
  }
  // Stepping through phases (j / k) swaps the open one in place, so Back
  // still closes the peek instead of walking every phase visited.
  history.replaceState(null, '', hash)
  sync(parseHash(hash))
}

/**
 * Persist a list filter in the URL. replaceState keeps chip clicks out of the
 * back-button history (and does not fire hashchange, so the route is updated
 * by hand).
 */
export function setListFilter(filter: ListFilter): void {
  const hash = listHref(filter)
  history.replaceState(null, '', hash === '#/' ? window.location.pathname + window.location.search : hash)
  sync(parseHash(hash))
}

// Receipts viewer (#202) is path-based, not hash-based: `/r/<run_id>` is a
// link a PR can carry, served by spf ui, the microsite and the hub alike. The
// hash router above is untouched. Computed once — the viewer is its own page.
export const viewerRunId: string | null = (() => {
  const m = window.location.pathname.match(/\/r\/([^/]+)\/?$/)
  return m ? decodeURIComponent(m[1]) : null
})()
const query = new URLSearchParams(window.location.search)
/** The evidence key a PR link pointed at, if any. */
export const viewerKey: string | null = query.get('key')
/** Disambiguates a run id that exists under more than one repo segment. */
export const viewerRepo: string | null = query.get('repo')
