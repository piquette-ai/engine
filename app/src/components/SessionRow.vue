<script setup lang="ts">
import { computed } from 'vue'
import type { SessionSummary } from '../lib/types'
import { Check, LoaderCircle, PanelRightOpen, RotateCcw, ShieldCheck, SquareCheckBig, Undo2, X } from 'lucide-vue-next'
import { costTitle, fmtCost, fmtDuration, fmtTokens, ts } from '../lib/format'
import { fmtFull, fmtHM, fmtInlineDay } from '../lib/day'
import { hrefFor } from '../lib/router'
import { verifiedFor } from '../lib/row-receipts'
import { domKey, kindLabel, plainRequest, runKind, runNote } from '../lib/runs'
import { repoShortName, sessionKey, syncLabel } from '@shared/hosted'
import PhaseDots from './PhaseDots.vue'

const props = defineProps<{
  session: SessionSummary
  nowMs: number
  inlineDay?: boolean
  /** Hosted mode: adds repo and factory to the meta line and the freshness note. */
  hosted?: boolean
  /** The owning factory's last sync, for the running-row freshness note. */
  lastSeen?: string | null
  /** The keyboard-triage cursor (j/k) is on this row. */
  focused?: boolean
  /** The Reviewed view: the action restores the run instead of marking it reviewed. */
  reviewed?: boolean
  /** The run peek is open on this row. */
  peeked?: boolean
  /** Alternate-row tint. The list counts parity from the group's oldest row,
      so a new run arriving on top never flips the rows under it. */
  striped?: boolean
}>()
const emit = defineEmits<{
  review: [session: SessionSummary]
  restore: [session: SessionSummary]
  cursor: [session: SessionSummary]
  peek: [session: SessionSummary]
}>()

const kind = computed(() => runKind(props.session))
const running = computed(() => kind.value === 'running')

const ICONS = { ok: Check, failed: X, recovered: RotateCcw, running: LoaderCircle } as const

const phases = computed(() => props.session.phases ?? [])

const durationMs = computed(() => {
  const start = ts(props.session.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = running.value ? props.nowMs : ts(props.session.ended_at)
  return (Number.isFinite(end) ? end : props.nowMs) - start
})

const runtime = computed(() => fmtDuration(durationMs.value))
const cost = computed(() => fmtCost(props.session.total_cost))
const tokens = computed(() => (props.session.total_tokens ? `${fmtTokens(props.session.total_tokens)} tok` : '—'))

// Search results have no day headers, so the time names its day.
const started = computed(() =>
  props.inlineDay ? fmtInlineDay(props.session.started_at, new Date(props.nowMs)) : fmtHM(props.session.started_at),
)

const title = computed(() => plainRequest(props.session.request))

// "issue-216 · repo · factory · chain" on one line; repo and factory only exist hosted.
const repoName = computed(() => (props.session.repo ? repoShortName(props.session.repo) : null))
const metaParts = computed(() =>
  [
    props.session.adw_id,
    props.hosted ? repoName.value : null,
    props.hosted ? props.session.factory_name : null,
    props.session.adw_name,
  ].filter((p): p is string => !!p),
)
const meta = computed(() => metaParts.value.join(' · '))
// Hosted phones drop the run id so repo and factory survive the ellipsis.
const metaShort = computed(() => (props.hosted && metaParts.value.length > 1 ? metaParts.value.slice(1).join(' · ') : meta.value))
const metaTitle = computed(() =>
  [props.session.adw_id, props.session.repo, props.session.factory_name, props.session.adw_name && `Chain: ${props.session.adw_name}`]
    .filter(Boolean)
    .join(' · '),
)

// Eventually consistent by design: a running row says how stale it may be.
const fresh = computed(() => (props.hosted && running.value ? syncLabel(props.lastSeen, props.nowMs) : null))
const note = computed(() => runNote(props.session))

const href = computed(() => hrefFor(props.session.adw_id, null, { factory: props.session.factory_id, repo: props.session.repo }))
const ariaLabel = computed(
  () =>
    `${kindLabel[kind.value]}: ${title.value}${note.value ? `, ${note.value}` : ''}. Run ${props.session.adw_id}${
      props.session.adw_name ? `, chain ${props.session.adw_name}` : ''
    }, started ${started.value}, runtime ${runtime.value}`,
)
const reviewLabel = computed(() => `${props.reviewed ? 'Restore' : 'Mark reviewed'}: ${title.value}`)

// A passing receipt, when the list has learned of one for this run.
const verified = computed(() => verifiedFor(props.session))
const verifiedLabel = computed(() => (verified.value ? `Verified: ${verified.value.passing}/${verified.value.total} checks pass` : ''))
</script>

<template>
  <div class="row" :class="[kind, { focused, striped }]" :data-key="domKey(sessionKey(session))">
    <a class="link" :href="href" :aria-label="ariaLabel" @focusin="emit('cursor', session)">
      <span class="glyph" :class="kind" aria-hidden="true">
        <component :is="ICONS[kind]" :size="18" :stroke-width="kind === 'ok' ? 2 : 2.5" />
      </span>
      <span class="body">
        <span class="title" :title="session.request ?? ''">{{ title }}</span>
        <span class="sub">
          <span v-if="note" class="note" :class="kind">{{ note }}</span>
          <span v-if="fresh" class="fresh">{{ fresh }}</span>
          <span v-if="verified" class="verified" :title="verifiedLabel" role="img" :aria-label="verifiedLabel">
            <ShieldCheck :size="18" :stroke-width="2" aria-hidden="true" />
          </span>
          <span class="meta mono" :title="metaTitle"><span class="meta-full">{{ meta }}</span><span class="meta-short">{{ metaShort }}</span></span>
        </span>
      </span>
      <span class="c-dots"><PhaseDots :phases="phases" :max="4" quiet /></span>
      <span class="when mono">
        <span class="runtime" title="Duration">{{ runtime }}</span>
        <span class="time dim" :title="fmtFull(session.started_at)">{{ started }}</span>
      </span>
      <span class="c-tokens mono" title="Tokens">{{ tokens }}</span>
      <span class="c-cost mono" :title="costTitle(session.total_cost)">{{ cost }}</span>
    </a>
<span class="acts">
      <button
        class="act act-peek"
        type="button"
        :aria-label="`Peek: ${title}`"
        :aria-pressed="peeked"
        title="Peek at this run (space)"
        @click="emit('peek', session)"
      >
        <PanelRightOpen :size="18" :stroke-width="2" />
      </button>
      <button
        v-if="kind !== 'running'"
        class="act"
        type="button"
        :aria-label="reviewLabel"
        :title="reviewed ? 'Restore to the review list (e)' : 'Mark reviewed (e)'"
        @click="reviewed ? emit('restore', session) : emit('review', session)"
      >
        <Undo2 v-if="reviewed" :size="18" :stroke-width="2" />
        <SquareCheckBig v-else :size="18" :stroke-width="2" />
      </button>
      <span v-else class="act-gap" aria-hidden="true" />
    </span>
  </div>
</template>

<style scoped>
/* One run: a hairline-ruled, two-line row. The request is the primary text;
   the muted line under it names where it came from and, only for exceptions,
   what happened. Colour is reserved for failed and running. */
.row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 84px;
  align-items: center;
  column-gap: 8px;
  border-bottom: 1px solid var(--rule-soft);
  container-type: inline-size;
  container-name: run-row;
  color: var(--fg);
}

/* Rows in a group are separated by a soft rule only; the strong rule belongs
   to the group head. The last row hands over to the next group's head. */
.row:last-child {
  border-bottom-color: transparent;
}

/* Alternate rows carry a tint halfway to the hover fill: light enough that
   hover and the cursor still read as a clear step past it, in both themes
   (paper steps darker, board steps lighter, then hover goes the other way). */
.row.striped {
  background: var(--stripe);
}

/* Hover and the keyboard cursor share one faint sunk fill across the whole
   row, cost and action included. Red means failure, so it never marks this. */
.row:hover,
.row.focused,
.row:has(.link:focus-visible) {
  background: var(--inset);
}

.row.running {
  background: var(--face);
}

.row.running:hover,
.row.running.focused {
  background: var(--inset);
}

/* The cursor adds a hairline ink ring (inset, so nothing shifts): the fill
   alone is too faint to be a focus indicator. Ink on ground is well over 3:1. */
.row.focused,
.row:has(.link:focus-visible) {
  outline: 1px solid var(--fg);
  outline-offset: -1px;
}

/* One table across every row: glyph, the request (the only flexible column,
   so a long title ellipsizes instead of crowding the numbers), then fixed
   columns for phases, duration, tokens, cost and start. The numbers sit
   centred between the row's two lines; the glyph sits on the title line. */
.link {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 128px 8ch 9ch 7ch 5ch;
  grid-template-areas: 'glyph body dots runtime tokens cost time';
  align-items: center;
  column-gap: 16px;
  min-width: 0;
  padding: 12px 0 12px 8px;
  color: inherit;
  text-decoration: none;
}

/* The row draws the cursor; the link does not add a second ring inside it. */
.link:focus-visible {
  outline: none;
}

.glyph {
  grid-area: glyph;
  align-self: start;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  color: var(--faint);
}

.glyph.failed {
  color: var(--fail);
}

.glyph.running {
  color: var(--live);
}

.glyph.recovered {
  color: var(--fg);
}

.body {
  grid-area: body;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.5;
}

.sub {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  color: var(--dim);
  white-space: nowrap;
}

.meta-short {
  display: none;
}

.meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--faint);
}

/* The exception note leads the line so an ellipsis never eats it. */
.note {
  flex: none;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
  color: var(--dim);
}

.note.failed {
  color: var(--fail);
}

.fresh {
  flex: none;
  font-style: italic;
}

/* A passing receipt: the one verdict glyph in the meta line. Ink, not green:
   the list colours exceptions only; green stays inside the receipt and its bands. */
.verified {
  flex: none;
  display: inline-flex;
  align-self: center;
  color: var(--fg);
}

.note.running {
  color: var(--live);
  font-style: italic;
}

/* Phases start at the column's left edge so the dots line up row to row;
   a "+N" tail trails them instead of pushing them about. */
.c-dots {
  grid-area: dots;
  display: flex;
  min-width: 0;
  overflow: hidden;
}

/* Desktop: duration and start are two table cells; the wrapper only exists
   for the narrow layout, where they share the line under the request. */
.when {
  display: contents;
}

.runtime,
.time,
.c-tokens,
.c-cost {
  white-space: nowrap;
  text-align: right;
  line-height: 1.5;
}

.runtime {
  grid-area: runtime;
}

.time {
  grid-area: time;
}

.c-tokens {
  grid-area: tokens;
  color: var(--faint);
}

.c-cost {
  grid-area: cost;
  color: var(--faint);
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.dim {
  color: var(--dim);
}

/* Peek and mark reviewed live outside the row link, so a click on them can
   never navigate. Faint until the row is hot; always reachable by keyboard. */
.acts {
  display: flex;
  justify-content: center;
  gap: 4px;
}

.act {
  justify-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  color: var(--faint);
  cursor: pointer;
  opacity: 0;
}

.row:hover .act,
.row.focused .act,
.act:focus-visible,
.act.act-peek[aria-pressed='true'] {
  opacity: 1;
}

/* The open peek is a selection: ink, never an accent. */
.act.act-peek[aria-pressed='true'] {
  border-color: var(--rule);
  color: var(--fg);
}

.act:hover,
.act:focus-visible {
  border-color: var(--rule);
  color: var(--accent);
}

/* Red on hover is the archive action's exception; the peek stays ink. */
.act.act-peek:hover,
.act.act-peek:focus-visible {
  color: var(--fg);
}

.act-gap {
  width: 36px;
}

/* The columns answer to the row's own width, not the window's, so the list
   beside an open peek steps down the same way a narrow window does. */
@container run-row (max-width: 1000px) {
  .link {
    grid-template-columns: 22px minmax(0, 1fr) 128px 8ch 5ch;
    grid-template-areas: 'glyph body dots runtime time';
  }

  .c-tokens,
  .c-cost {
    display: none;
  }
}

@container run-row (max-width: 780px) {
  .link {
    grid-template-columns: 22px minmax(0, 1fr) 8ch 5ch;
    grid-template-areas: 'glyph body runtime time';
  }

  .c-dots {
    display: none;
  }
}

/* Narrow: the request may take two lines rather than lose its tail, and
   duration and start move under it. */
@container run-row (max-width: 600px) {
  .link {
    grid-template-columns: 22px minmax(0, 1fr);
    grid-template-areas:
      'glyph body'
      '. when';
    row-gap: 2px;
    padding-left: 0;
  }

  .when {
    grid-area: when;
    display: flex;
    gap: 10px;
  }

  .runtime,
  .time {
    grid-area: auto;
    text-align: left;
  }

  .when .time::before {
    content: '· ';
  }

  .meta-full {
    display: none;
  }

  .meta-short {
    display: inline;
  }

  .note {
    max-width: none;
  }

  .title {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    white-space: normal;
    line-height: 1.35;
  }
}

@media (hover: none) {
  .act {
    opacity: 1;
  }
}

/* Touch: interactive targets reach 44px on phone glass. */
@media (max-width: 640px) {
  .row {
    grid-template-columns: minmax(0, 1fr) 44px;
  }

  /* A tap opens the run itself; the full-screen peek would only repeat it. */
  .act.act-peek {
    display: none;
  }

  .act {
    width: 44px;
    height: 44px;
  }

  .act-gap {
    width: 44px;
  }
}
</style>
