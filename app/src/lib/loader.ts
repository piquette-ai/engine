import { onMounted, onScopeDispose, ref, watch, type Ref, type WatchSource } from 'vue'

// The brand loader is one family of isometric factory-line figures; which one
// draws is a function of the job, never a viewer preference:
//
//   run       → relay     A run or receipt loading. Three stations, one lit at a
//                         time, the light handing off along the wire like phases.
//   progress  → stack     Real, measured progress (the on-device model download).
//                         Four floors light bottom to top as the percentage climbs.
//   wait      → conveyor  Everything else: the runs-list load, unknown waits, and
//                         the still mark on empty states. Four stations fill and
//                         stay lit until the line resets.
//
// Plus the three-tier rule for how long a wait has to be before it gets a
// loader at all (useLoadingTier).

export type LoaderJob = 'run' | 'progress' | 'wait'
export type LoaderFigure = 'conveyor' | 'relay' | 'stack'

export const FIGURE_FOR: Record<LoaderJob, LoaderFigure> = {
  run: 'relay',
  progress: 'stack',
  wait: 'conveyor',
}

export type LoadingTier = 'none' | 'skeleton' | 'brand'

export interface TierOptions {
  /** Waits shorter than this show nothing (default 300ms). */
  delayMs?: number
  /** From here on the brand loader replaces the skeleton (default 2000ms). */
  brandMs?: number
  /** A wait with no layout to sketch (a model download): go straight to the brand loader. */
  skeleton?: boolean
}

/**
 * The three tiers by wait length: under 300ms nothing, then a skeleton shaped
 * like the real layout, then after 2s the brand loader. Back to 'none' the
 * moment loading ends.
 */
export function useLoadingTier(loading: WatchSource<boolean>, opts: TierOptions = {}): Ref<LoadingTier> {
  const { delayMs = 300, brandMs = 2000, skeleton = true } = opts
  const tier = ref<LoadingTier>('none')
  let timers: ReturnType<typeof setTimeout>[] = []
  const clear = () => {
    for (const t of timers) clearTimeout(t)
    timers = []
  }
  watch(
    loading,
    (on) => {
      clear()
      if (!on) {
        tier.value = 'none'
        return
      }
      if (skeleton) {
        timers.push(setTimeout(() => (tier.value = 'skeleton'), delayMs))
        timers.push(setTimeout(() => (tier.value = 'brand'), Math.max(brandMs, delayMs)))
      } else {
        timers.push(setTimeout(() => (tier.value = 'brand'), delayMs))
      }
    },
    { immediate: true },
  )
  onScopeDispose(clear)
  return tier
}

/**
 * Text for a polite live region that mounts empty and fills a moment later.
 * Many screen readers skip a live region that arrives already holding its
 * text, so the region is in the tree first and the words land after it.
 * Later changes to the text follow straight away.
 */
export function useAnnouncement(text: () => string, delayMs = 100): Ref<string> {
  const said = ref('')
  let ready = false
  let timer: ReturnType<typeof setTimeout> | undefined
  onMounted(() => {
    timer = setTimeout(() => {
      ready = true
      said.value = text()
    }, delayMs)
  })
  watch(text, (t) => {
    if (ready) said.value = t
  })
  onScopeDispose(() => clearTimeout(timer))
  return said
}
