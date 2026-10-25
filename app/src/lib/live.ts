import { ref } from 'vue'

// Shared between the views (which poll) and the masthead/page title, so the
// masthead needs no second poll loop.

/** The adw_id of the most recently started running session on the list, or null. Feeds the page title. */
export const runningTicket = ref<string | null>(null)

/** Failed and recovered runs still waiting for a human, for the tab title. Null off the list. */
export const needsReviewCount = ref<number | null>(null)

/** The open run's request as a one-line title, set by the trace view once it loads. */
export const traceTitle = ref<string | null>(null)

/** The run behind the open receipt, as a one-line request title, set by the receipt viewer once its trace loads. */
export const receiptTitle = ref<string | null>(null)

/** True while the open run's trace says it is still running. */
export const traceRunning = ref(false)

/** When a view last received fresh data from the API (epoch ms), or null before the first response. */
export const lastUpdatedMs = ref<number | null>(null)
