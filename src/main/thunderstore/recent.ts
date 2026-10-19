import type { TsPackage, TsVersion } from '../../shared/types'

/**
 * Thunderstore's package-listing index lags its live site by an hour or more: it is rebuilt from
 * an older snapshot, then cached. The live listing (60 s cache) sorted by last update shows what
 * changed since, and each changed package's latest version comes from the experimental package
 * API. This lays those over the index, so a new mod or update shows within a couple of minutes.
 */

const LISTING = 'https://thunderstore.io/api/cyberstorm/listing/'
const PACKAGE = 'https://thunderstore.io/api/experimental/package/'
/** Live listing pages (20 packages each) read per check. Past this the index catches up. */
const MAX_PAGES = 5
const MAX_IN_FLIGHT = 3
/** Latest versions remembered, keyed by package and its last update. */
const MEMO_MAX = 2000

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const time = (s: string): number => {
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

/** The community slug in a package-listing index URL (`…/c/<slug>/api/v1/…`), or null. */
export function communityOf(indexUrl: string): string | null {
  const m =
    /^https:\/\/thunderstore\.io\/c\/([a-z0-9-]+)\/api\/v1\/package-listing-index\/?$/i.exec(
      indexUrl
    )
  return m ? m[1] : null
}

interface Listed {
  namespace: string
  name: string
  lastUpdated: string
  categories: string[]
  isPinned: boolean
  isDeprecated: boolean
  nsfw: boolean
  size: number
}

function listed(raw: unknown): Listed | null {
  if (!isObj(raw)) return null
  const namespace = str(raw.namespace)
  const name = str(raw.name)
  const lastUpdated = str(raw.last_updated)
  if (!namespace || !name || !lastUpdated) return null
  return {
    namespace,
    name,
    lastUpdated,
    categories: Array.isArray(raw.categories)
      ? raw.categories.flatMap((c) => (isObj(c) && typeof c.name === 'string' ? [c.name] : []))
      : [],
    isPinned: raw.is_pinned === true,
    isDeprecated: raw.is_deprecated === true,
    nsfw: raw.is_nsfw === true,
    size: num(raw.size)
  }
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

/** Live listing entries updated after `since`, newest first (pinned ones may come first). */
async function changedSince(
  fetchFn: typeof fetch,
  community: string,
  since: number
): Promise<Listed[]> {
  const out: Listed[] = []
  let url: string | null =
    `${LISTING}${encodeURIComponent(community)}/?ordering=last-updated&deprecated=true&nsfw=true`
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const data = await getJson(fetchFn, url)
    if (!isObj(data) || !Array.isArray(data.results)) throw new Error('Unexpected live listing')
    let done = false
    for (const raw of data.results) {
      const l = listed(raw)
      if (!l) continue
      if (time(l.lastUpdated) > since) out.push(l)
      // Pinned packages head the list whatever their date; the rest are newest first.
      else if (!l.isPinned) done = true
    }
    const next = str(data.next)
    url = done || !next.startsWith(LISTING) ? null : next
  }
  return out
}

/** A changed package, rebuilt from its latest version and what the index already had. */
function rebuild(
  l: Listed,
  raw: unknown,
  community: string,
  old: TsPackage | undefined
): TsPackage | null {
  if (!isObj(raw) || !isObj(raw.latest)) return null
  const v = raw.latest
  const version = str(v.version_number)
  if (!version || v.is_active === false) return null
  const latest: TsVersion = {
    version,
    dependencies: Array.isArray(v.dependencies)
      ? v.dependencies.filter((d): d is string => typeof d === 'string')
      : [],
    downloadUrl: str(v.download_url),
    downloads: num(v.downloads),
    fileSize: l.size,
    dateCreated: str(v.date_created)
  }
  if (!latest.downloadUrl) return null
  const versions = [latest, ...(old?.versions ?? []).filter((x) => x.version !== version)]
  return {
    fullName: `${l.namespace}-${l.name}`,
    owner: l.namespace,
    name: l.name,
    description: str(v.description),
    iconUrl: str(v.icon),
    websiteUrl: str(v.website_url),
    packageUrl:
      old?.packageUrl ??
      `https://thunderstore.io/c/${community}/p/${encodeURIComponent(l.namespace)}/${encodeURIComponent(l.name)}/`,
    categories: l.categories.length > 0 ? l.categories : (old?.categories ?? []),
    rating: num(raw.rating_score),
    totalDownloads: num(raw.total_downloads) || versions.reduce((n, x) => n + x.downloads, 0),
    dateUpdated: l.lastUpdated,
    isPinned: l.isPinned,
    isDeprecated: l.isDeprecated,
    nsfw: l.nsfw,
    versions
  }
}

export interface RecentOverlay {
  /** Packages after the overlay: the index's, with changed ones replaced and new ones added. */
  packages: TsPackage[]
  /** How many packages the overlay changed or added. */
  changed: number
}

/**
 * Brings an index's packages up to date with the live site. `memo` keeps latest versions between
 * checks, so a repeat check costs only the listing pages. Throws when Thunderstore can't be
 * reached; the caller keeps the index as it is.
 */
export async function overlayRecent(opts: {
  packages: TsPackage[]
  community: string
  fetch: typeof fetch
  memo: Map<string, TsPackage | null>
}): Promise<RecentOverlay> {
  const { packages, community, fetch: fetchFn, memo } = opts
  let since = 0
  for (const p of packages) since = Math.max(since, time(p.dateUpdated))
  const changed = await changedSince(fetchFn, community, since)
  if (changed.length === 0) return { packages, changed: 0 }

  const byName = new Map(packages.map((p) => [p.fullName, p]))
  const fresh = new Map<string, TsPackage>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < changed.length) {
      const l = changed[next++]
      const fullName = `${l.namespace}-${l.name}`
      const key = `${community}/${fullName}@${l.lastUpdated}`
      let pkg = memo.get(key)
      if (pkg === undefined) {
        const url = `${PACKAGE}${encodeURIComponent(l.namespace)}/${encodeURIComponent(l.name)}/`
        const raw = await getJson(fetchFn, url).catch(() => undefined)
        // A failed fetch isn't remembered, so the next check tries again.
        if (raw === undefined) continue
        pkg = rebuild(l, raw, community, byName.get(fullName))
        if (memo.size >= MEMO_MAX) memo.clear()
        memo.set(key, pkg)
      }
      if (pkg) fresh.set(fullName, pkg)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, changed.length) }, worker))
  if (fresh.size === 0) return { packages, changed: 0 }

  // Rebuilt from the index's own entry, so carry over versions the memo's copy may predate.
  const merged = packages.map((p) => {
    const f = fresh.get(p.fullName)
    if (!f) return p
    const known = new Set(f.versions.map((v) => v.version))
    return { ...f, versions: [...f.versions, ...p.versions.filter((v) => !known.has(v.version))] }
  })
  const added = [...fresh.values()].filter((f) => !byName.has(f.fullName))
  return { packages: [...added, ...merged], changed: fresh.size }
}
