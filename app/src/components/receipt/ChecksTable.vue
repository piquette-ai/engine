<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ReceiptView } from '../../lib/types'

const props = defineProps<{ head: ReceiptView | null; base: ReceiptView | null }>()
const failuresOnly = ref(false)

const show = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v))
const id = (journey: string, name: string) => `${journey}\u0000${name}`

const baseResult = computed(() => {
  const m = new Map<string, boolean>()
  for (const c of props.base?.receipt.checks ?? []) m.set(id(c.journey, c.name), c.pass)
  return m
})

const total = computed(() => props.head?.receipt.checks.length ?? 0)
const failed = computed(() => (props.head?.receipt.checks ?? []).filter((c) => !c.pass).length)

const groups = computed(() => {
  const criterion = new Map((props.head?.receipt.journeys ?? []).map((j) => [j.id, j.criterion]))
  const out = new Map<string, { journey: string; criterion: string; rows: NonNullable<typeof props.head>['receipt']['checks'] }>()
  for (const c of props.head?.receipt.checks ?? []) {
    if (failuresOnly.value && c.pass) continue
    const g = out.get(c.journey) ?? { journey: c.journey, criterion: criterion.get(c.journey) ?? c.journey, rows: [] }
    g.rows.push(c)
    out.set(c.journey, g)
  }
  return [...out.values()]
})

function baseCell(journey: string, name: string): 'pass' | 'fail' | null {
  const r = baseResult.value.get(id(journey, name))
  return r === undefined ? null : r ? 'pass' : 'fail'
}
</script>

<template>
  <div class="checks">
    <div class="bar">
      <span class="mono">{{ total }} checks, {{ failed }} failed</span>
      <label class="toggle">
        <input v-model="failuresOnly" type="checkbox" />
        failures only
      </label>
    </div>
    <p v-if="!groups.length" class="dim">{{ failuresOnly ? 'No failing checks.' : 'No checks recorded.' }}</p>
    <div v-for="g in groups" :key="g.journey" class="scroll">
    <table class="grp">
      <caption>
        <span class="mono dim">{{ g.journey }}</span>
        {{ g.criterion }}
      </caption>
      <thead>
        <tr>
          <th>Check</th>
          <th>Expected</th>
          <th>Actual</th>
          <th>Head</th>
          <th v-if="base">Base</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in g.rows" :key="c.name" :class="{ bad: !c.pass }">
          <td class="mono">{{ c.name }}</td>
          <td class="mono">{{ show(c.expected) }}</td>
          <td class="mono">{{ show(c.actual) }}</td>
          <td class="mono" :class="c.pass ? 'pass-t' : 'fail-t'">{{ c.pass ? 'pass' : 'fail' }}</td>
          <td v-if="base" class="mono" :class="baseCell(c.journey, c.name) === 'pass' ? 'pass-t' : 'fail-t'">
            {{ baseCell(c.journey, c.name) ?? '-' }}
          </td>
        </tr>
      </tbody>
    </table>
    </div>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0 12px;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-family: var(--mono);
}

.mono {
  font-family: var(--mono);
}

.dim {
  color: var(--dim);
}

.scroll {
  overflow-x: auto;
}

.grp {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 18px;
}

caption {
  text-align: left;
  font-weight: 700;
  padding: 6px 10px;
  border-bottom: 1px solid var(--rule);
}

caption .mono {
  margin-right: 10px;
  font-weight: 400;
}

th {
  text-align: left;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--dim);
  padding: 6px 10px;
}

td {
  padding: 5px 10px;
  border-bottom: 1px solid var(--rule-soft);
  vertical-align: top;
  word-break: break-word;
}

td:nth-child(2),
td:nth-child(3) {
  min-width: 140px;
  word-break: break-all;
}

tr.bad td:first-child {
  box-shadow: inset 3px 0 0 var(--fail);
}

.pass-t {
  color: var(--pass);
  font-weight: 700;
}

.fail-t {
  color: var(--fail);
  font-weight: 700;
}
</style>
