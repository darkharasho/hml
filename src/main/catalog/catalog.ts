import { promises as fs } from 'node:fs'
import type { Catalog } from '../../shared/types'
import type { AppPaths } from '../store/paths'
import { readJson, writeJsonAtomic } from '../store/json'
import { parseEcosystem } from './ecosystem'

export const SCHEMA_URL = 'https://thunderstore.io/api/experimental/schema/dev/latest/'

export async function loadCatalog(
  paths: AppPaths,
  fetchFn: typeof fetch,
  snapshotPath: string,
  maxAgeMs = 86_400_000,
  now: () => number = Date.now
): Promise<Catalog> {
  const cached = await readJson<Catalog>(paths.schemaCache)
  const fetchedMs = cached ? Date.parse(cached.fetchedAt) : NaN
  if (cached && now() - fetchedMs < maxAgeMs) return cached

  try {
    const res = await fetchFn(SCHEMA_URL)
    if (!res.ok) throw new Error(`Schema fetch failed: HTTP ${res.status}`)
    const catalog = {
      ...parseEcosystem(await res.json()),
      fetchedAt: new Date(now()).toISOString()
    }
    await writeJsonAtomic(paths.schemaCache, catalog)
    return catalog
  } catch {
    if (cached) return cached
    return parseEcosystem(JSON.parse(await fs.readFile(snapshotPath, 'utf8')))
  }
}
