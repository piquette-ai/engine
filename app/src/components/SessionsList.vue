<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, useTemplateRef, watch, watchEffect } from 'vue'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import type { SessionSummary } from '../lib/types'
import { archiveSession, fetchSessions } from '../lib/api'
import { health, hosted, loadHealth, refreshHealth } from '../lib/health'
import { startPolling } from '../lib/poll'
import { navigate, setListFilter, useRoute } from '../lib/router'
import { factoryIndex, filterIsEmpty, filterQuery, rowsByKeys, sessionKey, showFactoryFilter, showRepoFilter, sortSessions, type ListFilter } from '@shared/hosted'
import { dayKey, dayLabel } from '../lib/day'
import { domKey, needsReview, plainRequest, runKind } from '../lib/runs'
import { lastUpdatedMs, needsReviewCount, runningTicket } from '../lib/live'
import { loadRowReceipts } from '../lib/row-receipts'
import { isSemanticSearchAvailable, isSemanticSearchDisabled, rankSessions } from '../lib/semantic-search'
import SessionRow from './SessionRow.vue'
import RepoFilter from './RepoFilter.vue'
import FilterMenu from './FilterMenu.vue'
import PeekDrawer from './PeekDrawer.vue'
import RunPeek from './RunPeek.vue'

const sessions = shallowRef<SessionSummary[]>([])
// The Reviewed view's rows: fetched (archived=only) only while that view is open.
const archivedSessions = shallowRef<SessionSummary[]>([])
const reviewedLoaded = ref(false) // false until the archived=only fetch has answered for this visit

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
    const scope = hosted.value ? filter.value : undefined
    const rows = await fetchSessions(scope)
    const reviewedRows = showReviewed.value ? await fetchSessions(scope, true) : null
    if (gen !== fetchGen) return
    sessions.value = rows
    if (reviewedRows) {
      archivedSessions.value = reviewedRows
      reviewedLoaded.value = true
    }
    // This fetch began after every archive write that bumped fetchGen, so it
    // already reflects them: the optimistic hiding can end.
    for (const k of settled) hiding.delete(k)
    settled.clear()
    nowMs.value = Date.now()
    lastUpdatedMs.value = nowMs.value
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

// Rows hidden while their archive write is in flight, so a poll that lands
// first cannot bring a just-reviewed run back for a frame.
const hiding = reactive(new Set<string>())
// Written rows whose hiding ends at the next fetch that started after the write.
const settled = new Set<string>()

// started_at DESC across factories; ties break on the row key so polls never reorder them.
const ordered = computed(() => sortSessions(sessions.value).filter((s) => !hiding.has(sessionKey(s))))

// Feeds the page title: the newest running session, regardless of any search
// filter. Cleared on unmount so a session route doesn't show a stale ticket.
watchEffect(() => {
  runningTicket.value = ordered.value.find((s) => s.status === 'running')?.adw_id ?? null
})
onUnmounted(() => {
  runningTicket.value = null
  lastUpdatedMs.value = null
})

// Status is a client-side narrowing of whatever the list holds: it needs no
// route, and the hosted repo/factory filter stays the only thing in the URL.
const statusFilter = ref<string[]>([])
const showReviewed = computed(() => statusFilter.value[0] === 'reviewed')
const reviewedRows = computed(() => sortSessions(archivedSessions.value).filter((s) => !hiding.has(sessionKey(s))))
/** The rows the current view lists before any narrowing: open runs, or the reviewed ones. */
const listed = computed(() => (showReviewed.value ? (reviewedLoaded.value ? reviewedRows.value : []) : ordered.value))

// The tab title leads with how many runs still need a human.
watchEffect(() => {
  needsReviewCount.value = ordered.value.filter(needsReview).length
})
onUnmounted(() => {
  needsReviewCount.value = null
})

function onStatus(v: string[]) {
  statusFilter.value = v
  reviewedLoaded.value = false
  fetchGen++
  // A new search ranks the rows of the view it now sits in.
  if (query.value.trim()) void runSearch()
  void tick()
}

const statusOptions = computed(() => {
  const n = { review: 0, running: 0, ok: 0 }
  for (const s of ordered.value) {
    if (needsReview(s)) n.review++
    else if (runKind(s) === 'running') n.running++
    else n.ok++
  }
  return [
    { value: 'review', label: 'Needs review', count: n.review },
    { value: 'running', label: 'Running', count: n.running },
    { value: 'ok', label: 'Succeeded', count: n.ok },
    { value: 'reviewed', label: 'Reviewed', count: null, title: 'Runs you marked reviewed, each with a Restore action' },
  ]
})
const passesStatus = (s: SessionSummary) => {
  const f = statusFilter.value[0]
  if (!f || f === 'reviewed') return true
  return f === 'review' ? needsReview(s) : f === 'running' ? runKind(s) === 'running' : !needsReview(s) && runKind(s) !== 'running'
}

/** Default view (empty query) stays the started_at sort; a search reorders
 * and filters that same set down to what rankSessions returned. */
const visible = computed(() => {
  const base = !query.value.trim() || !rankedKeys.value ? listed.value : rowsByKeys(rankedKeys.value, searchPool().filter((s) => !hiding.has(sessionKey(s))))
  return base.filter(passesStatus)
})

const searchPool = () => (showReviewed.value ? (reviewedLoaded.value ? archivedSessions.value : []) : sessions.value)

/** A search has landed results: rows are relevance-ranked, so day headers
 * would fragment them and each row carries its day inline instead. */
const searchActive = computed(() => !!query.value.trim() && rankedKeys.value != null)

interface Group {
  key: string
  label: string
  rows: SessionSummary[]
  /** Day groups fold; Needs review and Running are always open. */
  collapsible: boolean
  tone?: 'review'
}

const collapsed = reactive(new Set<string>())
function toggleGroup(key: string) {
  if (collapsed.has(key)) collapsed.delete(key)
  else collapsed.add(key)
}

/** Row tint parity counted from the bottom (oldest) row, so runs arriving on
    top of a group, as polls add them, keep every existing row's stripe. */
function stripedAt(i: number, n: number): boolean {
  return (n - 1 - i) % 2 === 1
}

/** Needs review on top (failed and recovered), then Running, then one group
 * per local day. Recomputed on the poll (nowMs) so "Today" rolls over at midnight. */
const groups = computed<Group[]>(() => {
  if (searchActive.value) return []
  const out: Group[] = []
  // Reviewed runs are signed off already: they group by day alone.
  const sorted = !showReviewed.value
  const review = sorted ? visible.value.filter(needsReview) : []
  const live = sorted ? visible.value.filter((s) => runKind(s) === 'running') : []
  if (review.length) out.push({ key: 'review', label: 'Needs review', rows: review, collapsible: false, tone: 'review' })
  if (live.length) out.push({ key: 'running', label: 'Running', rows: live, collapsible: false })
  const now = new Date(nowMs.value)
  const days = new Map<string, Group>()
  for (const s of visible.value) {
    if (sorted && (needsReview(s) || runKind(s) === 'running')) continue
    const k = dayKey(s.started_at)
    let g = days.get(k)
    if (!g) {
      g = { key: `day:${k}`, label: dayLabel(s.started_at, now), rows: [], collapsible: true }
      days.set(k, g)
      out.push(g)
    }
    g.rows.push(s)
  }
  return out
})

/** What j/k walk: rows in display order, skipping folded days. */
const navRows = computed(() =>
  searchActive.value ? visible.value : groups.value.flatMap((g) => (g.collapsible && collapsed.has(g.key) ? [] : g.rows)),
)

/** "N runs" normally; "N of M runs" once a search has actually
 * filtered the list — otherwise the caption keeps citing the unfiltered
 * total while three rows show under it. */
const runCount = (n: number) => `${n} run${n === 1 ? '' : 's'}`
const caption = computed(() =>
  query.value.trim() && rankedKeys.value
    ? `${visible.value.length} of ${runCount(listed.value.length)}`
    : showReviewed.value
      ? `${listed.value.length} reviewed`
      : runCount(listed.value.length),
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
    const keys = await rankSessions(q, searchPool())
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

// ── Mark reviewed, with undo ──────────────────────────────────────────────
interface Toast {
  id: number
  key: string
  session: SessionSummary
  /** The write was a restore, so Undo reviews the run again. */
  restored: boolean
  timer: ReturnType<typeof setTimeout>
}
const toasts = ref<Toast[]>([])
const UNDO_MS = 6000
let toastId = 0

function dropToast(id: number) {
  const t = toasts.value.find((x) => x.id === id)
  if (t) clearTimeout(t.timer)
  toasts.value = toasts.value.filter((x) => x.id !== id)
}

// The undo window is a timer: hovering or focusing the toast must not run it out (WCAG 2.2.1).
function pauseToast(t: Toast) {
  clearTimeout(t.timer)
}
function resumeToast(t: Toast) {
  clearTimeout(t.timer)
  t.timer = setTimeout(() => dropToast(t.id), UNDO_MS)
}

async function markReviewed(s: SessionSummary, restore = false) {
  const key = sessionKey(s)
  if (hiding.has(key)) return
  // Keep the triage cursor where the row was: the next one slides under it.
  const prevFocus = focusedKey.value
  if (focusedKey.value === key) {
    const i = navRows.value.findIndex((r) => sessionKey(r) === key)
    const next = navRows.value[i + 1] ?? navRows.value[i - 1]
    focusedKey.value = next ? sessionKey(next) : null
  }
  const inRow = !!(document.activeElement as HTMLElement | null)?.closest(`[data-key="${CSS.escape(domKey(key))}"]`)
  hiding.add(key)
  try {
    await archiveSession(s.adw_id, !restore, s.factory_id, s.repo)
  } catch (err) {
    hiding.delete(key)
    // The row is back: so is the cursor (and an open peek with it).
    if (prevFocus === key) focusedKey.value = key
    actionError.value = `couldn't ${restore ? 'restore' : 'mark'} ${s.adw_id}${restore ? '' : ' reviewed'} — ${err instanceof Error ? err.message : String(err)}`
    return
  }
  actionError.value = null
  const id = ++toastId
  for (const old of toasts.value.slice(0, -2)) clearTimeout(old.timer)
  toasts.value = [...toasts.value.slice(-2), { id, key, session: s, restored: restore, timer: setTimeout(() => dropToast(id), UNDO_MS) }]
  // Drop any response already in flight (it began before the write), then refetch.
  settled.add(key)
  fetchGen++
  if (inRow) void nextTick(() => focusCursor(true))
  // The peek follows the cursor to the next run; if the button that was
  // pressed went with the old one, focus stays in the drawer.
  else if (peeking.value) void nextTick(() => keepPeekFocus())
  await tick()
}

async function undo(t: Toast) {
  dropToast(t.id)
  try {
    await archiveSession(t.session.adw_id, t.restored, t.session.factory_id, t.session.repo)
    actionError.value = null
  } catch (err) {
    actionError.value = `couldn't ${t.restored ? 'review' : 'restore'} ${t.session.adw_id} — ${err instanceof Error ? err.message : String(err)}`
  }
  fetchGen++
  await tick()
}

const actionError = ref<string | null>(null)

// ── Keyboard triage ───────────────────────────────────────────────────────
const focusedKey = ref<string | null>(null)
const root = useTemplateRef<HTMLElement>('root')
const searchInput = useTemplateRef<HTMLInputElement>('searchInput')
const showKeys = ref(false)

const focusedRow = computed(() => navRows.value.find((r) => sessionKey(r) === focusedKey.value) ?? null)
// A row that left the list (archived, filtered, folded) takes the cursor, and the peek, with it.
watch(focusedRow, (r) => {
  if (r) return
  focusedKey.value = null
  if (peeking.value) closePeek()
})

// ── Run peek ──────────────────────────────────────────────────────────────
// Space opens the run under the cursor in a drawer; while it is open, j / k
// move the cursor and the drawer follows. It reads the row the list already
// polls, so closing it leaves nothing running.
const peeking = ref(false)
const peekRow = computed(() => (peeking.value ? focusedRow.value : null))

function openPeek(s?: SessionSummary) {
  if (s) focusedKey.value = sessionKey(s)
  if (!focusedRow.value) return
  peeking.value = true
}

/** Close, and give focus back to the cursor row (or the Undo, when the row is gone). */
function closePeek() {
  peeking.value = false
  void nextTick(() => focusCursor(true))
}

function togglePeek(s: SessionSummary) {
  if (peeking.value && focusedKey.value === sessionKey(s)) closePeek()
  else openPeek(s)
}

function keepPeekFocus() {
  const active = document.activeElement
  if (active && active !== document.body && active.isConnected) return
  const heading = document.getElementById('run-peek-title')
  if (heading) {
    heading.tabIndex = -1
    heading.focus({ preventScroll: true })
  }
}

function moveFocus(step: 1 | -1) {
  const rows = navRows.value
  if (!rows.length) return
  const at = rows.findIndex((r) => sessionKey(r) === focusedKey.value)
  const next = at < 0 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step))
  focusedKey.value = sessionKey(rows[next] as SessionSummary)
  void nextTick(() => {
    const el = [...(root.value?.querySelectorAll<HTMLElement>('[data-key]') ?? [])].find((e) => e.dataset.key === domKey(focusedKey.value ?? ''))
    el?.scrollIntoView({ block: 'nearest' })
    // While peeking, focus stays in the drawer; the cursor ring marks the row.
    if (!peeking.value) el?.querySelector<HTMLElement>('a')?.focus({ preventScroll: true })
  })
}

/** Real DOM focus on the cursor row's link, so the ring and focus are one thing.
 * If the cursor has no row left, fall back to the toast's Undo so focus is never dropped to <body>. */
function focusCursor(fallbackToUndo: boolean) {
  const k = focusedKey.value
  const el = k ? [...(root.value?.querySelectorAll<HTMLElement>('[data-key]') ?? [])].find((e) => e.dataset.key === domKey(k)) : null
  const link = el?.querySelector<HTMLElement>('a')
  if (link) link.focus({ preventScroll: true })
  else if (fallbackToUndo) root.value?.querySelector<HTMLElement>('.toast-undo')?.focus()
}

function onCursor(s: SessionSummary) {
  focusedKey.value = sessionKey(s)
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest('[role="menu"], [role="group"][aria-label], [data-keys-off]')
}

function onKeydown(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
  if (typing(e.target)) return
  const interactive = (e.target as HTMLElement | null)?.closest('a, button')
  switch (e.key) {
    case 'j':
      moveFocus(1)
      break
    case 'k':
      moveFocus(-1)
      break
    case 'Enter': {
      // A focused link or button already handles Enter itself.
      if (interactive || !focusedRow.value) return
      const s = focusedRow.value
      navigate(s.adw_id, null, { factory: s.factory_id, repo: s.repo })
      break
    }
    case 'e':
      if (!focusedRow.value || runKind(focusedRow.value) === 'running') return
      void markReviewed(focusedRow.value, showReviewed.value)
      break
    case 'u': {
      const t = toasts.value[toasts.value.length - 1]
      if (!t) return
      void undo(t)
      break
    }
    case '/':
      searchInput.value?.focus()
      break
    case ' ':
      // A focused button (an action, a group toggle) takes Space itself.
      if ((e.target as HTMLElement | null)?.closest('button')) return
      if (peeking.value) closePeek()
      else if (focusedRow.value) openPeek()
      else return
      break
    case '?':
      showKeys.value = !showKeys.value
      break
    case 'Escape':
      if (showKeys.value) showKeys.value = false
      else if (peeking.value) closePeek()
      else if (focusedKey.value) focusedKey.value = null
      return
    default:
      return
  }
  e.preventDefault()
}

function onSearchKey(e: KeyboardEvent) {
  if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
}

// The mark learns which listed runs hold a passing receipt, for rows actually on screen.
const onScreen = new Set<string>()
let seen: IntersectionObserver | undefined
function askReceipts() {
  if (onScreen.size) void loadRowReceipts(visible.value.filter((s) => onScreen.has(domKey(sessionKey(s)))))
}
function observeRows() {
  if (typeof IntersectionObserver === 'undefined') return
  seen ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      const k = (e.target as HTMLElement).dataset.key ?? ''
      if (e.isIntersecting) onScreen.add(k)
      else onScreen.delete(k)
    }
    askReceipts()
  })
  seen.disconnect()
  onScreen.clear()
  for (const el of root.value?.querySelectorAll<HTMLElement>('[data-key]') ?? []) seen.observe(el)
}
watch(visible, () => void nextTick(observeRows), { immediate: true, flush: 'post' })
// A later poll can settle a prove phase on a row already on screen.
watch(visible, askReceipts)

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  seen?.disconnect()
  for (const t of toasts.value) clearTimeout(t.timer)
})
</script>

<template>
  <div ref="root" class="sessions page" :class="{ peeking: !!peekRow }">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>
    <div v-if="actionError" class="error-bar" role="alert">{{ actionError }}</div>

    <div class="list-caption">
      <h1 class="list-title">Runs</h1>
      <span v-if="visible.length" class="dim mono">{{ caption }}</span>
    </div>

    <div class="toolbar">
      <div class="search-bar">
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          class="search-input"
          placeholder="search requests, phases, errors…  ( / )"
          aria-label="Search runs"
          @focus="ensureSemanticChecked"
          @input="onSearchInput"
          @keydown="onSearchKey"
        />
        <span v-if="searching" class="search-note dim mono">searching…</span>
        <span v-else-if="semanticActive" class="search-note dim mono">semantic search active</span>
      </div>
      <div class="filters">
        <RepoFilter v-if="hosted && health && filterable" :health="health" :filter="filter" :rows="sessions" @change="onFilter" />
        <FilterMenu label="Status" all-label="All" :options="statusOptions" :selected="statusFilter" @change="onStatus" />
      </div>
    </div>

    <div v-if="visible.length" class="list" :class="{ 'list-search': searchActive, 'has-toast': toasts.length }">
      <div v-if="searchActive" class="rows" role="list">
        <SessionRow
          v-for="(s, i) in visible"
          :key="sessionKey(s)"
          :striped="stripedAt(i, visible.length)"
          role="listitem"
          :session="s"
          :now-ms="nowMs"
          inline-day
          :hosted="hosted"
          :focused="focusedKey === sessionKey(s)"
          :reviewed="showReviewed"
          :peeked="peekRow === s"
          :last-seen="s.factory_id ? factories.get(s.factory_id)?.last_seen_at : null"
          @review="markReviewed"
          @restore="(r) => markReviewed(r, true)"
          @cursor="onCursor"
          @peek="togglePeek"
        />
      </div>

      <section v-for="g in groups" v-else :key="g.key" class="group" :aria-label="g.label">
        <h2 class="g-head" :class="g.tone">
          <button
            v-if="g.collapsible"
            type="button"
            class="g-toggle"
            :aria-expanded="!collapsed.has(g.key)"
            @click="toggleGroup(g.key)"
          >
            <component :is="collapsed.has(g.key) ? ChevronRight : ChevronDown" :size="16" :stroke-width="2.5" />
            <span>{{ g.label }}</span>
            <span class="g-count mono">{{ g.rows.length }}</span>
          </button>
          <template v-else>
            <span>{{ g.label }}</span>
            <span class="g-count mono">{{ g.rows.length }}</span>
          </template>
        </h2>
        <div v-if="!(g.collapsible && collapsed.has(g.key))" class="rows" role="list">
          <SessionRow
            v-for="(s, i) in g.rows"
            :key="sessionKey(s)"
            :striped="stripedAt(i, g.rows.length)"
            role="listitem"
            :session="s"
            :now-ms="nowMs"
            :hosted="hosted"
            :focused="focusedKey === sessionKey(s)"
            :reviewed="showReviewed"
            :peeked="peekRow === s"
            :last-seen="s.factory_id ? factories.get(s.factory_id)?.last_seen_at : null"
            @review="markReviewed"
            @restore="(r) => markReviewed(r, true)"
            @cursor="onCursor"
            @peek="togglePeek"
          />
        </div>
      </section>

      <div class="legend dim" aria-label="Keyboard shortcuts">
        <span class="keys"><kbd>j</kbd><kbd>k</kbd> move</span>
        <span class="keys"><kbd>enter</kbd> open</span>
        <span class="keys"><kbd>space</kbd> peek</span>
        <span class="keys"><kbd>e</kbd> {{ showReviewed ? 'restore' : 'mark reviewed' }}</span>
        <span class="keys"><kbd>u</kbd> undo</span>
        <span class="keys"><kbd>/</kbd> search</span>
        <button type="button" class="keys legend-help" :aria-expanded="showKeys" @click="showKeys = !showKeys"><kbd>?</kbd> shortcuts</button>
      </div>
      <dl v-if="showKeys" class="keylist">
        <dt><kbd>j</kbd> / <kbd>k</kbd></dt><dd>Move the cursor down or up through the visible runs</dd>
        <dt><kbd>enter</kbd></dt><dd>Open the run under the cursor</dd>
        <dt><kbd>space</kbd></dt><dd>Peek at the run under the cursor; <kbd>j</kbd> / <kbd>k</kbd> follow it, <kbd>space</kbd> or <kbd>esc</kbd> closes</dd>
        <dt><kbd>e</kbd></dt><dd>Mark the run reviewed (undo stays for 6 seconds)</dd>
        <dt><kbd>u</kbd></dt><dd>Undo the latest mark reviewed</dd>
        <dt><kbd>/</kbd></dt><dd>Jump to search; <kbd>esc</kbd> leaves it</dd>
        <dt><kbd>?</kbd></dt><dd>Show or hide this list</dd>
      </dl>
    </div>
    <div v-else-if="loaded && query.trim()" class="empty-state">no matches for "{{ query }}"</div>
    <div v-else-if="showReviewed && !reviewedLoaded && !apiError" class="empty-state">loading reviewed runs…</div>
    <div v-else-if="loaded && showReviewed" class="empty-state">No reviewed runs. Runs you mark reviewed collect here, and can be restored.</div>
    <div v-else-if="loaded && (!filterIsEmpty(filter) || (statusFilter.length && sessions.length))" class="empty-state">no runs match this filter</div>
    <div v-else-if="loaded && hosted" class="empty-state">No runs synced yet. Runs appear here once a factory syncs (<code>sync.on_watch</code> or <code>spf sync</code>).</div>
    <div v-else-if="loaded" class="empty-state">No runs yet. Start one with <code>spf watch</code>, or run a chain such as <code>spf scout "…"</code> in this repo.</div>
    <div v-else-if="!apiError" class="empty-state">loading runs…</div>

    <PeekDrawer v-if="peekRow" labelledby="run-peek-title" :restore-focus="false">
      <RunPeek
        :session="peekRow"
        :now-ms="nowMs"
        :hosted="hosted"
        :reviewed="showReviewed"
        @close="closePeek"
        @review="(r) => markReviewed(r, showReviewed)"
      />
    </PeekDrawer>

    <div class="toasts" role="status" aria-live="polite">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        @mouseenter="pauseToast(t)"
        @focusin="pauseToast(t)"
        @mouseleave="resumeToast(t)"
        @focusout="resumeToast(t)"
      >
        <span class="toast-text">{{ t.restored ? 'Restored' : 'Reviewed' }} “{{ plainRequest(t.session.request) }}” <span class="mono dim">{{ t.session.adw_id }}</span></span>
        <button type="button" class="toast-undo" @click="undo(t)">Undo</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sessions {
  --peek-w: clamp(420px, 40vw, 640px);
  display: flex;
  flex-direction: column;
}

/* Wide glass: the list reflows beside the peek, so j / k never step blind. */
@media (min-width: 1280px) {
  .sessions.peeking {
    padding-right: calc(var(--peek-w) + var(--gutter));
  }
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  margin: 18px 0 0;
}

.search-bar {
  display: flex;
  flex: 1 1 320px;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}

.search-input {
  flex: 1;
  max-width: 420px;
  padding: 6px 10px;
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

.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.list {
  margin: 8px 0 24px;
}

.list-caption {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 18px 0 0;
}

.list-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.list.has-toast {
  padding-bottom: 72px;
}

.list-search .rows {
  border-top: 1px solid var(--rule);
}

.group + .group {
  margin-top: 8px;
}

/* A group head shares the column-head treatment (600, lowercase, tracked,
   faint) with a hairline under it; the count is data, so it is mono. */
.g-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0;
  padding: 14px 0 6px;
  border-bottom: 1px solid var(--rule);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  color: var(--faint);
}

.g-head.review {
  color: var(--fg);
}

.g-head.review .g-count {
  color: var(--fail);
}

.g-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  color: inherit;
  background: none;
  border: 0;
  border-radius: var(--radius);
  cursor: pointer;
  align-self: center;
}

.g-toggle:hover {
  color: var(--fg);
}

.g-count {
  font-family: var(--mono);
  font-weight: 400;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}

.rows {
  display: flex;
  flex-direction: column;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  margin-top: 28px;
  padding-top: 10px;
  border-top: 1px solid var(--rule-soft);
  color: var(--faint);
}

.keys {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.legend-help {
  font: inherit;
  padding: 0;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}

.legend-help:hover {
  color: var(--fg);
}

kbd {
  font-family: var(--mono);
  padding: 0 6px;
  color: var(--dim);
  background: var(--inset);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.keylist {
  position: fixed;
  right: var(--gutter);
  bottom: 20px;
  z-index: 40;
  width: min(420px, calc(100vw - 2 * var(--gutter)));
  box-sizing: border-box;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 18px;
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--face);
  color: var(--dim);
}

.keylist dt {
  color: var(--fg);
}

.keylist dd {
  margin: 0;
}

/* The undo toast: a hairline slab at the foot, no shadow. */
.toasts {
  position: fixed;
  left: var(--gutter);
  bottom: 20px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: calc(100vw - 2 * var(--gutter));
}

.toast {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 8px 8px 8px 14px;
  background: var(--fg);
  color: var(--ground);
  border-radius: var(--radius);
}

.toast-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toast-undo {
  font: inherit;
  font-weight: 700;
  padding: 4px 12px;
  color: var(--ground);
  background: transparent;
  border: 1px solid currentColor;
  border-radius: var(--radius);
  cursor: pointer;
}

.toast-undo:hover {
  background: var(--ground);
  color: var(--fg);
}

.toast-undo:focus-visible {
  outline-color: var(--ground);
  outline-offset: 1px;
}

@media (max-width: 980px) {
  .toolbar {
    margin: 12px 0 0;
  }

  .search-input {
    max-width: none;
  }

  .legend,
  .keylist {
    display: none;
  }
}

@media (max-width: 720px) {
  .toasts {
    left: 16px;
    right: 16px;
    bottom: 16px;
  }

  .toast {
    justify-content: space-between;
  }
}

/* Touch: interactive targets reach 44px on phone glass. */
@media (max-width: 640px) {
  .search-input {
    min-height: 44px;
  }

  .g-toggle {
    min-height: 44px;
  }
}
</style>
