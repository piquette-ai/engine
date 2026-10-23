<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'

export interface FilterOption {
  value: string
  label: string
  count?: number | null
  title?: string
}

const props = defineProps<{
  /** "Repo", "Factory", "Status": the button reads "Repo: All". */
  label: string
  allLabel: string
  options: FilterOption[]
  selected: string[]
  /** Multi keeps the menu open and toggles; single picks one and closes. */
  multi?: boolean
}>()
const emit = defineEmits<{ change: [values: string[]] }>()

const uid = `fm-${useId()}`
const open = ref(false)
// Flips the panel to the trigger's right edge when it would run off the viewport.
const alignEnd = ref(false)
const root = useTemplateRef<HTMLElement>('root')
const trigger = useTemplateRef<HTMLButtonElement>('trigger')
const menu = useTemplateRef<HTMLElement>('menu')

const summary = computed(() => {
  if (!props.selected.length) return props.allLabel
  const names = props.selected.map((v) => props.options.find((o) => o.value === v)?.label ?? v)
  return names.length === 1 ? (names[0] as string) : `${names.length} selected`
})

function items(): HTMLButtonElement[] {
  return [...(menu.value?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])]
}

function close(returnFocus: boolean) {
  open.value = false
  if (returnFocus) void nextTick(() => trigger.value?.focus())
}

function isOn(value: string): boolean {
  return value === '' ? props.selected.length === 0 : props.selected.includes(value)
}

function pick(value: string) {
  if (value === '') emit('change', [])
  else if (props.multi) emit('change', props.selected.includes(value) ? props.selected.filter((v) => v !== value) : [...props.selected, value])
  else emit('change', [value])
  if (!props.multi) close(true)
}

function focusAt(i: number) {
  const list = items()
  if (list.length) list[(i + list.length) % list.length]?.focus()
}

function onTriggerKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    open.value = true
  }
}

function onMenuKey(e: KeyboardEvent) {
  const list = items()
  const at = list.indexOf(document.activeElement as HTMLButtonElement)
  if (e.key === 'ArrowDown') focusAt(at + 1)
  else if (e.key === 'ArrowUp') focusAt(at - 1)
  else if (e.key === 'Home') focusAt(0)
  else if (e.key === 'End') focusAt(list.length - 1)
  else if (e.key === 'Tab') return close(false)
  else return
  e.preventDefault()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation()
    close(true)
  }
}

function onDocPointer(e: Event) {
  if (root.value && !root.value.contains(e.target as Node)) close(false)
}

watch(open, (o) => {
  if (o) {
    document.addEventListener('pointerdown', onDocPointer)
    alignEnd.value = false
    void nextTick(() => {
      const r = menu.value?.getBoundingClientRect()
      if (r && r.right > document.documentElement.clientWidth - 8) alignEnd.value = true
      const list = items()
      const on = list.find((b) => b.getAttribute('aria-checked') === 'true' && b.dataset.value !== '')
      ;(on ?? list[0])?.focus()
    })
  } else {
    document.removeEventListener('pointerdown', onDocPointer)
  }
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointer))
</script>

<template>
  <div ref="root" class="fm" @keydown="onKey">
    <button
      ref="trigger"
      type="button"
      class="fm-btn"
      :class="{ active: selected.length > 0 }"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="open ? uid : undefined"
      @click="open = !open"
      @keydown="onTriggerKey"
    >
      <span class="fm-label">{{ label }}:</span>
      <span class="fm-value">{{ summary }}</span>
      <ChevronDown :size="16" :stroke-width="2" class="fm-chev" />
    </button>
    <div v-if="open" :id="uid" ref="menu" class="fm-menu" :class="{ end: alignEnd }" role="menu" :aria-label="`Filter by ${label.toLowerCase()}`" @keydown="onMenuKey">
      <button
        type="button"
        class="fm-item"
        :role="multi ? 'menuitemcheckbox' : 'menuitemradio'"
        data-value=""
        :aria-checked="isOn('')"
        @click="pick('')"
      >
        <Check :size="16" :stroke-width="2.5" class="fm-check" />
        <span class="fm-text">{{ allLabel }}</span>
      </button>
      <button
        v-for="o in options"
        :key="o.value"
        type="button"
        class="fm-item"
        :role="multi ? 'menuitemcheckbox' : 'menuitemradio'"
        :data-value="o.value"
        :aria-checked="isOn(o.value)"
        :title="o.title"
        @click="pick(o.value)"
      >
        <Check :size="16" :stroke-width="2.5" class="fm-check" />
        <span class="fm-text">{{ o.label }}</span>
        <span v-if="o.count != null" class="fm-count mono">{{ o.count }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.fm {
  position: relative;
}

/* A square hairline cell like the theme control: label faint, value in ink. */
.fm-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  font: inherit;
  line-height: 1.2;
  padding: 5px 8px 5px 10px;
  color: var(--dim);
  background: transparent;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  cursor: pointer;
  white-space: nowrap;
}

.fm-btn:hover,
.fm-btn[aria-expanded='true'] {
  color: var(--fg);
  background: var(--face);
}

.fm-label {
  color: var(--faint);
}

.fm-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 22ch;
  color: var(--fg);
}

/* A narrowed filter is state the reader must not forget: inverted, not hued. */
.fm-btn.active {
  border-color: var(--fg);
}

.fm-chev {
  flex: none;
  color: var(--faint);
}

.fm-menu {
  position: absolute;
  left: 0;
  top: calc(100% + 6px);
  z-index: 30;
  min-width: 100%;
  width: max-content;
  max-width: min(360px, calc(100vw - 32px));
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  background: var(--face);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.fm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font: inherit;
  text-align: left;
  padding: 8px 12px 8px 10px;
  color: var(--dim);
  background: transparent;
  border: 0;
  border-radius: 0;
  cursor: pointer;
}

.fm-item + .fm-item {
  border-top: 1px solid var(--rule-soft);
}

.fm-item:hover {
  color: var(--fg);
  background: var(--inset);
}

.fm-item:focus-visible {
  outline-offset: -2px;
}

.fm-item[aria-checked='true'] {
  color: var(--fg);
}

.fm-check {
  flex: none;
  visibility: hidden;
}

.fm-item[aria-checked='true'] .fm-check {
  visibility: visible;
}

.fm-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fm-count {
  flex: none;
  color: var(--faint);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
.fm-menu.end {
  left: auto;
  right: 0;
}

/* Touch: interactive targets reach 44px on phone glass. */
@media (max-width: 640px) {
  .fm-btn {
    min-height: 44px;
  }
}
</style>
