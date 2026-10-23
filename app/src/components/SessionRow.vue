<script setup lang="ts">
import { computed } from 'vue'
import type { SessionSummary } from '../lib/types'
import { Archive } from 'lucide-vue-next'
import { archiveSession } from '../lib/api'
import { fmtCost, fmtDuration, fmtTokens, ts } from '../lib/format'
import { fmtFull, fmtHM, fmtInlineDay } from '../lib/day'
import { hrefFor } from '../lib/router'
import { repoShortName, sessionKey, syncLabel } from '@shared/hosted'
import PhaseDots from './PhaseDots.vue'

const props = defineProps<{
  session: SessionSummary
  nowMs: number
  inlineDay?: boolean
  /** Hosted mode: adds the repo/factory source cell and the freshness note. */
  hosted?: boolean
  /** The owning factory's last sync, for the running-row freshness note. */
  lastSeen?: string | null
}>()
const emit = defineEmits<{ archived: [key: string] }>()

// The row is an <a>; the archive button lives inside it, so the click must not
// navigate. Told the parent optimistically — the poll would take up to half a
// second to drop the row, and a triage click should feel instant.
async function archive(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  emit('archived', sessionKey(props.session))
  try {
    await archiveSession(props.session.adw_id, true, props.session.factory_id)
  } catch {
    emit('archived', '')   // signals the parent to re-sync from the server
  }
}

const running = computed(() => props.session.status === 'running')

const phases = computed(() => props.session.phases ?? [])
const phaseTotal = computed(() => phases.value.length)
const phaseDone = computed(() => phases.value.filter((p) => p.status === 'success').length)

const durationMs = computed(() => {
  const s = props.session
  const start = ts(s.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = running.value ? props.nowMs : ts(s.ended_at)
  return (Number.isFinite(end) ? end : props.nowMs) - start
})

const cost = computed(() => fmtCost(props.session.total_cost))
const runtime = computed(() => fmtDuration(durationMs.value))
const tokens = computed(() => fmtTokens(props.session.total_tokens))

// Search results have no day headers, so the departed time names its day.
const departed = computed(() =>
  props.inlineDay
    ? fmtInlineDay(props.session.started_at, new Date(props.nowMs))
    : fmtHM(props.session.started_at),
)

// Hosted: which repo and which factory produced this run. The chip carries the
// short name; the full slug is its tooltip.
const repoName = computed(() => (props.session.repo ? repoShortName(props.session.repo) : null))
const sourceLine = computed(() => [repoName.value, props.session.factory_name].filter(Boolean).join(' · ') || '—')
// Eventually consistent by design: a running row says how stale it may be.
const fresh = computed(() => (props.hosted && running.value ? syncLabel(props.lastSeen, props.nowMs) : null))

// The folded second line on narrow paper: everything the columns would have
// carried (including the inline day in search mode), in one mono remark line.
const metaLine = computed(
  () =>
    `${props.hosted ? sourceLine.value + ' · ' : ''}${departed.value} · ${phaseDone.value}/${phaseTotal.value} phases · ` +
    `${runtime.value} · ${cost.value} · ${tokens.value}`,
)

// Mid-width remark line: only what the mid breakpoint drops from the columns.
const metaMidLine = computed(
  () => `${props.session.adw_name ?? '—'} · ${phaseDone.value}/${phaseTotal.value} phases · ${tokens.value}`,
)

// Hosted: a trace link names its factory, since adw_id repeats across factories.
const href = computed(() => hrefFor(props.session.adw_id, null, props.session.factory_id))
</script>

<template>
  <a class="row" :class="[session.status, { 'inline-day': inlineDay, hosted }]" :href="href">
    <span class="c departed mono dim" :title="fmtFull(session.started_at)">{{ departed }}</span>
    <span class="c run mono">{{ session.adw_id }}</span>
    <span v-if="hosted" class="c source" :title="`${session.repo ?? ''} · ${session.factory_name ?? ''}`">
      <span v-if="repoName" class="stub mono">{{ repoName }}</span>
      <span class="factory mono dim">{{ session.factory_name ?? '—' }}</span>
      <span v-if="fresh" class="fresh fresh-col mono dim">{{ fresh }}</span>
    </span>
    <span class="c service" :title="session.adw_name ?? ''">{{ session.adw_name ?? '—' }}</span>
    <span class="c request" :title="session.request ?? ''">
      <span class="req-text">{{ session.request }}</span>
      <span v-if="fresh" class="fresh fresh-fold mono dim">{{ fresh }}</span>
    </span>
    <span class="c phases">
      <span class="mono dim">{{ phaseDone }}/{{ phaseTotal }}</span>
      <PhaseDots :phases="phases" :max="4" />
    </span>
    <span class="c status" :class="session.status ?? 'fail'">{{ session.status ?? 'fail' }}</span>
    <span class="c num cost mono">{{ cost }}</span>
    <span class="c num runtime mono">{{ runtime }}</span>
    <span class="c num tokens mono">{{ tokens }}</span>
    <button
      class="act"
      type="button"
      aria-label="Archive — remove this run from review"
      title="Archive — remove this run from review"
      @click="archive"
    >
      <Archive :size="17" :stroke-width="2" />
    </button>
    <span class="meta-mid mono dim">{{ metaMidLine }}</span>
    <span class="meta mono dim">{{ metaLine }}</span>
  </a>
</template>

<style scoped>
/* One departure on the printed timetable: baseline-aligned cells, a hairline
   under each row, numbers in the data voice right-aligned in their columns.
   The column template comes from --tt-columns on .tt (SessionsList) so the
   header stays in lockstep with the rows. */
.row {
  display: grid;
  grid-template-columns: var(--tt-columns);
  align-items: baseline;
  column-gap: 18px;
  padding: 9px 0;
  border-bottom: 1px solid var(--rule-soft);
  color: var(--fg);
  text-decoration: none;
  font-size: 16px;
}

.row:hover {
  background: var(--face);
}

.run {
  font-weight: 700;
}

/* "Yesterday 22:10" must not break across two lines and double the row. */
.departed {
  white-space: nowrap;
}

.service,
.request {
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Request text keeps the ellipsis; the freshness note beside it never shrinks. */
.request {
  display: flex;
  gap: 12px;
  align-items: baseline;
}

.req-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fresh {
  flex: none;
  font-style: italic;
}

/* Wide: the note sits under the source (the row grows a line, running rows only).
   Folded: the source column is gone, so it rides beside the request instead. */
.fresh-col {
  flex-basis: 100%;
}

.fresh-fold {
  display: none;
}

/* Source: repo as a tag stub (square cell, soft rule), factory in the data voice. */
.source {
  display: flex;
  flex-wrap: wrap;
  gap: 0 8px;
  align-items: baseline;
  overflow: hidden;
  white-space: nowrap;
}

.stub {
  flex: none;
  max-width: 100%;
  padding: 0 6px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
}

.factory {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.phases {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  overflow: hidden;
  white-space: nowrap;
}

.status {
  font-weight: 600;
  white-space: nowrap;
}

.num {
  text-align: right;
  white-space: nowrap;
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

/* State words are signals, written in their ink. */
.status.success {
  color: var(--pass);
}

.status.fail {
  color: var(--fail);
}

/* A run in flight gets annotated in ballpoint — the paper's only live mark. */
.status.running {
  color: var(--live);
  font-style: italic;
}

.status.queued {
  color: var(--faint);
  font-style: italic;
}

.row.running {
  background: var(--face);
}

.act {
  justify-self: end;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  color: var(--faint);
  cursor: pointer;
}

.act:hover,
.act:focus-visible {
  border-color: var(--rule);
  color: var(--accent);
}

.meta,
.meta-mid {
  display: none;
}

.meta-mid {
  grid-row: 2;
  grid-column: 3 / -1;
  font-size: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Mid paper: service, phases and tokens fold into a remark line under the
   request, so the request column keeps a sane width and the row never
   overflows. Widths and columns here must match --tt-columns in
   SessionsList: 981-1400px, and up to 1480px for search rows, whose wider
   inline-day departed column needs the extra room. */
@media (max-width: 1400px) and (min-width: 981px) {
  .row {
    row-gap: 3px;
  }

  .service,
  .phases,
  .tokens {
    display: none;
  }

  .meta-mid {
    display: block;
  }
}

@media (max-width: 1480px) and (min-width: 981px) {
  .row.inline-day {
    row-gap: 3px;
  }

  .inline-day .service,
  .inline-day .phases,
  .inline-day .tokens {
    display: none;
  }

  .inline-day .meta-mid {
    display: block;
  }
}

/* Hosted adds the source column, so the same folds begin 210px earlier (the
   column plus its gap). Matches --tt-columns in SessionsList. */
@media (max-width: 1610px) and (min-width: 981px) {
  .row.hosted {
    row-gap: 3px;
  }

  .hosted .service,
  .hosted .phases,
  .hosted .tokens {
    display: none;
  }

  .hosted .meta-mid {
    display: block;
    grid-column: 4 / -1;
  }
}

@media (max-width: 1690px) and (min-width: 981px) {
  .row.hosted.inline-day {
    row-gap: 3px;
  }

  .hosted.inline-day .service,
  .hosted.inline-day .phases,
  .hosted.inline-day .tokens {
    display: none;
  }

  .hosted.inline-day .meta-mid {
    display: block;
    grid-column: 4 / -1;
  }
}

/* Narrow paper: the timetable folds — id and status on the first line, the
   request on the second, and one mono remark line carrying everything the
   hidden columns would have. */
@media (max-width: 980px) {
  .row {
    grid-template-columns: 1fr auto auto;
    row-gap: 3px;
    padding: 12px 0;
  }

  .fresh-fold {
    display: inline;
  }

  .departed,
  .service,
  .source,
  .phases,
  .num {
    display: none;
  }

  .request {
    grid-column: 1 / -1;
  }

  .meta {
    display: block;
    grid-column: 1 / -1;
    font-size: 16px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
