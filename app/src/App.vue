<script setup lang="ts">
import { onMounted, ref, watchEffect } from 'vue'
import { useRoute, hrefFor, phaseCrumb } from './lib/router'
import { fetchHealth } from './lib/api'
import { runningTicket } from './lib/live'
import { theme, setTheme, useThemeEffect, type ThemeChoice } from './lib/theme'
import SessionsList from './components/SessionsList.vue'
import SessionTrace from './components/SessionTrace.vue'
import WebMcpConfirm from './components/WebMcpConfirm.vue'

const route = useRoute()

const themeOptions: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

// Light (paper) or dark (departure board) is a global choice, not a route
// property. Components bind only to semantic tokens (--ground, --fg, --rule,
// --accent…), which style.css swaps on body.board.
useThemeEffect()

// Tab title: "SPF: {project} - {ticket}". The ticket is the open run's id, or
// on the list the newest running run; blank parts drop out.
const project = ref<string | null>(null)
onMounted(async () => {
  try {
    project.value = (await fetchHealth()).project ?? null
  } catch {
    // title falls back to the bare form
  }
})

watchEffect(() => {
  const ticket = route.value.adwId ?? runningTicket.value
  const head = project.value ? `SPF: ${project.value}` : 'SPF'
  document.title = ticket ? (project.value ? `${head} - ${ticket}` : `${head}: ${ticket}`) : head
})
</script>

<template>
  <div class="app">
    <header class="masthead">
      <nav class="crumbs">
        <!-- Inline copy of public/logo.svg (the favicon) so the mark renders
             crisply with no fetch; keep the two in sync. The accent strip and
             outline follow the active theme. -->
        <svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
          <rect class="logo-plate" x="2.5" y="2.5" width="27" height="27" rx="2" />
          <rect class="logo-strip" x="7" y="8" width="18" height="4" />
          <rect class="logo-strip logo-accent" x="7" y="14" width="18" height="4" />
          <rect class="logo-strip" x="7" y="20" width="18" height="4" />
        </svg>
        <a class="brand" :href="hrefFor()">Super Portable Software Factory</a>
        <template v-if="route.adwId">
          <span class="sep">›</span>
          <a class="crumb-id" :href="hrefFor(route.adwId)" :class="{ current: !route.phaseId }">{{
            route.adwId
          }}</a>
        </template>
        <template v-if="route.adwId && route.phaseId">
          <span class="sep">›</span>
          <span class="current">{{ phaseCrumb ?? route.phaseId }}</span>
        </template>
      </nav>
      <div class="masthead-end">
        <div class="theme-toggle" role="group" aria-label="Color theme">
          <button
            v-for="o in themeOptions"
            :key="o.value"
            type="button"
            class="theme-opt"
            :aria-pressed="theme === o.value"
            @click="setTheme(o.value)"
          >
            {{ o.label }}
          </button>
        </div>
        <span class="live-hint"><span class="live-marker" /> live</span>
      </div>
    </header>
    <main>
      <SessionsList v-if="!route.adwId" />
      <SessionTrace v-else :key="route.adwId" :adw-id="route.adwId" :phase-id="route.phaseId" />
    </main>
    <WebMcpConfirm />
  </div>
</template>

<style scoped>
.masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 28px 14px;
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--ground);
}

/* The printed masthead rule: thick-and-thin double line under the wordmark.
   In dark the header takes the board's single hairline instead. */
.masthead::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  border-bottom: 4px double var(--fg);
}

body.board .masthead::after {
  border-bottom: 1px solid var(--rule);
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 17px;
  flex: 1 1 0;
  min-width: 0;
}

.logo {
  width: 26px;
  height: 26px;
  flex: none;
}

.logo-plate {
  fill: var(--face);
  stroke: var(--fg);
  stroke-width: 1.5;
}

.logo-strip {
  fill: var(--fg);
}

.logo-accent {
  fill: var(--accent);
}

.brand {
  color: var(--fg);
  font-weight: 700;
  letter-spacing: 0.02em;
  white-space: nowrap;
  text-decoration: none;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sep {
  color: var(--faint);
  flex: none;
}

.crumbs a {
  color: var(--dim);
}

.crumbs a:hover {
  color: var(--fg);
}

.crumb-id {
  font-family: var(--mono);
  font-size: 16px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crumbs .current {
  color: var(--fg);
}

.masthead-end {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
}

/* Segmented control in the timetable's grammar: mono, hairline, square bays.
   The pressed bay inverts to fg-on-ground. */
.theme-toggle {
  display: inline-flex;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}

.theme-opt {
  font: inherit;
  font-family: var(--mono);
  font-size: 16px;
  line-height: 1.2;
  padding: 3px 10px;
  color: var(--dim);
  background: transparent;
  border: 0;
  border-radius: 0;
  cursor: pointer;
}

.theme-opt + .theme-opt {
  border-left: 1px solid var(--rule);
}

.theme-opt:hover {
  color: var(--fg);
}

.theme-opt[aria-pressed='true'] {
  background: var(--fg);
  color: var(--ground);
}

.theme-opt:focus-visible {
  outline-offset: -2px;
}

.live-hint {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--mono);
  font-size: 16px;
  color: var(--live);
  white-space: nowrap;
}

/* Light annotates live state in ballpoint, and it stays still. Dark blinks —
   that is what boards do. */
.live-marker {
  width: 9px;
  height: 9px;
  background: var(--live);
}

body.board .live-marker {
  border-radius: 50%;
  animation: pulse 1.8s ease-in-out infinite;
}

@media (max-width: 980px) {
  .masthead {
    padding: 14px 16px 12px;
  }
}
</style>
