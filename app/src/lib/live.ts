import { ref } from 'vue'

// Shared between the sessions list (which already polls) and the page title:
// the adw_id of the most recently started running session, or null. Lives here
// so the title needs no second poll loop.
export const runningTicket = ref<string | null>(null)
