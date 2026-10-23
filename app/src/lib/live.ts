import { ref } from 'vue'

// Shared between the views (which poll) and the masthead/page title, so the
// masthead needs no second poll loop.

/** The adw_id of the most recently started running session on the list, or null. Feeds the page title. */
export const runningTicket = ref<string | null>(null)

/** True while the open run's trace says it is still running. */
export const traceRunning = ref(false)

/** When a view last received fresh data from the API (epoch ms), or null before the first response. */
export const lastUpdatedMs = ref<number | null>(null)
