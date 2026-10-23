import { ref } from 'vue'
import type { ReceiptsRunResponse } from './types'

/**
 * The open session's receipts, shared between the Verification block and the
 * prove_* phase panel so the run is fetched once. Set by SessionVerification.
 */
export const sessionReceipts = ref<{ adwId: string; run: ReceiptsRunResponse; repo: string | null } | null>(null)
