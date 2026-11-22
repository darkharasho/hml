// GET /v1/catalog/* routes: per-game indexes, repo status, blocklist, manifest schema.
import type { CatalogIndex, RepoStatus } from '../../../src/shared/ghCatalog'
import { manifestJsonSchema } from '../../../src/shared/hmlManifest'
import { err } from '../http'
import type { Env } from '../index'
import { serveBlocklist } from './blocklist'
import { parseState } from './crawl'
import { indexKey, KEY_STATE, KEY_STATUS, readBlocklist, readStored } from './store'

export const CATALOG_PREFIX = '/v1/catalog'
const GAME_RE = /^[a-z0-9-]{1,64}$/
const CACHE = 'public, max-age=300'

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'cache-control': CACHE, ...headers }
  })
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === etag || t === '*')
}

async function gameIndex(req: Request, env: Env, game: string): Promise<Response> {
  const { value, hash } = await readStored<CatalogIndex>(env.PROFILES, indexKey(game))
  if (!value) return json({ game, builtAt: new Date(0).toISOString(), mods: [] })
  if (!hash) return json(value)
  const etag = `"${hash}"`
  if (etagMatches(req.headers.get('if-none-match'), etag))
    return new Response(null, { status: 304, headers: { etag, 'cache-control': CACHE } })
  return json(value, { etag })
}

async function repoStatus(env: Env, owner: string, repo: string): Promise<Response> {
  const { value } = await readStored<Record<string, RepoStatus>>(env.PROFILES, KEY_STATUS)
  const key = `${owner}/${repo}`.toLowerCase()
  const status = value && Object.hasOwn(value, key) ? value[key] : undefined
  return status ? json(status) : err(404, 'not-crawled')
}

async function blocklist(env: Env): Promise<Response> {
  const [entries, state] = await Promise.all([
    readBlocklist(env.PROFILES),
    readStored<unknown>(env.PROFILES, KEY_STATE)
  ])
  return json(serveBlocklist(entries, parseState(state.value).blocks))
}

/** `path` is the URL pathname, starting with CATALOG_PREFIX. */
export async function handleCatalog(req: Request, env: Env, path: string): Promise<Response> {
  if (req.method !== 'GET') return err(405, 'method-not-allowed')
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown'
  const { success } = await env.CATALOG_LIMITER.limit({ key: ip })
  if (!success) return err(429, 'rate-limited')

  let segs: string[]
  try {
    segs = path
      .slice(CATALOG_PREFIX.length + 1)
      .split('/')
      .map(decodeURIComponent)
  } catch {
    return err(404, 'not-found')
  }
  if (segs.length === 1 && segs[0] === 'blocklist') return blocklist(env)
  if (segs.length === 1 && segs[0] === 'schema.json') return json(manifestJsonSchema())
  if (segs[0] === 'status') {
    if (segs.length !== 3 || !segs[1] || !segs[2]) return err(404, 'not-found')
    return repoStatus(env, segs[1], segs[2])
  }
  if (segs.length === 1 && GAME_RE.test(segs[0])) return gameIndex(req, env, segs[0])
  return err(404, 'not-found')
}
