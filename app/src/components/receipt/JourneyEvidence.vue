<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { receiptFileUrl } from '../../lib/api'
import type { ReceiptEvidenceItem, ReceiptView } from '../../lib/types'
import { droppedEvidence, evidenceKind, journeyEvidence } from '@shared/receipt_links'
import DetailSection from '../DetailSection.vue'
import ReceiptVideo from './ReceiptVideo.vue'

const props = defineProps<{ runId: string; repo: string | null; view: ReceiptView | null; focusKey: string | null }>()

const TEXT_LIMIT = 64 * 1024

const blocks = computed(() => {
  const receipt = props.view?.receipt
  if (!receipt) return []
  const ev = journeyEvidence(receipt)
  const dropped = droppedEvidence(receipt)
  // A journey whose files were all rejected still shows its notes: that is when they matter.
  return receipt.journeys
    .filter((j) => ev.has(j.id) || dropped.has(j.id))
    .map((j) => ({
      id: j.id,
      criterion: j.criterion,
      checks: receipt.checks.filter((c) => c.journey === j.id),
      items: ev.get(j.id) ?? [],
      dropped: dropped.get(j.id) ?? [],
    }))
})

const url = (item: ReceiptEvidenceItem) => receiptFileUrl(props.runId, item.key, props.repo)
const label = (name: string, journey: string) => name.replace(`journey:${journey}/`, '')

// Text and json evidence: closed by default, fetched lazily, cut at 64 KB.
const openText = ref<Record<string, boolean>>({})
const texts = ref<Record<string, { body: string; truncated: boolean } | { error: string }>>({})
async function toggleText(name: string, item: ReceiptEvidenceItem) {
  openText.value[name] = !openText.value[name]
  if (!openText.value[name] || texts.value[name]) return
  try {
    const res = await fetch(url(item), { headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    texts.value[name] = {
      body: new TextDecoder().decode(buf.slice(0, TEXT_LIMIT)),
      truncated: item.bytes > TEXT_LIMIT || buf.byteLength > TEXT_LIMIT,
    }
  } catch (e) {
    texts.value[name] = { error: (e as Error).message }
  }
}

onMounted(async () => {
  const k = props.focusKey
  if (!k) return
  const hit = blocks.value.find((b) => b.items.some(([, i]) => i.key === k))
  if (!hit) return
  await nextTick()
  document.getElementById(`journey-${hit.id}`)?.scrollIntoView({ block: 'start' })
})
</script>

<template>
  <div v-for="b in blocks" :id="`journey-${b.id}`" :key="b.id" class="jb">
    <div class="jh">
      <span class="mono dim">{{ b.id }}</span>
      {{ b.criterion }}
    </div>
    <ul v-if="b.checks.length" class="jc">
      <li v-for="c in b.checks" :key="c.name" :class="c.pass ? 'pass-t' : 'fail-t'">
        <span class="mono">{{ c.pass ? 'pass' : 'fail' }}</span>
        {{ c.name }}
      </li>
    </ul>
    <div v-for="[name, item] in b.items" :key="name" class="ji">
      <template v-if="evidenceKind(item) === 'video'">
        <p class="mono dim">{{ label(name, b.id) }}</p>
        <ReceiptVideo :run-id="runId" :repo="repo" :head="item" :base="null" :poster="null" initial="head" />
        <a class="dl" :href="url(item)" download>download {{ label(name, b.id) }}</a>
      </template>
      <template v-else-if="evidenceKind(item) === 'image'">
        <p class="mono dim">{{ label(name, b.id) }}</p>
        <a :href="url(item)" target="_blank" rel="noopener">
          <img class="sheet" :src="url(item)" :alt="`${b.id} ${label(name, b.id)}`" loading="lazy" />
        </a>
      </template>
      <DetailSection v-else :title="label(name, b.id)" :open="!!openText[name]" @toggle="toggleText(name, item)">
        <template v-if="texts[name]">
          <p v-if="'error' in texts[name]" class="fail-t">Could not load: {{ (texts[name] as { error: string }).error }}</p>
          <template v-else>
            <pre>{{ (texts[name] as { body: string }).body }}</pre>
            <p v-if="(texts[name] as { truncated: boolean }).truncated" class="dim">
              …truncated, <a :href="url(item)" target="_blank" rel="noopener">open raw</a>
            </p>
          </template>
        </template>
        <p v-else class="dim">Loading…</p>
      </DetailSection>
    </div>
    <p v-for="d in b.dropped" :key="d.file" class="dim">not kept: {{ d.file }} ({{ d.reason }})</p>
  </div>
</template>

<style scoped>
.jb {
  margin: 0 0 24px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--rule);
}

.jh {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}

.jc {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
}

.ji {
  margin: 12px 0;
}

.sheet {
  max-width: 100%;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.dl {
  display: inline-block;
  margin-top: 6px;
  color: var(--dim);
}

.pass-t {
  color: var(--pass);
}

.fail-t {
  color: var(--fail);
}
</style>
