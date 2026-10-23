import { watch } from 'vue'
import { hosted } from './health'

/** Local sqlite reads are free; a hosted reader bills per D1 row read, so it polls ten times slower. */
export const LOCAL_POLL_MS = 500
export const HOSTED_POLL_MS = 5000

/** Runs `tick` on the poll interval, re-arming when health says the app is hosted. Returns the stop function. */
export function startPolling(tick: () => void): () => void {
  let timer = setInterval(tick, hosted.value ? HOSTED_POLL_MS : LOCAL_POLL_MS)
  const stopWatch = watch(hosted, (h) => {
    clearInterval(timer)
    timer = setInterval(tick, h ? HOSTED_POLL_MS : LOCAL_POLL_MS)
  })
  return () => {
    stopWatch()
    clearInterval(timer)
  }
}
