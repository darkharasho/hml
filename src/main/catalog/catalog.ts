import { promises as fs } from 'node:fs'
import type { Catalog } from '../../shared/types'
import type { AppPaths } from '../store/paths'
import { readJson, writeJsonAtomic } from '../store/json'
import { isSupportedLoader, parseEcosystem } from './ecosystem'

export const SCHEMA_URL = 'https://thunderstore.io/api/experimental/schema/dev/latest/'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function readCache(paths: AppPaths, nowMs: number): Promise<Catalog | null> {
  let cached: Catalog | null
  try {
    cached = await readJson<Catalog>(paths.schemaCache)
  } catch (e) {
    console.warn(`Catalog cache unreadable: ${msg(e)}`)
    return null
  }
  if (!cached || typeof cached !== 'object') return null
  if (!Array.isArray(cached.games) || typeof cached.fetchedAt !== 'string') return null
  const ms = Date.parse(cached.fetchedAt)
  if (Number.isNaN(ms) || ms > nowMs) return null
  // Support is this version's call, not the one that wrote the cache.
  return {
    ...cached,
    games: cached.games.map((g) => ({ ...g, supported: isSupportedLoader(g.loader) }))
  }
}

export async function loadCatalog(
  paths: AppPaths,
  fetchFn: typeof fetch,
  snapshotPath: string,
  maxAgeMs = 86_400_000,
  now: () => number = Date.now
): Promise<Catalog> {
  const cached = await readCache(paths, now())
  if (cached && now() - Date.parse(cached.fetchedAt) < maxAgeMs) return cached

  let catalog: Catalog | null = null
  try {
    const res = await fetchFn(SCHEMA_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    catalog = { ...parseEcosystem(await res.json()), fetchedAt: new Date(now()).toISOString() }
  } catch (e) {
    console.warn(`Catalog fetch failed, using fallback: ${msg(e)}`)
  }
  if (catalog) {
    try {
      await writeJsonAtomic(paths.schemaCache, catalog)
    } catch (e) {
      console.warn(`Catalog cache write failed: ${msg(e)}`)
    }
    return catalog
  }
  if (cached) return cached
  return parseEcosystem(JSON.parse(await fs.readFile(snapshotPath, 'utf8')))
}
