<script setup lang="ts">
import { computed } from 'vue'
import { receiptFileUrl } from '../../lib/api'
import type { ReceiptView } from '../../lib/types'

const props = defineProps<{ runId: string; repo: string | null; head: ReceiptView | null; base: ReceiptView | null }>()

// The same rows as the table on the PR (verification.ts escalationText).
const LINKS: Array<[string, string]> = [
  ['receipt', ''],
  ['video', 'video'],
  ['contact sheet', 'contact_sheet'],
  ['transcript', 'transcript'],
]

const rows = computed(() =>
  [
    { label: 'Before the change', view: props.base },
    { label: 'The change', view: props.head },
  ]
    .filter((r) => r.view)
    .map(({ label, view }) => {
      const v = view!
      const failed = v.receipt.checks.filter((c) => !c.pass).length
      const links = LINKS.flatMap(([text, name]) => {
        const key = name === '' ? v.key : (v.receipt.evidence[name]?.key ?? null)
        return key ? [{ text, href: receiptFileUrl(props.runId, key, props.repo) }] : []
      })
      return {
        label,
        sha: v.receipt.revision.sha.slice(0, 12),
        tree: v.receipt.revision.tree.slice(0, 8),
        dirty: v.receipt.revision.dirty,
        verdict: v.receipt.verdict,
        failed,
        total: v.receipt.checks.length,
        links,
      }
    }),
)
</script>

<template>
  <table class="ba">
    <thead>
      <tr>
        <th>Proof</th>
        <th>Revision</th>
        <th>Result</th>
        <th>Evidence</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.label">
        <td>{{ row.label }}</td>
        <td class="mono">{{ row.sha }}+{{ row.tree }}<span v-if="row.dirty" class="fail-t"> dirty</span></td>
        <td class="mono">
          <span :class="row.verdict === 'PASS' ? 'pass-t' : 'fail-t'">{{ row.verdict }}</span>
          ({{ row.failed }}/{{ row.total }} failed)
        </td>
        <td class="links">
          <a v-for="l in row.links" :key="l.text" :href="l.href" target="_blank" rel="noopener">{{ l.text }}</a>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.ba {
  width: 100%;
  border-collapse: collapse;
}

th {
  text-align: left;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--dim);
  padding: 7px 10px;
  border-bottom: 1px solid var(--rule);
}

td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--rule-soft);
  vertical-align: top;
}

.mono {
  font-family: var(--mono);
}

.links {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
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
