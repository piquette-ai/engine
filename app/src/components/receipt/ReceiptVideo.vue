<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Play } from 'lucide-vue-next'
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

const items = computed<Record<Bay, ReceiptEvidenceItem | null>>(() => ({
  head: props.head,
  base: props.base,
}))
const bays = computed(() => (['head', 'base'] as Bay[]).filter((b) => items.value[b]))
const bay = ref<Bay>(items.value[props.initial] ? props.initial : (bays.value[0] ?? 'head'))
// The native <video> issues the Range requests, so seeking costs 206s, not a download.
const src = computed(() => {
  const item = items.value[bay.value]
  return item ? receiptFileUrl(props.runId, item.key, props.repo) : undefined
})
const posterUrl = computed(() =>
  props.poster ? receiptFileUrl(props.runId, props.poster.key, props.repo) : undefined,
)

const caption = computed(() =>
  bay.value === 'head'
    ? 'Recording of the journey after the change'
    : 'Recording of the journey before the change',
)

function select(which: Bay) {
  bay.value = which
}

const videoEl = ref<HTMLVideoElement | null>(null)
const started = ref(false)
const failed = ref(false)
// A different recording starts fresh: show the play control again, clear any load error.
watch(src, () => {
  started.value = false
  failed.value = false
})
function play() {
  void videoEl.value?.play().catch(() => {
    /* autoplay or decode refusal: the skin's own controls still work */
  })
}
</script>

<template>
  <figure class="rv">
    <p v-if="!bays.length" class="none">No recording was kept for this run.</p>
    <p v-else-if="failed" class="none">
      The recording could not be loaded.
      <a :href="src" target="_blank" rel="noopener">Open the video file directly</a>.
    </p>
    <div v-else class="stage">
      <video-player :poster="posterUrl">
        <video-skin class="skin">
          <video
            :key="src"
            ref="videoEl"
            :src="src"
            preload="metadata"
            playsinline
            :aria-label="caption"
            @play="started = true"
            @error="failed = true"
          ></video>
        </video-skin>
      </video-player>
      <button
        v-if="!started"
        type="button"
        class="big-play"
        aria-label="Play recording"
        @click="play"
      >
        <Play :size="28" :stroke-width="2" />
      </button>
    </div>
    <figcaption v-if="bays.length" class="cap">
      <span class="what">{{ caption }}</span>
      <span v-if="bays.length > 1" class="seg-wrap">
        <span id="rv-seg-label" class="seg-label">Showing</span>
        <span class="seg" role="group" aria-labelledby="rv-seg-label">
          <button
            v-for="b in bays"
            :key="b"
            type="button"
            class="bay"
            :aria-pressed="bay === b"
            @click="select(b)"
          >
            {{ b === 'head' ? 'After the change' : 'Before the change' }}
          </button>
        </span>
      </span>
    </figcaption>
  </figure>
</template>

<style scoped>
.rv {
  margin: 0;
}

.cap {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-top: 10px;
}

.what {
  color: var(--dim);
}

.seg-wrap {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.seg-label {
  color: var(--dim);
}

.seg {
  display: inline-flex;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.bay {
  font: inherit;
  padding: 5px 14px;
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

.stage {
  position: relative;
}

.big-play {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 72px;
  height: 72px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--ground);
  color: var(--fg);
  cursor: pointer;
}

.big-play:hover {
  background: var(--inset);
}

.skin {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius);
  overflow: hidden;
  background-color: var(--board-sunk);
  /* DESIGN.md: 2px corners, mono type; no pills. Tokens reach the skin's shadow root. */
  --media-border-radius: var(--radius);
  --media-control-radius: var(--radius);
  --media-controls-radius: var(--radius);
  --media-dialog-radius: var(--radius);
  --media-menu-item-radius: var(--radius);
  /* Solid control bar on the always-dark board tone: no translucency, no blur. */
  --media-controls: var(--board-sunk);
  --media-controls-foreground: var(--bone);
  --media-backdrop-filter-surface: none;
  --media-backdrop-filter-indicator: none;
  --media-backdrop-filter-dialog: none;
  --media-font-family: var(--mono);
  --media-accent-color: var(--fg);
  --media-accent-text-color: var(--ground);
}
</style>
