<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowRight, SquareCheckBig, Undo2, X } from 'lucide-vue-next'
import type { GateResult, Phase, SessionSummary } from '../lib/types'
import { axisTicks, costTitle, fmtCost, fmtDuration, fmtTokens } from '../lib/format'
import { fmtDayHM, fmtFull } from '../lib/day'
import { hrefFor, navigate } from '../lib/router'
import { plainRequest, runKind } from '../lib/runs'
import { modelsByOwner, phaseAxis, runDurationMs, stepPhasesOf } from '../lib/phases'
import { peekGates } from '../lib/run-peek'
import { STAT_TITLES } from '../lib/stats'
import { repoShortName } from '@shared/hosted'
import PhaseSteps from './PhaseSteps.vue'
import RunBand from './RunBand.vue'
import SessionVerification from './SessionVerification.vue'
import StatusGlyph from './StatusGlyph.vue'

// The run peek on the Runs list: the run under the keyboard cursor, summarised
// in the drawer. Everything but the gate record comes from the list's own row,
// so it stays live on the list's poll and closing it leaves nothing running.
const props = defineProps<{
  session: SessionSummary
  nowMs: number
  hosted?: boolean
  /** The Reviewed view: the action restores instead of marking reviewed. */
  reviewed?: boolean
}>()
const emit = defineEmits<{ close: []; review: [session: SessionSummary] }>()

const sel = computed(() => ({ factory: props.session.factory_id ?? null, repo: props.session.repo ?? null }))
const kind = computed(() => runKind(props.session))
const title = computed(() => {
  const t = plainRequest(props.session.request)
  return t === '—' ? `Run ${props.session.adw_id}` : t
})

const KIND_WORD = { ok: 'Succeeded', failed: 'Failed', recovered: 'Recovered', running: 'Running' } as const

const who = computed(() => props.session.factory_name ?? props.session.engineer ?? null)
const repoName = computed(() => (props.hosted && props.session.repo ? repoShortName(props.session.repo) : null))

const phases = computed(() => props.session.phases ?? [])
const steps = computed(() => stepPhasesOf(phases.value))
const axis = computed(() => phaseAxis(steps.value, props.session, props.nowMs))
const ticks = computed(() => axisTicks(axis.value.span, 4))
const modelFor = computed(() => modelsByOwner(phases.value, props.session.agents ?? []))
const durationMs = computed(() => runDurationMs(props.session, props.nowMs))

// The gate that stopped a failed run: fetched on peek, cached per settled state.
const gates = ref<GateResult[]>([])
let gen = 0
watch(
  () => props.session,
  (s) => {
    const mine = ++gen
    void peekGates(s)
      .then((g) => {
        if (mine === gen) gates.value = g
      })
      .catch(() => {
        // The band still names the failed phase without it.
        if (mine === gen) gates.value = []
      })
  },
  { immediate: true },
)

const href = computed(() => hrefFor(props.session.adw_id, null, sel.value))
const openPhase = (p: Phase) => navigate(props.session.adw_id, p.phase_id, sel.value)
const actionLabel = computed(() => (props.reviewed ? 'Restore' : 'Mark reviewed'))
</script>

<template>
  <section class="run-peek">
    <header class="rp-head">
      <div class="rp-titlebar">
        <h2 id="run-peek-title" class="rp-title" :title="session.request ?? ''">{{ title }}</h2>
        <button type="button" class="rp-close" aria-label="Close the run peek" title="Close (Esc)" @click="emit('close')">
          <X :size="18" :stroke-width="2" />
        </button>
      </div>
      <p class="rp-meta">
        <span class="mi rp-status" :class="kind">
          <StatusGlyph :status="session.status" />
          {{ KIND_WORD[kind] }}
        </span>
        <span v-if="session.adw_name" class="mi">{{ session.adw_name }}</span>
        <span v-if="repoName" class="mi">{{ repoName }}</span>
        <span v-if="who" class="mi">{{ who }}</span>
        <span class="mi mono" :title="fmtFull(session.started_at)">{{ fmtDayHM(session.started_at, new Date(nowMs)) }}</span>
        <span class="mi mono">{{ session.adw_id }}</span>
      </p>
      <div class="rp-actions">
        <a class="rp-open" :href="href">Open run <ArrowRight :size="18" :stroke-width="2" aria-hidden="true" /></a>
        <button v-if="kind !== 'running'" type="button" class="rp-review" :title="`${actionLabel} (e)`" @click="emit('review', session)">
          <Undo2 v-if="reviewed" :size="18" :stroke-width="2" aria-hidden="true" />
          <SquareCheckBig v-else :size="18" :stroke-width="2" aria-hidden="true" />
          {{ actionLabel }}
        </button>
      </div>
    </header>

    <div class="rp-body">
      <RunBand :session="session" :phases="phases" :gates="gates" @open="openPhase" />
      <SessionVerification :adw-id="session.adw_id" :session="session" :phases="phases" compact />

      <dl class="rp-numbers">
        <div>
          <dt :title="STAT_TITLES.runtime">Duration</dt>
          <dd>{{ fmtDuration(durationMs) }}</dd>
        </div>
        <div>
          <dt :title="STAT_TITLES.cost">Cost</dt>
          <dd :title="costTitle(session.total_cost)">{{ fmtCost(session.total_cost) }}</dd>
        </div>
        <div>
          <dt :title="STAT_TITLES.tokens">Tokens</dt>
          <dd>{{ fmtTokens(session.total_tokens) }}</dd>
        </div>
      </dl>

      <section class="rp-phases" aria-labelledby="run-peek-phases">
        <h3 id="run-peek-phases" class="rp-sec">
          Phases <span class="rp-count">{{ steps.length }}</span>
        </h3>
        <PhaseSteps
          v-if="steps.length"
          :phases="steps"
          :t0="axis.t0"
          :span="axis.span"
          :now-ms="nowMs"
          :ticks="ticks"
          :selected-id="null"
          :model-for="modelFor"
          compact
          @select="openPhase"
        />
        <p v-else class="rp-empty">No phases recorded for this run yet.</p>
      </section>

      <p class="rp-keys" aria-hidden="true">
        <span><kbd>j</kbd> <kbd>k</kbd> move</span>
        <span><kbd>e</kbd> {{ reviewed ? 'restore' : 'mark reviewed' }}</span>
        <span><kbd>space</kbd> <kbd>esc</kbd> close</span>
      </p>
    </div>
  </section>
</template>

<style scoped>
/* The run peek: the drawer is the frame, so the folio itself is flat. */
.run-peek {
  min-height: 100%;
}

.rp-head {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 16px 20px 14px;
  border-bottom: 1px solid var(--rule);
  background: var(--ground);
}

.rp-titlebar {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.rp-title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.3;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.rp-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  margin: -4px -8px 0 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  color: var(--faint);
  cursor: pointer;
}

.rp-close:hover,
.rp-close:focus-visible {
  border-color: var(--rule);
  color: var(--fg);
}

.rp-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin: 8px 0 0;
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

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.rp-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--fg);
}

.rp-status.mi:not(:last-child)::after {
  margin-left: 4px;
  font-weight: 400;
}

/* Colour only for the exception: failed in the fail ink, running in the live ink. */
.rp-status.failed {
  color: var(--fail);
}

.rp-status.running {
  color: var(--live);
}

.rp-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-top: 12px;
}

.rp-open,
.rp-review {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 12px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: none;
  color: var(--fg);
  font: inherit;
  text-decoration: none;
  cursor: pointer;
}

.rp-open {
  font-weight: 600;
}

.rp-open:hover,
.rp-open:focus-visible,
.rp-review:hover,
.rp-review:focus-visible {
  border-color: var(--fg);
}

.rp-review svg {
  color: var(--faint);
}

.rp-keys {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  margin: 0;
  padding-top: 10px;
  border-top: 1px solid var(--rule-soft);
  color: var(--faint);
}

.rp-keys > span {
  white-space: nowrap;
}

.rp-keys kbd {
  font-family: var(--mono);
  padding: 0 6px;
  color: var(--dim);
  background: var(--inset);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.rp-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 18px 20px 32px;
}

/* Key numbers: a key-value strip, faint key over a tabular value. */
.rp-numbers {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}

.rp-numbers > div {
  padding: 8px 12px;
  min-width: 0;
}

.rp-numbers > div + div {
  border-left: 1px solid var(--rule-soft);
}

.rp-numbers dt {
  color: var(--dim);
  text-decoration: underline dotted var(--rule);
  text-underline-offset: 4px;
  cursor: help;
  width: fit-content;
}

.rp-numbers dd {
  margin: 2px 0 0;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--fg);
  overflow-wrap: anywhere;
}

.rp-sec {
  margin: 0 0 10px;
  font-size: 17px;
  font-weight: 700;
}

.rp-count {
  margin-left: 6px;
  font-family: var(--mono);
  font-weight: 400;
  color: var(--faint);
}

.rp-empty {
  margin: 0;
  color: var(--faint);
}

@media (max-width: 980px) {
  .rp-keys {
    display: none;
  }
}

/* Touch: interactive targets reach 44px on phone glass. */
@media (max-width: 640px) {
  .rp-head {
    padding: 12px 16px;
  }

  .rp-body {
    padding: 16px 16px 32px;
  }

  .rp-close {
    width: 44px;
    height: 44px;
    margin: -6px -10px 0 0;
  }

  .rp-open,
  .rp-review {
    min-height: 44px;
  }
}
</style>
