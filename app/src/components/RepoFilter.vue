<script setup lang="ts">
import { computed } from 'vue'
import type { HealthResponse, SessionSummary } from '../lib/types'
import { filterIsEmpty, repoOptions, showFactoryFilter, showRepoFilter, toggleValue, type ListFilter } from '@shared/hosted'

const props = defineProps<{ health: HealthResponse; filter: ListFilter; rows: SessionSummary[] }>()
const emit = defineEmits<{ change: [filter: ListFilter] }>()

const repos = computed(() =>
  repoOptions(props.health.repos ?? [], props.filter.repos, props.rows, !filterIsEmpty(props.filter)),
)
const factories = computed(() => props.health.factories ?? [])
const showRepos = computed(() => showRepoFilter(props.health))
const showFactories = computed(() => showFactoryFilter(props.health))

const toggleRepo = (repo: string) => emit('change', { ...props.filter, repos: toggleValue(props.filter.repos, repo) })
const toggleFactory = (id: string) =>
  emit('change', { ...props.filter, factories: toggleValue(props.filter.factories, id) })
</script>

<template>
  <div v-if="showRepos || showFactories" class="filters">
    <div v-if="showRepos" class="bar" role="group" aria-label="Filter by repo">
      <span class="bar-label">repo</span>
      <button
        type="button"
        class="chip"
        :aria-pressed="filter.repos.length === 0"
        @click="emit('change', { ...filter, repos: [] })"
      >
        All repos
      </button>
      <button
        v-for="o in repos"
        :key="o.repo"
        type="button"
        class="chip"
        :title="o.repo"
        :aria-label="o.count != null ? `${o.label}, ${o.count} runs` : o.label"
        :aria-pressed="o.selected"
        @click="toggleRepo(o.repo)"
      >
        {{ o.label }}<span v-if="o.count != null" class="count">{{ o.count }}</span>
      </button>
    </div>
    <div v-if="showFactories" class="bar" role="group" aria-label="Filter by factory">
      <span class="bar-label">factory</span>
      <button
        type="button"
        class="chip"
        :aria-pressed="filter.factories.length === 0"
        @click="emit('change', { ...filter, factories: [] })"
      >
        All factories
      </button>
      <button
        v-for="f in factories"
        :key="f.id"
        type="button"
        class="chip"
        :title="`${f.name} · ${f.repo}`"
        :aria-pressed="filter.factories.includes(f.id)"
        @click="toggleFactory(f.id)"
      >
        {{ f.name }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 14px 0 0;
}

.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

/* Same grammar as the column heads: lowercase, tracked, faint. */
.bar-label {
  min-width: 7ch;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--faint);
}

/* A toggle cell in the theme control's grammar: square, hairline, mono. The
   selected cell inverts to fg-on-ground, so the state is not carried by hue. */
.chip {
  font: inherit;
  font-family: var(--mono);
  font-size: 16px;
  line-height: 1.2;
  padding: 3px 10px;
  color: var(--dim);
  background: transparent;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  cursor: pointer;
}

.chip:hover {
  color: var(--fg);
  background: var(--face);
}

.chip[aria-pressed='true'] {
  background: var(--fg);
  color: var(--ground);
  border-color: var(--fg);
}

.chip:focus-visible {
  outline-offset: 2px;
}

.count {
  margin-left: 8px;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 980px) {
  .filters {
    margin: 12px 16px 0;
  }
}
</style>
