<script setup lang="ts">
import { computed } from 'vue'
import type { GateResult, Phase } from '../lib/types'
import { failureCause } from '../lib/failure'
import { fmtDuration, statusWord, ts } from '../lib/format'
import { modelIcon, modelName } from '../lib/models'
import StatusGlyph from './StatusGlyph.vue'

// The run's phases as a step list, in the order they ran: what happened, who
// did it, how long it took, and where it sat in the run on one shared time axis.
const props = defineProps<{
  phases: Phase[]
  /** Shared axis: the first phase start and the span to the last end, in ms. */
  t0: number
  span: number
  nowMs: number
  ticks: { pct: number; label: string }[]
  selectedId: string | null
  /** Model per agent owner, when one was recorded. */
  modelFor: Record<string, string | null>
  /** The list's run peek: one line per step (glyph, name, bar, duration), no axis head or who column. */
  compact?: boolean
  /** The run's gate rows, so a failed step's annotation can quote the first violation. */
  gates?: GateResult[]
}>()

defineEmits<{ select: [phase: Phase] }>()

// The last label is right-aligned to the axis end; the one before it is centred on its tick. When the
// span is not a multiple of the tick step they land close together, so the earlier one gives way
// (its gridline stays).
const labelled = computed(() => {
  const last = props.ticks.length - 1
  return props.ticks.map((t, i) => ({
    ...t,
    show: i === last || i === 0 || last < 1 || (props.ticks[last]?.pct ?? 0) - t.pct >= 16 || (props.ticks[last]?.pct ?? 0) <= 92,
  }))
})

function durationMs(p: Phase): number {
  const start = ts(p.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = p.status === 'running' ? props.nowMs : ts(p.ended_at)
  return Number.isFinite(end) ? end - start : NaN
}

function bar(p: Phase): { left: string; width: string } | null {
  const start = ts(p.started_at)
  if (!Number.isFinite(start)) return null
  const dur = durationMs(p)
  const left = Math.min(Math.max(((start - props.t0) / props.span) * 100, 0), 99.4)
  const width = Math.min(Math.max(((Number.isFinite(dur) ? dur : 0) / props.span) * 100, 0.6), 100 - left)
  return { left: `${left}%`, width: `${width}%` }
}

// A failed step's annotation: the first line of its cause, the whole cause in the title.
const annotations = computed(() => {
  const out = new Map<string, { text: string; title: string }>()
  for (const p of props.phases) {
    if (p.status !== 'fail') continue
    const lines = failureCause(p, props.gates, Infinity)?.lines ?? []
    if (lines[0]) out.set(p.phase_id, { text: lines[0], title: lines.join('\n') })
  }
  return out
})

function who(p: Phase): string {
  if (p.kind === 'code') return 'command'
  if (p.kind === 'engineer') return p.owner ?? 'engineer'
  return p.owner ?? 'agent'
}

function model(p: Phase): string | null {
  return p.kind === 'agent' && p.owner ? (props.modelFor[p.owner] ?? null) : null
}
</script>

<template>
  <div class="steps" :class="{ compact }" role="list" aria-label="Phases in the order they ran">
    <div v-if="!compact" class="step-head" aria-hidden="true">
      <span />
      <span>Phase</span>
      <span>Run by</span>
      <span class="axis">
        <template v-for="(t, i) in labelled" :key="i">
          <span v-if="t.show" class="axis-label" :class="{ end: t.pct > 92 }" :style="{ left: `${t.pct}%` }">{{ t.label }}</span>
        </template>
      </span>
      <span class="num">Duration</span>
    </div>
    <div v-for="p in phases" :key="p.phase_id" role="listitem" class="step-item">
      <button
        type="button"
        class="step"
        :class="[p.status ?? 'queued', { selected: p.phase_id === selectedId }]"
        :aria-current="p.phase_id === selectedId ? 'true' : undefined"
        :aria-label="`${p.name ?? 'phase'}${(p.attempt ?? 1) > 1 ? `, attempt ${p.attempt}` : ''}, ${statusWord(p.status)}`"
        @click="$emit('select', p)"
      >
        <StatusGlyph :status="p.status" />
        <span class="name">
          {{ p.name ?? '—' }}
          <span v-if="(p.attempt ?? 1) > 1" class="attempt">attempt {{ p.attempt }}</span>
        </span>
        <span v-if="!compact" class="who">
          <span>{{ who(p) }}</span>
          <template v-if="model(p)">
            <span class="sep" aria-hidden="true">·</span>
            <span class="model" :title="model(p) ?? ''">
              <img v-if="modelIcon(model(p))" class="model-icon" :src="modelIcon(model(p))!" alt="" />
              {{ modelName(model(p)) }}
            </span>
          </template>
        </span>
        <span class="track">
          <span v-for="(t, i) in ticks" :key="i" class="gridline" :style="{ left: `${t.pct}%` }" />
          <span v-if="bar(p)" class="bar" :style="bar(p)!" />
        </span>
        <span class="num dur">{{ p.status === 'queued' || !p.started_at ? 'queued' : fmtDuration(durationMs(p)) }}</span>
      </button>
      <p v-if="annotations.get(p.phase_id)" class="annotation" :title="annotations.get(p.phase_id)!.title">
        {{ annotations.get(p.phase_id)!.text }}
      </p>
    </div>
  </div>
</template>

<style scoped>
/* One grid shared by the head and every row, so the columns line up. */
.steps {
  --step-cols: 24px minmax(9ch, 1.1fr) minmax(0, 1.3fr) minmax(120px, 2.4fr) 9ch;
  border-top: 1px solid var(--rule);
}

.step-head,
.step {
  display: grid;
  grid-template-columns: var(--step-cols);
  column-gap: 16px;
  align-items: center;
}

.step-head {
  padding: 8px 12px;
  border-bottom: 1px solid var(--rule);
  color: var(--faint);
}

.axis {
  position: relative;
  height: 1.5em;
}

.axis-label {
  position: absolute;
  transform: translateX(-50%);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* The first and last labels sit inside the column instead of hanging off it. */
.axis-label:first-child {
  transform: none;
}

.axis-label.end:not(:first-child) {
  transform: translateX(-100%);
}

.step-item {
  border-bottom: 1px solid var(--rule-soft);
}

.step {
  width: 100%;
  min-height: 48px;
  padding: 8px 12px;
  border: none;
  border-radius: 0;
  background: none;
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.step:hover {
  background: var(--face);
}

/* Selection is ink, never red: inside the trace a red mark means failure. */
.step.selected {
  background: var(--inset);
  box-shadow: inset 3px 0 0 var(--fg);
}

.name {
  min-width: 0;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.attempt {
  margin-left: 6px;
  font-weight: 400;
  color: var(--dim);
  white-space: nowrap;
}

.who {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--dim);
  white-space: nowrap;
  overflow: hidden;
}

.who > span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.sep {
  flex: none;
  color: var(--faint);
}

.model {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
}

.model-icon {
  width: 16px;
  height: 16px;
  flex: none;
  object-fit: contain;
}

.track {
  position: relative;
  height: 10px;
}

.gridline {
  position: absolute;
  top: -8px;
  bottom: -8px;
  border-left: 1px dashed color-mix(in srgb, var(--fg) 8%, transparent);
}

/* Duration bars: quiet ink for a finished phase; colour only for an exception
   (failed) or for live state. */
.bar {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 3px;
  background: var(--faint);
  border-radius: 1px;
}

.running .bar {
  background: var(--live);
}

.fail .bar {
  background: var(--fail);
}

.num {
  text-align: right;
  white-space: nowrap;
}

.dur {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--dim);
}

.queued .name,
.queued .dur {
  color: var(--dim);
}

/* A failed step carries its annotation, GitHub Actions style. */
.annotation {
  margin: -2px 0 0;
  padding: 0 12px 10px calc(12px + 24px + 16px);
  overflow: hidden;
  color: var(--fail);
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* Compact (the list's run peek): the drawer is too narrow for who and an axis
   head, so the bar takes a full-width line of its own under glyph, name and
   duration and keeps its proportion on the shared axis. */
.compact .step {
  grid-template-columns: 24px minmax(0, 1fr) auto;
  grid-template-areas:
    'glyph name dur'
    '. track track';
  row-gap: 4px;
  column-gap: 12px;
}

.compact .step > :nth-child(1) {
  grid-area: glyph;
}

.compact .name {
  grid-area: name;
}

.compact .track {
  grid-area: track;
  height: 6px;
  margin-top: 4px;
}

.compact .gridline {
  display: none;
}

.compact .dur {
  grid-area: dur;
}

.compact .annotation {
  padding-left: calc(12px + 24px + 12px);
}

.compact .step {
  min-height: 44px;
  padding: 6px 12px;
}

/* Narrow glass: glyph, name and duration on the first line; who and the bar
   on the second. The axis head drops away — the bar keeps its proportion. */
@media (max-width: 720px) {
  .step-head {
    display: none;
  }

  .step {
    grid-template-columns: 24px minmax(0, 1fr) auto;
    grid-template-areas:
      'glyph name dur'
      '. who who'
      '. track track';
    row-gap: 4px;
    column-gap: 12px;
  }

  .step > :nth-child(1) {
    grid-area: glyph;
  }

  .name {
    grid-area: name;
  }

  .who {
    grid-area: who;
  }

  .track {
    grid-area: track;
    height: 6px;
    margin-top: 4px;
  }

  .gridline {
    display: none;
  }

  .dur {
    grid-area: dur;
  }

  .annotation {
    padding-left: calc(12px + 24px + 12px);
  }

  .compact .step {
    grid-template-areas:
      'glyph name dur'
      '. track track';
  }
}
</style>
