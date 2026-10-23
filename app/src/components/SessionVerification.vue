<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ShieldCheck } from 'lucide-vue-next'
import type { Phase, ReceiptsRunResponse, Session } from '../lib/types'
import { fetchReceiptRun, receiptFileUrl, receiptViewerUrl } from '../lib/api'
import { sessionReceipts } from '../lib/session-receipts'
import { isProvePhase, loadReceipts, receiptRepoSegment, settledProveKey, summarizeReceipts, type ReceiptSide } from '@shared/receipt_links'
import DetailSection from './DetailSection.vue'

const props = defineProps<{ adwId: string; session: Session; phases: Phase[] }>()

const run = ref<ReceiptsRunResponse | null>(null)
// 'off' = the receipts module is not serving here (404 no store / 503); 'conflict' = the run id
// exists under several repos and we were not told which.
const state = ref<'idle' | 'ready' | 'off' | 'none' | 'conflict'>('idle')
const candidates = ref<string[]>([])
const open = ref(true)

const repoSeg = computed(() => receiptRepoSegment(props.session.repo))
// Receipts only exist for sessions whose chain proved something. A prove phase
// writes its receipt as it finishes, so refetch when one settles (not when it
// starts, and not on every poll).
const hasProve = computed(() => props.phases.some((p) => isProvePhase(p.name)))
const settled = computed(() => settledProveKey(props.phases))

// Only the latest request may write state: an older, slower response must not land last.
let seq = 0

watch(
  [() => props.adwId, repoSeg, hasProve, settled],
  async ([adwId, repo, proving]) => {
    const mine = ++seq
    if (!proving) {
      run.value = null
      candidates.value = []
      state.value = 'idle'
      sessionReceipts.value = null
      return
    }
    const r = await loadReceipts(fetchReceiptRun, adwId, repo)
    if (mine !== seq) return
    candidates.value = r.state === 'conflict' ? r.candidates : []
    run.value = r.state === 'ready' ? r.run : null
    sessionReceipts.value = r.state === 'ready' ? { adwId, run: r.run, repo: r.run.repo || repo } : null
    state.value = r.state
  },
  { immediate: true },
)

const summary = computed(() => (run.value ? summarizeReceipts(run.value) : null))
const repo = computed(() => run.value?.repo || repoSeg.value)
const posterSrc = computed(() =>
  summary.value?.posterKey ? receiptFileUrl(props.adwId, summary.value.posterKey, repo.value) : null,
)
const evMedia = computed(() => summary.value?.evidenceMedia ?? null)
const evSrc = computed(() => (evMedia.value ? receiptFileUrl(props.adwId, evMedia.value.key, repo.value) : null))
const evHref = computed(() => receiptViewerUrl(props.adwId, repo.value, evMedia.value?.key))
const playHref = computed(() => receiptViewerUrl(props.adwId, repo.value, summary.value?.videoKey))

const tone = (s: ReceiptSide | null) => (s?.verdict === 'PASS' ? 'pass' : s?.verdict === 'FAIL' ? 'fail' : 'unknown')
const counts = (s: ReceiptSide) => `${s.total - s.failed}/${s.total} checks pass`
</script>

<template>
  <section v-if="state === 'off' || state === 'conflict' || (state === 'ready' && summary)" class="verify-card">
    <DetailSection title="verification" :icon="ShieldCheck" :open="open" @toggle="open = !open">
      <p v-if="state === 'off'" class="dim">receipts are not available on this server</p>
      <div v-else-if="state === 'conflict'" class="v-conflict">
        <p class="dim">this run exists under more than one repo. pick one</p>
        <ul>
          <li v-for="c in candidates" :key="c">
            <a class="v-play" :href="receiptViewerUrl(adwId, c)">{{ c }}</a>
          </li>
        </ul>
      </div>
      <div v-else-if="summary" class="v-body">
        <div class="v-main">
          <div class="v-sides">
            <span v-if="summary.before" class="v-side">
              <span class="v-k">before</span>
              <span class="v-verdict" :class="tone(summary.before)">{{ summary.before.verdict }}</span>
              <span class="dim">{{ counts(summary.before) }}</span>
            </span>
            <span v-if="summary.before && summary.after" class="dim" aria-hidden="true">→</span>
            <span v-if="summary.after" class="v-side">
              <span class="v-k">after</span>
              <span class="v-verdict" :class="tone(summary.after)">{{ summary.after.verdict }}</span>
              <span class="dim">{{ counts(summary.after) }}</span>
            </span>
          </div>
          <a v-if="summary.videoKey" class="v-play" :href="playHref">play recording</a>
          <a v-else class="v-play" :href="playHref">open receipt</a>
          <a v-if="evMedia && evSrc" class="v-play" :href="evHref">open evidence</a>
        </div>
        <a v-if="posterSrc" class="v-poster" :href="playHref" aria-label="play recording">
          <img :src="posterSrc" alt="" loading="lazy" />
        </a>
        <a v-else-if="evMedia && evSrc" class="v-poster" :href="evHref" aria-label="open evidence">
          <img v-if="evMedia.kind === 'image'" :src="evSrc" alt="" loading="lazy" />
          <video v-else :src="evSrc" preload="metadata" muted playsinline></video>
        </a>
      </div>
    </DetailSection>
  </section>
</template>

<style scoped>
.verify-card {
  margin: 20px 28px 0;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--face);
  overflow: hidden;
}

.verify-card :deep(.dsec) {
  margin-bottom: 0;
}

.verify-card :deep(.dsec-head) {
  padding: 10px 16px;
  background: var(--inset);
}

.verify-card :deep(.dsec-head:hover) {
  background: var(--inset);
}

.verify-card :deep(.dsec-body) {
  padding: 14px 16px;
}

.v-body {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.v-main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.v-sides {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 16px;
}

.v-side {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
}

.v-k {
  color: var(--dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 16px;
  font-weight: 600;
}

.v-conflict ul {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.v-verdict {
  font-family: var(--mono);
  font-weight: 600;
}

.v-verdict.pass {
  color: var(--pass);
}

.v-verdict.fail {
  color: var(--fail);
}

.v-play {
  align-self: flex-start;
  padding: 5px 14px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  color: var(--fg);
  font-family: var(--mono);
  font-size: 16px;
  text-decoration: none;
}

.v-play:hover,
.v-play:focus-visible {
  border-color: var(--accent);
}

.v-poster img,
.v-poster video {
  display: block;
  max-width: min(360px, 100%);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}
</style>
