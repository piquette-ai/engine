<script setup lang="ts">
import { computed } from 'vue'
import { receiptFileUrl } from '../../lib/api'
import { checksPass } from '../../lib/checks'
import type { ReceiptView } from '../../lib/types'

const props = defineProps<{
  runId: string
  repo: string | null
  head: ReceiptView | null
  base: ReceiptView | null
}>()

// The same rows as the table on the PR (verification.ts escalationText).
const LINKS: Array<[string, string]> = [
  ['receipt.json', ''],
  ['video', 'video'],
  ['contact sheet', 'contact_sheet'],
  ['transcript', 'transcript'],
]

const rows = computed(() =>
  [
    { label: 'Before the change', view: props.base },
    { label: 'After the change', view: props.head },
  ]
    .filter((r) => r.view)
    .map(({ label, view }) => {
      const v = view!
      const total = v.receipt.checks.length
      const passed = v.receipt.checks.filter((c) => c.pass).length
      const links = LINKS.flatMap(([text, name]) => {
        const key = name === '' ? v.key : (v.receipt.evidence[name]?.key ?? null)
        return key ? [{ text, href: receiptFileUrl(props.runId, key, props.repo) }] : []
      })
      const rv = v.receipt.revision
      const rev = `commit ${rv.sha.slice(0, 7)}, tree ${rv.tree.slice(0, 8)}${rv.dirty ? ', uncommitted changes' : ''}`
      return { label, rev, verdict: v.receipt.verdict, passed, total, links }
    }),
)
const tone = (v: string) => (v === 'PASS' ? 'pass-t' : v === 'FAIL' ? 'fail-t' : 'dim')
const word = (v: string) => (v === 'PASS' ? 'Pass' : v === 'FAIL' ? 'Fail' : 'Unknown')
</script>

<template>
  <ul v-if="rows.length" class="ba" aria-label="Before and after the change">
    <li v-for="row in rows" :key="row.label" class="row">
      <span class="label" :title="`Proved on ${row.rev}`">{{ row.label }}</span>
      <span class="result mono">
        <span :class="tone(row.verdict)">{{ word(row.verdict) }}</span>
        {{ checksPass(row.passed, row.total) }}
      </span>
      <span class="links">
        <a v-for="l in row.links" :key="l.text" :href="l.href" target="_blank" rel="noopener">{{
          l.text
        }}</a>
      </span>
    </li>
  </ul>
</template>

<style scoped>
.ba {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--rule);
}

.row {
  display: grid;
  grid-template-columns: 150px 250px minmax(0, 1fr);
  gap: 6px 16px;
  align-items: baseline;
  padding: 10px 0;
  border-bottom: 1px solid var(--rule-soft);
}

.label {
  font-weight: 600;
}

.mono {
  font-family: var(--mono);
}

.links {
  display: flex;
  gap: 6px 14px;
  flex-wrap: wrap;
}

.dim {
  color: var(--dim);
}

.pass-t {
  color: var(--pass);
  font-weight: 700;
}

.fail-t {
  color: var(--fail);
  font-weight: 700;
}

@media (max-width: 640px) {
  .row {
    grid-template-columns: 1fr;
  }
}
</style>
