import type { HmlEvent, ImportResult, ModSource, SharePreview } from '../../shared/types'

/** Source badges for a shared mod list; colors match the mod list's badges. */
export const SHARE_SOURCE_BADGE: Record<ModSource['kind'], { label: string; className: string }> = {
  thunderstore: { label: 'Thunderstore', className: 'text-[#79b8ff] bg-[#79b8ff]/10' },
  github: { label: 'GitHub', className: 'text-fg bg-fg/10' },
  nexus: { label: 'Nexus', className: 'text-warn bg-warn/10' },
  local: { label: 'Local', className: 'text-muted bg-muted/10' }
}

/** The Share dialog's note about local mods, which can't travel with a code; null when there are none. */
export function localModsNote(localMods: number): string | null {
  if (localMods <= 0) return null
  return localMods === 1
    ? "1 local mod won't be included. Others will see it as missing."
    : `${localMods} local mods won't be included. Others will see them as missing.`
}

/** Shown in the Share dialog when the code can't be put on the clipboard. */
export const COPY_FAILED = "Couldn't copy. Select the code and copy it manually."

/** The headline of an import's result. */
export function importSummary(result: ImportResult): string {
  const total = result.installed + result.unresolved.length
  return `Imported ${result.installed} of ${total} ${total === 1 ? 'mod' : 'mods'}.`
}

/** The import result's line about Nexus mods waiting in the new profile. */
export function pendingNexusNote(n: number): string {
  const what =
    n === 1
      ? '1 Nexus mod needs a download from its page'
      : `${n} Nexus mods need downloads from their pages`
  return `${what}. The profile lists ${n === 1 ? 'it' : 'them'}, and HML's Nexus Mods window installs ${n === 1 ? 'it' : 'each one'} when you click "Mod Manager Download".`
}

/** The import result's button that opens the new profile's Nexus mods in HML's window. */
export function installNexusLabel(n: number): string {
  return n === 1 ? 'Install Nexus mod' : `Install ${n} Nexus mods`
}

const IMPORTING = 'Importing '

/**
 * Reads an import's own progress events. Each mod's install emits its own events on the same
 * channel; only the `Importing …` ones count, so the bar can't jump back and forth.
 */
export function importProgress(e: HmlEvent): { label: string; done: number; total: number } | null {
  if (e.type !== 'progress' || !e.message.startsWith(IMPORTING)) return null
  return { label: `${e.message} (${e.done + 1}/${e.total})`, done: e.done, total: e.total }
}

/** Notes a shared profile that belongs to a game other than the open one. */
export function gameMismatchNote(
  preview: Pick<SharePreview, 'game' | 'gameName'>,
  currentGame: string | null
): string | null {
  if (preview.game === currentGame) return null
  // Names like R.E.P.O. already end the sentence.
  const end = preview.gameName.endsWith('.') ? '' : '.'
  return `This profile is for ${preview.gameName}${end}`
}

/** The file name at the end of a Windows or POSIX path. */
export function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}
