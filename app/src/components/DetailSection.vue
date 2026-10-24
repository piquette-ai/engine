<script setup lang="ts">
import type { Component } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import InfoHint from './InfoHint.vue'

defineProps<{
  title: string
  /** Lucide icon component rendered before the title. */
  icon?: Component
  /** Shown after the title; omit for sections without a natural count. */
  count?: number | null
  open: boolean
  /** A newcomer hint for the title, shown beside the header (not inside the toggle button). */
  hint?: { label: string; text: string }
}>()

defineEmits<{ toggle: [] }>()
</script>

<template>
  <section class="dsec">
    <div class="dsec-bar">
      <button class="dsec-head" type="button" :aria-expanded="open" @click="$emit('toggle')">
        <ChevronRight class="chev" :class="{ open }" :size="16" :stroke-width="2" aria-hidden="true" />
        <component :is="icon" v-if="icon" class="dsec-icon" :size="17" :stroke-width="2" />
        <span class="dsec-title">{{ title }}</span>
        <span v-if="count != null" class="dsec-count dim">({{ count }})</span>
      </button>
      <InfoHint v-if="hint" class="dsec-hint" :label="hint.label" :text="hint.text" />
    </div>
    <div v-if="open" class="dsec-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.dsec {
  margin-bottom: 16px;
}

.dsec-bar {
  position: relative;
}

.dsec-hint {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 10px;
  display: flex;
  align-items: center;
}

.dsec-head {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 6px;
  background: none;
  border: none;
  border-bottom: 1px solid var(--rule);
  border-radius: 0;
  color: var(--fg);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}

.dsec-icon {
  flex: none;
  color: var(--faint);
}

.dsec-head:hover {
  background: var(--inset);
}

/* Sentence case, whatever case the caller passed: section heads read as
   labels, not as shouted uppercase bands. */
.dsec-title {
  display: inline-block;
}

.dsec-title::first-letter {
  text-transform: uppercase;
}

.chev {
  color: var(--faint);
  flex: none;
  transition: transform 150ms ease-out;
}

.chev.open {
  transform: rotate(90deg);
}

.dsec-count {
  font-weight: 400;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.dsec-body {
  padding-top: 12px;
}

/* Touch: interactive targets reach 44px on phone glass. */
@media (max-width: 640px) {
  .dsec-head {
    min-height: 44px;
  }
}
</style>
