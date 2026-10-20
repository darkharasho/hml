import type { ProfileManifest, ProfileSync, SyncChangeSummary } from '../../shared/types'

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

/** The sidebar badge for a profile's sync role; null for a plain profile. */
export function syncBadge(sync: ProfileSync | undefined): {
  label: 'Syncing' | 'Sync pending' | "Can't sync" | 'Synced' | 'Missing mods'
  tone: SyncTone
  /** Tooltip explaining a warning. */
  title?: string
} | null {
  if (!sync) return null
  if (sync.role === 'follower')
    return sync.behind
      ? { label: 'Missing mods', tone: 'warn', title: BEHIND_NOTE }
      : { label: 'Synced', tone: 'muted' }
  // An orphaned code can't be published at all, which matters more than a publish that's due.
  if (sync.orphaned) return { label: "Can't sync", tone: 'warn', title: ORPHANED_NOTE }
  if (sync.pending) return { label: 'Sync pending', tone: 'warn' }
  return { label: 'Syncing', tone: 'teal' }
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
