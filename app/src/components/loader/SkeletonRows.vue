<script setup lang="ts">
import './skeleton.css'
import { useAnnouncement } from '../../lib/loader'

// Runs list rows before the first answer: SessionRow's own column grid
// (glyph, title + muted line, phases, duration, tokens, cost, start, actions)
// with bars in the real line boxes, so rows land without a shift.
const props = withDefaults(
  defineProps<{
    rows?: number
    /** What the status region says while the bars stand in (the bars themselves are hidden from assistive tech). */
    label?: string
  }>(),
  { rows: 6, label: 'Loading runs…' },
)
const said = useAnnouncement(() => props.label)

// Fixed, varied title widths: a column of identical bars reads as a table rule.
const TITLE = [62, 48, 71, 39, 56, 66, 44, 58]
const META = [38, 30, 44, 26, 35, 41, 29, 33]
</script>

<template>
  <div class="sk-list">
    <span class="sk-sr" role="status">{{ said }}</span>
    <h2 class="g-head" aria-hidden="true"><span class="sk-bar" style="width: 5.5em" /></h2>
    <div v-for="i in rows" :key="i" class="row" :class="{ striped: i % 2 === 0 }" aria-hidden="true">
      <span class="link">
        <span class="glyph"><span class="sk-bar dot" /></span>
        <span class="body">
          <span class="sk-line title"><span class="sk-bar" :style="{ width: `${TITLE[(i - 1) % TITLE.length]}%` }" /></span>
          <span class="sk-line sub"><span class="sk-bar" :style="{ width: `${META[(i - 1) % META.length]}%` }" /></span>
        </span>
        <span class="c-dots"><span v-for="d in 3 + (i % 2)" :key="d" class="sk-bar pip" /></span>
        <span class="sk-line num runtime"><span class="sk-bar" style="width: 5ch" /></span>
        <span class="sk-line num c-tokens"><span class="sk-bar" style="width: 6ch" /></span>
        <span class="sk-line num c-cost"><span class="sk-bar" style="width: 4ch" /></span>
        <span class="sk-line num time"><span class="sk-bar" style="width: 4ch" /></span>
      </span>
      <span class="acts" />
    </div>
  </div>
</template>

<style scoped>
/* Mirrors .list / .g-head in SessionsList and .row / .link in SessionRow. Keep in step with them. */
.sk-list {
  margin: 8px 0 24px;
}

.g-head {
  margin: 0;
  padding: 14px 0 6px;
  border-bottom: 1px solid var(--rule);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 84px;
  align-items: center;
  column-gap: 8px;
  border-bottom: 1px solid var(--rule-soft);
  container-type: inline-size;
  container-name: sk-row;
}

.row:last-child {
  border-bottom-color: transparent;
}

.row.striped {
  background: var(--stripe);
}

.link {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 128px 8ch 9ch 7ch 5ch;
  grid-template-areas: 'glyph body dots runtime tokens cost time';
  align-items: center;
  column-gap: 16px;
  min-width: 0;
  padding: 12px 0 12px 8px;
  font-family: var(--mono);
}

.glyph {
  grid-area: glyph;
  align-self: start;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
}

.dot {
  width: 14px;
  height: 14px;
}

.body {
  grid-area: body;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  font-family: var(--sans);
}

.title {
  font-size: 17px;
}

.sub {
  font-size: 16px;
}

.c-dots {
  grid-area: dots;
  display: flex;
  gap: 6px;
}

.pip {
  width: 22px;
  height: 8px;
}

.num {
  text-align: right;
}

.runtime {
  grid-area: runtime;
}

.c-tokens {
  grid-area: tokens;
}

.c-cost {
  grid-area: cost;
}

.time {
  grid-area: time;
}

@container sk-row (max-width: 1000px) {
  .link {
    grid-template-columns: 22px minmax(0, 1fr) 128px 8ch 5ch;
    grid-template-areas: 'glyph body dots runtime time';
  }

  .c-tokens,
  .c-cost {
    display: none;
  }
}

@container sk-row (max-width: 780px) {
  .link {
    grid-template-columns: 22px minmax(0, 1fr) 8ch 5ch;
    grid-template-areas: 'glyph body runtime time';
  }

  .c-dots {
    display: none;
  }
}

@container sk-row (max-width: 600px) {
  .link {
    grid-template-columns: 22px minmax(0, 1fr);
    grid-template-areas:
      'glyph body'
      '. when';
    row-gap: 2px;
    padding-left: 0;
  }

  /* Duration · start move under the request, as in the real row. */
  .runtime {
    grid-area: when;
    text-align: left;
  }

  .time {
    display: none;
  }
}

@media (max-width: 640px) {
  .row {
    grid-template-columns: minmax(0, 1fr) 44px;
  }
}
</style>
