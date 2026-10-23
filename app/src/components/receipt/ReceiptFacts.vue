<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { Check, Copy } from 'lucide-vue-next'
import type { ReceiptView } from '../../lib/types'

const props = defineProps<{
  repoLabel: string | null
  head: ReceiptView | null
  runHref: string | null
  chain?: string | null
}>()

const r = computed(() => props.head?.receipt ?? null)

const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined
onUnmounted(() => clearTimeout(copyTimer))
async function copySha() {
  if (!r.value) return
  try {
    await navigator.clipboard.writeText(r.value.revision.sha)
    copied.value = true
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copied.value = false), 1600)
  } catch {
    /* clipboard blocked; the full sha is still in the tooltip */
  }
}
</script>

<template>
  <dl v-if="r" class="kv">
    <dt>Repo</dt>
    <dd class="mono wrap" :title="repoLabel ?? undefined">{{ repoLabel ?? '—' }}</dd>

    <dt>Run</dt>
    <dd>
      <a v-if="runHref" :href="runHref" class="view-run">View run →</a>
      <span v-else class="none" title="This run has no trace on this site">—</span>
    </dd>

    <dt>Chain</dt>
    <dd>
      <template v-if="chain">{{ chain }}</template>
      <span
        v-else
        class="none"
        :title="
          runHref
            ? 'No trace for this run on this site'
            : 'The receipt does not record which chain ran'
        "
        >—</span
      >
    </dd>

    <dt v-if="r.issue">Issue</dt>
    <dd v-if="r.issue" class="mono">#{{ r.issue }}</dd>

    <dt>Commit</dt>
    <dd class="mono">
      <span :title="r.revision.sha">{{ r.revision.sha.slice(0, 7) }}</span>
      <button
        type="button"
        class="copy"
        :aria-label="copied ? 'Copied' : 'Copy full commit sha'"
        :title="copied ? 'Copied' : 'Copy full sha'"
        @click="copySha"
      >
        <component :is="copied ? Check : Copy" :size="14" :stroke-width="2" />
      </button>
      <span class="sr-only" aria-live="polite">{{ copied ? 'Copied' : '' }}</span>
      <span
        v-if="r.revision.dirty"
        class="tag"
        title="The change was proved on a working tree with uncommitted edits, so the commit alone may not reproduce this result."
        >uncommitted changes</span
      >
    </dd>

    <dt>Tree</dt>
    <dd class="mono" :title="r.revision.tree">
      {{ r.revision.tree.slice(0, 8) }}
    </dd>
  </dl>
</template>

<style scoped>
.kv {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  margin: 0 0 8px;
  border-top: 1px solid var(--rule);
}

dt,
dd {
  margin: 0;
  padding: 8px 0;
  border-bottom: 1px solid var(--rule-soft);
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

dt {
  color: var(--dim);
}

.mono {
  font-family: var(--mono);
}

.wrap {
  overflow-wrap: anywhere;
}

.none {
  color: var(--dim);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.view-run {
  font-weight: 600;
}

.copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  color: var(--dim);
  cursor: pointer;
}

.copy:hover {
  color: var(--fg);
  border-color: var(--rule);
}

.tag {
  font-family: var(--mono);
  color: var(--dim);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  padding: 0 8px;
  cursor: help;
}
</style>
