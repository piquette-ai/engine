<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AgentSession, EventRow, Phase, PhaseKind } from '../lib/types'
import { Bot, SquareTerminal, UserRound } from 'lucide-vue-next'
import { payloadOk, statusWord, ts } from '../lib/format'
import { modelIcon, modelName } from '../lib/models'
import StatChip from './StatChip.vue'
import StatusGlyph from './StatusGlyph.vue'

// The board view of a run: one lane per actor, every phase a bay on a shared
// time axis. Lanes are identified by number and name, never by colour — hue
// on the board means state (live, failed), not actor.
const props = defineProps<{
  /** Every phase except the run's opening request, which lives in the header. */
  phases: Phase[]
  agents: AgentSession[]
  events: EventRow[]
  engineer: string | null
  t0: number
  span: number
  nowMs: number
  ticks: { pct: number; label: string }[]
  selectedId: string | null
  modelFor: Record<string, string | null>
}>()

defineEmits<{ select: [phase: Phase] }>()

const KIND_ICONS = { engineer: UserRound, code: SquareTerminal, agent: Bot }

interface LaneContext {
  used: number
  window: number
  /** 0–100, uncapped by the floor applied to the bar's width. */
  pct: number
}

interface Lane {
  id: string
  track: string
  label: string
  model: string | null
  context: LaneContext | null
  meta: string | null
  kind: PhaseKind
  phases: Phase[]
}

/** Occupancy for an agent lane. Null unless BOTH numbers are real — a bar
 *  against an unknown ceiling would be decoration, not data. */
function laneContext(info: AgentSession | undefined): LaneContext | null {
  const used = info?.context_tokens ?? 0
  const window = info?.context_window ?? 0
  if (!used || !window) return null
  return { used, window, pct: Math.min(100, (used / window) * 100) }
}

/** Sub-1% occupancy is common and real; round it away and the bar reads empty. */
function contextLabel(ctx: LaneContext): string {
  return ctx.pct < 1 ? `${ctx.pct.toFixed(1)}%` : `${Math.round(ctx.pct)}%`
}

function contextFill(ctx: LaneContext): string {
  return `scaleX(${Math.max(ctx.pct, 2) / 100})`
}

function laneRunning(lane: Lane): boolean {
  return lane.phases.some((p) => p.status === 'running')
}

const NUM = new Intl.NumberFormat('en-US')

function firstStart(phases: Phase[]): number {
  let first = Infinity
  for (const p of phases) {
    const s = ts(p.started_at)
    if (Number.isFinite(s)) first = Math.min(first, s)
  }
  return first
}

// Lanes in the order they first did something, so the board reads top-left to
// bottom-right like the run did. A lane with only queued work sits last.
const lanes = computed<Lane[]>(() => {
  const ph = props.phases
  const out: Lane[] = []
  const engineerPhases = ph.filter((p) => p.kind === 'engineer')
  if (engineerPhases.length) {
    out.push({ id: 'engineer', track: '', label: props.engineer ?? 'engineer', model: null, context: null, meta: 'engineer', kind: 'engineer', phases: engineerPhases })
  }
  const codePhases = ph.filter((p) => p.kind === 'code')
  if (codePhases.length) {
    out.push({ id: 'code', track: '', label: 'code', model: null, context: null, meta: 'commands', kind: 'code', phases: codePhases })
  }
  const owners: string[] = []
  for (const p of ph) if (p.kind === 'agent' && p.owner && !owners.includes(p.owner)) owners.push(p.owner)
  for (const owner of owners) {
    out.push({
      id: `agent:${owner}`,
      track: '',
      label: owner,
      model: props.modelFor[owner] ?? null,
      context: laneContext(props.agents.find((a) => a.agent === owner)),
      meta: null,
      kind: 'agent',
      phases: ph.filter((p) => p.kind === 'agent' && p.owner === owner),
    })
  }
  const sorted = out
    .map((lane, i) => {
      const first = firstStart(lane.phases)
      return { lane, i, first: Number.isFinite(first) ? first : Number.MAX_SAFE_INTEGER }
    })
    .toSorted((a, b) => a.first - b.first || a.i - b.i)
    .map((x) => x.lane)
  sorted.forEach((lane, i) => {
    lane.track = String(i + 1).padStart(2, '0')
  })
  return sorted
})

/**
 * Adjusted layout for every timed phase, in track-%.
 *
 * Phases are sequential by doctrine, and the render must say so: when a
 * near-zero phase (a git commit) is widened to a readable floor, every later
 * block shifts right by the same amount instead of being overlapped, and the
 * whole layout is normalized back into the track. Blocks may squeeze a hair;
 * they never stack.
 */
const MIN_BLOCK_PCT = 2.5

const blockLayout = computed<Record<string, { left: number; width: number }>>(() => {
  const avail = 100 - 0.8 // a hair of margin at both ends
  const t0 = props.t0
  const span = props.span
  const timed = props.phases
    .filter((p) => Number.isFinite(ts(p.started_at)))
    .map((p) => {
      const start = ts(p.started_at)
      let end = ts(p.ended_at)
      if (!Number.isFinite(end)) end = p.status === 'running' ? props.nowMs : start
      return {
        id: p.phase_id,
        start,
        left: (Math.max(start - t0, 0) / span) * avail,
        width: ((Math.max(end, start) - start) / span) * avail,
      }
    })
    .toSorted((a, b) => a.start - b.start)

  let shift = 0
  let prevEdge = 0
  const rows: { id: string; left: number; width: number }[] = []
  for (const b of timed) {
    let left = b.left + shift
    if (left < prevEdge) {
      shift += prevEdge - left
      left = prevEdge
    }
    const width = Math.max(b.width, MIN_BLOCK_PCT)
    shift += width - b.width
    prevEdge = left + width
    rows.push({ id: b.id, left, width })
  }
  const scale = avail / Math.max(prevEdge, avail)
  const out: Record<string, { left: number; width: number }> = {}
  for (const r of rows) out[r.id] = { left: 0.4 + r.left * scale, width: r.width * scale }
  return out
})

// Track width in px, so a bay too narrow to carry its name shows only its
// glyph (the name rides in the title, the aria-label and the step list)
// instead of being amputated to "p…".
const trackEl = ref<HTMLElement | null>(null)
const trackPx = ref(800)
let ro: ResizeObserver | undefined
onMounted(() => {
  if (!trackEl.value) return
  ro = new ResizeObserver(([entry]) => {
    if (entry) trackPx.value = entry.contentRect.width
  })
  ro.observe(trackEl.value)
})
onUnmounted(() => ro?.disconnect())

function geom(p: Phase): { left: number; width: number } | null {
  return blockLayout.value[p.phase_id] ?? null
}

// What a bay has room for, from its pixel width: the whole name and the
// duration, the name alone, or only the glyph. A name is never cut to "p…".
// Padding + glyph ≈ 50px; Overpass 700 at 17px runs about 10.5px a character.
function fit(p: Phase): 'full' | 'name' | 'glyph' {
  const g = geom(p)
  if (!g) return 'full'
  const px = (g.width / 100) * trackPx.value
  const nameMin = 50 + Math.min((p.name ?? '').length, 14) * 10.5
  if (px < nameMin) return 'glyph'
  return px < nameMin + 90 ? 'name' : 'full'
}

function compact(p: Phase): boolean {
  return fit(p) === 'glyph'
}

function blockDurationMs(p: Phase): number {
  const start = ts(p.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = p.status === 'running' ? props.nowMs : ts(p.ended_at)
  if (!Number.isFinite(end)) return NaN
  return end - start
}

const toolTicks = computed(() => {
  const map: Record<string, { t: number; ok: boolean }[]> = {}
  for (const e of props.events) {
    if (e.type !== 'tool_call' || !e.phase_id) continue
    map[e.phase_id] ??= []
    map[e.phase_id]?.push({ t: ts(e.started_at), ok: payloadOk(e.payload_json) })
  }
  return map
})

function ticksFor(p: Phase): { x: number; ok: boolean }[] {
  const start = ts(p.started_at)
  if (!Number.isFinite(start)) return []
  let end = ts(p.ended_at)
  if (!Number.isFinite(end)) end = p.status === 'running' ? props.nowMs : start
  const width = Math.max(end - start, 1)
  return (toolTicks.value[p.phase_id] ?? [])
    .filter((mark) => Number.isFinite(mark.t))
    .map((mark) => ({ x: Math.min(Math.max(((mark.t - start) / width) * 100, 1), 99), ok: mark.ok }))
}

const queuedByLane = computed(() => {
  const map: Record<string, Phase[]> = {}
  for (const lane of lanes.value) map[lane.id] = lane.phases.filter((p) => !p.started_at)
  return map
})

function label(p: Phase): string {
  const attempt = (p.attempt ?? 1) > 1 ? `, attempt ${p.attempt}` : ''
  return `${p.name ?? 'phase'}${attempt}, ${statusWord(p.status)}`
}
</script>

<template>
  <div class="waterfall">
    <div class="row axis-row">
      <div class="label" />
      <div ref="trackEl" class="track">
        <span
          v-for="(t, i) in ticks"
          :key="i"
          class="axis-label"
          :class="{ end: t.pct > 92 }"
          :style="{ left: `${t.pct}%` }"
          >{{ t.label }}</span
        >
      </div>
    </div>

    <div v-for="lane in lanes" :key="lane.id" class="row lane">
      <div class="label">
        <span class="lane-name">
          <span class="tno mono">{{ lane.track }}</span>
          <component :is="KIND_ICONS[lane.kind]" class="lane-icon" :size="19" :stroke-width="2" />
          <span class="lane-label">{{ lane.label }}</span>
        </span>
        <span v-if="lane.model" class="lane-meta lane-model" :title="lane.model">
          <img v-if="modelIcon(lane.model)" class="model-icon" :src="modelIcon(lane.model)!" alt="" />
          {{ modelName(lane.model) }}
        </span>
        <span
          v-if="lane.context"
          class="lane-ctx"
          :title="`${NUM.format(lane.context.used)} / ${NUM.format(lane.context.window)} tokens used · ${NUM.format(lane.context.window - lane.context.used)} remaining`"
        >
          <span class="ctx-head">
            <span class="ctx-label">Context</span>
            <span class="ctx-pct">{{ contextLabel(lane.context) }}</span>
          </span>
          <span class="ctx-bar">
            <span class="ctx-fill" :class="{ live: laneRunning(lane) }" :style="{ transform: contextFill(lane.context) }" />
          </span>
        </span>
        <span v-if="lane.meta" class="lane-meta">{{ lane.meta }}</span>
      </div>
      <div class="track">
        <span v-for="(t, i) in ticks" :key="i" class="gridline" :style="{ left: `${t.pct}%` }" />
        <template v-for="p in lane.phases" :key="p.phase_id">
          <button
            v-if="geom(p)"
            type="button"
            class="block"
            :class="[p.status, { selected: p.phase_id === selectedId, compact: compact(p) }]"
            :style="{ left: `${geom(p)!.left}%`, width: `${geom(p)!.width}%` }"
            :title="`${p.name}${(p.attempt ?? 1) > 1 ? ` (attempt ${p.attempt})` : ''} — ${statusWord(p.status)}${p.description ? `\n${p.description}` : ''}`"
            :aria-label="label(p)"
            @click="$emit('select', p)"
          >
            <span class="b-top">
              <StatusGlyph :status="p.status" />
              <template v-if="!compact(p)">
                <span class="b-name">{{ p.name }}</span>
                <StatChip v-if="fit(p) === 'full' && Number.isFinite(blockDurationMs(p))" class="b-dur" kind="runtime" compact :value="blockDurationMs(p)" />
              </template>
            </span>
            <span v-if="!compact(p)" class="b-desc">{{ p.description }}</span>
            <span
              v-for="(tick, i) in ticksFor(p)"
              :key="i"
              class="tool-tick"
              :class="{ err: !tick.ok }"
              :style="{ left: `${tick.x}%` }"
            />
          </button>
        </template>
        <button
          v-for="(p, i) in queuedByLane[lane.id]"
          :key="p.phase_id"
          type="button"
          class="block queued"
          :class="{ selected: p.phase_id === selectedId }"
          :style="{ right: `${10 + i * 5}px`, width: '170px' }"
          :title="`${p.name} — queued`"
          :aria-label="label(p)"
          @click="$emit('select', p)"
        >
          <span class="b-top">
            <StatusGlyph status="queued" />
            <span class="b-name">{{ p.name }}</span>
          </span>
          <span class="b-desc">queued</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The board itself: squared corners, hairline frame, one material. */
.waterfall {
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--face);
  overflow: hidden;
}

.row {
  display: grid;
  grid-template-columns: 220px 1fr;
}

.axis-row {
  border-bottom: 1px solid var(--rule);
}

.axis-row .track {
  height: 34px;
  overflow: hidden;
}

.axis-label {
  position: absolute;
  bottom: 5px;
  transform: translateX(-50%);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--dim);
  white-space: nowrap;
}

.axis-label:first-child {
  transform: none;
  padding-left: 6px;
}

.axis-label.end {
  transform: translateX(-100%);
  padding-right: 6px;
}

.label {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  border-right: 1px solid var(--rule);
  overflow: hidden;
  white-space: nowrap;
  min-width: 0;
}

.lane-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 17px;
  font-weight: 700;
  color: var(--fg);
  min-width: 0;
}

.lane-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The track number is the lane's identity — attribution by position and name. */
.tno {
  flex: none;
  width: 24px;
  color: var(--faint);
}

.lane-icon {
  flex: none;
  color: var(--dim);
}

.lane-meta {
  font-family: var(--mono);
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
}

.lane-model {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.model-icon {
  width: 16px;
  height: 16px;
  flex: none;
  object-fit: contain;
}

.lane-ctx {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
  max-width: 180px;
}

.ctx-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.ctx-label {
  color: var(--faint);
}

.ctx-pct {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--dim);
}

.ctx-bar {
  height: 6px;
  background: var(--inset);
  border: 1px solid var(--rule-soft);
  overflow: hidden;
}

.ctx-fill {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--faint);
  transform-origin: left center;
  transition: transform 300ms ease;
}

.ctx-fill.live {
  background: var(--live);
}

.lane {
  border-bottom: 1px solid var(--rule-soft);
}

.lane:last-child {
  border-bottom: none;
}

.track {
  position: relative;
  height: 110px;
  overflow: hidden;
}

.gridline {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px dashed color-mix(in srgb, var(--fg) 8%, transparent);
}

/* A phase bay: square, hairline frame. Hue belongs to the state. */
.block {
  position: absolute;
  top: 12px;
  height: 86px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 4px;
  padding: 10px 12px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--rule);
  background: var(--face);
  font: inherit;
  color: var(--fg);
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  text-align: left;
  transition:
    border-color 120ms ease,
    background 120ms ease;
}

.block:hover {
  border-color: var(--dim);
  background: color-mix(in srgb, var(--fg) 5%, var(--face));
}

/* Too narrow for a name: the glyph alone, centred. */
.block.compact {
  padding: 10px 0 16px;
  align-items: center;
}

.b-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.b-name {
  min-width: 0;
  font-size: 17px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
}

.b-dur {
  margin-left: auto;
  flex: none;
}

.b-desc {
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.block.running {
  border-color: var(--live);
}

.block.running .b-name {
  color: var(--live);
}

.block.fail {
  border-color: var(--fail);
}

.block.queued {
  background: transparent;
  border-style: dashed;
  color: var(--dim);
}

.block.selected {
  outline: 2px solid var(--fg);
  outline-offset: 1px;
}

.tool-tick {
  position: absolute;
  bottom: 4px;
  width: 3px;
  height: 9px;
  background: var(--faint);
}

.tool-tick.err {
  background: var(--fail);
}

/* On narrow glass the board pans instead of compressing. */
@media (max-width: 980px) {
  .waterfall {
    overflow-x: auto;
  }

  .row {
    min-width: 700px;
    grid-template-columns: 180px 1fr;
  }
}
</style>
