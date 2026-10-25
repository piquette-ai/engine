<script setup lang="ts">
import { computed } from 'vue'
import { AlertTriangle, RotateCcw } from 'lucide-vue-next'
import type { GateResult, Phase, Session, SessionSummary } from '../lib/types'
import { recoveryOf } from '../lib/runs'
import { failureCause } from '../lib/failure'
import { HINTS } from '../lib/hints'
import InfoHint from './InfoHint.vue'

// The band a run opens on when it needs a look: a failed run names the phase
// (and the gate, when one was recorded) that stopped it, then the cause in the
// record's own words (up to three violation lines); a run that succeeded
// through a failed phase gets a quiet ink band with a way to the failed attempt.
const props = defineProps<{
  session: Session
  phases: Phase[]
  gates?: GateResult[]
  /** The list's run peek: the cause spans the band's full width, with the Open action below it. */
  compact?: boolean
}>()
defineEmits<{ open: [phase: Phase] }>()

const attention = computed(() => {
  if (props.session.status !== 'fail') return null
  const failed = props.phases.findLast((p) => p.status === 'fail')
  // A killed run or a session-level error can fail with no phase marked.
  if (!failed) return { phase: null, gate: null, cause: null }
  const gate = (props.gates ?? []).findLast((g) => g.phase_id === failed.phase_id && !g.passed)
  const cause = failureCause(failed, props.gates)
  // "1 gate failed" adds nothing once the line above names the gate.
  return { phase: failed, gate: gate?.gate ?? null, cause: cause?.source === 'count' && gate?.gate ? null : cause }
})

const recovery = computed(() => recoveryOf({ ...props.session, phases: props.phases } as unknown as SessionSummary))
</script>

<template>
  <div v-if="attention" class="attention" :class="{ compact }">
    <AlertTriangle class="att-icon" :size="20" :stroke-width="2" aria-hidden="true" />
    <div v-if="attention.phase" class="att-body">
      <p class="att-line">
        <strong>Failed at {{ attention.phase.name ?? 'a phase' }}</strong>
        <span v-if="attention.gate" class="att-gate">the {{ attention.gate }} gate didn't <span class="nowrap">pass<InfoHint label="What is a gate?" :text="HINTS.gate" /></span></span>
      </p>
      <ul v-if="attention.cause" class="att-cause">
        <li v-for="(line, i) in attention.cause.lines" :key="i" :title="line">{{ line }}</li>
        <li v-if="attention.cause.more" class="att-more">+{{ attention.cause.more }} more</li>
      </ul>
    </div>
    <div v-else class="att-body">
      <p class="att-line"><strong>This run failed</strong> · no phase recorded the failure</p>
    </div>
    <button v-if="attention.phase" type="button" class="att-open" @click="$emit('open', attention.phase)">
      Open {{ attention.phase.name ?? 'phase' }}
    </button>
  </div>
  <div v-else-if="recovery" class="recovered">
    <RotateCcw class="rec-icon" :size="20" :stroke-width="2" aria-hidden="true" />
    <p class="rec-line"><strong>Recovered</strong>: {{ recovery.text }}</p>
    <button type="button" class="att-open" @click="$emit('open', recovery.phase)">Open {{ recovery.phase.name ?? 'phase' }}</button>
  </div>
</template>

<style scoped>
.nowrap {
  white-space: nowrap;
}

.attention {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  border: 1px solid var(--fail);
  border-radius: var(--radius);
  background: var(--face);
}

.att-icon {
  flex: none;
  margin-top: 2px;
  color: var(--fail);
}

.att-body {
  flex: 1 1 auto;
  min-width: 0;
}

.att-line {
  margin: 0;
}

.att-line strong {
  color: var(--fail);
}

/* The same trailing-dot separator as the meta lines, with room on both sides. */
.att-gate::before {
  content: '·';
  margin: 0 8px;
  color: var(--faint);
}

/* The cause, in the record's words: code voice, ink, one hairline-indented line each. */
.att-cause {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  font-family: var(--mono);
  color: var(--fg);
  overflow-wrap: anywhere;
}

.att-cause li + li {
  margin-top: 2px;
}

/* A long violation keeps to two lines (the full text in its title); a phone shows it whole. */
.att-cause li {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* The peek is narrow: the cause takes the band's whole width and Open sits below it. */
.attention.compact {
  flex-wrap: wrap;
}

.attention.compact .att-body {
  flex-basis: calc(100% - 32px);
}

.attention.compact .att-open {
  margin-left: 32px;
}

.att-more {
  font-family: var(--sans);
  color: var(--dim);
}

.recovered {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--face);
}

.rec-icon {
  flex: none;
  color: var(--fg);
}

.rec-line {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  color: var(--dim);
}

.rec-line strong {
  color: var(--fg);
}

.att-open {
  flex: none;
  padding: 3px 12px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: none;
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}

.att-open:hover,
.att-open:focus-visible {
  border-color: var(--fg);
}

@media (max-width: 640px) {
  .attention,
  .recovered {
    flex-wrap: wrap;
  }

  .att-body,
  .recovered .rec-line {
    flex-basis: calc(100% - 40px);
  }

  .att-open {
    min-height: 44px;
    margin-left: 32px;
  }

  .att-cause li {
    display: block;
    -webkit-line-clamp: unset;
    line-clamp: none;
  }
}
</style>
