<script setup lang="ts">
import { nextTick, onUnmounted, ref } from 'vue'
import { FIGURE_FOR, useLoadingTier, type LoaderJob } from '../../lib/loader'
import { setTheme, theme, type ThemeChoice } from '../../lib/theme'
import Loader from './Loader.vue'
import SkeletonReceipt from './SkeletonReceipt.vue'
import SkeletonRows from './SkeletonRows.vue'
import SkeletonRun from './SkeletonRun.vue'

// #/_/loaders (dev server only): the reference for the loader family. Each
// figure with its job and the states it draws, the tier rule to try, the
// skeletons, and links that slow the real pages down to watch them in place.

const progress = ref(42)

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]

interface Member {
  job: LoaderJob
  title: string
  blurb: string
  used: string[]
  label: string
  detail?: string
  progress?: boolean
  still?: string
}

const FAMILY: Member[] = [
  {
    job: 'run',
    title: 'Relay',
    blurb: 'A run or a receipt loading. Three stations; only the current one is lit, and the light hands off along the wire like a phase.',
    used: ['Run page, first load', 'Receipt, first load'],
    label: 'Loading the run',
    detail: '3 phases',
  },
  {
    job: 'progress',
    title: 'Stack',
    blurb: 'Real, measured progress. Four floors light bottom to top as the percentage climbs, the wire drawn hot up the riser. It never loops.',
    used: ['Summary, model download', 'Ask, model download'],
    label: 'Downloading the on-device model',
    progress: true,
  },
  {
    job: 'wait',
    title: 'Conveyor',
    blurb: 'Every other wait, and the still mark on empty states. Four stations fill along the line and stay lit until it resets.',
    used: ['Runs list, first load', 'Runs list, empty state'],
    label: 'Loading the runs list',
    still: 'No runs yet',
  },
]

// ── tier simulator ──
const simLoading = ref(false)
const simTier = useLoadingTier(simLoading)
const simMs = ref<number | null>(null)
const simElapsed = ref(0)
const simDone = ref<number | null>(null)
let simEnd: ReturnType<typeof setTimeout> | undefined
let simTick: ReturnType<typeof setInterval> | undefined

async function simulate(ms: number | null) {
  clearTimeout(simEnd)
  clearInterval(simTick)
  simLoading.value = false
  simDone.value = null
  await nextTick()
  simMs.value = ms
  simElapsed.value = 0
  simLoading.value = true
  const start = performance.now()
  simTick = setInterval(() => (simElapsed.value = performance.now() - start), 100)
  if (ms != null) simEnd = setTimeout(() => stopSim(ms), ms)
}
function stopSim(ms?: number) {
  clearTimeout(simEnd)
  clearInterval(simTick)
  if (!simLoading.value) return
  simLoading.value = false
  simDone.value = ms ?? simElapsed.value
}
onUnmounted(() => stopSim())

const SIMS: { ms: number | null; label: string }[] = [
  { ms: 200, label: '200ms wait' },
  { ms: 1200, label: '1.2s wait' },
  { ms: 4000, label: '4s wait' },
  { ms: null, label: 'Unknown wait' },
]
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

// ── in place: every API answer held 2.5s (?latency, dev server only) ──
const root = window.location.pathname.replace(/r\/[^/]+\/?$/, '')
const LATENCY = '?latency=2500'
const LINKS = [
  { label: 'Runs list, first load', figure: FIGURE_FOR.wait, href: `${root}${LATENCY}#/` },
  { label: 'Run page', figure: FIGURE_FOR.run, href: `${root}${LATENCY}#/a1b2c3d4` },
  { label: 'Receipt', figure: FIGURE_FOR.run, href: `${root}r/7ec31b90${LATENCY}` },
]
</script>

<template>
  <div class="gallery page">
    <header class="g-intro">
      <h1 class="g-title">Loaders</h1>
      <p class="lede">
        One family of isometric factory-line figures in hairlines, one figure per job. The job picks the figure at the call site
        (<code>&lt;Loader job="run"&gt;</code>); the reader never chooses. Under 300ms a wait shows nothing, to 2s a skeleton shaped
        like the page, and past 2s (or when the wait is unknown) the figure takes over.
      </p>
    </header>

    <section class="controls" aria-label="Preview settings">
      <div class="ctl">
        <span id="ctl-theme" class="ctl-key" title="Sets the app theme, the same saved choice as the header toggle">App theme</span>
        <div class="seg" role="radiogroup" aria-labelledby="ctl-theme">
          <button
            v-for="t in THEMES"
            :key="t.id"
            type="button"
            role="radio"
            :aria-checked="theme === t.id"
            :class="{ on: theme === t.id }"
            @click="setTheme(t.id)"
          >
            {{ t.label }}
          </button>
        </div>
      </div>
      <label class="ctl">
        <span class="ctl-key">Progress</span>
        <input v-model.number="progress" class="range" type="range" min="0" max="100" step="1" />
        <span class="mono ctl-val">{{ progress }}%</span>
      </label>
    </section>
    <p class="note">
      Reduced motion (system setting) lights every station and stops the pulse. Paper draws lit stations flat; the board adds a soft
      bloom.
    </p>

    <section class="block" aria-labelledby="h-family">
      <h2 id="h-family" class="sec-head">The family</h2>
      <div class="v-head" aria-hidden="true">
        <span>Figure and job</span>
        <span>Mark</span>
        <span>Inline, beside text</span>
        <span>Still, empty state</span>
      </div>
      <article v-for="m in FAMILY" :key="m.job" class="v-row">
        <div class="v-name">
          <h3 class="v-title">{{ m.title }} <code class="job">job="{{ m.job }}"</code></h3>
          <p class="v-blurb">{{ m.blurb }}</p>
          <ul class="used">
            <li v-for="u in m.used" :key="u">{{ u }}</li>
          </ul>
        </div>
        <div class="cell">
          <span class="cell-cap">{{ m.progress ? `Mark, progress ${progress}%` : 'Mark' }}</span>
          <Loader :job="m.job" :label="m.label" :detail="m.progress ? `${progress}%` : m.detail" :progress="m.progress ? progress : null" />
        </div>
        <div class="cell">
          <span class="cell-cap">Inline</span>
          <Loader
            :job="m.job"
            size="inline"
            :label="m.progress ? 'Model' : m.label"
            :detail="m.progress ? `${progress}%` : m.detail"
            :progress="m.progress ? progress : null"
          />
        </div>
        <div class="cell" :class="{ unused: !m.still }">
          <span class="cell-cap">Still</span>
          <Loader v-if="m.still" :job="m.job" still :label="m.still" />
          <span v-else class="na">Not used</span>
        </div>
      </article>
    </section>

    <section class="block" aria-labelledby="h-tiers">
      <h2 id="h-tiers" class="sec-head">The tier rule</h2>
      <ul class="tiers">
        <li><span class="mono tier-k">&lt; 300ms</span> Nothing. A flash of anything reads as a flicker.</li>
        <li><span class="mono tier-k">0.3–2s</span> A skeleton shaped like the real layout, so the page does not jump when it lands.</li>
        <li>
          <span class="mono tier-k">&gt; 2s</span> The brand figure for the job, with plain words for what is loading. Real progress
          skips the skeleton (<code>useLoadingTier(…, { skeleton: false })</code>).
        </li>
      </ul>
      <p class="note">Start a fake wait and watch what the reader would see. The runs list, run page and receipt use this same rule.</p>
      <div class="sims">
        <button v-for="s in SIMS" :key="s.label" type="button" class="act" @click="simulate(s.ms)">{{ s.label }}</button>
        <button type="button" class="act" :disabled="!simLoading" @click="stopSim()">Finish now</button>
      </div>
      <p class="mono readout" aria-live="polite">
        <template v-if="simLoading">showing: {{ simTier === 'none' ? 'nothing yet' : simTier }} · {{ secs(simElapsed) }}{{ simMs == null ? ' of ?' : ` of ${secs(simMs)}` }}</template>
        <template v-else-if="simDone != null">loaded after {{ secs(simDone) }}</template>
        <template v-else>idle</template>
      </p>
      <div class="sim-frame">
        <SkeletonRows v-if="simTier === 'skeleton'" :rows="3" />
        <div v-else-if="simTier === 'brand'" class="sim-brand"><Loader job="wait" label="Loading the runs list" /></div>
        <p v-else-if="simDone != null" class="sim-done">The data would be here.</p>
      </div>
    </section>

    <section class="block" aria-labelledby="h-skeletons">
      <h2 id="h-skeletons" class="sec-head">Skeletons</h2>
      <h3 class="sk-cap">Runs list</h3>
      <div class="frame"><SkeletonRows :rows="4" /></div>
      <h3 class="sk-cap">Run page</h3>
      <div class="frame"><SkeletonRun /></div>
      <h3 class="sk-cap">Receipt</h3>
      <div class="frame"><div class="receipt-col"><SkeletonReceipt /></div></div>
    </section>

    <section class="block" aria-labelledby="h-place">
      <h2 id="h-place" class="sec-head">In place</h2>
      <p class="note">
        These open the real pages with every API answer held 2.5s (<code>?latency=</code>, dev server only): a skeleton first, then
        the figure for that page's job.
      </p>
      <ul class="links">
        <li v-for="l in LINKS" :key="l.href">
          <a :href="l.href">{{ l.label }}</a> <span class="faint">{{ l.figure }}</span> <code>{{ l.href }}</code>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.gallery {
  padding-top: 24px;
  padding-bottom: 64px;
}

.g-title {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
}

.lede {
  max-width: 72ch;
  margin: 8px 0 0;
  color: var(--dim);
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 28px;
  margin-top: 24px;
  padding: 14px 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}

.ctl {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ctl-key {
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  color: var(--faint);
}

.ctl-val {
  min-width: 4ch;
  text-align: right;
}

.mono,
code {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

/* Segmented control: squared cells on one hairline; the selected cell inverts. */
.seg {
  display: inline-flex;
  flex-wrap: wrap;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.seg button {
  min-height: 36px;
  padding: 4px 14px;
  border: none;
  border-radius: 0;
  background: none;
  color: var(--dim);
  font: inherit;
  cursor: pointer;
}

.seg button + button {
  border-left: 1px solid var(--rule);
}

.seg button:hover {
  color: var(--fg);
}

.seg button.on {
  background: var(--fg);
  color: var(--ground);
}

.range {
  width: 180px;
  accent-color: var(--live);
}

.note {
  max-width: 80ch;
  margin: 12px 0 0;
  color: var(--dim);
}

.block {
  margin-top: 40px;
}

.sec-head {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 700;
}

/* The family as one table: a name column, then four hairline cells. */
.v-head,
.v-row {
  display: grid;
  grid-template-columns: 260px repeat(3, minmax(0, 1fr));
}

.v-head {
  padding: 8px 0 6px;
  border-bottom: 1px solid var(--rule);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  color: var(--faint);
}

.v-head > span {
  padding-inline: 16px;
}

.v-row {
  border-bottom: 1px solid var(--rule-soft);
}

.v-name {
  padding: 24px 16px 24px 0;
}

.v-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}

.v-blurb {
  margin: 6px 0 12px;
  color: var(--dim);
}

.job {
  margin-left: 6px;
  font-size: 16px;
  font-weight: 400;
  color: var(--faint);
}

.used {
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--fg);
}

.used li::before {
  content: '— ';
  color: var(--faint);
}

.na,
.faint {
  color: var(--faint);
}

.tiers {
  max-width: 80ch;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.tiers li {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  padding: 8px 0;
  border-bottom: 1px solid var(--rule-soft);
}

.tier-k {
  min-width: 8ch;
  font-weight: 600;
}

.cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  min-width: 0;
  padding: 28px 12px;
  border-left: 1px solid var(--rule-soft);
}

.cell-cap {
  display: none;
  align-self: flex-start;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  color: var(--faint);
}

.act {
  min-height: 36px;
  padding: 4px 14px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: none;
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}

.act:hover:not(:disabled) {
  border-color: var(--accent);
}

.act:disabled {
  color: var(--faint);
  cursor: default;
}

.sims {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.readout {
  margin: 12px 0 0;
  color: var(--dim);
}

.sim-frame {
  min-height: 260px;
  margin-top: 12px;
  padding: 0 16px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.sim-brand {
  display: flex;
  justify-content: center;
  padding: 48px 0;
}

.sim-done {
  margin: 0;
  padding: 48px 0;
  text-align: center;
  color: var(--dim);
}

.sk-cap {
  margin: 20px 0 8px;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  color: var(--faint);
}

.frame {
  padding: 16px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  overflow: hidden;
}

.receipt-col {
  max-width: 820px;
  margin-inline: auto;
}

.links {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.links li {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--rule-soft);
}

.links a {
  color: var(--live);
  font-weight: 600;
}

.links code {
  color: var(--faint);
  overflow-wrap: anywhere;
}

@media (max-width: 1100px) {
  .v-head {
    display: none;
  }

  .v-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .v-name {
    grid-column: 1 / -1;
    padding-bottom: 0;
  }

  .cell {
    border-left: none;
    border-top: 1px solid var(--rule-soft);
  }

  .cell:nth-child(odd) {
    border-left: 1px solid var(--rule-soft);
  }

  .cell-cap {
    display: block;
  }

  /* Stacked, an empty "Not used" cell is noise; the wide table keeps it for the grid. */
  .cell.unused {
    display: none;
  }
}

@media (max-width: 560px) {
  .v-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .cell:nth-child(odd) {
    border-left: none;
  }

  .seg button,
  .act {
    min-height: 44px;
  }

  .range {
    width: 140px;
  }
}
</style>
