<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId } from 'vue'
import { Info } from 'lucide-vue-next'

/** A faint "what is this?" mark for words a first-time reader may not know. Click (or Enter/Space) toggles a hairline popover, Esc or an outside tap closes it. */
defineProps<{ text: string; label: string }>()

const id = useId()
const open = ref(false)
const btn = ref<HTMLButtonElement | null>(null)
const pop = ref<HTMLElement | null>(null)
const pos = ref({ top: 0, left: 0 })

function place() {
  const b = btn.value?.getBoundingClientRect()
  if (!b) return
  const w = Math.min(300, window.innerWidth - 32)
  const left = Math.max(16, Math.min(b.left + b.width / 2 - w / 2, window.innerWidth - w - 16))
  pos.value = { top: b.bottom + 6, left }
  // Flip above the mark when the popover would run past the bottom edge.
  void nextTick(() => {
    const h = pop.value?.offsetHeight ?? 0
    if (b.bottom + 6 + h > window.innerHeight - 16 && b.top - 6 - h >= 16) pos.value = { top: b.top - 6 - h, left }
  })
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  // Capture phase: closing the hint must not also close a peek or clear a search behind it.
  e.stopPropagation()
  close()
  btn.value?.focus()
}
function onDown(e: Event) {
  const t = e.target as Node
  if (pop.value?.contains(t) || btn.value?.contains(t)) return
  close()
}

function close() {
  open.value = false
  document.removeEventListener('keydown', onKey, true)
  document.removeEventListener('pointerdown', onDown, true)
  window.removeEventListener('resize', close)
  window.removeEventListener('scroll', onScroll, true)
}

function onScroll(e: Event) {
  if (pop.value && e.target instanceof Node && pop.value.contains(e.target)) return
  close()
}

/** Tabbing away from the mark closes the hint. */
function onFocusOut(e: FocusEvent) {
  const t = e.relatedTarget as Node | null
  if (t && pop.value?.contains(t)) return
  close()
}

function toggle() {
  if (open.value) return close()
  open.value = true
  place()
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onDown, true)
  window.addEventListener('resize', close)
  window.addEventListener('scroll', onScroll, true)
}

onBeforeUnmount(close)
</script>

<template>
  <span class="hint">
    <button
      ref="btn"
      type="button"
      class="hint-btn"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="open ? id : undefined"
      :aria-describedby="open ? id : undefined"
      @focusout="onFocusOut"
      @click.stop.prevent="toggle"
    >
      <Info :size="16" :stroke-width="2" aria-hidden="true" />
    </button>
    <!-- Teleported so no ancestor transform or filter can become the fixed popover's containing block. -->
    <Teleport to="body">
      <span v-if="open" :id="id" ref="pop" class="hint-pop" role="note" :style="{ top: `${pos.top}px`, left: `${pos.left}px` }">{{ text }}</span>
    </Teleport>
  </span>
</template>

<style scoped>
.hint {
  display: inline-flex;
  vertical-align: -0.2em;
}

/* The mark stays 16px; padding and a matching negative margin grow the hit area. */
.hint-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  margin: -6px 0;
  background: none;
  border: none;
  border-radius: var(--radius);
  color: var(--faint);
  font: inherit;
  cursor: pointer;
}

.hint-btn:hover,
.hint-btn[aria-expanded='true'] {
  color: var(--fg);
}

.hint-pop {
  position: fixed;
  z-index: 60;
  width: min(300px, calc(100vw - 32px));
  padding: 10px 12px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--face);
  color: var(--fg);
  font-size: 16px;
  font-weight: 400;
  letter-spacing: normal;
  line-height: 1.45;
  text-transform: none;
  white-space: normal;
}

@media (max-width: 640px) {
  .hint-btn {
    padding: 14px;
    margin: -14px -6px;
  }
}
</style>
