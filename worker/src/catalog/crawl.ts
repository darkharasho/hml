// Resumable GitHub catalog crawl, run from the cron trigger. Free plan: at most
// CRAWL_PAGES_PER_RUN GraphQL pages per run, and KV writes only when a value's hash changed.
// Star and download counts alone rewrite an index or the status map at most every 6 hours.
import type { CatalogEntry, CatalogIndex, RepoStatus } from '../../../src/shared/ghCatalog'
import { isKnownGameLabel } from '../../../src/shared/hmlManifest'
import type { Env, KvLike } from '../index'
import { isBlocked, updateBlockState, type BlockState } from './blocklist'
import { fetchSearchPage, GhGraphqlError } from './github'
import { buildStatus } from './listing'
import {
  isObj,
  KEY_GAMES,
  KEY_STATE,
  KEY_STATUS,
  indexKey,
  putCatalogValue,
  putIfChanged,
  readBlocklist,
  readStored
} from './store'

export const CRAWL_PAGES_PER_RUN = 3
export const RETRY_PAGE_SIZE = 15
export const SCHEMA_URL = 'https://thunderstore.io/api/experimental/schema/dev/latest/'
const GAMES_MAX_AGE_MS = 86_400_000
const SEARCH_RESULT_CAP = 1000
/** Consecutive failed runs at one cursor before the pass is ended early. */
export const MAX_FAILURES = 3

export interface CrawlState {
  cursor: string | null
  /** This pass's statuses so far, keyed lowercase `owner/repo`. */
  pass: Record<string, RepoStatus>
  total: number
  blocks: BlockState
  /** Games that got a non-empty index at the end of the last pass. */
  indexed: string[]
  /** Consecutive runs that failed at the stored cursor. */
  failures: number
}

export interface GamesCache {
  fetchedAt: string
  slugs: string[]
}

export function parseState(v: unknown): CrawlState {
  const s = isObj(v) ? v : {}
  return {
    cursor: typeof s.cursor === 'string' ? s.cursor : null,
    pass: isObj(s.pass) ? (s.pass as CrawlState['pass']) : {},
    total: typeof s.total === 'number' ? s.total : 0,
    blocks:
      isObj(s.blocks) && isObj(s.blocks.ids) ? (s.blocks as unknown as BlockState) : { ids: {} },
    indexed: Array.isArray(s.indexed) ? s.indexed.filter((g) => typeof g === 'string') : [],
    failures: typeof s.failures === 'number' ? s.failures : 0
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

const byKey = (a: CatalogEntry, b: CatalogEntry): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0

/** An entry without its star and download counts. */
function withoutCounts(e: CatalogEntry): Omit<CatalogEntry, 'stars' | 'downloads'> {
  const rest: Partial<CatalogEntry> = { ...e }
  delete rest.stars
  delete rest.downloads
  return rest as Omit<CatalogEntry, 'stars' | 'downloads'>
}

function withoutCrawledAt(s: RepoStatus, counts: boolean): unknown {
  const rest: Partial<RepoStatus> = { ...s }
  delete rest.crawledAt
  return counts ? rest : { ...rest, listed: s.listed.map(withoutCounts) }
}

/** Status map with keys sorted, so crawl order never causes a write. */
function sortedStatus(pass: Record<string, RepoStatus>): Record<string, RepoStatus> {
  const out: Record<string, RepoStatus> = {}
  for (const k of Object.keys(pass).sort()) out[k] = pass[k]
  return out
}

const mapValues = <T, U>(o: Record<string, T>, f: (v: T) => U): Record<string, U> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]))

/** Writes per-game indexes and the status map for a finished pass. Returns the write count and indexed games. */
async function finishPass(
  kv: KvLike,
  state: CrawlState,
  now: number
): Promise<{ writes: number; indexed: string[] }> {
  const builtAt = new Date(now).toISOString()
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
    mods.sort(byKey)
    const index: CatalogIndex = { game, builtAt, mods }
    const content = { game, mods }
    const stable = { game, mods: mods.map(withoutCounts) }
    if (await putCatalogValue(kv, indexKey(game), index, content, stable, now)) writes++
  }
  const status = sortedStatus(state.pass)
  const content = mapValues(status, (s) => withoutCrawledAt(s, true))
  const stable = mapValues(status, (s) => withoutCrawledAt(s, false))
  if (await putCatalogValue(kv, KEY_STATUS, status, content, stable, now)) writes++
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

  let failed = false
  while (pages < CRAWL_PAGES_PER_RUN) {
    const page = await fetchPage(fetchFn, env.GITHUB_TOKEN, state.cursor)
    if (!page) {
      failed = true
      break
    }
    pages++
    state.failures = 0
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

  if (failed && ++state.failures >= MAX_FAILURES) {
    // One page keeps failing: end the pass with what we have, keeping last pass's other repos.
    console.error(
      JSON.stringify({ catalog: 'stalled', cursor: state.cursor, failures: state.failures })
    )
    const prev = (await readStored<Record<string, RepoStatus>>(kv, KEY_STATUS)).value
    if (isObj(prev))
      for (const [k, v] of Object.entries(prev))
        if (!Object.hasOwn(state.pass, k)) state.pass[k] = v
    finishedPass = true
  }
  if (finishedPass) {
    const res = await finishPass(kv, state, now())
    writes += res.writes
    state.indexed = res.indexed
    state.pass = {}
    state.cursor = null
    state.failures = 0
  }
  if (state.total > SEARCH_RESULT_CAP)
    console.warn(
      `catalog: search total ${state.total} exceeds GitHub's ${SEARCH_RESULT_CAP}-result cap`
    )
  if (await putIfChanged(kv, KEY_STATE, state, stored.hash)) writes++
  return done()
}
