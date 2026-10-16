// Pure display helpers for the Nexus Mods views. No DOM, no store, so they unit-test in node.
import type { DeploymentStatus, InstalledMod, NxFileCategory, NxStatus } from '../../shared/types'
import { compactCount } from './tsView'

export const NX_NO_KEY = 'Add your Nexus Mods API key in Settings to download.'
export const NX_API_KEY_PAGE = 'https://www.nexusmods.com/users/myaccount?tab=api'

export function nexusModUrl(domain: string, modId: number): string {
  return `https://www.nexusmods.com/${domain}/mods/${modId}`
}

const CATEGORY_LABELS: Record<NxFileCategory, string> = {
  MAIN: 'Main',
  UPDATE: 'Update',
  OPTIONAL: 'Optional',
  MISCELLANEOUS: 'Miscellaneous',
  OLD_VERSION: 'Old version',
  REMOVED: 'Removed',
  ARCHIVED: 'Archived'
}

export function fileCategoryLabel(c: NxFileCategory): string {
  return CATEGORY_LABELS[c]
}

/** 999 -> "999", 1234 -> "1.2K", 3_400_000 -> "3.4M". */
export function formatCount(n: number): string {
  return compactCount(n)
}

const DAY_MS = 24 * 3600 * 1000

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`

/** "today", "yesterday", "3 days ago", "2 months ago", "1 year ago". Future dates read as today. */
export function relativeDate(unixSeconds: number, nowMs: number): string {
  const days = Math.floor(Math.max(0, nowMs - unixSeconds * 1000) / DAY_MS)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return plural(days, 'day')
  if (days < 365) return plural(Math.floor(days / 30), 'month')
  return plural(Math.floor(days / 365), 'year')
}

/** The profile's mod installed from this Nexus mod, or null. */
export function installedNexusMod(mods: InstalledMod[], modId: number): InstalledMod | null {
  return mods.find((m) => m.source.kind === 'nexus' && m.source.modId === modId) ?? null
}

/** Shown after opening a file page for a free account's "Mod Manager Download". */
export function openWebsiteToast(handler: NxStatus['handler']): string {
  const base =
    'Click "Mod Manager Download" on Nexus Mods. HML installs it when the download starts.'
  return handler === 'registered'
    ? base
    : `${base} Turn on "Use HML for Nexus downloads" in Settings first.`
}

/** Shown after updates opened the first few file pages for a free account. */
export const NX_MORE_UPDATES = "Open the remaining updates from each mod's menu."
/** How many file pages one Update all opens for a free account. */
export const NX_MAX_UPDATE_TABS = 5

/** The launch bar's line for a deploy game: what is in its game folder now. */
export function deploymentLabel(
  s: DeploymentStatus | null,
  currentProfileId: string | null
): string {
  if (!s) return "Mods aren't deployed."
  if (s.profileId === currentProfileId) {
    return `This profile is deployed (${s.files} ${s.files === 1 ? 'file' : 'files'}).`
  }
  return `${s.profileName ?? 'Another profile'} is deployed.`
}
