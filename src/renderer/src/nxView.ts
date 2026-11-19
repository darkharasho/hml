// Pure display helpers for the Nexus Mods views. No DOM, no store, so they unit-test in node.
import type {
  DeploymentStatus,
  GameDef,
  InstalledMod,
  NxFileCategory,
  NxStatus,
  ProfileManifest
} from '../../shared/types'
import { NX_NO_KEY } from '../../shared/messages'
import { nexusFilePageUrl, stillPending } from '../../shared/nexusPage'
import { compactCount } from './tsView'

export { NX_NO_KEY }
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

/** Shown after HML's Nexus window opened a free account's file pages. */
export function nxInAppHint(pages: number): string {
  const base = 'Click "Mod Manager Download" in the Nexus Mods window.'
  return pages > 1
    ? `${base} HML installs each file and opens the next page.`
    : `${base} HML installs the file when the download starts.`
}

/** Shown after updates opened the first few file pages for a free account. */
export const NX_MORE_UPDATES = "Open the remaining updates from each mod's menu."
/** How many file pages one Update all opens for a free account. */
export const NX_MAX_UPDATE_TABS = 5

/**
 * True when HML can start a deploy game: custom games, and games it knows the Steam app of
 * (added from Nexus Mods and found installed through Steam). Others are started as usual.
 */
export function canPlayDeployGame(g: Pick<GameDef, 'custom' | 'steamAppId'>): boolean {
  return !!g.custom || !!g.steamAppId
}

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

/** A Nexus file the profile lists to install from its page. */
export interface PendingNexusRow {
  key: string
  name: string
  /** Empty when the list doesn't record it (a follower's manual download). */
  version: string
  url: string
  /** The Nexus mod id, for taking it off the list; null for a follower, whose sync owns the list. */
  modId: number | null
}

/**
 * The profile's Nexus mods still to install: a follower's manual downloads, or the ones an import
 * couldn't download itself that aren't installed since.
 */
export function pendingNexusRows(
  profile: Pick<ProfileManifest, 'mods' | 'sync' | 'pendingNexus'>
): PendingNexusRow[] {
  if (profile.sync?.role === 'follower') {
    return (profile.sync.manual ?? []).map((m) => ({
      key: m.url,
      name: m.name,
      version: '',
      url: m.url,
      modId: null
    }))
  }
  return stillPending(profile.pendingNexus, profile.mods).map((p) => ({
    key: `${p.domain}/${p.modId}`,
    name: p.name,
    version: p.version,
    url: nexusFilePageUrl(p.domain, p.modId, p.fileId),
    modId: p.modId
  }))
}

/** The heading of a profile's list of Nexus mods to install. */
export function pendingNexusHeading(n: number): string {
  return n === 1 ? '1 Nexus mod to install' : `${n} Nexus mods to install`
}
