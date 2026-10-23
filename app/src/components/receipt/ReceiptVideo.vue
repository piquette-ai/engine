<script setup lang="ts">
import { computed, ref } from 'vue'
// Video.js 10 (HTML package): <video-player>/<video-skin> custom elements.
// This component is itself lazy-loaded, so the player stays out of the main bundle.
import '@videojs/html/video/player'
import '@videojs/html/video/skin'
import { receiptFileUrl } from '../../lib/api'
import type { ReceiptEvidenceItem } from '../../lib/types'

type Bay = 'head' | 'base'

const props = defineProps<{
  runId: string
  repo: string | null
  head: ReceiptEvidenceItem | null
  base: ReceiptEvidenceItem | null
  poster: ReceiptEvidenceItem | null
  initial: Bay
}>()

const items = computed<Record<Bay, ReceiptEvidenceItem | null>>(() => ({ head: props.head, base: props.base }))
const bays = computed(() => (['head', 'base'] as Bay[]).filter((b) => items.value[b]))
const bay = ref<Bay>(items.value[props.initial] ? props.initial : (bays.value[0] ?? 'head'))
// The native <video> issues the Range requests, so seeking costs 206s, not a download.
const src = computed(() => {
  const item = items.value[bay.value]
  return item ? receiptFileUrl(props.runId, item.key, props.repo) : undefined
})
const posterUrl = computed(() => (props.poster ? receiptFileUrl(props.runId, props.poster.key, props.repo) : undefined))

function select(which: Bay) {
  bay.value = which
}
</script>

<template>
  <div class="rv">
    <div v-if="bays.length > 1" class="bays" role="group" aria-label="Recording">
      <button
        v-for="b in bays"
        :key="b"
        type="button"
        class="bay"
        :aria-pressed="bay === b"
        @click="select(b)"
      >
        {{ b === 'head' ? 'head (the change)' : 'base (before)' }}
      </button>
    </div>
    <p v-if="!bays.length" class="none">No recording was kept for this run.</p>
    <video-player v-else :poster="posterUrl">
      <video-skin class="skin">
        <video :key="src" :src="src" preload="metadata" playsinline></video>
      </video-skin>
    </video-player>
  </div>
</template>

<style scoped>
.rv {
  max-width: 960px;
}

.bays {
  display: inline-flex;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  margin-bottom: 10px;
}

.bay {
  font: inherit;
  font-family: var(--mono);
  padding: 3px 12px;
  color: var(--dim);
  background: transparent;
  border: 0;
  border-radius: 0;
  cursor: pointer;
}

.bay + .bay {
  border-left: 1px solid var(--rule);
}

.bay:hover {
  color: var(--fg);
}

.bay[aria-pressed='true'] {
  background: var(--fg);
  color: var(--ground);
}

.none {
  color: var(--dim);
}

.skin {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius);
  overflow: hidden;
  background-color: #000;
  /* DESIGN.md: 2px corners, mono type; no pills. Tokens reach the skin's shadow root. */
  --media-border-radius: var(--radius);
  --media-font-family: var(--mono);
  --media-accent-color: var(--fg);
  --media-accent-text-color: var(--ground);
}
</style>
