import type {
  ProfileManifest,
  ProfileSync,
  SyncChangeSummary,
  SyncProgress
} from '../../shared/types'

/** Shown on a followed profile, whose mods only change through its sync code. */
export const SYNC_LOCKED_NOTE = 'Synced from a friend. Detach to change mods.'

/** Marks an owner's local mods, which can't travel with a sync code. */
export const LOCAL_WONT_SYNC = "Won't sync to friends"

export const CREATE_SYNC_NOTE = 'Friends who import a sync code get your changes automatically.'
export const STOP_SYNC_CONFIRM =
  "Friends will keep their current copy, but it won't update anymore."
export const DETACH_CONFIRM = 'It becomes a normal profile and stops getting updates.'
export const ALREADY_FOLLOWING = 'You already have this synced profile'

/** An owner whose key is lost or whose code ended on the server: its code no longer updates. */
export const ORPHANED_NOTE =
  "This PC can't publish to this code anymore. Stop syncing and create a new code."

/** A follower some of whose owner's mods didn't install. */
export const BEHIND_NOTE =
  "Some of the owner's mods couldn't be installed. HML tries again every hour and before launching."

/** The toast for a follower that just took its owner's changes; zero counts are left out. */
export function syncUpdatedToast(profileName: string, c: SyncChangeSummary): string {
  const parts: string[] = []
  if (c.added > 0) parts.push(`+${c.added} ${c.added === 1 ? 'mod' : 'mods'}`)
  if (c.removed > 0) parts.push(`${c.removed} removed`)
  if (c.updated > 0) parts.push(`${c.updated} updated`)
  if (c.enabled > 0) parts.push(`${c.enabled} enabled`)
  if (c.disabled > 0) parts.push(`${c.disabled} disabled`)
  if (c.configs > 0) parts.push('configs changed')
  return parts.length > 0 ? `${profileName} updated: ${parts.join(', ')}` : `${profileName} updated`
}

/** Nexus mods a sync couldn't download on a free account. */
export function manualDownloadToast(n: number): string {
  return n === 1 ? '1 mod needs a manual download' : `${n} mods need a manual download`
}

/** A follower's manual downloads left after Open showed the first batch of pages. */
export function moreManualToast(n: number): string {
  return n === 1 ? '1 more mod needs a manual download' : `${n} more mods need a manual download`
}

export type SyncTone = 'teal' | 'warn' | 'muted'

/** The store key of a profile's live sync progress. */
export const syncProgressKey = (game: string, profileId: string): string => `${game}\0${profileId}`

/** How many of the owner's mods a follower has, out of the owner's total; null before it's known. */
export function followerTally(
  sync: Extract<ProfileSync, { role: 'follower' }>
): { have: number; total: number } | null {
  if (sync.total === undefined) return null
  const have = sync.total - (sync.local?.length ?? 0) - (sync.missing?.length ?? 0)
  return { have: Math.max(0, have), total: sync.total }
}

/** The tooltip for a follower's tally: what's missing and why. */
function tallyTitle(sync: Extract<ProfileSync, { role: 'follower' }>): string | undefined {
  const lines: string[] = []
  if (sync.missing?.length) lines.push(`Missing: ${sync.missing.join(', ')}`)
  if (sync.local?.length)
    lines.push(`Only on the owner's PC (local files never sync): ${sync.local.join(', ')}`)
  if (sync.behind) lines.push(BEHIND_NOTE)
  return lines.length > 0 ? lines.join('\n') : undefined
}

/** The sidebar badge for a profile's sync role, or its live progress; null for a plain profile. */
export function syncBadge(
  sync: ProfileSync | undefined,
  progress?: SyncProgress | null
): {
  label: string
  tone: SyncTone
  /** Tooltip explaining a warning. */
  title?: string
  /** The profile is behind its owner and catching up: draw attention to it. */
  loud?: true
} | null {
  if (!sync) return null
  if (progress?.phase === 'checking') return { label: 'Checking…', tone: 'teal' }
  if (progress?.phase === 'updating')
    return { label: 'Getting latest…', tone: 'teal', loud: true, title: UPDATING_NOTE }
  if (progress?.phase === 'applying')
    return {
      label: `Syncing ${progress.done}/${progress.total}`,
      tone: 'teal',
      loud: true,
      ...(progress.current ? { title: `Installing ${progress.current}` } : {})
    }
  if (progress?.phase === 'held')
    return { label: 'Waiting for game', tone: 'warn', loud: true, title: HELD_NOTE }
  if (sync.role === 'follower') {
    const tally = followerTally(sync)
    const title = tallyTitle(sync)
    if (!tally)
      return sync.behind
        ? { label: 'Missing mods', tone: 'warn', title: BEHIND_NOTE }
        : { label: 'Synced', tone: 'muted' }
    const short = tally.have < tally.total
    return {
      label: `Synced ${tally.have}/${tally.total}`,
      tone: short ? 'warn' : 'muted',
      ...(title ? { title } : {})
    }
  }
  // An orphaned code can't be published at all, which matters more than a publish that's due.
  if (sync.orphaned) return { label: "Can't sync", tone: 'warn', title: ORPHANED_NOTE }
  if (sync.pending) return { label: 'Sync pending', tone: 'warn' }
  return { label: 'Syncing', tone: 'teal' }
}

export const UPDATING_NOTE = 'The owner changed this profile. HML is getting their latest changes.'
export const HELD_NOTE =
  "The owner's latest changes are downloaded. HML applies them when the game closes."

/** The banner above a followed profile's mods: whether it matches its owner, loudly when not. */
export interface FollowerStatus {
  tone: SyncTone
  /** Spinning while HML works on catching up. */
  busy: boolean
  text: string
  detail?: string
  /** Apply progress, 0–1. */
  bar?: number
  /** Offer Sync now: the profile is out of sync and a retry may fix it. */
  syncNow?: true
}

export function followerStatus(
  sync: Extract<ProfileSync, { role: 'follower' }>,
  progress?: SyncProgress | null
): FollowerStatus {
  if (progress?.phase === 'checking')
    return { tone: 'teal', busy: true, text: "Checking for the owner's latest changes…" }
  if (progress?.phase === 'updating')
    return { tone: 'teal', busy: true, text: "Out of sync: getting the owner's latest changes…" }
  if (progress?.phase === 'applying') {
    const { done, total, current } = progress
    return {
      tone: 'teal',
      busy: true,
      text: `Out of sync: getting the owner's latest changes (${done}/${total})`,
      ...(current ? { detail: `Installing ${current}` } : {}),
      ...(total > 0 ? { bar: Math.min(1, done / total) } : {})
    }
  }
  if (progress?.phase === 'held')
    return {
      tone: 'warn',
      busy: false,
      text: "Out of sync: close the game to apply the owner's latest changes."
    }
  const missing = sync.missing ?? []
  if (missing.length > 0 || sync.behind) {
    const tally = followerTally(sync)
    return {
      tone: 'warn',
      busy: false,
      text: tally
        ? `Out of sync: ${tally.have}/${tally.total} of the owner's mods installed.`
        : "Out of sync: some of the owner's mods aren't installed.",
      detail: [missing.length > 0 ? `Missing: ${missing.join(', ')}` : '', BEHIND_NOTE]
        .filter(Boolean)
        .join(' '),
      syncNow: true
    }
  }
  const local = sync.local ?? []
  return {
    tone: 'muted',
    busy: false,
    text: `Up to date with the owner. ${SYNC_LOCKED_NOTE}`,
    ...(local.length > 0
      ? { detail: `Only on the owner's PC (local files never sync): ${local.join(', ')}` }
      : {})
  }
}

/** Badge classes per tone, matching the mod list's badges. */
export const SYNC_TONE_CLASS: Record<SyncTone, string> = {
  teal: 'text-teal bg-teal/10',
  warn: 'text-warn bg-warn/10',
  muted: 'text-muted bg-muted/10'
}

/** A profile that follows someone else's sync code; its mods are locked. */
export function isFollower(p: ProfileManifest | null | undefined): boolean {
  return p?.sync?.role === 'follower'
}

/** A profile that publishes its own sync code. */
export function isOwner(p: ProfileManifest | null | undefined): boolean {
  return p?.sync?.role === 'owner'
}
