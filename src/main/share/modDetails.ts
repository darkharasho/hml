import type { ModSource, ShareModDetail } from '../../shared/types'

/** Where a shared mod's icon and description come from; each may throw or answer null. */
export interface ModDetailLookups {
  thunderstore(fullName: string): Promise<ShareModDetail | null>
  github(owner: string, repo: string): Promise<ShareModDetail | null>
  nexus(domain: string, modId: number): Promise<ShareModDetail | null>
}

/** Lookups running at once. */
const CONCURRENCY = 4

/**
 * Details for each source, in order: null for a local file, a failed lookup or one with nothing
 * to show. Never throws, so one unreachable source leaves only its own mods bare.
 */
export async function describeMods(
  sources: ModSource[],
  lookups: ModDetailLookups
): Promise<(ShareModDetail | null)[]> {
  const out: (ShareModDetail | null)[] = sources.map(() => null)
  const one = (s: ModSource): Promise<ShareModDetail | null> => {
    switch (s.kind) {
      case 'thunderstore':
        return lookups.thunderstore(s.fullName)
      case 'github':
        return lookups.github(s.owner, s.repo)
      case 'nexus':
        return lookups.nexus(s.domain, s.modId)
      case 'local':
        return Promise.resolve(null)
    }
  }
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < sources.length; i = next++) {
      const d = await one(sources[i]).catch(() => null)
      out[i] = d && (d.iconUrl || d.description) ? d : null
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, worker))
  return out
}
