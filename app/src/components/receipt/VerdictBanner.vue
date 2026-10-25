<script setup lang="ts">
import { computed } from 'vue'
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-vue-next'
import { checkFraction, checksPass } from '../../lib/checks'
import { fmtAgo, fmtDate } from '../../lib/format'
import type { ReceiptView } from '../../lib/types'

const props = defineProps<{
  head: ReceiptView | null
  base: ReceiptView | null
}>()

const r = computed(() => props.head?.receipt ?? null)
const counts = (v: ReceiptView | null) => {
  const checks = v?.receipt.checks ?? []
  const passed = checks.filter((c) => c.pass).length
  return { total: checks.length, passed, failed: checks.length - passed }
}
const before = computed(() => counts(props.base))
const after = computed(() => counts(props.head))
const tone = computed(() =>
  r.value?.verdict === 'PASS' ? 'pass' : r.value?.verdict === 'FAIL' ? 'fail' : 'unknown',
)
const icon = computed(() =>
  tone.value === 'pass' ? ShieldCheck : tone.value === 'fail' ? ShieldAlert : ShieldQuestion,
)

// The receipt's reason often just restates the counts the headline already gives.
const reason = computed(() => {
  const t = r.value?.reason
  return t && !/^\d+ of \d+ checks? (still )?fail/i.test(t.trim()) ? t : null
})
const headline = computed(() => {
  const a = after.value
  if (tone.value === 'pass') return `Verified: ${checksPass(a.total - a.failed, a.total)}`
  if (tone.value === 'fail') return `Not verified: ${checksPass(a.total - a.failed, a.total)}`
  return 'Could not tell whether this change works'
})
</script>

<template>
  <section class="banner" aria-label="Verdict">
    <template v-if="r">
      <span class="mark" :class="tone" aria-hidden="true">
        <component :is="icon" :size="32" :stroke-width="2" />
      </span>
      <div class="meta">
        <h1 class="headline">{{ headline }}</h1>
        <p class="sub">
          <span v-if="base" class="mono">{{ checkFraction(before.total - before.failed, before.total) }} before</span>
          <span :title="fmtDate(r.at)">recorded {{ fmtAgo(r.at) }}</span>
        </p>
        <p v-if="tone !== 'pass' && reason" class="reason">{{ reason }}</p>
      </div>
    </template>
    <p v-else class="reason">No proof of the change is recorded for this run.</p>
  </section>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 8px 0 22px;
}

.mark {
  flex: none;
  display: inline-flex;
  margin-top: 2px;
  color: var(--dim);
}

.mark.pass {
  color: var(--pass);
}

.mark.fail {
  color: var(--fail);
}

.meta {
  min-width: 0;
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

p,
h1 {
  margin: 0;
}

.headline {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
  text-wrap: balance;
}

.sub {
  display: flex;
  flex-wrap: wrap;
  gap: 0 0.6em;
  margin-top: 6px;
  color: var(--dim);
}

.sub > span + span::before {
  content: '·';
  margin-right: 0.6em;
}

.reason {
  margin-top: 6px;
  color: var(--dim);
}

@media (max-width: 560px) {
  .headline {
    font-size: 22px;
  }
}
</style>
