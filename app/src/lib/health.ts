import { computed, shallowRef } from 'vue'
import { isHosted } from '@shared/hosted'
import type { HealthResponse } from './types'
import { fetchHealth, setHostedMode } from './api'

/**
 * `/api/health`, shared by the masthead and the list. Hosted mode is whatever
 * the server declares; a failed or old server leaves this null and the app
 * behaves as local.
 */
export const health = shallowRef<HealthResponse | null>(null)
export const hosted = computed(() => isHosted(health.value))

let lastFetch = 0
let failures = 0
let inflight: Promise<void> | null = null

export function loadHealth(): Promise<void> {
  inflight ??= fetchHealth()
    .then((h) => {
      health.value = h
      setHostedMode(isHosted(h))
      lastFetch = Date.now()
      failures = 0
    })
    .catch(() => {
      // Stay null; refreshHealth retries with backoff, so a cold start or a
      // blip can't leave a hosted dashboard in local mode until a reload.
      failures++
      lastFetch = Date.now()
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/**
 * Hosted: re-read health (new repos, factories' last_seen_at) at most every
 * `everyMs`. Never loaded: retry with backoff (1s, 2s, 4s, capped at 10s).
 */
export function refreshHealth(everyMs = 5000): void {
  const wait = health.value == null ? Math.min(1000 * 2 ** Math.max(failures - 1, 0), 10_000) : hosted.value ? everyMs : Infinity
  if (Date.now() - lastFetch >= wait) void loadHealth()
}
