import type { TsPackage, TsQuery } from '../../shared/types'

function haystack(p: TsPackage): string {
  const name = p.name.toLowerCase()
  return [
    name,
    name.replace(/_/g, ' '),
    name.replace(/_/g, ''),
    p.owner.toLowerCase(),
    p.fullName.toLowerCase(),
    p.description.toLowerCase()
  ].join('\n')
}

type Cmp = (a: TsPackage, b: TsPackage) => number

const COMPARATORS: Record<TsQuery['sort'], Cmp> = {
  top: (a, b) =>
    Number(b.isPinned) - Number(a.isPinned) ||
    b.rating - a.rating ||
    b.totalDownloads - a.totalDownloads,
  downloads: (a, b) => b.totalDownloads - a.totalDownloads,
  updated: (a, b) => (a.dateUpdated < b.dateUpdated ? 1 : a.dateUpdated > b.dateUpdated ? -1 : 0),
  name: (a, b) => {
    const x = a.name.toLowerCase()
    const y = b.name.toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  }
}

/** Pure: one filter pass, then a stable sort (ties keep index order). */
export function searchPackages(
  pkgs: TsPackage[],
  q: TsQuery
): { items: TsPackage[]; total: number } {
  const terms = q.text.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = pkgs.filter((p) => {
    if (p.isDeprecated && !q.includeDeprecated) return false
    if (p.nsfw && !q.includeNsfw) return false
    for (const c of q.categories) if (!p.categories.includes(c)) return false
    if (terms.length === 0) return true
    const h = haystack(p)
    return terms.every((t) => h.includes(t))
  })
  matches.sort(COMPARATORS[q.sort])
  const limit = Math.min(100, Math.max(1, Math.floor(q.limit) || 1))
  const offset = Math.max(0, Math.floor(q.offset) || 0)
  return { items: matches.slice(offset, offset + limit), total: matches.length }
}

export function allCategories(pkgs: TsPackage[]): string[] {
  const set = new Set<string>()
  for (const p of pkgs) for (const c of p.categories) set.add(c)
  return [...set].sort()
}
