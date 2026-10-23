<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watchEffect } from 'vue'
import { useRoute, hrefFor, listHref, lastListFilter, phaseCrumb, traceRepo, viewerRunId, viewerKey, viewerRepo } from './lib/router'
import { health, hosted, loadHealth } from './lib/health'
import { HOSTED_POLL_MS, LOCAL_POLL_MS } from './lib/poll'
import { lastUpdatedMs, runningTicket, traceRunning } from './lib/live'
import { brandName, brandLogo, hasDashboard, dashboardRoot, orgHome, titleName } from './lib/brand'
import { useThemeEffect } from './lib/theme'
import { receiptRepoSegment } from '@shared/receipt_links'
import SessionsList from './components/SessionsList.vue'
import SessionTrace from './components/SessionTrace.vue'
import SettingsMenu from './components/SettingsMenu.vue'
import WebMcpConfirm from './components/WebMcpConfirm.vue'

// Video.js 10 is ~370 KB; keep it out of the main dashboard bundle until a receipt is opened.
const ReceiptViewer = defineAsyncComponent(() => import('./components/receipt/ReceiptViewer.vue'))

const route = useRoute()

// Light (paper) or dark (departure board) is a global choice, not a route
// property. Components bind only to semantic tokens (--ground, --fg, --rule,
// --accent…), which style.css swaps on body.board.
useThemeEffect()

// Tab title: "SPF: {project} - {ticket}". The ticket is the open run's id, or
// on the list the newest running run; blank parts drop out.
const project = computed(() => health.value?.project ?? null)
// Local: the one repo this `spf ui` serves. Hosted: the open run's repo, or on
// the list the single repo the filter is narrowed to; with none or several
// selected there is no honest single crumb.
const repo = computed(() => {
  if (!hosted.value) return health.value?.repo || null
  if (route.value.adwId) return traceRepo.value
  return route.value.filter.repos.length === 1 ? (route.value.filter.repos[0] ?? null) : null
})
// The crumb shows just the repo name; the full owner/repo (or GitLab namespace
// path) lives in the title tooltip and aria-label.
const repoName = computed(() => repo.value?.split('/').filter(Boolean).pop() ?? repo.value)
// The repo/brand crumbs return to the list with the filter the reader had.
// The brand always leads back to the dashboard root (under the mount base). On /r/<run_id> hrefFor()
// would stay on the receipt page, so the receipt page uses the absolute root. A receipts-only app has
// no dashboard: the brand is plain text there. The org's own root is a separate link (orgHome).
const brandLink = computed(() => (viewerRunId ? (hasDashboard ? dashboardRoot : null) : listLink.value))
// The way back is the breadcrumb itself (brand → list or dashboard, repo → list), identical on every route.
// On a receipt the run id crumb links on to the run's trace when there is a dashboard to hold it.
// The receipt URL's repo is the store's segment (owner--name), not the trace's host/owner/name slug, so
// map it back through health.repos; with no match the link carries no repo. Standalone `prove-` runs
// have no session behind them, so they get no link.
const receiptRunLink = computed(() => {
  if (!viewerRunId || !hasDashboard || viewerRunId.startsWith('prove-')) return null
  const slug = viewerRepo ? health.value?.repos?.find((r) => receiptRepoSegment(r) === viewerRepo) : undefined
  return dashboardRoot + hrefFor(viewerRunId, null, slug ? { repo: slug } : {})
})
const listLink = computed(() => listHref(lastListFilter.value))
// Hosted, on a trace: the repo crumb names the open run's repo, so it links to
// that repo's list, not whatever filter was active before.
const repoLink = computed(() =>
  hosted.value && route.value.adwId && traceRepo.value ? listHref({ repos: [traceRepo.value], factories: [] }) : listLink.value,
)
// Live only when something is running; otherwise a quiet "updated Ns ago" for the last response.
// "Live" also needs fresh data: when the API stops answering (or a factory stops syncing) the last rows
// stay on screen, and a pulsing mark would lie.
const clock = ref(Date.now())
const isLive = computed(() => {
  if (viewerRunId || !(route.value.adwId ? traceRunning.value : runningTicket.value !== null)) return false
  const poll = hosted.value ? HOSTED_POLL_MS : LOCAL_POLL_MS
  return lastUpdatedMs.value != null && clock.value - lastUpdatedMs.value < Math.max(3 * poll, 5000)
})
let clockTimer: ReturnType<typeof setInterval> | undefined
const updatedLabel = computed(() => {
  if (viewerRunId || isLive.value || lastUpdatedMs.value == null) return null
  const s = Math.max(0, Math.round((clock.value - lastUpdatedMs.value) / 1000))
  if (s < 10) return null // local polling is sub-second; a permanent 'just now' says nothing
  return s < 60 ? `updated ${s}s ago` : `updated ${Math.floor(s / 60)}m ago`
})

onMounted(() => {
  void loadHealth()
  clockTimer = setInterval(() => (clock.value = Date.now()), 1000)
})
onUnmounted(() => clearInterval(clockTimer))

watchEffect(() => {
  if (viewerRunId) {
    document.title = `${titleName} receipt: ${viewerRunId}`
    return
  }
  const ticket = route.value.adwId ?? runningTicket.value
  const head = project.value ? `${titleName}: ${project.value}` : titleName
  document.title = ticket ? (project.value ? `${head} - ${ticket}` : `${head}: ${ticket}`) : head
})
</script>

<template>
  <div class="app">
    <header class="masthead">
     <div class="masthead-inner page">
      <nav class="crumbs" aria-label="Breadcrumb">
        <!-- A configured logo replaces the mark. Otherwise an inline copy of public/logo.svg (the favicon) so the
             mark renders crisply with no fetch; keep the two in sync. The accent strip and outline follow the theme. -->
        <img v-if="brandLogo" class="logo logo-img" :src="brandLogo" alt="" />
        <svg v-else class="logo" viewBox="0 0 32 32" aria-hidden="true">
          <rect class="logo-plate" x="2.5" y="2.5" width="27" height="27" rx="2" />
          <rect class="logo-strip" x="7" y="8" width="18" height="4" />
          <rect class="logo-strip logo-accent" x="7" y="14" width="18" height="4" />
          <rect class="logo-strip" x="7" y="20" width="18" height="4" />
        </svg>
        <a v-if="brandLink" class="brand" :href="brandLink">{{ brandName }}</a>
        <span v-else class="brand">{{ brandName }}</span>
        <template v-if="viewerRunId">
          <span class="sep">›</span>
          <span class="crumb-id">receipts</span>
          <span class="sep">›</span>
          <a v-if="receiptRunLink" class="crumb-id current crumb-link" :href="receiptRunLink" title="Open this run">{{ viewerRunId }}</a>
          <span v-else class="crumb-id current">{{ viewerRunId }}</span>
        </template>
        <template v-else-if="repo">
          <span class="sep">›</span>
          <a
            class="crumb-repo"
            :href="repoLink"
            :title="repo"
            :aria-label="`Repository ${repo}`"
            :class="{ current: !route.adwId }"
            :aria-current="route.adwId ? undefined : 'page'"
            >{{ repoName }}</a
          >
        </template>
        <template v-if="!viewerRunId && route.adwId">
          <span class="sep">›</span>
          <a class="crumb-id" :href="hrefFor(route.adwId, null, { factory: route.factory, repo: route.repo })" :class="{ current: !route.phaseId }">{{
            route.adwId
          }}</a>
        </template>
        <template v-if="!viewerRunId && route.adwId && route.phaseId">
          <span class="sep">›</span>
          <span class="current">{{ phaseCrumb ?? route.phaseId }}</span>
        </template>
      </nav>
      <div class="masthead-end">
        <a v-if="orgHome" class="masthead-link org-home" :href="orgHome.href">{{ orgHome.label }}</a>
        <span v-if="isLive" class="live-hint"><span class="live-marker" /> live</span>
        <span v-else-if="updatedLabel" class="updated-hint">{{ updatedLabel }}</span>
        <SettingsMenu />
      </div>
     </div>
    </header>
    <main>
      <ReceiptViewer v-if="viewerRunId" :run-id="viewerRunId" :focus-key="viewerKey" />
      <SessionsList v-else-if="!route.adwId" />
      <SessionTrace v-else :key="`${route.factory ?? ''}/${route.repo ?? ''}/${route.adwId}`" :adw-id="route.adwId" :phase-id="route.phaseId" />
    </main>
    <WebMcpConfirm />
  </div>
</template>

<style scoped>
.masthead {
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

.masthead-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 16px;
  padding-bottom: 14px;
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

.logo-img {
  object-fit: contain;
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

.crumb-repo {
  font-family: var(--mono);
  font-size: 16px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 16px;
}

/* Way-back links: action words in the plain voice, faint at rest, accent underline on hover. */
.masthead-link {
  color: var(--dim);
  text-decoration: none;
  white-space: nowrap;
  padding: 2px 0;
  border-bottom: 1px solid transparent;
}

.masthead-link:hover {
  color: var(--fg);
  border-bottom-color: var(--accent);
}

.updated-hint {
  flex: none;
  font-family: var(--mono);
  color: var(--faint);
  white-space: nowrap;
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

/* Phone width: one row. The brand wordmark gives way first, then the repo; the run id (where you are)
   never shrinks. */
@media (max-width: 640px) {
  .masthead-inner {
    gap: 10px;
    padding-top: 14px;
    padding-bottom: 12px;
  }

  .brand {
    flex-shrink: 3;
  }

  .crumb-repo {
    flex-shrink: 1;
  }

  .masthead-end {
    gap: 10px;
  }
}

.crumb-id.current {
  flex-shrink: 0;
  max-width: 100%;
}

.crumb-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
