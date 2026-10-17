import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readJson, writeJsonAtomic } from '../store/json'
import { steamArtUrl } from './protocol'

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
 * The portrait cover Steam's client cached for an app: `<appid>/library_600x900.jpg`, else the
 * newest `<appid>/<hash>/library_capsule.jpg` (the current layout), else the legacy flat
 * `<appid>_library_600x900.jpg`. Null when there is none or the id isn't numeric.
 */
export async function findLibraryCover(steamRoot: string, appId: string): Promise<string | null> {
  if (!isAppId(appId)) return null
  const cache = path.join(steamRoot, 'appcache', 'librarycache')
  const appDir = path.join(cache, appId)
  const portrait = path.join(appDir, 'library_600x900.jpg')
  if (await isFile(portrait)) return portrait
  const entries = await fs.readdir(appDir, { withFileTypes: true }).catch(() => [])
  let best: { file: string; mtime: number } | null = null
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const file = path.join(appDir, e.name, 'library_capsule.jpg')
    const stat = await fs.stat(file).catch(() => null)
    if (stat?.isFile() && (!best || stat.mtimeMs > best.mtime)) {
      best = { file, mtime: stat.mtimeMs }
    }
  }
  if (best) return best.file
  const legacy = path.join(cache, `${appId}_library_600x900.jpg`)
  return (await isFile(legacy)) ? legacy : null
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

interface CachedCover {
  url: string | null
  at: number
}

export interface SteamArt {
  /**
   * Cover URLs to try in order for each numeric app id: the Steam client's cached cover (served
   * as `hml-art://steam/<appid>`), the store's capsule, then the old CDN URL. Never throws.
   */
  covers(appIds: string[]): Promise<Map<string, string[]>>
}

export function createSteamArt(opts: {
  fetch: typeof fetch
  getSteamRoot(): Promise<string | null>
  cacheFile: string
  now?: () => number
}): SteamArt {
  const now = opts.now ?? Date.now
  let loaded: Promise<Map<string, CachedCover>> | null = null
  const inFlight = new Map<string, Promise<void>>()
  let failedAt = -Infinity

  const load = (): Promise<Map<string, CachedCover>> => {
    loaded ??= readJson<{ items?: Record<string, CachedCover> }>(opts.cacheFile)
      .catch(() => null)
      .then((j) => {
        const m = new Map<string, CachedCover>()
        for (const [id, v] of Object.entries(j?.items ?? {})) {
          if (isAppId(id) && v && typeof v.at === 'number') {
            m.set(id, { url: typeof v.url === 'string' ? v.url : null, at: v.at })
          }
        }
        return m
      })
    return loaded
  }

  const fresh = (c: CachedCover | undefined): boolean =>
    !!c && now() - c.at < (c.url ? FOUND_MAX_AGE_MS : MISSING_MAX_AGE_MS)

  async function fetchBatch(ids: string[], cache: Map<string, CachedCover>): Promise<void> {
    try {
      const res = await opts.fetch(storeItemsUrl(ids), {
        signal: AbortSignal.timeout(STORE_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const found = parseStoreCovers(await res.json())
      const at = now()
      for (const id of ids) cache.set(id, { url: found.get(id) ?? null, at })
      await writeJsonAtomic(
        opts.cacheFile,
        { items: Object.fromEntries(cache) },
        { pretty: false }
      ).catch(() => undefined)
    } catch {
      failedAt = now()
    }
  }

  /** Fetches the ids whose store capsule isn't cached (or is old), sharing in-flight requests. */
  async function refresh(ids: string[], cache: Map<string, CachedCover>): Promise<void> {
    const waits: Promise<void>[] = []
    const wanted: string[] = []
    for (const id of ids) {
      const pending = inFlight.get(id)
      if (pending) waits.push(pending)
      else if (!fresh(cache.get(id))) wanted.push(id)
    }
    if (wanted.length > 0 && now() - failedAt >= FAILED_RETRY_MS) {
      for (let i = 0; i < wanted.length; i += STORE_BATCH) {
        const batch = wanted.slice(i, i + STORE_BATCH)
        const p = fetchBatch(batch, cache).finally(() => {
          for (const id of batch) if (inFlight.get(id) === p) inFlight.delete(id)
        })
        for (const id of batch) inFlight.set(id, p)
        waits.push(p)
      }
    }
    await Promise.all(waits)
  }

  return {
    async covers(appIds) {
      const ids = [...new Set(appIds.filter(isAppId))]
      const out = new Map<string, string[]>()
      if (ids.length === 0) return out
      const cache = await load()
      const root = await opts.getSteamRoot().catch(() => null)
      const [local] = await Promise.all([
        Promise.all(ids.map((id) => (root ? findLibraryCover(root, id) : Promise.resolve(null)))),
        refresh(ids, cache)
      ])
      ids.forEach((id, i) => {
        const store = cache.get(id)?.url
        out.set(id, [
          ...(local[i] ? [steamArtUrl(id)] : []),
          ...(store ? [store] : []),
          steamCdnCover(id)
        ])
      })
      return out
    }
  }
}
