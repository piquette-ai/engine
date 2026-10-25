<script setup lang="ts">
import './skeleton.css'
import { useAnnouncement } from '../../lib/loader'

// The bars are hidden from assistive tech; a status region says what is coming.
const said = useAnnouncement(() => 'Loading the run…')

// The run page before the first answer: the header (title, meta line) and the
// grid of the Steps list beside the Details card. The card prints its real
// keys (they never change); only the values wait. Mirrors SessionTrace.
const KEYS = ['Repository', 'Chain', 'Engineer', 'Started', 'Duration', 'Cost', 'Tokens', 'Read', 'Written', 'Issue', 'Pull request', 'Run id']
const VALS = [70, 55, 40, 62, 35, 30, 38, 34, 30, 28, 32, 50]
const STEPS = [
  [22, 64],
  [18, 40],
  [24, 82],
  [16, 30],
]
</script>

<template>
  <div class="sk-run">
    <span class="sk-sr" role="status">{{ said }}</span>
    <header class="run-head" aria-hidden="true">
      <span class="sk-line run-title"><span class="sk-bar" style="width: min(46ch, 70%)" /></span>
      <span class="sk-line run-meta"><span class="sk-bar" style="width: min(40ch, 85%)" /></span>
    </header>
    <div class="run-grid" aria-hidden="true">
      <div class="run-main">
        <div class="phases-bar">
          <span class="sec-head">Phases</span>
        </div>
        <div class="steps">
          <div v-for="(s, i) in STEPS" :key="i" class="step">
            <span class="sk-bar dot" />
            <span class="sk-line"><span class="sk-bar" :style="{ width: `${s[0]}ch` }" /></span>
            <span class="track"><span class="sk-bar bar" :style="{ width: `${s[1]}%`, marginLeft: `${i * 6}%` }" /></span>
            <span class="sk-line num"><span class="sk-bar" style="width: 5ch" /></span>
          </div>
        </div>
      </div>
      <aside class="run-side">
        <section class="side-card">
          <h2 class="side-head">Details</h2>
          <dl class="kv">
            <div v-for="(k, i) in KEYS" :key="k">
              <dt>{{ k }}</dt>
              <dd class="sk-line"><span class="sk-bar" :style="{ width: `${VALS[i]}%` }" /></dd>
            </div>
          </dl>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* Mirrors the header, grid and side card in SessionTrace. Keep in step with it. */
.run-head {
  margin-bottom: 24px;
}

.run-title {
  font-size: 24px;
  line-height: 1.3;
}

.run-meta {
  margin-top: 10px;
}

.run-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 32px;
  align-items: start;
}

.run-main {
  min-width: 0;
}

.phases-bar {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
  min-height: 32px;
}

.sec-head {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--faint);
}

.step {
  display: grid;
  grid-template-columns: 22px 14ch minmax(0, 1fr) 7ch;
  align-items: center;
  gap: 14px;
  padding: 12px 0;
  border-bottom: 1px solid var(--rule-soft);
}

.dot {
  width: 14px;
  height: 14px;
}

.track {
  display: block;
}

.bar {
  height: 4px;
  display: block;
}

.num {
  text-align: right;
  font-family: var(--mono);
}

.side-card {
  padding: 14px 16px 16px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--face);
}

.side-head {
  margin: 0 0 10px;
  font-size: 17px;
  font-weight: 700;
}

.kv {
  margin: 0;
}

.kv > div {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 12px;
  padding: 5px 0;
  border-top: 1px solid var(--rule-soft);
}

.kv > div:first-child {
  border-top: none;
}

.kv dt {
  color: var(--dim);
}

.kv dd {
  margin: 0;
  min-width: 0;
}

/* On the raised card the bar takes the sunk tone on both themes. */
.side-card .sk-bar {
  background: var(--inset);
}

@media (max-width: 1100px) {
  .run-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .run-title {
    font-size: 20px;
  }

  .step {
    grid-template-columns: 22px 10ch minmax(0, 1fr) 6ch;
  }
}
</style>
