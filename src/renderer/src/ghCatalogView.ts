import type { CatalogEntry } from '../../shared/ghCatalog'
import { isNewerTag, normPrefix, samePrefix, tagPrefix } from '../../shared/ghTag'
import type { InstalledMod } from '../../shared/types'

export type CatSort = 'updated' | 'downloads' | 'stars' | 'newest'

export const CAT_SORTS: { value: CatSort; label: string }[] = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'downloads', label: 'Most downloaded' },
  { value: 'stars', label: 'Most stars' },
  { value: 'newest', label: 'Newest' }
]

/** Where authors learn how to list a mod in the catalog. */
export const CATALOG_DOCS_URL = 'https://github.com/darkharasho/hml/blob/main/docs/catalog.md'

const time = (iso: string): number => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

const SORT_KEY: Record<CatSort, (m: CatalogEntry) => number> = {
  updated: (m) => time(m.latest.publishedAt),
  downloads: (m) => m.downloads,
  stars: (m) => m.stars,
  newest: (m) => time(m.repoCreatedAt)
}

/** The catalog entries matching a search, category and NSFW choice, in the chosen order. */
export function filterCatalog(
  mods: CatalogEntry[],
  q: { text: string; category: string | null; sort: CatSort; nsfw: boolean }
): CatalogEntry[] {
  const needle = q.text.trim().toLowerCase()
  const category = q.category?.toLowerCase() ?? null
  const key = SORT_KEY[q.sort]
  return mods
    .filter(
      (m) =>
        (q.nsfw || !m.nsfw) &&
        (category === null || m.categories.some((c) => c.toLowerCase() === category)) &&
        (!needle ||
          [m.name, m.description, m.owner, ...m.categories].some((s) =>
            s.toLowerCase().includes(needle)
          ))
    )
    .sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name))
}

/** Every category in the catalog once, alphabetically. */
export function catCategories(mods: CatalogEntry[]): string[] {
  const seen = new Map<string, string>()
  for (const m of mods)
    for (const c of m.categories) if (!seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c)
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/**
 * The profile's copy of a catalog mod: same repo and, for an entry with a tagPrefix (a monorepo),
 * the same tag prefix. A repo of one mod matches whatever prefix its tags have.
 */
export function findCatInstalled(
  entry: CatalogEntry,
  installed: InstalledMod[]
): (InstalledMod & { source: { kind: 'github'; tag: string } }) | undefined {
  const prefix = typeof entry.tagPrefix === 'string' ? normPrefix(entry.tagPrefix) : null
  return installed.find(
    (m): m is InstalledMod & { source: { kind: 'github'; tag: string } } =>
      m.source.kind === 'github' &&
      m.source.owner.toLowerCase() === entry.owner.toLowerCase() &&
      m.source.repo.toLowerCase() === entry.repo.toLowerCase() &&
      (prefix === null || samePrefix(tagPrefix(m.source.tag), prefix))
  )
}

/** True when the catalog lists the mod from a pre-release (it has no stable release). */
export const listedFromPrerelease = (entry: CatalogEntry): boolean =>
  entry.latest.prerelease === true

export function catInstallState(
  entry: CatalogEntry,
  installed: InstalledMod[]
): 'none' | 'installed' | 'update' {
  const mod = findCatInstalled(entry, installed)
  if (!mod) return 'none'
  return isNewerTag(entry.latest.tag, mod.source.tag) ? 'update' : 'installed'
}

/** "a", "a and b", "a, b and c". */
export function joinOwners(owners: string[]): string {
  if (owners.length <= 1) return owners.join('')
  return `${owners.slice(0, -1).join(', ')} and ${owners[owners.length - 1]}`
}

export const CONFIRM_OWNERS_TITLE = 'Install from an unvetted author?'

export function confirmOwnersBody(owners: string[]): string {
  return `${joinOwners(owners)} publish${owners.length === 1 ? 'es' : ''} on GitHub, not Thunderstore or Nexus Mods. HML doesn't review GitHub mods. Only install mods from authors you trust.`
}

export function catReportUrl(owner: string, repo: string): string {
  return `https://github.com/darkharasho/hml/issues/new?template=catalog-report.yml&title=${encodeURIComponent(`Report: ${owner}/${repo}`)}`
}

export const catRepoUrl = (entry: Pick<CatalogEntry, 'owner' | 'repo'>): string =>
  `https://github.com/${entry.owner}/${entry.repo}`

/** The toast after a catalog install: the mod, how many dependencies came with it, what's missing. */
export function catInstallToast(
  entry: CatalogEntry,
  installed: InstalledMod[],
  unavailable: string[]
): { kind: 'success' | 'info'; message: string } {
  const missing = unavailable.length > 0 ? ` — missing dependencies: ${unavailable.join(', ')}` : ''
  if (installed.length === 0) {
    return { kind: 'info', message: `${entry.name} is already installed${missing}` }
  }
  const target = findCatInstalled(entry, installed)
  const deps = installed.length - (target ? 1 : 0)
  const what = target ? `${target.name} ${target.version}` : entry.name
  const also = deps > 0 ? ` and ${deps} ${deps === 1 ? 'dependency' : 'dependencies'}` : ''
  return { kind: missing ? 'info' : 'success', message: `Installed ${what}${also}${missing}` }
}
