<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { fetchReceiptRun, receiptFileUrl } from '../../lib/api'
import { viewerRepo } from '../../lib/router'
import type { ReceiptEvidenceItem, ReceiptsRunResponse, ReceiptView } from '../../lib/types'
import DetailSection from '../DetailSection.vue'
import BeforeAfterTable from './BeforeAfterTable.vue'
import ChecksTable from './ChecksTable.vue'
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
    olderHead.value = { key: a.key, attempt: a.attempt, receipt: (await res.json()) as ReceiptView['receipt'] }
  } catch {
    /* fall back to the latest attempt */
  }
}

const head = computed<ReceiptView | null>(() => olderHead.value ?? run.value?.head ?? null)
const base = computed<ReceiptView | null>(() => run.value?.base ?? null)
const repo = computed(() => run.value?.repo ?? viewerRepo)

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

const recording = (v: ReceiptView | null): ReceiptEvidenceItem | null => v?.receipt.evidence['video'] ?? v?.receipt.evidence['source'] ?? null
const poster = computed(() => head.value?.receipt.evidence['poster'] ?? base.value?.receipt.evidence['poster'] ?? null)

// The attempt whose contact sheet and transcript the sections show.
const shown = computed(() => (focusIsBase.value ? base.value : (head.value ?? base.value)))
const contactSheet = computed(() => shown.value?.receipt.evidence['contact_sheet'] ?? null)
const transcript = computed(() => shown.value?.receipt.evidence['transcript'] ?? null)

const open = ref({
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
  <div class="viewer">
    <p v-if="state === 'loading'" class="note">Loading receipt…</p>
    <p v-else-if="state === 'missing'" class="note">No receipt for {{ runId }}.</p>
    <div v-else-if="state === 'conflict'" class="note">
      <p>{{ runId }} exists under more than one repo. Pick one:</p>
      <ul>
        <li v-for="c in candidates" :key="c"><a :href="withRepo(c)">{{ c }}</a></li>
      </ul>
    </div>
    <p v-else-if="state === 'error'" class="note fail-t">Could not load the receipt: {{ message }}</p>

    <template v-else-if="run">
      <VerdictBanner :head="head" :base="base" />
      <BeforeAfterTable :run-id="runId" :repo="repo" :head="head" :base="base" />

      <h2 class="h">Recording</h2>
      <ReceiptVideo
        :run-id="runId"
        :repo="repo"
        :head="recording(head)"
        :base="recording(base)"
        :poster="poster"
        :initial="focusIsBase ? 'base' : 'head'"
      />

      <div class="sections">
        <DetailSection title="Contact sheet" :open="open.sheet" @toggle="open.sheet = !open.sheet">
          <a v-if="contactSheet" :href="receiptFileUrl(runId, contactSheet.key, repo)" target="_blank" rel="noopener">
            <img class="sheet" :src="receiptFileUrl(runId, contactSheet.key, repo)" alt="Contact sheet of the recording" />
          </a>
          <p v-else class="note">No contact sheet for this run.</p>
        </DetailSection>
        <DetailSection title="Transcript" :open="open.transcript" @toggle="toggleTranscript">
          <pre v-if="terminal !== null">{{ terminal }}</pre>
          <p v-else-if="terminalError" class="note fail-t">Could not load the transcript: {{ terminalError }}</p>
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
</template>

<style scoped>
.viewer {
  max-width: 1100px;
}

.note {
  color: var(--dim);
  margin: 16px 0;
}

.h {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--dim);
  margin: 24px 0 10px;
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
