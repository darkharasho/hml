import type { Catalog, GameDef, Settings } from '../../shared/types'
import type { AppPaths } from '../store/paths'
import { readJson, writeJsonAtomic } from '../store/json'
import { findGameByName, gameByDomain, searchNexusGames, type NxClientOpts } from './api'

const RECHECK_MS = 7 * 24 * 3_600_000
const DEPLOY_PREFIX = 'nexus-'
const DOMAIN_RE = /^[a-z0-9_-]{1,64}$/

interface CacheEntry {
  domain: string | null
  gameId: number | null
  checkedAt: number
}
type Cache = Record<string, CacheEntry>
interface AddedGame {
  name: string
  domain: string
  /** The count when the game was added; it can go stale, which is fine for a card label. */
  modCount?: number
}

export interface NexusGames {
  domainFor(game: GameDef, settings: Settings): Promise<{ domain: string; gameId: number } | null>
  /** `cache` is a preloaded domain cache, to avoid rereading the file per game. */
  cachedDomain(game: GameDef, settings: Settings, cache?: Cache): Promise<string | null>
  searchExtra(query: string, catalog: Catalog, settings: Settings): Promise<GameDef[]>
  /**
   * The game in `games` that is the same game as the Nexus game with domain `domain` (by its
   * known Nexus domain, else by label), so a game with Thunderstore and Nexus mods shows up once.
   */
  twinOf(domain: string, games: GameDef[], settings: Settings): Promise<GameDef | null>
  addGame(domain: string): Promise<GameDef>
  addedGames(): Promise<GameDef[]>
  /** Records a user-chosen domain (already validated) so its game id is known without a request. */
  rememberDomain(label: string, domain: string, gameId: number): Promise<void>
  forgetDomain(label: string): Promise<void>
}

/** Domains whose mods go in the game's `Data` folder (Bethesda engine games). */
const DATA_ROOT_DOMAINS = new Set([
  'skyrim',
  'skyrimspecialedition',
  'fallout4',
  'fallout3',
  'newvegas',
  'falloutnv',
  'oblivion',
  'morrowind',
  'starfield',
  'enderal',
  'enderalspecialedition'
])

export function nexusGameDef(g: { name: string; domain: string; modCount?: number }): GameDef {
  return {
    label: `${DEPLOY_PREFIX}${g.domain}`,
    displayName: g.name,
    steamAppId: null,
    steamFolderName: '',
    exeNames: [],
    dataFolderName: '',
    loader: 'deploy',
    installRules: [],
    packageIndex: null,
    searchStrings: [g.domain],
    iconUrl: null,
    supported: true,
    ...(g.modCount !== undefined ? { nexusModCount: g.modCount } : {}),
    ...(DATA_ROOT_DOMAINS.has(g.domain) ? { deployRoot: 'Data' } : {})
  }
}

/** Nexus-only games (label `nexus-…`); a custom no-loader game also deploys but is not one. */
const isNexusOnly = (g: GameDef): boolean => g.label.startsWith(DEPLOY_PREFIX)
const deployDomain = (g: GameDef): string => g.label.slice(DEPLOY_PREFIX.length)
const normalizeDomain = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function createNexusGames(ctx: {
  paths: AppPaths
  client: NxClientOpts
  now: () => number
}): NexusGames {
  const { paths, client, now } = ctx

  // Serializes read-modify-write of the cache file.
  let tail: Promise<unknown> = Promise.resolve()
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn)
    tail = run.catch(() => undefined)
    return run
  }
  const readCache = async (): Promise<Cache> => {
    const c = await readJson<unknown>(paths.nxGames)
    return c && typeof c === 'object' && !Array.isArray(c) ? (c as Cache) : {}
  }
  const putCache = (label: string, entry: CacheEntry): Promise<void> =>
    locked(async () => {
      const c = await readCache()
      c[label] = entry
      await writeJsonAtomic(paths.nxGames, c, { pretty: false })
    })

  const overrideFor = (game: GameDef, settings: Settings): string | null =>
    settings.nexusDomainOverrides[game.label] || null

  async function domainFor(
    game: GameDef,
    settings: Settings
  ): Promise<{ domain: string; gameId: number } | null> {
    const cache = await readCache()
    const hit = cache[game.label]
    const fresh = hit && now() - hit.checkedAt < RECHECK_MS

    const known = isNexusOnly(game) ? deployDomain(game) : overrideFor(game, settings)
    if (known) {
      if (hit && hit.domain === known && hit.gameId !== null && fresh) {
        return { domain: known, gameId: hit.gameId }
      }
      const found = await gameByDomain(client, known)
      if (!found) {
        if (isNexusOnly(game)) return null
        throw new Error(`Nexus Mods has no game "${known}".`)
      }
      await putCache(game.label, { domain: found.domain, gameId: found.id, checkedAt: now() })
      return { domain: found.domain, gameId: found.id }
    }

    if (fresh) {
      return hit.domain && hit.gameId !== null ? { domain: hit.domain, gameId: hit.gameId } : null
    }
    const want = normalizeDomain(game.label)
    const nodes = await findGameByName(client, game.displayName)
    const match = nodes.find((n) => n.domain === want) ?? null
    await putCache(game.label, {
      domain: match?.domain ?? null,
      gameId: match?.id ?? null,
      checkedAt: now()
    })
    return match ? { domain: match.domain, gameId: match.id } : null
  }

  async function cachedDomain(
    game: GameDef,
    settings: Settings,
    preloaded?: Cache
  ): Promise<string | null> {
    if (isNexusOnly(game)) return deployDomain(game)
    return (
      overrideFor(game, settings) ?? (preloaded ?? (await readCache()))[game.label]?.domain ?? null
    )
  }

  async function addedGames(): Promise<GameDef[]> {
    const stored = await readJson<unknown>(paths.nxAddedGames)
    if (!Array.isArray(stored)) return []
    return stored
      .filter(
        (g): g is AddedGame =>
          !!g &&
          typeof g.name === 'string' &&
          typeof g.domain === 'string' &&
          DOMAIN_RE.test(g.domain)
      )
      .map((g) =>
        nexusGameDef({
          name: g.name,
          domain: g.domain,
          ...(typeof g.modCount === 'number' ? { modCount: g.modCount } : {})
        })
      )
  }

  async function searchExtra(
    query: string,
    catalog: Catalog,
    settings: Settings
  ): Promise<GameDef[]> {
    const q = query.trim()
    if (q.length < 2) return []
    let found: Awaited<ReturnType<typeof searchNexusGames>>
    try {
      found = await searchNexusGames(client, q)
    } catch {
      return []
    }
    const cache = await readCache()
    const out: GameDef[] = []
    for (const n of found) {
      if (!DOMAIN_RE.test(n.domain)) continue
      if (await twinOf(n.domain, catalog.games, settings, cache)) continue
      out.push(nexusGameDef({ name: n.name, domain: n.domain, modCount: n.modCount }))
    }
    return out
  }

  async function twinOf(
    domain: string,
    games: GameDef[],
    settings: Settings,
    preloaded?: Cache
  ): Promise<GameDef | null> {
    const cache = preloaded ?? (await readCache())
    for (const g of games) {
      if (isNexusOnly(g)) continue
      const known = await cachedDomain(g, settings, cache)
      if (known) {
        if (known === domain) return g
        continue
      }
      // Not looked up yet (a lookup that found nothing is cached as null): domainFor would pick
      // the Nexus game whose domain is the label.
      if (!(g.label in cache) && normalizeDomain(g.label) === domain) return g
    }
    return null
  }

  async function addGame(domain: string): Promise<GameDef> {
    const d = String(domain).trim().toLowerCase()
    const noGame = (): Error => new Error(`Nexus Mods has no game "${d}".`)
    if (!DOMAIN_RE.test(d)) throw noGame()
    const found = await gameByDomain(client, d)
    if (!found || !DOMAIN_RE.test(found.domain)) throw noGame()
    const def = nexusGameDef({ name: found.name, domain: found.domain, modCount: found.modCount })
    await locked(async () => {
      const stored = await readJson<unknown>(paths.nxAddedGames)
      const list = (Array.isArray(stored) ? stored : []) as AddedGame[]
      if (!list.some((g) => g.domain === found.domain)) {
        list.push({ name: found.name, domain: found.domain, modCount: found.modCount })
        await writeJsonAtomic(paths.nxAddedGames, list)
      }
    })
    return def
  }

  return {
    domainFor,
    cachedDomain,
    searchExtra,
    twinOf: (domain, games, settings) => twinOf(domain, games, settings),
    addGame,
    addedGames,
    rememberDomain: (label, domain, gameId) =>
      putCache(label, { domain, gameId, checkedAt: now() }),
    forgetDomain: (label) =>
      locked(async () => {
        const c = await readCache()
        if (!(label in c)) return
        delete c[label]
        await writeJsonAtomic(paths.nxGames, c, { pretty: false })
      })
  }
}
