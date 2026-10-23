<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import { Settings } from 'lucide-vue-next'
import { theme, setTheme, type ThemeChoice } from '../lib/theme'

const options: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

const open = ref(false)
const root = useTemplateRef<HTMLElement>('root')
const trigger = useTemplateRef<HTMLButtonElement>('trigger')
const panel = useTemplateRef<HTMLElement>('panel')

function close(returnFocus: boolean) {
  open.value = false
  if (returnFocus) void nextTick(() => trigger.value?.focus())
}

function onDocPointer(e: Event) {
  if (root.value && !root.value.contains(e.target as Node)) close(false)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close(true)
  }
}

function onFocusOut(e: FocusEvent) {
  const to = e.relatedTarget as Node | null
  if (open.value && to && root.value && !root.value.contains(to)) close(false)
}

// Arrow keys walk the options, like the radio group this reads as.
function onPanelKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  const btns = [...(panel.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  const at = btns.indexOf(document.activeElement as HTMLButtonElement)
  if (!btns.length) return
  e.preventDefault()
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
  btns[(at + step + btns.length) % btns.length]?.focus()
}

watch(open, (o) => {
  if (o) {
    document.addEventListener('pointerdown', onDocPointer)
    void nextTick(() => panel.value?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus())
  } else {
    document.removeEventListener('pointerdown', onDocPointer)
  }
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointer))
</script>

<template>
  <div ref="root" class="settings" @keydown="onKey" @focusout="onFocusOut">
    <button
      ref="trigger"
      type="button"
      class="settings-btn"
      aria-label="Settings"
      title="Settings"
      aria-controls="settings-panel"
      :aria-expanded="open"
      @click="open = !open"
    >
      <Settings :size="18" :stroke-width="2" />
    </button>
    <div v-if="open" id="settings-panel" ref="panel" class="settings-panel" role="group" aria-label="Color theme" @keydown="onPanelKey">
      <span class="settings-label">Theme</span>
      <button
        v-for="o in options"
        :key="o.value"
        type="button"
        class="settings-opt"
        :aria-pressed="theme === o.value"
        @click="setTheme(o.value)"
      >
        {{ o.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.settings {
  position: relative;
}

/* An action icon in the timetable's grammar: a bare glyph, faint at rest,
   hairline border and fg on hover or while open. */
.settings-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  color: var(--faint);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius);
  cursor: pointer;
}

.settings-btn:hover,
.settings-btn[aria-expanded='true'] {
  color: var(--fg);
  border-color: var(--rule);
}

/* A square hairline panel; no shadow, per the Hairline Rule. */
.settings-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 20;
  min-width: 160px;
  display: flex;
  flex-direction: column;
  background: var(--face);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.settings-label {
  padding: 8px 12px 6px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  color: var(--faint);
  border-bottom: 1px solid var(--rule-soft);
}

.settings-opt {
  font: inherit;
  text-align: left;
  padding: 8px 12px;
  color: var(--dim);
  background: transparent;
  border: 0;
  border-radius: 0;
  cursor: pointer;
}

.settings-opt + .settings-opt {
  border-top: 1px solid var(--rule-soft);
}

.settings-opt:hover {
  color: var(--fg);
  background: var(--inset);
}

.settings-opt[aria-pressed='true'] {
  background: var(--fg);
  color: var(--ground);
}

.settings-opt:focus-visible {
  outline-offset: -2px;
}

/* Touch: interactive targets reach 44px on phone glass. */
@media (max-width: 640px) {
  .settings-btn {
    width: 44px;
    height: 44px;
  }
}

/* Touch: interactive targets reach 44px on phone glass. */
@media (max-width: 640px) {
  .settings-opt {
    min-height: 44px;
    display: flex;
    align-items: center;
  }
}
</style>
