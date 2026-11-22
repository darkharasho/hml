// Resumable GitHub catalog crawl, run from the cron trigger. Free plan: at most
// CRAWL_PAGES_PER_RUN GraphQL pages per run, and KV writes only when a value's hash changed.
import type {
  BlockEntry,
  CatalogEntry,
  CatalogIndex,
  RepoStatus
} from '../../../src/shared/ghCatalog'
import { isKnownGameLabel } from '../../../src/shared/hmlManifest'
import type { Env, KvLike } from '../index'
import { isBlocked, updateBlockState, type BlockState } from './blocklist'
import { fetchSearchPage, GhGraphqlError } from './github'
import { buildStatus } from './listing'

export const CRAWL_PAGES_PER_RUN = 3
export const RETRY_PAGE_SIZE = 15
export const SCHEMA_URL = 'https://thunderstore.io/api/experimental/schema/dev/latest/'
const GAMES_MAX_AGE_MS = 86_400_000
const SEARCH_RESULT_CAP = 1000

export const KEY_STATE = 'catalog:state'
export const KEY_STATUS = 'catalog:status'
export const KEY_BLOCKLIST = 'catalog:blocklist'
export const KEY_GAMES = 'catalog:games'
export const indexKey = (game: string): string => `catalog:index:${game}`

export interface CrawlState {
  cursor: string | null
  /** This pass's statuses so far, keyed lowercase `owner/repo`. */
  pass: Record<string, RepoStatus>
  total: number
  blocks: BlockState
  /** Games that got a non-empty index at the end of the last pass. */
  indexed: string[]
}

export interface GamesCache {
  fetchedAt: string
  slugs: string[]
}

export interface Stored<T> {
  value: T | null
  hash: string | null
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Reads a JSON value and the hash stored in its metadata. Unparseable values read as null. */
export async function readStored<T>(kv: KvLike, key: string): Promise<Stored<T>> {
  const { value, metadata } = await kv.getWithMetadata<{ hash?: unknown }>(key, 'text')
  const hash = isObj(metadata) && typeof metadata.hash === 'string' ? metadata.hash : null
  if (value === null) return { value: null, hash }
  try {
    return { value: JSON.parse(value) as T, hash }
  } catch {
    return { value: null, hash }
  }
}

/**
 * Writes `value` unless the stored hash matches. The hash covers `stable` (default: the value),
 * so volatile fields such as builtAt or crawledAt alone never cause a write.
 */
async function putIfChanged(
  kv: KvLike,
  key: string,
  value: unknown,
  stable: unknown = value,
  known?: string | null
): Promise<boolean> {
  const hash = await sha256Hex(JSON.stringify(stable))
  const prev = known !== undefined ? known : (await readStored(kv, key)).hash
  if (prev === hash) return false
  await kv.put(key, JSON.stringify(value), { metadata: { hash } })
  return true
}

export async function readBlocklist(kv: KvLike): Promise<BlockEntry[]> {
  const { value } = await readStored<unknown>(kv, KEY_BLOCKLIST)
  if (!Array.isArray(value)) return []
  return value.filter(
    (e): e is BlockEntry =>
      isObj(e) && typeof e.target === 'string' && e.target !== '' && typeof e.reason === 'string'
  )
}

export function parseState(v: unknown): CrawlState {
  const s = isObj(v) ? v : {}
  return {
    cursor: typeof s.cursor === 'string' ? s.cursor : null,
    pass: isObj(s.pass) ? (s.pass as CrawlState['pass']) : {},
    total: typeof s.total === 'number' ? s.total : 0,
    blocks:
      isObj(s.blocks) && isObj(s.blocks.ids) ? (s.blocks as unknown as BlockState) : { ids: {} },
    indexed: Array.isArray(s.indexed) ? s.indexed.filter((g) => typeof g === 'string') : []
  }
}

/** Thunderstore community slugs that have an r2modman (mod loader) entry. */
export function parseSlugs(json: unknown): string[] {
  const games = isObj(json) && isObj(json.games) ? json.games : {}
  const out: string[] = []
  for (const [key, g] of Object.entries(games)) {
    if (!isObj(g) || !Array.isArray(g.r2modman) || g.r2modman.length === 0) continue
    out.push(typeof g.label === 'string' && g.label ? g.label : key)
  }
  return out
}

async function refreshSlugs(fetchFn: typeof fetch, now: number): Promise<GamesCache | null> {
  try {
    const res = await fetchFn(SCHEMA_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const slugs = parseSlugs(JSON.parse(await res.text()))
    if (slugs.length === 0) throw new Error('no communities')
    return { fetchedAt: new Date(now).toISOString(), slugs }
  } catch (e) {
    console.warn(`catalog: Thunderstore schema fetch failed: ${(e as Error).message}`)
    return null
  }
}

function knownGame(games: GamesCache | null): (label: string) => boolean {
  if (!games) return (l) => /^[a-z0-9-]+$/.test(l) // fail open until a slug list is cached
  const set = new Set(games.slugs)
  return (l) => isKnownGameLabel(l, set)
}

type Page = Awaited<ReturnType<typeof fetchSearchPage>>

/** One page, retried once at a smaller size on a GitHub gateway timeout. Null stops the run. */
async function fetchPage(
  fetchFn: typeof fetch,
  token: string,
  cursor: string | null
): Promise<Page | null> {
  try {
    return await fetchSearchPage(fetchFn, token, cursor)
  } catch (e) {
    if (e instanceof GhGraphqlError && (e.status === 502 || e.status === 504)) {
      try {
        return await fetchSearchPage(fetchFn, token, cursor, RETRY_PAGE_SIZE)
      } catch (e2) {
        console.warn(`catalog: page retry failed, resuming next run: ${(e2 as Error).message}`)
        return null
      }
    }
    console.warn(`catalog: page failed, resuming next run: ${(e as Error).message}`)
    return null
  }
}

const stripCrawledAt = (
  s: Record<string, RepoStatus>
): Record<string, Omit<RepoStatus, 'crawledAt'>> =>
  Object.fromEntries(
    Object.entries(s).map(([k, v]) => {
      const rest: Partial<RepoStatus> = { ...v }
      delete rest.crawledAt
      return [k, rest as Omit<RepoStatus, 'crawledAt'>]
    })
  )

/** Writes per-game indexes and the status map for a finished pass. Returns the write count and indexed games. */
async function finishPass(
  kv: KvLike,
  state: CrawlState,
  builtAt: string
): Promise<{ writes: number; indexed: string[] }> {
  const byGame = new Map<string, CatalogEntry[]>()
  for (const status of Object.values(state.pass))
    for (const entry of status.listed)
      for (const game of new Set(entry.games)) {
        const list = byGame.get(game) ?? []
        list.push(entry)
        byGame.set(game, list)
      }
  for (const game of state.indexed) if (!byGame.has(game)) byGame.set(game, [])
  let writes = 0
  for (const [game, mods] of byGame) {
    mods.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const index: CatalogIndex = { game, builtAt, mods }
    if (await putIfChanged(kv, indexKey(game), index, { game, mods })) writes++
  }
  if (await putIfChanged(kv, KEY_STATUS, state.pass, stripCrawledAt(state.pass))) writes++
  const indexed = [...byGame]
    .filter(([, mods]) => mods.length > 0)
    .map(([g]) => g)
    .sort()
  return { writes, indexed }
}

export async function runCrawl(
  env: Env,
  fetchFn: typeof fetch,
  now: () => number
): Promise<{ pages: number; repos: number; finishedPass: boolean; writes: number }> {
  const started = now()
  const kv = env.PROFILES
  let pages = 0
  let repos = 0
  let writes = 0
  let finishedPass = false
  const done = (): { pages: number; repos: number; finishedPass: boolean; writes: number } => {
    console.log(JSON.stringify({ catalog: 'run', pages, repos, writes, ms: now() - started }))
    return { pages, repos, finishedPass, writes }
  }

  let games = (await readStored<GamesCache>(kv, KEY_GAMES)).value
  if (!isObj(games) || !Array.isArray(games.slugs)) games = null
  if (!games || !(started - Date.parse(games.fetchedAt) <= GAMES_MAX_AGE_MS)) {
    const fresh = await refreshSlugs(fetchFn, started)
    if (fresh) {
      if (await putIfChanged(kv, KEY_GAMES, fresh)) writes++
      return done() // parsing the schema is this run's CPU budget; crawl next run
    }
  }
  const isKnown = knownGame(games)

  const entries = await readBlocklist(kv)
  const stored = await readStored<unknown>(kv, KEY_STATE)
  const state = parseState(stored.value)

  while (pages < CRAWL_PAGES_PER_RUN) {
    const page = await fetchPage(fetchFn, env.GITHUB_TOKEN, state.cursor)
    if (!page) break
    pages++
    repos += page.repos.length
    state.total = page.total
    state.blocks = updateBlockState(entries, state.blocks, page.repos)
    const crawledAt = new Date(now()).toISOString()
    for (const r of page.repos) {
      const status = buildStatus(r, isKnown, crawledAt)
      const blocked = isBlocked(r, entries, state.blocks)
      state.pass[`${r.owner}/${r.repo}`.toLowerCase()] = blocked
        ? { ...status, listed: [], rejected: 'blocked' }
        : status
    }
    state.cursor = page.nextCursor
    if (page.nextCursor === null) {
      finishedPass = true
      break
    }
  }

  if (finishedPass) {
    const res = await finishPass(kv, state, new Date(now()).toISOString())
    writes += res.writes
    state.indexed = res.indexed
    state.pass = {}
    state.cursor = null
  }
  if (state.total > SEARCH_RESULT_CAP)
    console.warn(
      `catalog: search total ${state.total} exceeds GitHub's ${SEARCH_RESULT_CAP}-result cap`
    )
  if (await putIfChanged(kv, KEY_STATE, state, state, stored.hash)) writes++
  return done()
}
