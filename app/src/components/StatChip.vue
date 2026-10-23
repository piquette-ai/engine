<script setup lang="ts">
import { computed } from 'vue'
import { BookOpen, CircleDollarSign, Coins, PenLine, Timer } from 'lucide-vue-next'
import { costTitle, fmtCost, fmtDuration, fmtTokens } from '../lib/format'
import { STAT_TITLES as TITLES, type StatKind } from '../lib/stats'

const props = defineProps<{
  kind: StatKind
  /** Raw value — cost in dollars, tokens as a count, runtime in milliseconds. */
  value: number | null | undefined
  /** Bare value, no cell chrome — for tight spots like board strips. */
  compact?: boolean
}>()

const ICONS = {
  cost: CircleDollarSign,
  tokens: Coins,
  runtime: Timer,
  read: BookOpen,
  written: PenLine,
}

const text = computed(() => {
  if (props.kind === 'cost') return fmtCost(props.value)
  if (props.kind === 'runtime') return fmtDuration(props.value ?? NaN)
  return fmtTokens(props.value)
})
</script>

<template>
  <span class="stat" :class="{ compact }" :title="kind === 'cost' ? (costTitle(value) ?? TITLES.cost) : TITLES[kind]">
    <component :is="ICONS[kind]" class="stat-icon" :size="compact ? 16 : 17" :stroke-width="2" />
    <span class="stat-value">{{ text }}</span>
  </span>
</template>

<style scoped>
/* A square borderless cell: the timetable records numbers in columns, not in
   pills. The hairline cell only appears where the stat stands alone. */
.stat {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 2px 10px;
  border: 1px solid var(--rule-soft);
  border-radius: var(--radius);
  font-size: 16px;
  white-space: nowrap;
}

.stat-icon {
  color: var(--faint);
  flex: none;
}

.stat-value {
  color: var(--fg);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.stat.compact {
  padding: 0;
  border: none;
}

.stat.compact .stat-value {
  color: var(--dim);
}
</style>
