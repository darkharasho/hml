import { promises as fs } from 'node:fs'
import path from 'node:path'
import { steamArtUrl, steamHeroArtUrl } from './protocol'
import { createUrlCache, type CachedUrl } from './urlCache'

const STORE_API = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1'
const STORE_ASSETS = 'https://shared.steamstatic.com/store_item_assets/'
/** A store capsule is looked up again after a week; an app the store has none for, after a day. */
const FOUND_MAX_AGE_MS = 7 * 86_400_000
const MISSING_MAX_AGE_MS = 86_400_000
/** After a failed store request, ids are not asked for again for this long. */
const FAILED_RETRY_MS = 60_000
const STORE_TIMEOUT_MS = 5_000
const STORE_BATCH = 100

export const isAppId = (s: string): boolean => /^\d{1,10}$/.test(s)

/** The old fixed CDN portrait, which newer games don't have. */
export const steamCdnCover = (appId: string): string =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`

async function isFile(p: string): Promise<boolean> {
  return fs.stat(p).then(
    (s) => s.isFile(),
    () => false
  )
}

/**
 * A picture Steam's client cached for an app: `<appid>/<flat>`, else the newest
 * `<appid>/<hash>/<hashed>` (the current layout), else the legacy flat `<appid>_<flat>`.
 */
async function findLibraryFile(
  steamRoot: string,
  appId: string,
  flat: string,
  hashed: string
): Promise<string | null> {
  if (!isAppId(appId)) return null
  const cache = path.join(steamRoot, 'appcache', 'librarycache')
  const appDir = path.join(cache, appId)
  const direct = path.join(appDir, flat)
  if (await isFile(direct)) return direct
  const entries = await fs.readdir(appDir, { withFileTypes: true }).catch(() => [])
  let best: { file: string; mtime: number } | null = null
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const file = path.join(appDir, e.name, hashed)
    const stat = await fs.stat(file).catch(() => null)
    if (stat?.isFile() && (!best || stat.mtimeMs > best.mtime)) {
      best = { file, mtime: stat.mtimeMs }
    }
  }
  if (best) return best.file
  const legacy = path.join(cache, `${appId}_${flat}`)
  return (await isFile(legacy)) ? legacy : null
}

/** The portrait cover Steam's client cached for an app. Null when there is none or the id isn't numeric. */
export const findLibraryCover = (steamRoot: string, appId: string): Promise<string | null> =>
  findLibraryFile(steamRoot, appId, 'library_600x900.jpg', 'library_capsule.jpg')

/** The wide banner art Steam's client cached for an app (shown behind the launch bar). */
export const findLibraryHero = (steamRoot: string, appId: string): Promise<string | null> =>
  findLibraryFile(steamRoot, appId, 'library_hero.jpg', 'library_hero.jpg')

/**
 * Banner URLs to try in order for an app: the Steam client's cached copy, then Steam's CDN, then
 * the store's asset path (newer games only have the latter). Empty for a non-numeric id.
 */
export function steamHeroUrls(appId: string): string[] {
  if (!isAppId(appId)) return []
  return [
    steamHeroArtUrl(appId),
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_hero.jpg`,
    `${STORE_ASSETS}steam/apps/${appId}/library_hero.jpg`
  ]
}

/** One GetItems request for many apps, asking for their store assets. */
export function storeItemsUrl(appIds: string[]): string {
  const input = {
    ids: appIds.map((id) => ({ appid: Number(id) })),
    context: { language: 'english', country_code: 'US' },
    data_request: { include_assets: true }
  }
  return `${STORE_API}?input_json=${encodeURIComponent(JSON.stringify(input))}`
}

/** appid -> portrait capsule URL, or null for an item the store returned without one. */
export function parseStoreCovers(json: unknown): Map<string, string | null> {
  const out = new Map<string, string | null>()
  const items = (json as { response?: { store_items?: unknown } } | null)?.response?.store_items
  if (!Array.isArray(items)) return out
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const { appid, assets } = item as { appid?: unknown; assets?: unknown }
    if (typeof appid !== 'number' || !Number.isInteger(appid)) continue
    const a = (assets ?? {}) as { asset_url_format?: unknown; library_capsule?: unknown }
    const ok =
      typeof a.asset_url_format === 'string' &&
      a.asset_url_format.includes('${FILENAME}') &&
      typeof a.library_capsule === 'string' &&
      a.library_capsule !== ''
    out.set(
      String(appid),
      ok
        ? STORE_ASSETS +
            (a.asset_url_format as string).replace('${FILENAME}', a.library_capsule as string)
        : null
    )
  }
  return out
}

export interface SteamArt {
  /**
   * Cover URLs to try in order for each numeric app id: the Steam client's cached cover (served
   * as `hml-art://steam/<appid>`), the store's capsule, then the old CDN URL. Never waits for the
   * store: capsules not cached yet are fetched in the background for later calls. Never throws.
   */
  covers(appIds: string[]): Promise<Map<string, string[]>>
  /** Resolves once no store request is in flight. */
  idle(): Promise<void>
}

export function createSteamArt(opts: {
  fetch: typeof fetch
  getSteamRoot(): Promise<string | null>
  cacheFile: string
  now?: () => number
}): SteamArt {
  const now = opts.now ?? Date.now
  const store = createUrlCache(opts.cacheFile, isAppId)
  const inFlight = new Map<string, Promise<void>>()
  let failedAt = -Infinity

  const fresh = (c: CachedUrl | undefined): boolean =>
    !!c && now() - c.at < (c.url ? FOUND_MAX_AGE_MS : MISSING_MAX_AGE_MS)

  async function fetchBatch(ids: string[], cache: Map<string, CachedUrl>): Promise<void> {
    try {
      const res = await opts.fetch(storeItemsUrl(ids), {
        signal: AbortSignal.timeout(STORE_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const found = parseStoreCovers(await res.json())
      const at = now()
      for (const id of ids) cache.set(id, { url: found.get(id) ?? null, at })
      await store.save()
    } catch {
      failedAt = now()
    }
  }

  /** Starts fetching the ids whose store capsule isn't cached (or is old) and isn't in flight. */
  function refresh(ids: string[], cache: Map<string, CachedUrl>): void {
    const wanted = ids.filter((id) => !inFlight.has(id) && !fresh(cache.get(id)))
    if (wanted.length === 0 || now() - failedAt < FAILED_RETRY_MS) return
    for (let i = 0; i < wanted.length; i += STORE_BATCH) {
      const batch = wanted.slice(i, i + STORE_BATCH)
      const p = fetchBatch(batch, cache).finally(() => {
        for (const id of batch) if (inFlight.get(id) === p) inFlight.delete(id)
      })
      for (const id of batch) inFlight.set(id, p)
    }
  }

  return {
    async covers(appIds) {
      const ids = [...new Set(appIds.filter(isAppId))]
      const out = new Map<string, string[]>()
      if (ids.length === 0) return out
      const cache = await store.load()
      // The store is asked in the background; its capsule shows from the next call on.
      refresh(ids, cache)
      const root = await opts.getSteamRoot().catch(() => null)
      const local = await Promise.all(
        ids.map((id) => (root ? findLibraryCover(root, id) : Promise.resolve(null)))
      )
      ids.forEach((id, i) => {
        const store = cache.get(id)?.url
        out.set(id, [
          ...(local[i] ? [steamArtUrl(id)] : []),
          ...(store ? [store] : []),
          steamCdnCover(id)
        ])
      })
      return out
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all(new Set(inFlight.values()))
    }
  }
}
