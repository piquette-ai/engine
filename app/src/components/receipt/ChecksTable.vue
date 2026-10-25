<script setup lang="ts">
import { computed, ref } from 'vue'
import { checkFraction, checksPass } from '../../lib/checks'
import type { ReceiptView } from '../../lib/types'

const props = defineProps<{
  head: ReceiptView | null
  base: ReceiptView | null
}>()
type Mode = 'changed' | 'failing' | 'all'
const picked = ref<Mode | null>(null)

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

function baseCell(journey: string, name: string): 'pass' | 'fail' | null {
  const r = baseResult.value.get(id(journey, name))
  return r === undefined ? null : r ? 'pass' : 'fail'
}

// Changed = the before result differs from the after result, a check the baseline never ran included.
// With no baseline nothing can have changed.
const changedCount = computed(() =>
  !props.base
    ? 0
    : (props.head?.receipt.checks ?? []).filter(
        (c) => baseCell(c.journey, c.name) !== (c.pass ? 'pass' : 'fail'),
      ).length,
)
// Open on what moved; with nothing moved, on what is broken, else on everything.
const mode = computed<Mode>(
  () => picked.value ?? (changedCount.value ? 'changed' : failed.value ? 'failing' : 'all'),
)
const modes = computed<Array<{ key: Mode; label: string; count: number }>>(() => [
  { key: 'changed', label: 'Changed', count: changedCount.value },
  { key: 'failing', label: 'Failing', count: failed.value },
  { key: 'all', label: 'All', count: total.value },
])
const keep = (c: { journey: string; name: string; pass: boolean }) =>
  mode.value === 'all' ||
  (mode.value === 'failing' ? !c.pass : baseCell(c.journey, c.name) !== (c.pass ? 'pass' : 'fail'))
const emptyText = computed(() =>
  !total.value
    ? 'No checks recorded.'
    : mode.value === 'failing'
      ? 'No failing checks.'
      : props.base
        ? 'No check changed between before and after.'
        : 'No baseline to compare against.',
)

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
    if (!keep(c)) continue
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
</script>

<template>
  <div class="checks">
    <div class="bar">
      <span class="mono"
        >{{ checksPass(total - failed, total)
        }}<template v-if="baseCounts"> · {{ checkFraction(baseCounts.passing, baseCounts.total) }} before</template></span
      >
      <div class="seg" role="group" aria-label="Which checks to show">
        <button
          v-for="m in modes"
          :key="m.key"
          type="button"
          :aria-pressed="mode === m.key"
          :class="{ on: mode === m.key }"
          @click="picked = m.key"
        >
          {{ m.label }} ({{ m.count }})
        </button>
      </div>
    </div>
    <p v-if="!groups.length" class="dim">
      {{ emptyText }}
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

/* Segmented control, as the run page's Steps/Timeline: squared cells on one hairline. */
.seg {
  display: inline-flex;
  flex-wrap: wrap;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.seg button {
  padding: 3px 14px;
  border: none;
  border-radius: 0;
  background: none;
  color: var(--dim);
  font: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.seg button + button {
  border-left: 1px solid var(--rule);
}

.seg button:hover {
  color: var(--fg);
}

.seg button.on {
  background: var(--fg);
  color: var(--ground);
  font-weight: 600;
}

@media (max-width: 640px) {
  .bar {
    flex-wrap: wrap;
  }

  .seg button {
    min-height: 44px;
  }
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
