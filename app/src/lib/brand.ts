import { apiBase } from '@shared/viewer_base'
import type { Brand, BrandPage } from '@shared/brand'

/** The product name when no brand sets one. */
export const DEFAULT_NAME = 'Piquette'
export const DEFAULT_SHORT_NAME = 'PIQUETTE'

/**
 * What the server injected into the shell (#214): a non-executable JSON
 * script, so the CSP needs no script exception. Missing or malformed means the
 * stock look: branding is cosmetic and never breaks the app.
 */
function readPage(): BrandPage {
  try {
    const el = document.getElementById('piquette-brand')
    const raw: unknown = el?.textContent ? JSON.parse(el.textContent) : null
    return raw && typeof raw === 'object' ? (raw as BrandPage) : {}
  } catch {
    return {}
  }
}

const page = readPage()
export const brand: Brand = page.brand ?? {}

/** Header wordmark. */
export const brandName: string = brand.name ?? DEFAULT_NAME
/** Document titles lead with the short name, or the brand's own. */
export const titleName: string = brand.name ?? DEFAULT_SHORT_NAME
export const brandLogo: string | null = brand.logo_url ?? null

/** False on a receipts-only app, where `/` is not a dashboard. */
export const hasDashboard: boolean = page.dashboard !== false

/** The dashboard root under the mount base: `/`, `/piquette/`, also from `/piquette/r/<id>`. */
export const dashboardRoot: string = apiBase(location.pathname) + '/'

/** The org's own root: brand.home_url (or the host chrome's home link, which the server folds in). */
export const orgHome: { href: string; label: string } | null = (() => {
  const href = brand.home_url ?? document.querySelector<HTMLMetaElement>('meta[name="piquette-home-url"]')?.content
  return href ? { href, label: brand.home_label ?? 'Home' } : null
})()
