<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { fetchReceiptRun, fetchSession, receiptFileUrl } from '../../lib/api'
import { dashboardRoot, hasDashboard } from '../../lib/brand'
import { health } from '../../lib/health'
import { receiptTitle } from '../../lib/live'
import { plainRequest, runIssueLink, runPrLink, type RunLinkView } from '../../lib/runs'
import { receiptRepoSlug } from '../../lib/receipt-repo'
import { hrefFor, viewerRepo } from '../../lib/router'
import { droppedEvidence, journeyEvidence, receiptRepoSegment } from '@shared/receipt_links'
import type { ReceiptEvidenceItem, ReceiptsRunResponse, ReceiptView } from '../../lib/types'
import DetailSection from '../DetailSection.vue'
import BeforeAfterTable from './BeforeAfterTable.vue'
import ChecksTable from './ChecksTable.vue'
import JourneyEvidence from './JourneyEvidence.vue'
import ReceiptFacts from './ReceiptFacts.vue'
import ReceiptVideo from './ReceiptVideo.vue'
import VerdictBanner from './VerdictBanner.vue'

const props = defineProps<{ runId: string; focusKey: string | null }>()

const run = ref<ReceiptsRunResponse | null>(null)
const state = ref<'loading' | 'ready' | 'missing' | 'conflict' | 'error'>('loading')
const message = ref('')
const candidates = ref<string[]>([])

onMounted(async () => {
  try {
    const r = await fetchReceiptRun(props.runId, viewerRepo)
    run.value = r
    await loadFocusedAttempt(r)
    state.value = 'ready'
    void loadChain()
  } catch (e) {
    const err = e as Error & { status?: number; candidates?: string[] }
    message.value = err.message
    candidates.value = err.candidates ?? []
    state.value = err.status === 404 ? 'missing' : err.status === 409 ? 'conflict' : 'error'
  }
})

// A link to an earlier head attempt (`?key=<attempt>/receipt.json`, from a prove phase
// whose fix loop ran again) opens on that attempt instead of the latest one.
const olderHead = ref<ReceiptView | null>(null)
async function loadFocusedAttempt(r: ReceiptsRunResponse) {
  const k = props.focusKey
  const a = k ? r.attempts.find((x) => x.key === k && x.stage === 'head') : null
  if (!a || a.key === r.head?.key) return
  try {
    const res = await fetch(receiptFileUrl(props.runId, a.key, r.repo ?? viewerRepo))
    if (!res.ok) return
    olderHead.value = {
      key: a.key,
      attempt: a.attempt,
      receipt: (await res.json()) as ReceiptView['receipt'],
    }
  } catch {
    /* fall back to the latest attempt */
  }
}

const head = computed<ReceiptView | null>(() => olderHead.value ?? run.value?.head ?? null)
const base = computed<ReceiptView | null>(() => run.value?.base ?? null)
const repo = computed(() => run.value?.repo ?? viewerRepo)
// What the Repo row prints: the slug, never the store's segment (which for older local receipts is the run id).
const repoLabel = computed(() => receiptRepoSlug(repo.value, props.runId))

// The run's trace, when this site has a dashboard to hold it. Standalone `prove-` runs have no session.
const runHref = computed(() => {
  if (!hasDashboard || props.runId.startsWith('prove-')) return null
  const seg = repo.value
  const slug = seg ? health.value?.repos?.find((x) => receiptRepoSegment(x) === seg) : undefined
  return dashboardRoot + hrefFor(props.runId, null, slug ? { repo: slug } : {})
})

// Which chain ran, from the run's trace when this site has one. Failure leaves the row at '—'.
const chain = ref<string | null>(null)
const issueLink = ref<RunLinkView | null>(null)
const prLink = ref<RunLinkView | null>(null)
onUnmounted(() => (receiptTitle.value = null))
async function loadChain() {
  if (!runHref.value) return
  const seg = repo.value
  const slug = seg ? health.value?.repos?.find((x) => receiptRepoSegment(x) === seg) : undefined
  try {
    const d = await fetchSession(props.runId, slug ? { repo: slug } : undefined)
    chain.value = d.session.adw_name || null
    issueLink.value = runIssueLink(d.session)
    prLink.value = runPrLink(d.session)
    const t = plainRequest(d.session.request)
    receiptTitle.value = t === '—' ? null : t
  } catch {
    /* no trace for this run here */
  }
}

// A PR link carries `?key=<evidence key>`; if it belongs to the base attempt, start there.
const focusIsBase = computed(() => {
  const k = props.focusKey
  if (!k || !base.value) return false
  return k === base.value.key || Object.values(base.value.receipt.evidence).some((e) => e.key === k)
})
const focusEvidence = computed(() => {
  const k = props.focusKey
  if (!k) return null
  const view = focusIsBase.value ? base.value : head.value
  return Object.entries(view?.receipt.evidence ?? {}).find(([, e]) => e.key === k)?.[0] ?? null
})

const recording = (v: ReceiptView | null): ReceiptEvidenceItem | null =>
  v?.receipt.evidence['video'] ?? v?.receipt.evidence['source'] ?? null
const poster = computed(
  () => head.value?.receipt.evidence['poster'] ?? base.value?.receipt.evidence['poster'] ?? null,
)

// The attempt whose contact sheet and transcript the sections show.
const shown = computed(() => (focusIsBase.value ? base.value : (head.value ?? base.value)))
const hasJourneyEvidence = computed(() =>
  shown.value ? journeyEvidence(shown.value.receipt).size > 0 || droppedEvidence(shown.value.receipt).size > 0 : false,
)
const contactSheet = computed(() => shown.value?.receipt.evidence['contact_sheet'] ?? null)
const transcript = computed(() => shown.value?.receipt.evidence['transcript'] ?? null)

const open = ref({
  journeys: true,
  sheet: false,
  transcript: false,
  checks: true,
})
onMounted(() => {
  if (focusEvidence.value === 'contact_sheet') open.value.sheet = true
  if (focusEvidence.value === 'transcript') {
    open.value.transcript = true
    void loadTranscript()
  }
})

const terminal = ref<string | null>(null)
const terminalError = ref('')
async function loadTranscript() {
  const item = transcript.value
  if (!item || terminal.value !== null) return
  try {
    const res = await fetch(receiptFileUrl(props.runId, item.key, repo.value))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    terminal.value = await res.text()
  } catch (e) {
    terminalError.value = (e as Error).message
  }
}
function toggleTranscript() {
  open.value.transcript = !open.value.transcript
  if (open.value.transcript) void loadTranscript()
}
const withRepo = (r: string) => `?repo=${encodeURIComponent(r)}`
</script>

<template>
  <div class="viewer page">
    <div class="col">
      <p v-if="state === 'loading'" class="note">Loading receipt…</p>
      <p v-else-if="state === 'missing'" class="note">No receipt for {{ runId }}.</p>
      <div v-else-if="state === 'conflict'" class="note">
        <p>{{ runId }} exists under more than one repo. Pick one:</p>
        <ul>
          <li v-for="c in candidates" :key="c">
            <a :href="withRepo(c)">{{ c }}</a>
          </li>
        </ul>
      </div>
      <p v-else-if="state === 'error'" class="error-bar" role="alert">
        Could not load the receipt: {{ message }}. Reload the page to try again.
      </p>

      <template v-else-if="run">
        <VerdictBanner :head="head" :base="base" />
        <ReceiptFacts :repo-label="repoLabel" :head="head" :run-href="runHref" :chain="chain" :issue="issueLink" :pr="prLink" />
        <BeforeAfterTable :run-id="runId" :repo="repo" :head="head" :base="base" />

        <div class="figure">
          <ReceiptVideo
            :run-id="runId"
            :repo="repo"
            :head="recording(head)"
            :base="recording(base)"
            :poster="poster"
            :initial="focusIsBase ? 'base' : 'head'"
          />
        </div>

        <div class="sections">
          <DetailSection v-if="hasJourneyEvidence" title="Journeys" :open="open.journeys" @toggle="open.journeys = !open.journeys">
            <JourneyEvidence :run-id="runId" :repo="repo" :view="shown" :focus-key="focusKey" />
          </DetailSection>
          <DetailSection
            title="Contact sheet"
            :open="open.sheet"
            @toggle="open.sheet = !open.sheet"
          >
            <a
              v-if="contactSheet"
              :href="receiptFileUrl(runId, contactSheet.key, repo)"
              target="_blank"
              rel="noopener"
            >
              <img
                class="sheet"
                :src="receiptFileUrl(runId, contactSheet.key, repo)"
                alt="Contact sheet of the recording"
              />
            </a>
            <p v-else class="note">No contact sheet for this run.</p>
          </DetailSection>
          <DetailSection title="Transcript" :open="open.transcript" @toggle="toggleTranscript">
            <pre v-if="terminal !== null">{{ terminal }}</pre>
            <p v-else-if="terminalError" class="note fail-t">
              Could not load the transcript: {{ terminalError }}
            </p>
            <p v-else-if="!transcript" class="note">No transcript for this run.</p>
            <p v-else class="note">Loading…</p>
          </DetailSection>
          <DetailSection
            title="Checks"
            :count="head?.receipt.checks.length ?? 0"
            :open="open.checks"
            @toggle="open.checks = !open.checks"
          >
            <ChecksTable :head="head" :base="base" />
          </DetailSection>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.note {
  color: var(--dim);
  margin: 16px 0;
}

/* One reading column, centred inside the shared page container. */
.col {
  max-width: 820px;
  margin-inline: auto;
  padding: 24px 0 56px;
}

.figure {
  margin-top: 32px;
}

.sections {
  margin-top: 24px;
}

.sheet {
  max-width: 100%;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.fail-t {
  color: var(--fail);
}
</style>
