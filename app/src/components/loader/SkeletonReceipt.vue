<script setup lang="ts">
import './skeleton.css'
import { useAnnouncement } from '../../lib/loader'

// The bars are hidden from assistive tech; a status region says what is coming.
const said = useAnnouncement(() => 'Loading the receipt…')

// The receipt before its run answers: the verdict banner (mark, headline, sub
// line) and the facts list with its real keys. Mirrors VerdictBanner and ReceiptFacts.
const FACTS: [string, number][] = [
  ['Repo', 48],
  ['Run', 22],
  ['Chain', 30],
  ['Commit', 14],
  ['Tree', 16],
]
</script>

<template>
  <div class="sk-receipt">
    <span class="sk-sr" role="status">{{ said }}</span>
    <section class="banner" aria-hidden="true">
      <span class="mark" />
      <div class="meta">
        <span class="sk-line headline"><span class="sk-bar" style="width: min(30ch, 80%)" /></span>
        <span class="sk-line sub"><span class="sk-bar" style="width: min(26ch, 60%)" /></span>
      </div>
    </section>
    <dl class="kv" aria-hidden="true">
      <template v-for="[k, w] in FACTS" :key="k">
        <dt>{{ k }}</dt>
        <dd><span class="sk-bar" :style="{ width: `${w}%` }" /></dd>
      </template>
    </dl>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 8px 0 22px;
}

.mark {
  flex: none;
  width: 36px;
  height: 36px;
  margin-top: 2px;
  border: 2px solid var(--rule);
  border-radius: var(--radius);
}

.meta {
  flex: 1;
  min-width: 0;
}

.headline {
  font-size: 28px;
  line-height: 1.2;
}

.sub {
  margin-top: 6px;
}

.kv {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  margin: 0 0 8px;
  border-top: 1px solid var(--rule);
}

dt,
dd {
  margin: 0;
  padding: 8px 0;
  border-bottom: 1px solid var(--rule-soft);
  min-width: 0;
  display: flex;
  align-items: center;
  min-height: 41px;
}

dt {
  color: var(--dim);
}

@media (max-width: 560px) {
  .headline {
    font-size: 22px;
  }
}
</style>
