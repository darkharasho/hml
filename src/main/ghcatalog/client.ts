import type { CatalogEntry, CatListResult, ServedBlocklist } from '../../shared/ghCatalog'
import { readJson, writeJsonAtomic } from '../store/json'

export const CATALOG_MAX_AGE_MS = 30 * 60_000
const TIMEOUT_MS = 20_000

export interface CatalogClientOptions {
  fetch: typeof fetch
  /** Base URL of the Worker; routes live under /v1/catalog/. */
  base: string
  now: () => number
  /** Cache file of this game's index. */
  indexFile: string
  blocklistFile: string
}

interface IndexCache {
  fetchedAt: string
  etag: string | null
  mods: CatalogEntry[]
}

interface BlocklistCache {
  fetchedAt: string
  list: ServedBlocklist
}

const root = (o: { base: string }): string => `${o.base.replace(/\/+$/, '')}/v1/catalog`

/** GET with a timeout; null on a network error. */
async function get(
  o: Pick<CatalogClientOptions, 'fetch'>,
  url: string,
  headers: Record<string, string> = {}
): Promise<Response | null> {
  try {
    return await o.fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    return null
  }
}

async function jsonBody(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text())
  } catch {
    return null
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function validCache(c: unknown): c is IndexCache {
  return (
    isObject(c) &&
    typeof c.fetchedAt === 'string' &&
    Array.isArray(c.mods) &&
    !Number.isNaN(+new Date(c.fetchedAt))
  )
}

/**
 * The game's index: from the cache while it is under 30 minutes old, else revalidated against the
 * Worker. Offline (network error, bad status or garbage body) serves the cache. Never throws.
 */
export async function loadCatalogIndex(
  o: CatalogClientOptions,
  game: string,
  force = false
): Promise<CatListResult> {
  const stored = await readJson<unknown>(o.indexFile).catch(() => null)
  const cache = validCache(stored) ? stored : null
  const cached = (offline: boolean): CatListResult =>
    cache
      ? { mods: cache.mods, fetchedAt: cache.fetchedAt, offline }
      : { mods: [], fetchedAt: null, offline }

  const now = o.now()
  if (!force && cache && now - Date.parse(cache.fetchedAt) < CATALOG_MAX_AGE_MS)
    return cached(false)

  const headers: Record<string, string> = {}
  if (cache?.etag) headers['if-none-match'] = cache.etag
  const res = await get(o, `${root(o)}/${encodeURIComponent(game)}`, headers)
  if (!res) return cached(true)

  const fetchedAt = new Date(now).toISOString()
  try {
    if (res.status === 304 && cache) {
      const next: IndexCache = { ...cache, fetchedAt }
      await writeJsonAtomic(o.indexFile, next, { pretty: false })
      return { mods: next.mods, fetchedAt, offline: false }
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined)
      return cached(true)
    }
    const body = await jsonBody(res)
    if (!isObject(body) || !Array.isArray(body.mods)) return cached(true)
    const next: IndexCache = {
      fetchedAt,
      etag: res.headers.get('etag'),
      mods: body.mods as CatalogEntry[]
    }
    await writeJsonAtomic(o.indexFile, next, { pretty: false })
    return { mods: next.mods, fetchedAt, offline: false }
  } catch {
    return cached(true)
  }
}

/** The blocklist, refetched when the cached copy is over 30 minutes old; null with none at all. */
async function loadBlocklist(o: CatalogClientOptions): Promise<ServedBlocklist | null> {
  const stored = await readJson<BlocklistCache>(o.blocklistFile).catch(() => null)
  const cache =
    isObject(stored) &&
    typeof stored.fetchedAt === 'string' &&
    isObject(stored.list) &&
    Array.isArray(stored.list.entries)
      ? (stored as BlocklistCache)
      : null
  const now = o.now()
  if (cache && now - Date.parse(cache.fetchedAt) < CATALOG_MAX_AGE_MS) return cache.list

  const res = await get(o, `${root(o)}/blocklist`)
  if (res?.ok) {
    const body = await jsonBody(res)
    if (isObject(body) && Array.isArray(body.entries)) {
      const list = body as unknown as ServedBlocklist
      await writeJsonAtomic(o.blocklistFile, {
        fetchedAt: new Date(now).toISOString(),
        list
      } satisfies BlocklistCache).catch(() => undefined)
      return list
    }
  } else {
    void res?.body?.cancel().catch(() => undefined)
  }
  return cache?.list ?? null
}

/**
 * Why HML blocks this repo, or null. Matches `owner/repo` and a bare `owner` entry,
 * case-insensitively. Offline it uses the cached copy; with none it fails open (null).
 */
export async function blockedReason(
  o: CatalogClientOptions,
  owner: string,
  repo: string
): Promise<string | null> {
  const list = await loadBlocklist(o)
  if (!list) return null
  const names = [`${owner}/${repo}`.toLowerCase(), owner.toLowerCase()]
  for (const e of list.entries) {
    if (Array.isArray(e?.names) && e.names.some((n) => names.includes(String(n).toLowerCase())))
      return e.reason
  }
  return null
}
