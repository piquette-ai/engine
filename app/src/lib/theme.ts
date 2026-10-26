import { ref, watchEffect } from 'vue'

// Global Light / Dark / System choice. Dark is body.board (the departure-board
// palette in style.css); light is the paper palette. The same logic runs in
// app/index.html before mount so the first paint is already right — keep the
// storage key and class name in sync with it.
export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'piquette-theme'

function load(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // storage blocked — fall through to the default
  }
  return 'system'
}

export const theme = ref<ThemeChoice>(load())

const media = window.matchMedia('(prefers-color-scheme: dark)')
const systemDark = ref(media.matches)
media.addEventListener('change', (e) => {
  systemDark.value = e.matches
})

export function setTheme(choice: ThemeChoice): void {
  theme.value = choice
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    // not persisted; still applies for this page load
  }
}

/** Start applying the choice to <body>; call once from App setup. */
export function useThemeEffect(): void {
  watchEffect(() => {
    const dark = theme.value === 'dark' || (theme.value === 'system' && systemDark.value)
    document.body.classList.toggle('board', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  })
}
