<script setup lang="ts">
import { computed } from 'vue'
import { Check, CircleHelp, X } from 'lucide-vue-next'
import type { ReceiptView } from '../../lib/types'

const props = defineProps<{ head: ReceiptView | null; base: ReceiptView | null }>()

const r = computed(() => props.head?.receipt ?? null)
const counts = (v: ReceiptView | null) => {
  const checks = v?.receipt.checks ?? []
  return { total: checks.length, passed: checks.filter((c) => c.pass).length }
}
const before = computed(() => counts(props.base))
const after = computed(() => counts(props.head))
const tone = computed(() => (r.value?.verdict === 'PASS' ? 'pass' : r.value?.verdict === 'FAIL' ? 'fail' : 'unknown'))
const icon = computed(() => (tone.value === 'pass' ? Check : tone.value === 'fail' ? X : CircleHelp))
</script>

<template>
  <section class="banner" aria-label="Verdict">
    <template v-if="r">
      <div class="verdict" :class="tone">
        <component :is="icon" :size="28" :stroke-width="3" />
        <span class="word">{{ r.verdict }}</span>
      </div>
      <div class="meta">
        <p class="reason">{{ r.reason }}</p>
        <p class="data dim">
          <span>{{ r.revision.sha.slice(0, 12) }}+{{ r.revision.tree.slice(0, 8) }}</span>
          <span v-if="r.revision.dirty" class="dirty" title="proved on uncommitted work">dirty</span>
          <span>{{ r.at }}</span>
        </p>
        <p v-if="base" class="data delta">
          before:
          <span :class="base.receipt.verdict === 'PASS' ? 'pass-t' : 'fail-t'">{{ base.receipt.verdict }}</span>
          ({{ before.total - before.passed }}/{{ before.total }} failed) →
          after:
          <span :class="r.verdict === 'PASS' ? 'pass-t' : 'fail-t'">{{ r.verdict }}</span>
          ({{ after.passed }}/{{ after.total }} passed)
        </p>
      </div>
    </template>
    <p v-else class="reason">No proof of the change (head) is recorded for this run.</p>
  </section>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: stretch;
  gap: 20px;
  padding: 16px 0 20px;
  flex-wrap: wrap;
}

.verdict {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 10px 22px;
  border: 2px solid var(--rule);
  border-radius: var(--radius);
  color: var(--dim);
}

.verdict.pass {
  color: var(--pass);
  border-color: var(--pass);
}

.verdict.fail {
  color: var(--fail);
  border-color: var(--fail);
}

.word {
  font-family: var(--mono);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.meta {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  min-width: 0;
}

p {
  margin: 0;
}

.reason {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
}

.data {
  font-family: var(--mono);
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}

.dim {
  color: var(--dim);
}

.dirty {
  color: var(--fail);
  border: 1px solid var(--fail);
  padding: 0 6px;
  border-radius: var(--radius);
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
