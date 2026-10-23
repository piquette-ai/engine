<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Phase, Session } from '../lib/types'
import {
  buildSessionSummaryInput,
  checkAvailability,
  generateSummary,
  getCachedSummary,
  isSummarizerNamespacePresent,
  setCachedSummary,
  summaryCacheKey,
} from '../lib/summarizer'
import { renderMarkdown } from '../lib/markdown'

const props = defineProps<{ adwId: string; session: Session; phases: Phase[] }>()
// Tells the trace whether to show the on-device assistant card at all.
const emit = defineEmits<{ available: [boolean] }>()

type State = 'idle' | 'generating' | 'ready' | 'error'

// Gated on availability(), not just the namespace check — a browser that
// ships Summarizer but can't actually run it (no on-device model, etc.)
// should look exactly like one that never shipped it: no visual trace.
const visible = ref(false)
const state = ref<State>('idle')
const html = ref('')
const downloadPct = ref<number | null>(null)
const errorMessage = ref<string | null>(null)
// The key the currently-shown summary was generated for — not a ref, since
// nothing needs to render off it directly (see `stale` below).
let shownKey: string | null = null
// Lets a component unmount (navigating away mid-generation) cancel the
// in-flight create()/summarize() instead of leaving the on-device model
// running for a view nobody's looking at.
let abortController: AbortController | null = null

onMounted(async () => {
  if (!isSummarizerNamespacePresent()) return
  try {
    visible.value = (await checkAvailability()) !== 'unavailable'
  } catch {
    visible.value = false
  }
  emit('available', visible.value)
})

onUnmounted(() => {
  abortController?.abort()
})

// null while the card isn't shown (no API, or availability() said no) — SessionTrace
// hands in fresh session/phases objects every 500ms tick, so without this
// gate the input text and its hash would get rebuilt on every tick for a
// feature that's invisible or, in Chrome, not yet opened.
const summaryText = computed(() =>
  visible.value ? buildSessionSummaryInput({ session: props.session, phases: props.phases }) : null,
)

const cacheKey = computed(() =>
  summaryText.value ? summaryCacheKey(props.adwId, summaryText.value.full) : null,
)

// A summary already generated for this exact session content (e.g. the trace
// was left and revisited) shows immediately, with no regeneration. When the
// session moves on to a new key, the last summary just stays put — `stale`
// below is the only hint anything changed; regenerating is the user's call.
watch(
  cacheKey,
  (key) => {
    if (key == null || key === shownKey || state.value === 'generating') return
    const cached = getCachedSummary(key)
    if (cached) {
      html.value = renderMarkdown(cached)
      shownKey = key
      state.value = 'ready'
    }
  },
  { immediate: true },
)

const stale = computed(() => state.value === 'ready' && cacheKey.value !== shownKey)

/**
 * Fired directly from the "generate"/"regenerate" click — must stay the
 * synchronous continuation of that click, since Summarizer.create() requires
 * user activation and nothing here awaits anything before it.
 */
async function generate() {
  const key = cacheKey.value
  const text = summaryText.value?.input
  if (key == null || text == null) return
  state.value = 'generating'
  downloadPct.value = null
  errorMessage.value = null
  abortController = new AbortController()
  try {
    const summary = await generateSummary(
      text,
      (m) => {
        m.addEventListener('downloadprogress', (e) => {
          downloadPct.value = Math.round(e.loaded * 100)
        })
      },
      abortController.signal,
    )
    setCachedSummary(key, summary)
    html.value = renderMarkdown(summary)
    shownKey = key
    state.value = 'ready'
  } catch (err) {
    state.value = 'error'
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    downloadPct.value = null
    abortController = null
  }
}
</script>

<template>
  <section v-if="visible" class="as-block" aria-labelledby="as-summary-head">
    <h3 id="as-summary-head" class="as-head">Summary</h3>

    <template v-if="state === 'idle'">
      <p class="as-note">Key points of this run, written on-device. Nothing leaves the browser.</p>
      <button class="as-btn" type="button" @click="generate">Generate summary</button>
    </template>

    <p v-else-if="state === 'generating'" class="as-note" aria-live="polite">
      {{ downloadPct != null ? `Downloading the model… ${downloadPct}%` : 'Writing the summary…' }}
    </p>

    <template v-else-if="state === 'ready'">
      <!-- Safe: renderMarkdown escapes ALL input before emitting its own tags. -->
      <div class="md" v-html="html" />
      <p v-if="stale" class="as-note">The run has moved on since this summary.</p>
      <button class="as-btn" type="button" @click="generate">Regenerate</button>
    </template>

    <template v-else>
      <p class="as-note" :title="errorMessage ?? undefined">The summary couldn't be written.</p>
      <button class="as-btn" type="button" @click="generate">Try again</button>
    </template>
  </section>
</template>

<style scoped>
/* One block of the sidebar's assistant card: a sentence-case head, a note,
   and an action word. The card's frame belongs to the trace. */
.as-head {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 700;
  color: var(--fg);
}

.as-note {
  margin: 0 0 10px;
  color: var(--dim);
}

.as-btn {
  padding: 3px 12px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: none;
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}

.as-btn:hover,
.as-btn:focus-visible {
  border-color: var(--accent);
}

.md {
  margin-bottom: 10px;
}

/* Touch: interactive targets reach 44px on phone glass. */
@media (max-width: 640px) {
  .as-btn {
    min-height: 44px;
  }
}
</style>
