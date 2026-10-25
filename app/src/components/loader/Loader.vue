<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { FIGURE_FOR, useAnnouncement, type LoaderJob } from '../../lib/loader'
import './skeleton.css'
import { allLit, FIGURES, frameAt, frameForProgress, noneLit } from '../../lib/loader-figures'

// The brand loader: an isometric factory line in hairlines. A pulse runs the
// wire and stations light as it reaches them, like phases completing in a
// chain. The figure follows the job (see FIGURE_FOR in lib/loader.ts). Waits
// over ~2s only (see useLoadingTier); shorter ones get a skeleton.
const props = withDefaults(
  defineProps<{
    /** What is loading, which picks the figure: a run or receipt, real progress, or any other wait. */
    job: LoaderJob
    /** mark: the figure 180px tall over its label; inline: 64px tall beside it. */
    size?: 'mark' | 'inline'
    /** Plain words for what is loading. Required while loading; optional for `still`. */
    label?: string
    /** A second clause after the label ("3 phases", "42%"), joined as "label · detail". */
    detail?: string | number | null
    /** Real progress 0–100: stations light by progress instead of looping. */
    progress?: number | null
    /** The static empty-state form: nothing lit, nothing moves. */
    still?: boolean
  }>(),
  { size: 'mark', label: undefined, detail: null, progress: null, still: false },
)

const fig = computed(() => FIGURES[FIGURE_FOR[props.job]])
const fid = `ldr-bloom-${useId()}`
const box = computed(() => fig.value.viewBox.split(' ').map(Number))

const reduced = ref(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
const onMq = (e: MediaQueryListEvent) => (reduced.value = e.matches)

const t = ref(0)
let raf = 0
let t0 = 0
const looping = computed(() => !props.still && props.progress == null && !reduced.value)

function step(now: number) {
  t.value = ((now - t0) % fig.value.period) / fig.value.period
  raf = requestAnimationFrame(step)
}
function sync() {
  cancelAnimationFrame(raf)
  raf = 0
  if (!looping.value) return
  t0 = performance.now()
  t.value = 0
  raf = requestAnimationFrame(step)
}
watch([looping, fig], sync)
onMounted(() => {
  mq.addEventListener('change', onMq)
  sync()
})
onUnmounted(() => {
  cancelAnimationFrame(raf)
  mq.removeEventListener('change', onMq)
})

const state = computed(() => {
  if (props.still) return noneLit(fig.value)
  if (props.progress != null) return frameForProgress(fig.value, props.progress)
  if (reduced.value) return allLit(fig.value)
  return frameAt(fig.value, t.value)
})

const PULSE = 90 // dash length in pathLength units
// Height is fixed per size; width follows each figure's own proportions so a
// wide conveyor and a squat stack read at the same scale.
const HEIGHT = { mark: 180, inline: 64 } as const
const figStyle = computed(() => {
  const h = HEIGHT[props.size]
  return { width: `${Math.round(h * fig.value.aspect)}px`, height: `${h}px` }
})
const text = computed(() => {
  const detail = props.detail == null || props.detail === '' ? null : String(props.detail)
  return [props.label, detail].filter(Boolean).join(' · ')
})
// A looping wait speaks through a status region that mounts empty and fills a
// moment later; measured progress is a progressbar, so the percentage is a
// value, never re-announced; the still mark is plain content.
const busy = computed(() => !props.still && props.progress == null)
const said = useAnnouncement(() => (busy.value ? text.value : ''))
const rootAttrs = computed(() => {
  if (props.progress != null)
    return {
      role: 'progressbar',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': Math.round(Math.min(100, Math.max(0, props.progress))),
      'aria-label': props.label,
    }
  if (props.still && !text.value) return { 'aria-hidden': 'true' as const }
  return {}
})
</script>

<template>
  <div class="ldr" :class="[size, { still }]" v-bind="rootAttrs">
    <svg
      class="ldr-fig"
      :viewBox="fig.viewBox"
      :style="figStyle"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <!-- userSpaceOnUse: the riser and wire are straight lines, whose zero-height box would clip a default filter region. -->
        <filter :id="fid" filterUnits="userSpaceOnUse" :x="box[0]" :y="box[1]" :width="box[2]" :height="box[3]">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <template v-for="(p, i) in fig.parts" :key="i">
        <g
          class="ldr-box"
          :class="{ lit: p.station != null && state.lit[p.station] }"
          :filter="p.station != null && state.lit[p.station] ? `url(#${fid})` : undefined"
        >
          <polygon class="ldr-side" :points="p.box.side" />
          <polygon class="ldr-front" :points="p.box.front" />
          <polygon class="ldr-top" :points="p.box.top" />
        </g>
        <polygon v-if="i === 0" class="ldr-inset" :points="fig.inset" />
      </template>
      <path class="ldr-wire" :d="fig.stubs" />
      <path class="ldr-wire" :d="fig.wire" />
      <path
        v-if="state.hot != null && state.hot > 0"
        class="ldr-hot"
        :d="fig.wire"
        pathLength="1000"
        :stroke-dasharray="`${state.hot * 1000} 2000`"
        :filter="`url(#${fid})`"
      />
      <path
        v-if="state.pulse != null"
        class="ldr-pulse"
        :d="fig.wire"
        pathLength="1000"
        :stroke-dasharray="`${PULSE} 2000`"
        :stroke-dashoffset="PULSE - state.pulse * 1000"
        :filter="`url(#${fid})`"
      />
    </svg>
    <span v-if="text" class="ldr-label" :aria-hidden="busy ? 'true' : undefined">{{ text }}</span>
    <span v-if="busy" class="sk-sr" role="status">{{ said }}</span>
  </div>
</template>

<style scoped>
.ldr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--dim);
}

.ldr.inline {
  flex-direction: row;
  gap: 16px;
}

/* Size comes from figStyle; max-width keeps a wide figure inside a phone column.
   Strokes are non-scaling, so the hairlines stay 1px at any size. */
.ldr-fig {
  display: block;
  max-width: 100%;
  overflow: visible;
}

.inline .ldr-fig {
  flex: none;
}

.ldr-label {
  font-size: 16px;
  line-height: 1.5;
  color: var(--dim);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.inline .ldr-label {
  text-align: left;
}

/* Hairline structure, tonal faces: top lightest, side in the sunk tone. */
polygon {
  stroke: var(--dim);
  stroke-width: 1;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.ldr-top {
  fill: var(--face);
}

.ldr-front {
  fill: var(--ground);
}

.ldr-side {
  fill: var(--inset);
}

.ldr-inset {
  fill: none;
  stroke: var(--rule);
}

/* Lit: a flat accent fill (ballpoint on paper, amber on the board). */
.lit .ldr-top,
.lit .ldr-front {
  fill: var(--live);
}

.lit .ldr-side {
  fill: color-mix(in srgb, var(--live) 70%, var(--fg));
}

.lit polygon {
  stroke: var(--fg);
}

.ldr-wire {
  fill: none;
  stroke: var(--faint);
  stroke-width: 1.5;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}

.ldr-pulse,
.ldr-hot {
  fill: none;
  stroke: var(--live);
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}

.ldr-pulse {
  stroke-width: 3.5;
}

.ldr-hot {
  stroke-width: 2.5;
}

.inline .ldr-pulse {
  stroke-width: 2.5;
}

/* Paper has no glow: lit things are flat accent. Only the board blooms. */
:global(body:not(.board) .ldr [filter]) {
  filter: none;
}

.still polygon {
  stroke: var(--faint);
}
</style>
