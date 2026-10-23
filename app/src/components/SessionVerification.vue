<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Play, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-vue-next'
import type { Phase, ReceiptsRunResponse, Session } from '../lib/types'
import { fetchReceiptRun, receiptFileUrl, receiptViewerUrl } from '../lib/api'
import { checkFraction, checksPass } from '../lib/checks'
import { sessionReceipts } from '../lib/session-receipts'
import { cachedReceiptRun } from '../lib/row-receipts'
import { isProvePhase, loadReceipts, receiptRepoSegment, settledProveKey, summarizeReceipts, type ReceiptSide } from '@shared/receipt_links'

const props = defineProps<{
  adwId: string
  session: Session
  phases: Phase[]
  /** The list's run peek: no poster (a Play link instead), and the open run's shared receipts are left alone. */
  compact?: boolean
}>()

const run = ref<ReceiptsRunResponse | null>(null)
// 'off' = the receipts module is not serving here (404 no store / 503); 'conflict' = the run id
// exists under several repos and we were not told which.
const state = ref<'idle' | 'ready' | 'off' | 'none' | 'conflict'>('idle')
const candidates = ref<string[]>([])

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
      if (!props.compact) sessionReceipts.value = null
      return
    }
    const cached = props.compact ? cachedReceiptRun({ ...props.session, phases: props.phases } as never) : null
    const r = cached ? ({ state: 'ready', run: cached } as const) : await loadReceipts(fetchReceiptRun, adwId, repo)
    if (mine !== seq) return
    candidates.value = r.state === 'conflict' ? r.candidates : []
    run.value = r.state === 'ready' ? r.run : null
    if (!props.compact) sessionReceipts.value = r.state === 'ready' ? { adwId, run: r.run, repo: r.run.repo || repo } : null
    state.value = r.state
  },
  { immediate: true },
)

const summary = computed(() => (run.value ? summarizeReceipts(run.value) : null))
const repo = computed(() => run.value?.repo || repoSeg.value)
const posterSrc = computed(() =>
  summary.value?.posterKey && !props.compact ? receiptFileUrl(props.adwId, summary.value.posterKey, repo.value) : null,
)
// Journey evidence (a screenshot or video a proof attached) stands in for the
// poster when the run kept no terminal recording.
const evMedia = computed(() => (props.compact ? null : (summary.value?.evidenceMedia ?? null)))
const evSrc = computed(() => (evMedia.value ? receiptFileUrl(props.adwId, evMedia.value.key, repo.value) : null))
const evHref = computed(() => receiptViewerUrl(props.adwId, repo.value, evMedia.value?.key))
const playHref = computed(() => receiptViewerUrl(props.adwId, repo.value, summary.value?.videoKey))
const receiptHref = computed(() => receiptViewerUrl(props.adwId, repo.value))

// The verdict is the "after" side when there is one: the run's claim is about
// the code it left behind. A base-only run has a baseline and nothing more.
const latest = computed(() => summary.value?.after ?? summary.value?.before ?? null)
const tone = computed(() => {
  if (!summary.value?.after) return 'unknown'
  return summary.value.after.verdict === 'PASS' ? 'pass' : summary.value.after.verdict === 'FAIL' ? 'fail' : 'unknown'
})
const headline = computed(() => {
  const after = summary.value?.after
  if (!after) return 'Baseline recorded, not yet verified'
  if (after.verdict === 'PASS') return 'Verified'
  if (after.verdict === 'FAIL') return 'Not verified'
  return 'Inconclusive'
})
const ICON = { pass: ShieldCheck, fail: ShieldAlert, unknown: ShieldQuestion }

// One framing everywhere: "36/36 checks pass · 28/36 before".
const passing = (s: ReceiptSide) => s.total - s.failed
const detail = computed(() => {
  const s = summary.value
  const l = latest.value
  if (!s || !l) return ''
  const now = checksPass(passing(l), l.total)
  if (s.after && s.before) return `${now} · ${checkFraction(passing(s.before), s.before.total)} before`
  return s.after ? now : `${now} before this change`
})
</script>

<template>
  <section v-if="state === 'off'" class="verify-band quiet" aria-label="Verification">
    <ShieldQuestion class="v-icon" :size="20" :stroke-width="2" aria-hidden="true" />
    <p class="dim">This run recorded a verification, but receipts aren't served here.</p>
  </section>
  <section v-else-if="state === 'conflict'" class="verify-band quiet" aria-label="Verification">
    <ShieldQuestion class="v-icon" :size="20" :stroke-width="2" aria-hidden="true" />
    <div>
      <p class="dim">This run id has receipts under more than one repository. Pick one:</p>
      <ul class="v-conflict">
        <li v-for="c in candidates" :key="c">
          <a class="v-link mono" :href="receiptViewerUrl(adwId, c)">{{ c }}</a>
        </li>
      </ul>
    </div>
  </section>
  <section v-else-if="state === 'ready' && summary" class="verify-band" :class="[tone, { compact }]" aria-label="Verification">
    <div class="v-text">
      <h2 class="v-head">
        <component :is="ICON[tone]" class="v-icon" :size="22" :stroke-width="2" aria-hidden="true" />
        <span class="v-verdict">{{ headline }}</span>
      </h2>
      <p class="v-detail">{{ detail }}</p>
      <p class="v-actions">
        <a class="v-link" :href="receiptHref">Open receipt</a>
        <a v-if="summary.videoKey && !posterSrc" class="v-link" :href="playHref">Play recording</a>
        <a v-if="evMedia && evSrc" class="v-link" :href="evHref">Open evidence</a>
      </p>
    </div>
    <a
      v-if="posterSrc"
      class="v-poster"
      :class="{ video: summary.videoKey }"
      :href="summary.videoKey ? playHref : receiptHref"
      :aria-label="summary.videoKey ? 'Play the verification recording' : 'Open the receipt'"
    >
      <img :src="posterSrc" alt="" loading="lazy" />
      <span v-if="summary.videoKey" class="v-play" aria-hidden="true">
        <Play :size="18" :stroke-width="2.25" />
        <span>Play</span>
      </span>
    </a>
    <a v-else-if="evMedia && evSrc" class="v-poster" :href="evHref" aria-label="Open the journey evidence">
      <img v-if="evMedia.kind === 'image'" :src="evSrc" alt="" loading="lazy" />
      <video v-else :src="evSrc" preload="metadata" muted playsinline></video>
    </a>
  </section>
</template>

<style scoped>
/* The verdict band: the run's one focal claim, full width at the top of the
   main column. A hairline frame; the verdict's colour lives on the shield and,
   when it failed, on the word. */
.verify-band {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 20px;
  align-items: center;
  padding: 16px 20px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--face);
}

.verify-band.compact {
  grid-template-columns: minmax(0, 1fr);
  padding: 12px 16px;
}

.compact .v-head {
  font-size: 17px;
}

.compact .v-actions {
  margin-top: 8px;
}

.verify-band.fail {
  border-color: var(--fail);
}

.verify-band.quiet {
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  padding: 12px 16px;
}

.verify-band.quiet p {
  margin: 0;
}

.v-text {
  min-width: 0;
}

.v-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--fg);
}

.v-icon {
  flex: none;
  color: var(--faint);
}

.pass .v-icon {
  color: var(--pass);
}

.fail .v-icon,
.fail .v-verdict {
  color: var(--fail);
}

.v-detail {
  margin: 6px 0 0;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--dim);
}

.v-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin: 12px 0 0;
}

.v-link {
  color: var(--fg);
  text-decoration: underline;
  text-decoration-color: var(--rule);
  text-underline-offset: 4px;
}

.v-link:hover,
.v-link:focus-visible {
  text-decoration-color: var(--fg);
}

.v-conflict {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.v-poster {
  position: relative;
  display: block;
  width: 240px;
  aspect-ratio: 16 / 10;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--inset);
  overflow: hidden;
  line-height: 0;
}

.v-poster img,
.v-poster video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.v-poster:hover,
.v-poster:focus-visible {
  border-color: var(--fg);
}

/* The play affordance: a squared cell on the frame, not a floating disc. */
.v-play {
  position: absolute;
  left: 10px;
  bottom: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--ground);
  color: var(--fg);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.4;
}

.v-poster:hover .v-play,
.v-poster:focus-visible .v-play {
  border-color: var(--fg);
}

@media (max-width: 640px) {
  .verify-band {
    grid-template-columns: 1fr;
  }

  .v-poster {
    width: 100%;
    max-width: 420px;
  }
}
</style>
