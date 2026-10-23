<script setup lang="ts">
import { computed } from 'vue'
import { AlertTriangle, RotateCcw } from 'lucide-vue-next'
import type { GateResult, Phase, Session, SessionSummary } from '../lib/types'
import { recoveryOf } from '../lib/runs'

// The band a run opens on when it needs a look: a failed run names the phase
// (and the gate, when one was recorded) that stopped it; a run that succeeded
// through a failed phase gets a quiet ink band with a way to the failed attempt.
const props = defineProps<{ session: Session; phases: Phase[]; gates?: GateResult[] }>()
defineEmits<{ open: [phase: Phase] }>()

const attention = computed(() => {
  if (props.session.status !== 'fail') return null
  const failed = props.phases.findLast((p) => p.status === 'fail')
  // A killed run or a session-level error can fail with no phase marked.
  if (!failed) return { phase: null, gate: null }
  const gate = (props.gates ?? []).findLast((g) => g.phase_id === failed.phase_id && !g.passed)
  return { phase: failed, gate: gate?.gate ?? null }
})

const recovery = computed(() => recoveryOf({ ...props.session, phases: props.phases } as unknown as SessionSummary))
</script>

<template>
  <div v-if="attention" class="attention">
    <AlertTriangle class="att-icon" :size="20" :stroke-width="2" aria-hidden="true" />
    <div v-if="attention.phase" class="att-body">
      <p class="att-line">
        <strong>Failed at {{ attention.phase.name ?? 'a phase' }}</strong>
        <span v-if="attention.gate" class="att-gate">the {{ attention.gate }} gate didn't pass</span>
      </p>
      <p v-if="attention.phase.error" class="att-error">{{ attention.phase.error }}</p>
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

.att-line,
.att-error {
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

.att-error {
  margin-top: 2px;
  font-family: var(--mono);
  color: var(--dim);
  overflow-wrap: anywhere;
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

  .recovered .rec-line {
    flex-basis: calc(100% - 40px);
  }

  .att-open {
    min-height: 44px;
    margin-left: 32px;
  }
}
</style>
