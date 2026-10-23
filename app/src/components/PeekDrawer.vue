<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, useTemplateRef } from 'vue'

// The peek shell shared by the run page's phase peek and the list's run peek:
// a fixed panel from the right that starts under the sticky masthead, so the
// crumbs, live state and settings stay in view. Mount it with v-if; it takes
// focus to its heading on open and, unless the owner says otherwise, hands it
// back to whatever had it when it closes.
const props = withDefaults(
  defineProps<{
    /** The id of the heading inside the slot that names the drawer. */
    labelledby: string
    /** Return focus to the element that held it before the drawer opened. */
    restoreFocus?: boolean
  }>(),
  { restoreFocus: true },
)

const el = useTemplateRef<HTMLElement>('el')
let returnFocus: HTMLElement | null = null

onMounted(async () => {
  const active = document.activeElement
  if (active instanceof HTMLElement && !el.value?.contains(active)) returnFocus = active
  await nextTick()
  // Focus the drawer's heading, not the whole aside (which would frame it).
  const heading = el.value?.querySelector<HTMLElement>(`#${CSS.escape(props.labelledby)}`)
  if (heading) {
    heading.tabIndex = -1
    heading.focus({ preventScroll: true })
  } else {
    el.value?.focus({ preventScroll: true })
  }
})

onBeforeUnmount(() => {
  const target = returnFocus
  returnFocus = null
  if (props.restoreFocus && target?.isConnected) target.focus({ preventScroll: true })
})

defineExpose({ contains: (n: Node | null) => !!n && !!el.value?.contains(n) })
</script>

<template>
  <aside ref="el" class="peek" role="dialog" aria-modal="false" :aria-labelledby="labelledby" tabindex="-1">
    <slot />
  </aside>
</template>

<style scoped>
.peek {
  position: fixed;
  top: var(--masthead-h, 0px);
  right: 0;
  bottom: 0;
  z-index: 9;
  width: min(var(--peek-w, clamp(420px, 40vw, 640px)), 100%);
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--ground);
  border-left: 1px solid var(--rule);
}

.peek:focus,
.peek :deep([tabindex='-1']:focus) {
  outline: none;
}

/* Phones: the peek takes the whole glass under the masthead. */
@media (max-width: 640px) {
  .peek {
    left: 0;
    right: 0;
    width: auto;
    border-left: none;
  }
}
</style>
