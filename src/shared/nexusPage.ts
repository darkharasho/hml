import type { PendingNexusMod } from './types'

/** A Nexus Mods file page; HML's Nexus window opens it with the Mod Manager Download link. */
export const nexusFilePageUrl = (domain: string, modId: number, fileId: number): string =>
  `https://www.nexusmods.com/${domain}/mods/${modId}?tab=files&file_id=${fileId}`

/** The pending Nexus mods still missing from `mods`: a mod installed at any file counts. */
export function stillPending(
  pending: readonly PendingNexusMod[] | undefined,
  mods: readonly { source: { kind: string; modId?: number; domain?: string } }[]
): PendingNexusMod[] {
  if (!pending?.length) return []
  const installed = new Set(
    mods.flatMap((m) =>
      m.source.kind === 'nexus' ? [`${m.source.domain?.toLowerCase()}/${m.source.modId}`] : []
    )
  )
  return pending.filter((p) => !installed.has(`${p.domain.toLowerCase()}/${p.modId}`))
}
