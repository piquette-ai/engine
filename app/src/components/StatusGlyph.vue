<script setup lang="ts">
import { Check, Circle, CircleDot, X } from 'lucide-vue-next'

// A phase or run status as one drawn mark: hue is the state (pass, fail, live),
// never the lane. Keyed on status, so when the poll flips it the remount plays
// the board's split-flap; the paper never animates.
withDefaults(defineProps<{ status: string | null | undefined; size?: number }>(), { size: 17 })

const ICONS: Record<string, unknown> = { success: Check, fail: X, running: CircleDot, queued: Circle }
</script>

<template>
  <span :key="status ?? ''" class="glyph flap" :class="status ?? 'queued'" aria-hidden="true">
    <component :is="ICONS[status ?? ''] ?? Circle" :size="size" :stroke-width="2.5" />
  </span>
</template>

<style scoped>
.glyph {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  transform-origin: 50% 65%;
  color: var(--faint);
}

.glyph.success {
  color: var(--pass);
}

.glyph.fail {
  color: var(--fail);
}

.glyph.running {
  color: var(--live);
}

body.board .flap {
  animation: flap-in 280ms cubic-bezier(0.2, 0.7, 0.3, 1);
}

body.board .glyph.running {
  animation:
    flap-in 280ms cubic-bezier(0.2, 0.7, 0.3, 1),
    pulse 1.6s ease-in-out 340ms infinite;
}
</style>
