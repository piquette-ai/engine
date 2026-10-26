<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watchEffect } from 'vue'
import type {
  AgentSession,
  AgentStartPayload,
  Envelope,
  EventRow,
  GateResult,
  Phase,
  Session,
  SessionUsage,
} from '../lib/types'
import { Inbox } from 'lucide-vue-next'
import { fetchEnvelopes, fetchEvents, fetchGates, fetchSession } from '../lib/api'
import { axisTicks, costTitle, fmtCost, fmtDuration, fmtTokens } from '../lib/format'
import { fmtDayHM, fmtFull } from '../lib/day'
import { parseAgentStart } from '../lib/events'
import { startPolling } from '../lib/poll'
import { navigate, phaseCrumb, traceRepo, useRoute } from '../lib/router'
import { lastUpdatedMs, traceRunning, traceTitle } from '../lib/live'
import { health, hosted } from '../lib/health'
import { sessionReceipts } from '../lib/session-receipts'
import { kindGlyph, kindWord, plainRequest, runIssueLink, runKind, runPrLink, type RunLinkView } from '../lib/runs'
import { HINTS } from '../lib/hints'
import InfoHint from './InfoHint.vue'
import { phaseAxis, requestPhaseOf, runDurationMs, stepPhasesOf } from '../lib/phases'
import { renderMarkdown } from '../lib/markdown'
import { STAT_TITLES } from '../lib/stats'
import DetailSection from './DetailSection.vue'
import PeekDrawer from './PeekDrawer.vue'
import PhaseDetail from './PhaseDetail.vue'
import PhaseSteps from './PhaseSteps.vue'
import PhaseTimeline from './PhaseTimeline.vue'
import RunBand from './RunBand.vue'
import RunLink from './RunLink.vue'
import StatusGlyph from './StatusGlyph.vue'
import SessionSummary from './SessionSummary.vue'
import SessionVerification from './SessionVerification.vue'
import SessionQaPanel from './SessionQaPanel.vue'
import Loader from './loader/Loader.vue'
import SkeletonRun from './loader/SkeletonRun.vue'
import { useLoadingTier } from '../lib/loader'

const props = defineProps<{ adwId: string; phaseId: string | null }>()

// Hosted mode: factories and repos can share an adw_id, so every call names both.
// Null in local mode, where the server ignores it. App keys this view on (adwId, factory, repo).
const sel = { factory: useRoute().value.factory, repo: useRoute().value.repo }

const session = ref<Session | null>(null)
const phases = ref<Phase[]>([])
const agents = ref<AgentSession[]>([])
const usage = ref<SessionUsage>({ read: 0, written: 0 })
const events = ref<EventRow[]>([])
const envelopes = ref<Envelope[]>([])
const gates = ref<GateResult[]>([])
const apiError = ref<string | null>(null)
const loaded = ref(false)
// Nothing under 300ms, then the page's skeleton, then the brand loader past 2s.
const firstLoad = useLoadingTier(() => !session.value && !apiError.value)
const nowMs = ref(Date.now())

let cursor = 0
let inflight = false
let stopPolling: (() => void) | undefined

const SIDE_TABLE_TYPES = new Set(['gate_pass', 'gate_fail', 'handoff', 'agent_end', 'phase_end', 'error'])

async function tick() {
  if (inflight) return
  inflight = true
  try {
    const detail = await fetchSession(props.adwId, sel)
    session.value = detail.session
    traceRepo.value = detail.session.repo ?? null
    traceTitle.value = plainRequest(detail.session.request)
    phases.value = detail.phases.toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    agents.value = detail.agents
    usage.value = detail.usage

    const fresh: EventRow[] = []
    let page
    do {
      // Cursor pagination is inherently sequential: each request needs the previous cursor.
      // oxlint-disable-next-line no-await-in-loop
      page = await fetchEvents(props.adwId, cursor, 1000, sel)
      cursor = Math.max(cursor, page.cursor)
      fresh.push(...page.events)
    } while (page.has_more)
    if (fresh.length) events.value = [...events.value, ...fresh]

    // Envelopes and gates only gain rows around phase/agent boundaries — refetch
    // on those events instead of every tick.
    if (!loaded.value || fresh.some((e) => e.type !== null && SIDE_TABLE_TYPES.has(e.type))) {
      const [env, g] = await Promise.all([fetchEnvelopes(props.adwId, sel), fetchGates(props.adwId, sel)])
      envelopes.value = env
      gates.value = g
    }

    nowMs.value = Date.now()
    lastUpdatedMs.value = nowMs.value
    apiError.value = null
    loaded.value = true
  } catch (err) {
    apiError.value = err instanceof Error ? err.message : String(err)
  } finally {
    inflight = false
  }
}

onMounted(() => {
  void tick()
  stopPolling = startPolling(() => void tick())
})

onUnmounted(() => {
  stopPolling?.()
  phaseCrumb.value = null
  traceRepo.value = null
  traceTitle.value = null
  traceRunning.value = false
  lastUpdatedMs.value = null
})

const selectedPhase = computed(
  () => phases.value.find((p) => p.phase_id === props.phaseId) ?? null,
)

watchEffect(() => {
  phaseCrumb.value = selectedPhase.value?.name ?? null
})
watchEffect(() => {
  traceRunning.value = session.value?.status === 'running'
})

// ── Who ran what ─────────────────────────────────────────────────────────────

// A live agent's model arrives on its agent_start event before any
// agent_sessions row exists; attribute each start to its phase's owner.
const ownerStart = computed<Record<string, AgentStartPayload>>(() => {
  const ownerByPhase = new Map<string, string | null>(phases.value.map((p) => [p.phase_id, p.owner]))
  const meta: Record<string, AgentStartPayload> = {}
  for (const e of events.value) {
    if (e.type !== 'agent_start') continue
    const owner = (e.phase_id ? ownerByPhase.get(e.phase_id) : null) ?? e.name
    if (!owner || meta[owner]) continue
    const payload = parseAgentStart(e)
    if (payload) meta[owner] = payload
  }
  return meta
})

const modelFor = computed<Record<string, string | null>>(() => {
  const out: Record<string, string | null> = {}
  for (const p of phases.value) {
    if (p.kind !== 'agent' || !p.owner || p.owner in out) continue
    const info = agents.value.find((a) => a.agent === p.owner)
    out[p.owner] = info?.model ?? ownerStart.value[p.owner]?.model ?? null
  }
  return out
})

// ── The request ──────────────────────────────────────────────────────────────
// The engineer's ask opens every run. It is the page title now, not a zone on
// the board: the opening request phase is left out of the step list and the
// timeline (a link under the list still opens it). Only the earliest phase
// counts; a later engineer phase (a human review) stays in the list.

const requestPhase = computed(() => requestPhaseOf(phases.value))

// Only the request's first line: pasted issue bodies run on for pages, and the whole text stays in the Request disclosure.
const title = computed(() => {
  const t = plainRequest(session.value?.request)
  return t === '—' ? `Run ${props.adwId}` : t
})
const requestText = computed(() => session.value?.request?.trim() ?? '')
// The disclosure earns its place only when the title had to drop something.
const requestHasMore = computed(() => {
  const full = requestText.value
  return !!full && (full !== title.value || full.length > 140)
})
const requestHtml = computed(() => (requestHasMore.value ? renderMarkdown(requestText.value) : ''))
const requestOpen = ref(false)

// ── Phases in time order ─────────────────────────────────────────────────────

const stepPhases = computed(() => stepPhasesOf(phases.value))

// One time axis for both views: from the first phase after the request to the
// last end (or now, while running).
const axis = computed(() => phaseAxis(stepPhases.value, session.value, nowMs.value))

const ticks = computed(() => axisTicks(axis.value.span, 6))

const sessionDurationMs = computed(() => runDurationMs(session.value, nowMs.value))

// ── Header meta ──────────────────────────────────────────────────────────────

// The header reads the run the way the list does: a run that succeeded through a
// failed phase is "Recovered" with the rotate mark, never a green "Succeeded".
const runAsRow = computed(() => (session.value ? { ...session.value, phases: phases.value, phase_count: phases.value.length, agents: agents.value } : null))
const statusWord = computed(() => (runAsRow.value ? kindWord[runKind(runAsRow.value)] : '—'))
const statusGlyph = computed(() => (runAsRow.value ? kindGlyph(runAsRow.value) : null))

const repoName = computed(() => session.value?.repo ?? health.value?.repo ?? null)
// The sidebar prints owner/name: the host ("github.com/") would push the name
// itself past the ellipsis. The full slug rides in the title.
// Only a host/owner/name slug drops its first segment: "my.org/repo" keeps its owner.
const repoLabel = computed(() => repoName.value?.replace(/^[^/]+\.[^/]+\/(?=[^/]+\/[^/])/, '') ?? null)
const who = computed(() => session.value?.factory_name ?? session.value?.engineer ?? null)

// Sidebar rows that would only repeat their neighbour stay out: a factory named
// like its engineer prints once (as Engineer), and Read goes when it is the
// whole token count. Equal values only — nothing is merged or guessed.
const factoryName = computed(() => session.value?.factory_name ?? session.value?.factory_id ?? null)
const showFactory = computed(() => hosted.value && factoryName.value !== (session.value?.engineer ?? null))
const showRead = computed(() => !usage.value.read || usage.value.read !== session.value?.total_tokens)

// The tracked issue: the one `piquette watch` recorded on the run, else the one a
// receipt names. A receipt's number is linked only where the repo slug names
// its host; otherwise the number alone, never a guessed URL.
const issue = computed<RunLinkView | null>(() => {
  const recorded = session.value ? runIssueLink(session.value) : null
  if (recorded) return recorded
  const r = sessionReceipts.value
  if (!r || r.adwId !== props.adwId) return null
  const n = r.run.head?.receipt.issue ?? r.run.base?.receipt.issue ?? null
  if (!n) return null
  const num = String(n).replace(/^#/, '')
  const slug = session.value?.repo ?? ''
  const href = /^\d+$/.test(num) && slug.startsWith('github.com/') ? `https://${slug}/issues/${num}` : null
  return { label: /^\d+$/.test(num) ? `#${num}` : num, href }
})

// The pull request `piquette watch` opened for this run, when it recorded one.
const pr = computed(() => (session.value ? runPrLink(session.value) : null))

// ── Assistant card ───────────────────────────────────────────────────────────

const summaryAvailable = ref(false)
const askAvailable = ref(false)

// ── Views ────────────────────────────────────────────────────────────────────

type View = 'steps' | 'timeline'
const VIEW_KEY = 'piquette-phase-view'
function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'timeline' ? 'timeline' : 'steps'
  } catch {
    return 'steps'
  }
}
const chosenView = ref<View>(loadView())
// The lane view needs width: on phones it scrolls sideways and its blocks cannot hold a label, so
// narrow screens always show Steps and offer no toggle. The stored choice is kept for wide screens.
const narrowMq = typeof matchMedia === 'function' ? matchMedia('(max-width: 640px)') : null
const narrow = ref(narrowMq?.matches ?? false)
const onNarrow = (e: MediaQueryListEvent) => (narrow.value = e.matches)
narrowMq?.addEventListener('change', onNarrow)
onUnmounted(() => narrowMq?.removeEventListener('change', onNarrow))
const view = computed<View>(() => (narrow.value ? 'steps' : chosenView.value))
function setView(v: View) {
  chosenView.value = v
  try {
    localStorage.setItem(VIEW_KEY, v)
  } catch {
    // a per-viewer convenience; fine if it doesn't stick
  }
}

// ── Peek ─────────────────────────────────────────────────────────────────────
// The phase detail opens in a drawer beside the run (the phase id rides in the
// URL, so a peek is linkable and Back closes it). Esc closes; j / k step.

const peekEl = ref<InstanceType<typeof PeekDrawer> | null>(null)

function selectPhase(p: Phase) {
  navigate(props.adwId, p.phase_id === props.phaseId ? null : p.phase_id, sel)
}

function openPhase(p: Phase, replace = false) {
  navigate(props.adwId, p.phase_id, sel, { replace })
}

function closePeek() {
  navigate(props.adwId, null, sel)
}

function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
}

function onKey(e: KeyboardEvent) {
  if (!selectedPhase.value || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'Escape') {
    // Esc in a field outside the drawer (Ask, search) belongs to that field.
    if (typing(e.target) && !peekEl.value?.contains(e.target as Node | null)) return
    e.preventDefault()
    closePeek()
    return
  }
  if ((e.key === 'j' || e.key === 'k') && !typing(e.target)) {
    const list = stepPhases.value
    if (!list.length) return
    const i = list.findIndex((p) => p.phase_id === props.phaseId)
    const next = e.key === 'j' ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0)
    const target = list[i === -1 ? 0 : next]
    if (target && target.phase_id !== props.phaseId) {
      e.preventDefault()
      openPhase(target, true)
    }
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="trace page" :class="{ peeking: !!selectedPhase }">
    <div v-if="apiError" class="error-bar">The API isn't answering. Retrying… ({{ apiError }})</div>

    <header v-if="session" class="run-head">
      <h1 class="run-title" :title="title">{{ title }}</h1>
      <p class="run-meta">
        <span class="mi status" :class="statusGlyph ?? 'queued'">
          <StatusGlyph :status="statusGlyph" />
          {{ statusWord }}
        </span>
        <span v-if="session.adw_name" class="mi">{{ session.adw_name }}</span>
        <span v-if="who" class="mi">{{ who }}</span>
        <span class="mi mono" :title="fmtFull(session.started_at)">{{ fmtDayHM(session.started_at, new Date(nowMs)) }}</span>
        <span class="mi mono" :title="STAT_TITLES.runtime">{{ fmtDuration(sessionDurationMs) }}</span>
        <span v-if="issue" class="mi"><RunLink :link="issue" prefix="Issue" arrow /></span>
        <span v-if="pr" class="mi"><RunLink :link="pr" prefix="PR" arrow /></span>
      </p>

      <RunBand class="run-band" :session="session" :phases="phases" :gates="gates" @open="openPhase" />
    </header>

    <div v-if="session" class="run-grid">
      <div class="run-main">
        <SessionVerification :adw-id="adwId" :session="session" :phases="phases" />

        <div v-if="requestHasMore" class="request-box">
          <DetailSection title="Request" :icon="Inbox" :open="requestOpen" @toggle="requestOpen = !requestOpen">
            <!-- Safe: renderMarkdown escapes ALL input before emitting its own tags. -->
            <div class="md request-md" v-html="requestHtml" />
          </DetailSection>
        </div>

        <section class="phases" aria-labelledby="phases-label">
          <div class="phases-bar">
            <h2 id="phases-head" class="sec-head">
              <span id="phases-label">Phases</span> <span class="count">{{ stepPhases.length }}</span>
              <InfoHint class="sec-hint" label="What are phases?" :text="HINTS.phases" />
            </h2>
            <div v-if="!narrow" class="seg" role="group" aria-label="Phase view">
              <button
                type="button"
                :aria-pressed="view === 'steps'"
                :class="{ on: view === 'steps' }"
                @click="setView('steps')"
              >
                Steps
              </button>
              <button
                type="button"
                :aria-pressed="view === 'timeline'"
                :class="{ on: view === 'timeline' }"
                @click="setView('timeline')"
              >
                Timeline
              </button>
            </div>
          </div>

          <template v-if="stepPhases.length">
            <PhaseSteps
              v-if="view === 'steps'"
              :phases="stepPhases"
              :t0="axis.t0"
              :span="axis.span"
              :now-ms="nowMs"
              :ticks="ticks"
              :selected-id="phaseId"
              :model-for="modelFor"
              :gates="gates"
              @select="selectPhase"
            />
            <PhaseTimeline
              v-else
              :phases="stepPhases"
              :agents="agents"
              :events="events"
              :engineer="session.engineer"
              :t0="axis.t0"
              :span="axis.span"
              :now-ms="nowMs"
              :ticks="ticks"
              :selected-id="phaseId"
              :model-for="modelFor"
              @select="selectPhase"
            />
            <p v-if="!phaseId || requestPhase" class="hint">
              <span v-if="!phaseId">Select a phase to see its events, gates and outputs.</span>
              <button v-if="requestPhase" type="button" class="hint-link" @click="openPhase(requestPhase)">Open the request</button>
            </p>
          </template>
          <p v-else-if="loaded" class="empty">No phases recorded for this run yet.</p>
        </section>
      </div>

      <aside class="run-side" aria-label="Run details">
        <section class="side-card" aria-labelledby="side-run-head">
          <h2 id="side-run-head" class="side-head">Run</h2>
          <dl class="kv">
            <div>
              <dt>Repository</dt>
              <dd class="mono line" :title="repoName ?? undefined">{{ repoLabel ?? '—' }}</dd>
            </div>
            <div>
              <dt>Chain <InfoHint label="What is a chain?" :text="HINTS.chain" /></dt>
              <dd>{{ session.adw_name ?? '—' }}</dd>
            </div>
            <div v-if="showFactory">
              <dt>Factory</dt>
              <dd class="line" :title="factoryName ?? undefined">{{ factoryName ?? '—' }}</dd>
            </div>
            <div>
              <dt>Engineer</dt>
              <dd class="line" :title="session.engineer ?? undefined">{{ session.engineer ?? '—' }}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd class="mono" :title="fmtFull(session.started_at)">{{ fmtDayHM(session.started_at, new Date(nowMs)) }}</dd>
            </div>
            <div>
              <dt :title="STAT_TITLES.runtime">Duration</dt>
              <dd class="mono">{{ fmtDuration(sessionDurationMs) }}</dd>
            </div>
            <div>
              <dt>Issue</dt>
              <dd class="mono"><RunLink :link="issue" /></dd>
            </div>
            <div>
              <dt>Pull request</dt>
              <dd class="mono"><RunLink :link="pr" /></dd>
            </div>
            <div>
              <dt>Run id</dt>
              <dd class="mono">{{ adwId }}</dd>
            </div>
          </dl>

          <h2 id="side-spend-head" class="side-head side-group">Spend</h2>
          <dl class="kv" aria-labelledby="side-spend-head">
            <div>
              <dt :title="STAT_TITLES.cost">Cost</dt>
              <dd class="mono" :title="costTitle(session.total_cost)">{{ fmtCost(session.total_cost) }}</dd>
            </div>
            <div>
              <dt :title="STAT_TITLES.tokens">Tokens</dt>
              <dd class="mono">{{ fmtTokens(session.total_tokens) }}</dd>
            </div>
            <div v-if="showRead">
              <dt :title="STAT_TITLES.read">Read</dt>
              <dd class="mono">{{ usage.read ? fmtTokens(usage.read) : '—' }}</dd>
            </div>
            <div>
              <dt :title="STAT_TITLES.written">Written</dt>
              <dd class="mono">{{ usage.written ? fmtTokens(usage.written) : '—' }}</dd>
            </div>
          </dl>
        </section>
      </aside>

      <!-- The assistant reads the run, so it sits under the steps (beside the
           sidebar on wide glass, after it when stacked) instead of lengthening
           the sidebar into a long column beside a short run. -->
      <section v-show="summaryAvailable || askAvailable" class="side-card assistant" aria-labelledby="assistant-head">
        <h2 id="assistant-head" class="side-head">Assistant <span class="faint">(on-device)</span></h2>
        <SessionSummary :adw-id="adwId" :session="session" :phases="phases" @available="summaryAvailable = $event" />
        <SessionQaPanel :adw-id="adwId" :session="session" :phases="phases" @available="askAvailable = $event" />
      </section>
    </div>
    <SkeletonRun v-else-if="!apiError && firstLoad === 'skeleton'" />
    <div v-else-if="!apiError && firstLoad === 'brand'" class="empty-state"><Loader job="run" :label="`Loading the run ${adwId}`" /></div>

    <PeekDrawer v-if="selectedPhase" ref="peekEl" labelledby="peek-title">
      <PhaseDetail
        :phase="selectedPhase"
        :events="events"
        :envelopes="envelopes"
        :gates="gates"
        :now-ms="nowMs"
        @close="closePeek"
      />
    </PeekDrawer>
  </div>
</template>

<style scoped>
.trace {
  padding-top: 24px;
  padding-bottom: 48px;
}

/* ── header: title, status + meta line, attention ── */

.run-head {
  margin-bottom: 24px;
}

.run-title {
  margin: 0;
  max-width: 72ch;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: -0.01em;
  text-wrap: balance;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.run-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin: 10px 0 0;
  color: var(--dim);
}

.mi {
  white-space: nowrap;
}

/* The separator trails its item, so a wrapped line never opens on a dot. */
.mi:not(:last-child)::after {
  content: '·';
  margin-left: 10px;
  font-family: var(--sans);
  color: var(--faint);
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--fg);
}

/* Colour only for the exception: a failure prints red, a live run in the
   live ink. Success keeps the green to its glyph. */
/* inline-flex adds its gap before the trailing dot; take it back. */
.status.mi:not(:last-child)::after {
  margin-left: 4px;
  font-weight: 400;
}

.status.fail {
  color: var(--fail);
}

.status.running {
  color: var(--live);
}

.run-band {
  margin-top: 18px;
}

/* ── two columns: the run, and its key-value sidebar ── */

.run-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  /* Row 1 is as tall as the run itself; the sidebar spans into row 2, which
     takes any surplus, so a short run never stretches and the assistant sits
     straight under its steps. */
  grid-template-rows: auto 1fr;
  grid-template-areas:
    'main side'
    'assist side';
  gap: 32px;
  align-items: start;
}

.run-main {
  grid-area: main;
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}

.request-box :deep(.dsec) {
  margin-bottom: 0;
}

.request-md {
  max-width: 72ch;
  padding: 0 6px;
}

.sec-head {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
}

.sec-hint {
  margin-left: 4px;
}

.count {
  margin-left: 6px;
  font-family: var(--mono);
  font-weight: 400;
  color: var(--faint);
}

.phases-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

/* Segmented control: two squared cells on one hairline. */
.seg {
  display: inline-flex;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.seg button {
  padding: 3px 14px;
  border: none;
  border-radius: 0;
  background: none;
  color: var(--dim);
  font: inherit;
  cursor: pointer;
}

.seg button + button {
  border-left: 1px solid var(--rule);
}

.seg button:hover {
  color: var(--fg);
}

.seg button.on {
  background: var(--fg);
  color: var(--ground);
  font-weight: 600;
}

.hint,
.empty {
  margin: 10px 0 0;
  color: var(--faint);
}

.hint-link {
  margin-left: 8px;
  padding: 0;
  border: none;
  background: none;
  color: var(--dim);
  font: inherit;
  text-decoration: underline;
  text-decoration-color: var(--rule);
  text-underline-offset: 4px;
  cursor: pointer;
}

.hint-link:hover,
.hint-link:focus-visible {
  color: var(--fg);
  text-decoration-color: var(--fg);
}

.run-side {
  grid-area: side;
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}

.side-card {
  padding: 14px 16px 16px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--face);
}

.side-head {
  margin: 0 0 10px;
  font-size: 17px;
  font-weight: 700;
}

.side-head .faint {
  font-weight: 400;
}

.kv {
  margin: 0;
}

.kv > div {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  align-items: baseline;
  gap: 12px;
  padding: 5px 0;
  border-top: 1px solid var(--rule-soft);
}

.kv > div:first-child {
  border-top: none;
}

.kv dt {
  color: var(--dim);
}

.kv dt[title] {
  text-decoration: underline dotted var(--rule);
  text-underline-offset: 4px;
  cursor: help;
}

.kv dd {
  margin: 0;
  min-width: 0;
  color: var(--fg);
  overflow-wrap: anywhere;
}

/* Names on one line: a long slug ellipsizes (the full value rides in the
   title), never wraps mid-slug. */
.kv dd.line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow-wrap: normal;
}

/* The second group in the card: a hairline and air above its head. */
.side-group {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--rule);
}

.kv dd.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.assistant {
  grid-area: assist;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.assistant .side-head {
  margin-bottom: -6px;
}

/* ── peek drawer ──
   Starts under the sticky masthead (crumbs, live state and settings stay in
   view) and sits below it in the stack. On wide glass the run reflows beside
   it, the sidebar dropping under the steps, so j / k never steps blind. */

.trace {
  --peek-w: clamp(420px, 40vw, 640px);
}

@media (min-width: 1280px) {
  .trace.peeking {
    padding-right: calc(var(--peek-w) + var(--gutter));
  }

  .trace.peeking .run-grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: none;
    grid-template-areas: 'main' 'side' 'assist';
  }
}

@media (max-width: 1100px) {
  .run-grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: none;
    grid-template-areas: 'main' 'side' 'assist';
  }
}

@media (max-width: 640px) {
  .trace {
    padding-top: 18px;
  }

  .run-title {
    font-size: 20px;
  }
}

/* Touch: interactive targets reach 44px on phone glass. */
@media (max-width: 640px) {
  .seg button {
    min-height: 44px;
  }
}
</style>
