// Pure display helpers for the GitHub views. No DOM, no store, so they unit-test in node.
import type { GhUpdateMode, InstalledMod } from '../../shared/types'

const UNITS = ['KB', 'MB', 'GB', 'TB']

/** 512 -> "512 B", 1536 -> "1.5 KB", 12.3 MiB -> "12.3 MB". */
export function formatBytes(n: number): string {
  const bytes = Math.max(0, Math.round(n))
  if (bytes < 1024) return `${bytes} B`
  let value = bytes / 1024
  let unit = 0
  // Compare the rounded value so 1023.96 KB reads "1.0 MB", not "1024.0 KB".
  while (Number(value.toFixed(1)) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`
}

const MODE_LABELS: Record<GhUpdateMode, string> = {
  auto: 'Auto-install updates',
  notify: 'Notify only',
  pinned: 'Pinned'
}

export const UPDATE_MODES = Object.keys(MODE_LABELS) as GhUpdateMode[]

export function updateModeLabel(m: GhUpdateMode): string {
  return MODE_LABELS[m]
}

export function githubRepoUrl(source: { owner: string; repo: string }): string {
  return `https://github.com/${source.owner}/${source.repo}`
}

/** "owner/repo · v1.2.0", with " · Notify only" or " · Pinned" when updates aren't automatic. */
export function ghSubline(
  source: { owner: string; repo: string; tag: string },
  mode: GhUpdateMode
): string {
  const base = `${source.owner}/${source.repo} · ${source.tag}`
  return mode === 'auto' ? base : `${base} · ${MODE_LABELS[mode]}`
}

/** The toast after a GitHub install. */
export function ghInstallToast(mod: InstalledMod, replaced: string[]): string {
  const pinned = mod.github?.updateMode === 'pinned' ? ' (pinned to this release)' : ''
  const swapped = replaced.length > 0 ? `, replaced ${replaced.join(', ')}` : ''
  return `Installed ${mod.name} ${mod.version}${pinned}${swapped}`
}

/** The toast after GitHub mods were updated, by hand or by the background scheduler. */
export function ghUpdatedToast(mods: { name: string; tag: string }[]): string {
  return mods.length === 1
    ? `Updated ${mods[0].name} to ${mods[0].tag}`
    : `Updated ${mods.length} GitHub mods`
}

/** True when the mod's installed GitHub release is a pre-release (older installs don't say). */
export function isPrereleaseInstall(mod: InstalledMod): boolean {
  return mod.source.kind === 'github' && mod.github?.installedPrerelease === true
}

/** True for GitHub mods that can follow pre-releases: not loader mods on a release track. */
export function canFollowPrereleases(mod: InstalledMod): boolean {
  return mod.source.kind === 'github' && !mod.github?.track
}
