<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch, watchEffect } from 'vue'
import type { SessionSummary } from '../lib/types'
import { fetchSessions } from '../lib/api'
import { health, hosted, loadHealth, refreshHealth } from '../lib/health'
import { startPolling } from '../lib/poll'
import { setListFilter, useRoute } from '../lib/router'
import { factoryIndex, filterIsEmpty, filterQuery, rowsByKeys, sessionKey, showFactoryFilter, showRepoFilter, sortSessions, type ListFilter } from '@shared/hosted'
import { withDayHeaders } from '../lib/day'
import { runningTicket } from '../lib/live'
import { isSemanticSearchAvailable, isSemanticSearchDisabled, rankSessions } from '../lib/semantic-search'
import SessionRow from './SessionRow.vue'
import RepoFilter from './RepoFilter.vue'

const sessions = shallowRef<SessionSummary[]>([])

// The filter lives in the URL (#/?repo=a,b&factory=x), so reload and a copied
// link keep it. Local mode never has one: the chip bar is hidden and the
// request is the bare /api/sessions it always was.
const route = useRoute()
const filter = computed<ListFilter>(() => (hosted.value ? route.value.filter : { repos: [], factories: [] }))
const factories = computed(() => factoryIndex(health.value?.factories))
const filterable = computed(() => showRepoFilter(health.value) || showFactoryFilter(health.value))
let fetchGen = 0 // a response for a filter the reader has since left must not land
const apiError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())

const query = ref('')
// null = no search active, show the default started_at sort.
const rankedKeys = ref<string[] | null>(null)
const semanticActive = ref(false)
const searching = ref(false)

let stopPolling: (() => void) | undefined
let inflight = false
let searchTimer: ReturnType<typeof setTimeout> | undefined
let searchToken = 0 // guards a debounced rankSessions() call against being superseded mid-flight
let semanticChecked = false

async function tick() {
  if (inflight) return
  inflight = true
  const gen = fetchGen
  try {
    refreshHealth()
    const rows = await fetchSessions(hosted.value ? filter.value : undefined)
    if (gen !== fetchGen) return
    sessions.value = rows
    nowMs.value = Date.now()
    apiError.value = null
    loaded.value = true
  } catch (err) {
    apiError.value = err instanceof Error ? err.message : String(err)
  } finally {
    inflight = false
    // A filter change landed mid-flight; fetch for it now rather than at the next poll.
    if (gen !== fetchGen) void tick()
  }
}

function onFilter(next: ListFilter) {
  fetchGen++
  setListFilter(next)
  void tick()
}

// The list's shape depends on health (hosted or not) and on the filter, so a
// change in either re-fetches now instead of at the next poll, and a response
// already in flight for the old one is dropped.
watch([hosted, () => (hosted.value ? filterQuery(route.value.filter) : '')], () => {
  fetchGen++
  void tick()
})

onMounted(() => {
  // Learn hosted-or-local before the first list request, so a hosted page
  // never fetches (or flashes) an unfiltered list. A failed health still
  // falls through to a local fetch; the poll keeps retrying health.
  void loadHealth().finally(() => void tick())
  stopPolling = startPolling(() => void tick())
})

onUnmounted(() => {
  stopPolling?.()
  clearTimeout(searchTimer)
})

/** Optimistic removal; an empty id means the write failed, so re-sync instead. */
function onArchived(key: string) {
  if (!key) {
    void tick()
    return
  }
  // By row key, not adw_id: another factory's run can share the id.
  sessions.value = sessions.value.filter((s) => sessionKey(s) !== key)
}

// started_at DESC across factories; ties break on the row key so polls never reorder them.
const ordered = computed(() => sortSessions(sessions.value))

// Feeds the page title: the newest running session, regardless of any search
// filter. Cleared on unmount so a session route doesn't show a stale ticket.
watchEffect(() => {
  runningTicket.value = ordered.value.find((s) => s.status === 'running')?.adw_id ?? null
})
onUnmounted(() => {
  runningTicket.value = null
})

/** Default view (empty query) stays the started_at sort; a search reorders
 * and filters that same set down to what rankSessions returned. */
const visible = computed(() => {
  if (!query.value.trim() || !rankedKeys.value) return ordered.value
  // By row key: two factories can share an adw_id.
  return rowsByKeys(rankedKeys.value, sessions.value)
})

/** A search has landed results: rows are relevance-ranked, so day headers
 * would fragment them and each row carries its day inline instead. */
const searchActive = computed(() => !!query.value.trim() && rankedKeys.value != null)

/** Rows with a day header wherever the local day changes (default view only).
 * Recomputed on the poll (nowMs) so "Today" rolls over at midnight. */
const grouped = computed(() =>
  searchActive.value
    ? visible.value.map((item) => ({ kind: 'row' as const, item }))
    : withDayHeaders(visible.value, (s) => s.started_at, new Date(nowMs.value)),
)

/** "N recorded" normally; "N of M recorded" once a search has actually
 * filtered the list — otherwise the caption keeps citing the unfiltered
 * total while three rows show under it. */
const caption = computed(() =>
  query.value.trim() && rankedKeys.value
    ? `${visible.value.length} of ${ordered.value.length} recorded`
    : `${ordered.value.length} recorded`,
)

/** Probes availability lazily, on the user's first real interaction with the
 * box — never eagerly on mount — since create() likely needs a user-
 * activation gesture the poll tick and page load don't have. */
function ensureSemanticChecked() {
  if (semanticChecked) return
  semanticChecked = true
  void isSemanticSearchAvailable().then((available) => {
    semanticActive.value = available
  })
}

async function runSearch() {
  const q = query.value
  if (!q.trim()) {
    rankedKeys.value = null
    return
  }
  const token = ++searchToken
  searching.value = true
  try {
    const keys = await rankSessions(q, sessions.value)
    if (token !== searchToken) return
    rankedKeys.value = keys
  } finally {
    if (token === searchToken) {
      searching.value = false
      // The embedder can latch itself off mid-session (an unshipped API
      // failing outright) — re-read that live state after every search so
      // the caption stops claiming semantic ranking once it's gone.
      if (isSemanticSearchDisabled()) semanticActive.value = false
    }
  }
}

/** Debounced on input; an empty box snaps back to the default sort right
 * away and bumps the token so a still-inflight search for the old query
 * can't land its results under the now-different (or now-empty) box. */
function onSearchInput() {
  ensureSemanticChecked()
  clearTimeout(searchTimer)
  if (!query.value.trim()) {
    rankedKeys.value = null
    ++searchToken
    return
  }
  searchTimer = setTimeout(() => void runSearch(), 300)
}
</script>

<template>
  <div class="sessions">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>

    <div class="search-bar">
      <input
        v-model="query"
        type="search"
        class="search-input"
        placeholder="search requests, phases, errors…"
        aria-label="Search sessions"
        @focus="ensureSemanticChecked"
        @input="onSearchInput"
      />
      <span v-if="searching" class="search-note dim mono">searching…</span>
      <span v-else-if="semanticActive" class="search-note dim mono">semantic search active</span>
    </div>

    <RepoFilter v-if="hosted && health && filterable" :health="health" :filter="filter" :rows="sessions" @change="onFilter" />

    <div v-if="visible.length" class="tt" :class="{ 'tt-search': searchActive, 'tt-hosted': hosted }">
      <div class="tt-caption">
        <span class="tt-title">departures</span>
        <span class="dim mono">{{ caption }}</span>
      </div>
      <div class="tt-head" aria-hidden="true">
        <span class="h">departed</span>
        <span class="h">run</span>
        <span v-if="hosted" class="h">source</span>
        <span class="h h-mid">service</span>
        <span class="h">request</span>
        <span class="h h-mid">phases</span>
        <span class="h">status</span>
        <span class="h h-num">cost</span>
        <span class="h h-num">runtime</span>
        <span class="h h-num h-mid">tokens</span>
        <span class="h" />
      </div>
      <template v-for="g in grouped" :key="g.kind === 'head' ? 'h:' + g.key : sessionKey(g.item)">
        <div v-if="g.kind === 'head'" class="h day-head" role="presentation">{{ g.label }}</div>
        <SessionRow
          v-else
          :session="g.item"
          :now-ms="nowMs"
          :inline-day="searchActive"
          :hosted="hosted"
          :last-seen="g.item.factory_id ? factories.get(g.item.factory_id)?.last_seen_at : null"
          @archived="onArchived"
        />
      </template>
    </div>
    <div v-else-if="loaded && query.trim()" class="empty-state">no matches for "{{ query }}"</div>
    <div v-else-if="loaded && !filterIsEmpty(filter)" class="empty-state">no runs match this filter</div>
    <div v-else-if="loaded" class="empty-state">no sessions yet — run an ADW to see it here</div>
    <div v-else-if="!apiError" class="empty-state">loading sessions…</div>
  </div>
</template>

<style scoped>
.sessions {
  display: flex;
  flex-direction: column;
}

.search-bar {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 18px 28px 0;
}

.search-input {
  flex: 1;
  max-width: 420px;
  padding: 7px 10px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--face);
  color: var(--fg);
  font-family: var(--mono);
  font-size: 16px;
}

.search-input::placeholder {
  color: var(--faint);
}

.search-note {
  font-size: 16px;
  white-space: nowrap;
}

/* The printed timetable: one shared column template, so the head and every
   row sit on the same grid. */
.tt {
  --tt-departed: 84px;
  --tt-columns: var(--tt-departed) 160px minmax(90px, 140px) minmax(0, 1fr) 168px 100px 90px 90px 90px 70px;
  margin: 8px 28px 40px;
}

/* Hosted adds a source column (repo stub + factory) after the run id. */
.tt-hosted {
  --tt-columns: var(--tt-departed) 160px 192px minmax(90px, 140px) minmax(0, 1fr) 168px 100px 90px 90px 90px 70px;
}

.tt-caption {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 18px 0 8px;
}

.tt-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.tt-head {
  display: grid;
  grid-template-columns: var(--tt-columns);
  column-gap: 18px;
  padding: 0 0 6px;
  border-bottom: 1px solid var(--rule);
}

.h {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  color: var(--faint);
  white-space: nowrap;
}

.h-num {
  text-align: right;
}

/* A day divider on the timetable; shares the .h column-head treatment
   (600, lowercase, tracked, faint) and only adds spacing and the rule. */
.day-head {
  padding: 16px 0 5px;
  border-bottom: 1px solid var(--rule);
}

/* Search results are relevance-ranked, so the departed cell carries the day
   inline ("Yesterday 22:10") and needs the wider column: 180px holds the
   longest form, "Dec 31, 2025 23:59" (18 mono chars at 16px), on one line. */
.tt-search {
  --tt-departed: 180px;
}

/* Mid widths: the full template only leaves request a readable 160px from
   ~1400px (~1480px in search mode, for the wider departed column), so below
   that service, phases and tokens leave the columns and ride a remark line
   under the request (see SessionRow, which folds on the same widths). The
   100px request floor keeps the search template inside a 981px viewport with
   a classic 15px scrollbar, so nothing overflows. */
@media (max-width: 1400px) and (min-width: 981px) {
  .tt {
    --tt-columns: var(--tt-departed) 160px minmax(100px, 1fr) 100px 90px 90px 70px;
  }

  .h-mid {
    display: none;
  }
}

@media (max-width: 1480px) and (min-width: 981px) {
  .tt-search {
    --tt-columns: var(--tt-departed) 160px minmax(100px, 1fr) 100px 90px 90px 70px;
  }

  .tt-search .h-mid {
    display: none;
  }
}

/* Hosted folds the same columns, but 210px earlier: the source column and its
   gap take that much from the request. SessionRow's hosted folds match. */
@media (max-width: 1610px) and (min-width: 981px) {
  .tt.tt-hosted {
    --tt-columns: var(--tt-departed) 160px 192px minmax(100px, 1fr) 100px 90px 90px 70px;
  }

  .tt-hosted .h-mid {
    display: none;
  }
}

@media (max-width: 1690px) and (min-width: 981px) {
  .tt.tt-hosted.tt-search {
    --tt-columns: var(--tt-departed) 160px 192px minmax(100px, 1fr) 100px 90px 90px 70px;
  }

  .tt-hosted.tt-search .h-mid {
    display: none;
  }
}

@media (max-width: 980px) {
  .search-bar {
    margin: 12px 16px 0;
  }

  .search-input {
    max-width: none;
  }

  .tt {
    margin: 8px 16px 40px;
  }

  .tt-head {
    display: none;
  }
}
</style>
