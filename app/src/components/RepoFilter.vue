<script setup lang="ts">
import { computed } from 'vue'
import type { HealthResponse, SessionSummary } from '../lib/types'
import { filterIsEmpty, repoOptions, showFactoryFilter, showRepoFilter, type ListFilter } from '@shared/hosted'
import FilterMenu, { type FilterOption } from './FilterMenu.vue'

// Hosted-mode repo and factory filters as two compact menus. Same contract as
// the chip bar they replace: the selection lives in the URL (the parent owns
// it), repos and factories stay multi-select, and counts only show while
// unfiltered, since a filtered `rows` would count only what survived.
const props = defineProps<{ health: HealthResponse; filter: ListFilter; rows: SessionSummary[] }>()
const emit = defineEmits<{ change: [filter: ListFilter] }>()

const active = computed(() => !filterIsEmpty(props.filter))

const repos = computed<FilterOption[]>(() =>
  repoOptions(props.health.repos ?? [], props.filter.repos, props.rows, active.value).map((o) => ({
    value: o.repo,
    label: o.label,
    count: o.count,
    title: o.repo,
  })),
)

const factories = computed<FilterOption[]>(() => {
  const counts = new Map<string, number>()
  for (const s of props.rows) if (s.factory_id) counts.set(s.factory_id, (counts.get(s.factory_id) ?? 0) + 1)
  return (props.health.factories ?? []).map((f) => ({
    value: f.id,
    label: f.name,
    count: active.value ? null : (counts.get(f.id) ?? 0),
    title: `${f.name} · ${f.repo}`,
  }))
})

const showRepos = computed(() => showRepoFilter(props.health))
const showFactories = computed(() => showFactoryFilter(props.health))
</script>

<template>
  <FilterMenu
    v-if="showRepos"
    label="Repo"
    all-label="All"
    multi
    :options="repos"
    :selected="filter.repos"
    @change="(v) => emit('change', { ...filter, repos: v })"
  />
  <FilterMenu
    v-if="showFactories"
    label="Factory"
    all-label="All"
    multi
    :options="factories"
    :selected="filter.factories"
    @change="(v) => emit('change', { ...filter, factories: v })"
  />
</template>
