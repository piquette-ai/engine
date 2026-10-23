<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Phase, Session, SessionDetail } from '../lib/types'
import {
  buildImmediateContext,
  createSessionQaSession,
  isPromptApiAvailable,
  upgradeSessionContext,
} from '../lib/prompt-qa'
import type { SessionQaContextMode, SessionQaSession } from '../lib/prompt-qa'
import { buildSessionSummaryInput, summaryCacheKey } from '../lib/summarizer'

const props = defineProps<{ adwId: string; session: Session; phases: Phase[] }>()
// Tells the trace whether to show the on-device assistant card at all.
const emit = defineEmits<{ available: [boolean] }>()

interface ChatMessage {
  id: number
  role: 'user' | 'assistant' | 'error'
  text: string
}

// Gated on availability(), not just the namespace check — same reasoning as
// SessionSummary.vue: a browser that ships LanguageModel but can't actually
// run it should look exactly like one that never shipped it.
const visible = ref(false)
const question = ref('')
const messages = ref<ChatMessage[]>([])
const answering = ref(false)
const downloadPct = ref<number | null>(null)
// Set once, the first time context is built for this (session-scoped) panel.
const contextMode = ref<SessionQaContextMode | null>(null)
// True once the model has reported dropping earlier turns to fit its context
// window — sticky for the life of the panel, not just the triggering turn.
const contextOverflowed = ref(false)
// The trace-content key (see summarizer.ts's summaryCacheKey) the current
// session's context was built from. SessionTrace polls fetchSession every
// 500ms and hands this panel fresh `phases` on an in-progress run, so the
// trace CAN change shape mid-conversation — this is compared against the
// live trace below to flag that instead of silently answering from stale
// context.
const contextKey = ref<string | null>(null)

let nextId = 0
let qaSession: SessionQaSession | null = null
// De-dupes concurrent create() calls; in practice `answering` already
// prevents concurrent submits, but this keeps ensureSession safe on its own.
let creating: Promise<SessionQaSession> | null = null
// Aborts an in-flight create() (and lets a subsequent ask() bail out) if the
// panel unmounts before it resolves. App.vue's `:key="route.adwId"` remounts
// this panel per run, so navigating away mid-create() — likely here, since
// create() may trigger a model download — is the normal case, not an edge
// case, and must not leak the eventual session.
let createAbort: AbortController | null = null
let askAbort: AbortController | null = null
let unmounted = false

onMounted(async () => {
  try {
    visible.value = await isPromptApiAvailable()
  } catch {
    visible.value = false
  }
  emit('available', visible.value)
})

onUnmounted(() => {
  unmounted = true
  createAbort?.abort()
  askAbort?.abort()
  qaSession?.destroy()
})

function pushMessage(role: ChatMessage['role'], text: string): ChatMessage {
  const msg = { id: ++nextId, role, text }
  messages.value.push(msg)
  return msg
}

/**
 * Lazily creates the on-device session, seeded with this session's trace as
 * context. Only ever called from inside submit()'s own gesture — Chrome's
 * LanguageModel.create() requires user activation, same as
 * Summarizer.create() (see summarizer.ts, prompt-qa.ts). Cached for the
 * panel's lifetime so the trace context is sent once, not re-seeded per
 * question. create() is always the first awaited call in this chain — any
 * condensing happens afterwards via upgradeSessionContext, since it can take
 * seconds (potentially plus a model download) and would otherwise burn
 * through the same activation window create() needs.
 */
async function ensureSession(): Promise<SessionQaSession> {
  if (qaSession) return qaSession
  if (creating) return creating
  createAbort = new AbortController()
  const signal = createAbort.signal
  creating = (async () => {
    const detail: Pick<SessionDetail, 'session' | 'phases'> = {
      session: props.session,
      phases: props.phases,
    }
    contextKey.value = summaryCacheKey(props.adwId, buildSessionSummaryInput(detail).full)
    const context = buildImmediateContext(detail)
    contextMode.value = context.mode
    const created = await createSessionQaSession(
      props.adwId,
      context.text,
      (m) => {
        m.addEventListener('downloadprogress', (e) => {
          downloadPct.value = Math.round(e.loaded * 100)
        })
      },
      () => {
        contextOverflowed.value = true
      },
      signal,
    )
    if (unmounted) {
      // Nobody's holding a reference to `created` once this throws — destroy
      // it now rather than leaking an on-device session for a panel nobody's
      // looking at.
      created.destroy()
      throw new DOMException('SessionQaPanel unmounted', 'AbortError')
    }
    qaSession = created
    if (context.mode === 'truncated') {
      void upgradeSessionContext(detail, created).then((mode) => {
        if (mode && qaSession === created) contextMode.value = mode
      })
    }
    return created
  })()
  try {
    return await creating
  } finally {
    creating = null
    downloadPct.value = null
  }
}

async function submit() {
  const text = question.value.trim()
  if (!text || answering.value) return
  question.value = ''
  pushMessage('user', text)
  answering.value = true
  const pending = pushMessage('assistant', '')
  askAbort = new AbortController()
  try {
    const session = await ensureSession()
    const answer = await session.ask(text, askAbort.signal)
    const idx = messages.value.findIndex((m) => m.id === pending.id)
    if (idx !== -1) messages.value[idx].text = answer
  } catch (err) {
    if (unmounted) return
    messages.value = messages.value.filter((m) => m.id !== pending.id)
    pushMessage('error', err instanceof Error ? err.message : String(err))
    // A rejection from an already-established session (not just ensureSession
    // itself failing to create one) likely means the session is wedged —
    // drop it so the next question starts a fresh session instead of
    // retrying the same broken one forever.
    if (qaSession) {
      qaSession.destroy()
      qaSession = null
    }
  } finally {
    answering.value = false
    askAbort = null
  }
}

// Live trace-content key, recomputed whenever SessionTrace's poll hands in
// new `phases` — null until a session's context has actually been built, so
// an untouched panel isn't rehashing the trace every 500ms tick for nothing.
const currentTraceKey = computed(() => {
  if (contextKey.value == null) return null
  return summaryCacheKey(
    props.adwId,
    buildSessionSummaryInput({ session: props.session, phases: props.phases }).full,
  )
})

// True once the trace has moved on from what the session's context was built
// from — e.g. a question asked mid-run, then more phases arrive. Mirrors
// SessionSummary.vue's `stale`: surfaced as a note, not auto-fixed, since
// rebuilding mid-conversation would silently drop the existing thread.
const traceAdvanced = computed(
  () => currentTraceKey.value !== null && currentTraceKey.value !== contextKey.value,
)

const contextNote = computed(() => {
  if (contextMode.value === 'condensed') {
    return 'Using a condensed summary of this run as context: the full trace was too large to fit.'
  }
  if (contextMode.value === 'truncated') {
    return "This run's trace was cut down to fit as context, so some phase data was left out."
  }
  return null
})

const roleLabel: Record<ChatMessage['role'], string> = {
  user: 'You',
  assistant: 'Model',
  error: 'Error',
}
</script>

<template>
  <section v-if="visible" class="as-block" aria-labelledby="as-ask-head">
    <h3 id="as-ask-head" class="as-head">Ask</h3>
    <p v-if="contextNote" class="as-note">{{ contextNote }}</p>
    <p v-if="contextOverflowed" class="as-note warn">
      The model dropped earlier turns to fit its context window, so its answers may not reflect the whole conversation.
    </p>
    <p v-if="traceAdvanced" class="as-note warn">
      This run has moved on since the conversation started. Later phases aren't in the model's context.
    </p>

    <div class="qa-thread" aria-live="polite">
      <p v-if="!messages.length" class="as-note">
        Ask a question about this run. It's answered on-device; nothing leaves the browser.
      </p>
      <div v-for="m in messages" :key="m.id" class="qa-msg" :class="`qa-role-${m.role}`">
        <span class="qa-role">{{ roleLabel[m.role] }}</span>
        <span v-if="m.role === 'assistant' && !m.text && answering" class="dim">Thinking…</span>
        <span v-else class="qa-text">{{ m.text }}</span>
      </div>
      <p v-if="downloadPct != null" class="as-note">Downloading the model… {{ downloadPct }}%</p>
    </div>

    <form class="qa-input-row" @submit.prevent="submit">
      <input
        v-model="question"
        class="qa-input"
        type="text"
        aria-label="Question about this run"
        placeholder="Ask about this run"
        :disabled="answering"
      />
      <button class="qa-btn" type="submit" :disabled="answering || !question.trim()">Ask</button>
    </form>
  </section>
</template>

<style scoped>
.as-head {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 700;
  color: var(--fg);
}

.as-note {
  margin: 0 0 10px;
  color: var(--dim);
}

.as-note.warn {
  color: var(--live);
}

.qa-thread {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  overflow-y: auto;
  margin-bottom: 10px;
}

.qa-msg {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  border: 1px solid var(--rule-soft);
  border-radius: var(--radius);
  background: var(--inset);
}

.qa-role-user {
  background: none;
}

.qa-role-error {
  border-color: var(--fail);
}

.qa-role {
  color: var(--faint);
  font-size: 16px;
}

.qa-text {
  color: var(--fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.qa-role-error .qa-text {
  color: var(--fail);
}

.qa-input-row {
  display: flex;
  gap: 8px;
}

.qa-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 10px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--ground);
  color: var(--fg);
  font: inherit;
}

.qa-input::placeholder {
  color: var(--faint);
}

.qa-input:focus-visible {
  outline: none;
  border-color: var(--accent);
}

.qa-btn {
  padding: 3px 12px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: none;
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}

.qa-btn:hover:not(:disabled),
.qa-btn:focus-visible:not(:disabled) {
  border-color: var(--accent);
}

.qa-btn:disabled {
  color: var(--faint);
  cursor: default;
}

/* Touch: interactive targets reach 44px on phone glass. */
@media (max-width: 640px) {
  .qa-input,
  .qa-btn {
    min-height: 44px;
  }
}
</style>
