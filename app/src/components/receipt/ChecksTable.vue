<script setup lang="ts">
import { computed, ref } from 'vue'
import { checkFraction, checksPass } from '../../lib/checks'
import type { ReceiptView } from '../../lib/types'

const props = defineProps<{
  head: ReceiptView | null
  base: ReceiptView | null
}>()
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
const baseCounts = computed(() => {
  const checks = props.base?.receipt.checks
  return checks ? { total: checks.length, passing: checks.filter((c) => c.pass).length } : null
})

const groups = computed(() => {
  const criterion = new Map((props.head?.receipt.journeys ?? []).map((j) => [j.id, j.criterion]))
  const out = new Map<
    string,
    {
      journey: string
      criterion: string
      rows: NonNullable<typeof props.head>['receipt']['checks']
    }
  >()
  for (const c of props.head?.receipt.checks ?? []) {
    if (failuresOnly.value && c.pass) continue
    const g = out.get(c.journey) ?? {
      journey: c.journey,
      criterion: criterion.get(c.journey) ?? c.journey,
      rows: [],
    }
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
      <span class="mono"
        >{{ checksPass(total - failed, total)
        }}<template v-if="baseCounts"> · {{ checkFraction(baseCounts.passing, baseCounts.total) }} before</template></span
      >
      <label class="toggle">
        <input v-model="failuresOnly" type="checkbox" />
        failures only
      </label>
    </div>
    <p v-if="!groups.length" class="dim">
      {{ failuresOnly ? 'No failing checks.' : 'No checks recorded.' }}
    </p>
    <table v-if="groups.length" class="grp">
      <colgroup>
        <col />
        <col v-if="base" class="res" />
        <col class="res" />
      </colgroup>
      <thead>
        <tr>
          <th>Check</th>
          <th v-if="base">Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody v-for="g in groups" :key="g.journey">
        <tr class="head">
          <th :colspan="base ? 3 : 2" scope="colgroup">
            <span class="mono dim">{{ g.journey }}</span>
            <template v-if="g.criterion !== g.journey"> {{ g.criterion }}</template>
          </th>
        </tr>
        <tr v-for="c in g.rows" :key="c.name" :class="{ bad: !c.pass }">
          <td>
            <span class="mono name">{{ c.name }}</span>
            <span
              v-if="!c.pass && (c.expected !== undefined || c.actual !== undefined)"
              class="why mono"
            >
              <span v-if="c.expected !== undefined">expected {{ show(c.expected) }}</span>
              <span v-if="c.actual !== undefined">actual {{ show(c.actual) }}</span>
            </span>
          </td>
          <td
            v-if="base"
            class="mono res-t"
            :class="
              baseCell(c.journey, c.name) === 'fail'
                ? 'fail-t'
                : baseCell(c.journey, c.name) === 'pass'
                  ? 'ok-t'
                  : 'none-t'
            "
          >
            {{ baseCell(c.journey, c.name) ?? '—' }}
          </td>
          <td class="mono res-t" :class="c.pass ? 'ok-t' : 'fail-t'">
            {{ c.pass ? 'pass' : 'fail' }}
          </td>
        </tr>
      </tbody>
    </table>
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

/* One table so the After/Before columns line up across every journey. */
.grp {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  margin-bottom: 18px;
}

col.res {
  width: 84px;
}

.head th {
  text-align: left;
  padding: 14px 10px 6px;
  border-bottom: 1px solid var(--rule);
  font-size: inherit;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: none;
  color: var(--fg);
}

.head th .mono {
  margin-right: 10px;
  font-weight: 400;
}

thead th {
  text-align: left;
  font-size: 16px;
  font-weight: 600;
  color: var(--dim);
  padding: 6px 10px;
}

td {
  padding: 5px 10px;
  border-bottom: 1px solid var(--rule-soft);
  vertical-align: top;
}

.name {
  overflow-wrap: anywhere;
}

.why {
  display: flex;
  flex-direction: column;
  margin-top: 2px;
  color: var(--dim);
  overflow-wrap: anywhere;
}

tr.bad td:first-child {
  box-shadow: inset 3px 0 0 var(--fail);
}

.res-t {
  white-space: nowrap;
}

.ok-t,
.none-t {
  color: var(--dim);
}

.fail-t {
  color: var(--fail);
  font-weight: 700;
}
</style>
