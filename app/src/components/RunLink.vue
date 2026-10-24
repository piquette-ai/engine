<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUpRight } from 'lucide-vue-next'
import type { RunLinkView } from '../lib/runs'

// An issue or PR a run belongs to: a link that opens the tracker in a new tab
// when one was recorded, the bare label when only that was, `—` otherwise.
const props = defineProps<{
  link: RunLinkView | null
  /** Printed before the label, e.g. "PR" for "PR #217". */
  prefix?: string
  /** A trailing arrow marking the link as leaving the app (the header meta line). */
  arrow?: boolean
}>()

const text = computed(() => (props.link ? `${props.prefix ? `${props.prefix} ` : ''}${props.link.label}` : '—'))
</script>

<template>
  <a v-if="link?.href" class="run-link" :href="link.href" target="_blank" rel="noopener noreferrer">
    <span>{{ text }}</span>
    <ArrowUpRight v-if="arrow" class="run-link-arrow" :size="16" :stroke-width="2" aria-hidden="true" />
    <span class="run-link-sr"> (opens in a new tab)</span>
  </a>
  <template v-else>{{ text }}</template>
</template>

<style scoped>
.run-link {
  color: var(--fg);
  text-decoration: underline;
  text-decoration-color: var(--rule);
  text-underline-offset: 4px;
  overflow-wrap: anywhere;
}

.run-link:hover,
.run-link:focus-visible {
  text-decoration-color: var(--fg);
}

.run-link-arrow {
  margin-left: 2px;
  vertical-align: -2px;
  color: var(--faint);
}

.run-link:hover .run-link-arrow,
.run-link:focus-visible .run-link-arrow {
  color: var(--fg);
}

/* Phones: inline vertical padding grows the tap target to 44px without
   moving the line it sits in. */
@media (max-width: 640px) {
  .run-link {
    padding-block: 12px;
  }
}

.run-link-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
