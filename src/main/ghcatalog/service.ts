import type { CatalogEntry, CatListResult, RepoStatus } from '../../shared/ghCatalog'
import { OWNER_RE, REPO_RE } from '../../shared/ghCatalog'
import type { AppPaths } from '../store/paths'
import { readJson } from '../store/json'
import {
  blockedReason as blockedReasonOf,
  loadCatalogIndex,
  type CatalogClientOptions
} from './client'

const README_HOST = 'https://raw.githubusercontent.com/'
const MAX_README_BYTES = 1024 * 1024
const TIMEOUT_MS = 20_000

export interface CatalogServiceDeps {
  paths: AppPaths
  fetch: typeof fetch
  shareBaseUrl: string
  now?: () => number
}

export interface CatalogServices {
  catList(game: string, force?: boolean): Promise<CatListResult>
  catReadme(game: string, key: string): Promise<string>
  catStatus(ownerRepo: string): Promise<RepoStatus | null>
  /** Disk cache only, no fetch. `prefix` is the entry's tagPrefix ('' when it has none). */
  cachedEntry(
    game: string,
    owner: string,
    repo: string,
    prefix: string
  ): Promise<CatalogEntry | null>
  /** Null when not blocked, or when offline with no cached blocklist (fails open). */
  blockedReason(owner: string, repo: string): Promise<string | null>
}

export function createCatalogServices(deps: CatalogServiceDeps): CatalogServices {
  const client = (game: string): CatalogClientOptions => ({
    fetch: deps.fetch,
    base: deps.shareBaseUrl,
    now: deps.now ?? Date.now,
    indexFile: deps.paths.catalogCache(game),
    blocklistFile: deps.paths.catalogBlocklist
  })

  const list = (game: string, force?: boolean): Promise<CatListResult> =>
    loadCatalogIndex(client(game), game, force === true)

  /** Reads the disk cache only; never fetches. */
  async function cachedEntry(
    game: string,
    owner: string,
    repo: string,
    prefix: string
  ): Promise<CatalogEntry | null> {
    const cache = await readJson<{ mods?: unknown }>(deps.paths.catalogCache(game)).catch(
      () => null
    )
    if (!cache || !Array.isArray(cache.mods)) return null
    const o = owner.toLowerCase()
    const r = repo.toLowerCase()
    return (
      (cache.mods as CatalogEntry[]).find(
        (m) =>
          m.owner.toLowerCase() === o &&
          m.repo.toLowerCase() === r &&
          (m.tagPrefix ?? '') === prefix
      ) ?? null
    )
  }

  return {
    catList: list,
    cachedEntry,
    blockedReason: (owner: string, repo: string): Promise<string | null> =>
      blockedReasonOf(client('blocklist'), owner, repo),

    async catReadme(game: string, key: string): Promise<string> {
      const { mods } = await cachedMods(game)
      const url = mods.find((m) => m.key === key)?.readme
      if (!url || !url.startsWith(README_HOST)) throw new Error('This mod has no README to show.')
      const res = await deps.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined)
        throw new Error("The README couldn't be loaded.")
      }
      return readCapped(res, MAX_README_BYTES)
    },

    async catStatus(ownerRepo: string): Promise<RepoStatus | null> {
      const [owner, repo, ...extra] = ownerRepo.split('/')
      if (extra.length > 0 || !OWNER_RE.test(owner ?? '') || !REPO_RE.test(repo ?? '')) return null
      try {
        const res = await deps.fetch(
          `${deps.shareBaseUrl.replace(/\/+$/, '')}/v1/catalog/status/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
          { signal: AbortSignal.timeout(TIMEOUT_MS) }
        )
        if (!res.ok) {
          void res.body?.cancel().catch(() => undefined)
          return null
        }
        const body = (await res.json()) as unknown
        return typeof body === 'object' && body !== null ? (body as RepoStatus) : null
      } catch {
        return null
      }
    }
  }

  async function cachedMods(game: string): Promise<CatListResult> {
    const cache = await readJson<{ mods?: unknown }>(deps.paths.catalogCache(game)).catch(
      () => null
    )
    if (cache && Array.isArray(cache.mods))
      return { mods: cache.mods as CatalogEntry[], fetchedAt: null, offline: false }
    return list(game)
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < max) {
    const { done, value } = await reader.read()
    if (done) break
    const take = value.subarray(0, max - total)
    chunks.push(take)
    total += take.byteLength
  }
  void reader.cancel().catch(() => undefined)
  return new TextDecoder().decode(Buffer.concat(chunks))
}
