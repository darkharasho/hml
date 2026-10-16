import type {
  NxFile,
  NxFileCategory,
  NxMod,
  NxQuery,
  NxSearchResult,
  NxSort,
  NxUser
} from '../../shared/types'

export interface NxClientOpts {
  fetch: typeof fetch
  appVersion: string
  os: { type: string; release: string; arch: string }
}

const GRAPHQL_URL = 'https://api.nexusmods.com/v2/graphql'
const V1_ROOT = 'https://api.nexusmods.com/v1/'
const API_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 600_000
/** Largest file HML downloads (it is held in memory). */
export const NX_MAX_DOWNLOAD = 1024 ** 3

const CONNECTION_ERROR = "Couldn't reach Nexus Mods. Check your connection and try again."
const TIMEOUT_ERROR = 'Nexus Mods took too long to respond. Try again later.'
const TOO_BIG = "This file is larger than 1 GB, which HML can't install yet."

export class NxPremiumRequiredError extends Error {
  constructor() {
    super('Direct downloads need a Nexus Mods Premium account.')
    this.name = 'NxPremiumRequiredError'
  }
}

export class NxRejectedKeyError extends Error {
  constructor() {
    super("Nexus Mods didn't accept that API key.")
    this.name = 'NxRejectedKeyError'
  }
}

const isTimeout = (e: unknown): boolean => e instanceof Error && e.name === 'TimeoutError'

export function nxHeaders(o: NxClientOpts): Record<string, string> {
  return {
    'Application-Name': 'HML',
    'Application-Version': o.appVersion,
    'User-Agent': `HML/${o.appVersion} (${o.os.type} ${o.os.release}; ${o.os.arch})`
  }
}

/** The key is only ever attached to api.nexusmods.com/v1 requests. */
function headersFor(o: NxClientOpts, url: string, key?: string): Record<string, string> {
  const h = nxHeaders(o)
  if (key && url.startsWith(V1_ROOT)) h.apikey = key
  return h
}

async function send(
  o: NxClientOpts,
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
  timeoutMs = API_TIMEOUT_MS
): Promise<Response> {
  // A redirect would carry the apikey header to wherever it points, so keyed requests refuse them.
  const redirect: RequestRedirect = 'apikey' in init.headers ? 'error' : 'follow'
  try {
    return await o.fetch(url, { ...init, redirect, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new Error(isTimeout(e) ? TIMEOUT_ERROR : CONNECTION_ERROR, { cause: e })
  }
}

function throwRateLimit(res: Response): never {
  const reset = res.headers.get('x-rl-hourly-reset')
  const at = reset ? new Date(reset) : null
  const when =
    at && !Number.isNaN(at.getTime())
      ? `Try again after ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
      : 'Try again later.'
  throw new Error(`Nexus Mods' rate limit was reached. ${when}`)
}

interface GqlError {
  message?: string
  extensions?: { code?: string }
}
interface GqlReply<T> {
  data: T | null
  errors: GqlError[]
}

async function gqlRaw<T>(o: NxClientOpts, query: string, variables: object): Promise<GqlReply<T>> {
  const res = await send(o, GRAPHQL_URL, {
    method: 'POST',
    headers: { ...headersFor(o, GRAPHQL_URL), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  })
  if (res.status === 429) throwRateLimit(res)
  let body: { data?: T | null; errors?: GqlError[] }
  try {
    body = (await res.json()) as typeof body
  } catch {
    throw new Error(`Nexus Mods returned HTTP ${res.status}.`)
  }
  if (!body || typeof body !== 'object') throw new Error(`Nexus Mods returned HTTP ${res.status}.`)
  const errors = Array.isArray(body.errors) ? body.errors : []
  if (errors.length === 0 && !res.ok) throw new Error(`Nexus Mods returned HTTP ${res.status}.`)
  return { data: body.data ?? null, errors }
}

export async function gql<T>(o: NxClientOpts, query: string, variables: object): Promise<T> {
  const { data, errors } = await gqlRaw<T>(o, query, variables)
  if (errors.length > 0) {
    throw new Error(`Nexus Mods search failed: ${errors[0].message ?? 'unknown error'}`)
  }
  if (!data) throw new Error('Nexus Mods search failed: empty response')
  return data
}

/** A GraphQL string literal (JSON strings are valid GraphQL strings). */
const lit = (s: string): string => JSON.stringify(s)

function assertId(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid Nexus ${what} id.`)
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function toMod(n: Record<string, unknown>): NxMod {
  return {
    modId: num(n.modId),
    name: String(n.name ?? ''),
    summary: String(n.summary ?? ''),
    author: String(n.author ?? ''),
    version: String(n.version ?? ''),
    pictureUrl: typeof n.pictureUrl === 'string' && n.pictureUrl ? n.pictureUrl : null,
    thumbnailUrl: typeof n.thumbnailUrl === 'string' && n.thumbnailUrl ? n.thumbnailUrl : null,
    downloads: num(n.downloads),
    endorsements: num(n.endorsements),
    updatedAt: String(n.updatedAt ?? ''),
    adultContent: n.adultContent === true
  }
}

const MOD_FIELDS =
  'modId name summary author version pictureUrl thumbnailUrl downloads endorsements updatedAt adultContent'

const SORT_FIELD: Record<NxSort, string> = {
  relevance: 'relevance',
  downloads: 'downloads',
  endorsements: 'endorsements',
  updated: 'updatedAt',
  name: 'name'
}

export async function validateKey(
  o: NxClientOpts,
  key: string
): Promise<NxUser & { userId: number }> {
  const url = `${V1_ROOT}users/validate.json`
  const res = await send(o, url, { headers: headersFor(o, url, key) })
  if (res.status === 401) throw new NxRejectedKeyError()
  if (res.status === 429) throwRateLimit(res)
  if (!res.ok) throw new Error(`Nexus Mods returned HTTP ${res.status}.`)
  const b = (await res.json()) as Record<string, unknown>
  return { name: String(b.name ?? ''), isPremium: b.is_premium === true, userId: num(b.user_id) }
}

export async function searchMods(
  o: NxClientOpts,
  domain: string,
  q: NxQuery
): Promise<NxSearchResult> {
  const text = q.text.trim()
  const field = text === '' && q.sort === 'relevance' ? 'downloads' : SORT_FIELD[q.sort]
  const dir = q.sort === 'name' ? 'ASC' : 'DESC'
  const filters = [`gameDomainName:[{value:${lit(domain)}}]`]
  if (text !== '') filters.push(`name:[{value:${lit(text)}, op:WILDCARD}]`)
  if (!q.includeAdult) filters.push('adultContent:[{value:false}]')
  const limit = Math.min(50, Math.max(1, Math.trunc(q.limit) || 1))
  const offset = Math.max(0, Math.trunc(q.offset) || 0)
  const query = `{ mods(filter:{${filters.join(', ')}}, sort:[{${field}:{direction:${dir}}}], offset:${offset}, count:${limit}) { totalCount nodes { ${MOD_FIELDS} } } }`
  const data = await gql<{ mods: { totalCount: unknown; nodes: Record<string, unknown>[] } }>(
    o,
    query,
    {}
  )
  return { items: (data.mods.nodes ?? []).map(toMod), total: num(data.mods.totalCount) }
}

export async function gameByDomain(
  o: NxClientOpts,
  domain: string
): Promise<{ id: number; name: string; domain: string } | null> {
  const { data, errors } = await gqlRaw<{ game: Record<string, unknown> | null }>(
    o,
    `{ game(domainName:${lit(domain)}) { id name domainName } }`,
    {}
  )
  if (data?.game) {
    return {
      id: num(data.game.id),
      name: String(data.game.name),
      domain: String(data.game.domainName)
    }
  }
  if (errors.length > 0 && !errors.some((e) => e.extensions?.code === 'GAME_NOT_FOUND')) {
    throw new Error(`Nexus Mods search failed: ${errors[0].message ?? 'unknown error'}`)
  }
  return null
}

export async function getMod(o: NxClientOpts, domain: string, modId: number): Promise<NxMod> {
  assertId(modId, 'mod')
  const game = await gameByDomain(o, domain)
  if (!game) throw new Error("That game isn't on Nexus Mods.")
  const data = await gql<{ mods: { nodes: Record<string, unknown>[] } }>(
    o,
    `{ mods(filter:{gameId:[{value:${lit(String(game.id))}}], modId:[{value:${lit(String(modId))}}]}, offset:0, count:1) { nodes { ${MOD_FIELDS} } } }`,
    {}
  )
  const node = data.mods.nodes?.[0]
  if (!node) throw new Error("That mod isn't on Nexus Mods.")
  return toMod(node)
}

type GameNode = { id: unknown; name: unknown; domainName: unknown; modCount?: unknown }

export async function searchNexusGames(
  o: NxClientOpts,
  text: string
): Promise<{ id: number; name: string; domain: string; modCount: number }[]> {
  const data = await gql<{ games: { nodes: GameNode[] } }>(
    o,
    `{ games(filter:{name:[{value:${lit(text)}, op:WILDCARD}]}, count:20, offset:0, sort:[{downloads:{direction:DESC}}]) { nodes { id name domainName modCount } } }`,
    {}
  )
  return (data.games.nodes ?? []).map((n) => ({
    id: num(n.id),
    name: String(n.name),
    domain: String(n.domainName),
    modCount: num(n.modCount)
  }))
}

export async function findGameByName(
  o: NxClientOpts,
  name: string
): Promise<{ id: number; name: string; domain: string }[]> {
  const data = await gql<{ games: { nodes: GameNode[] } }>(
    o,
    `{ games(filter:{name:[{value:${lit(name)}, op:EQUALS}]}, count:20, offset:0) { nodes { id name domainName } } }`,
    {}
  )
  return (data.games.nodes ?? []).map((n) => ({
    id: num(n.id),
    name: String(n.name),
    domain: String(n.domainName)
  }))
}

export async function modFiles(o: NxClientOpts, gameId: number, modId: number): Promise<NxFile[]> {
  assertId(gameId, 'game')
  assertId(modId, 'mod')
  const data = await gql<{ modFiles: Record<string, unknown>[] }>(
    o,
    `query($modId: ID!, $gameId: ID!) { modFiles(modId: $modId, gameId: $gameId) { fileId name version category categoryId primary size sizeInBytes date } }`,
    { modId: String(modId), gameId: String(gameId) }
  )
  return (data.modFiles ?? [])
    .map((f): NxFile => {
      const bytes = num(f.sizeInBytes)
      return {
        fileId: num(f.fileId),
        name: String(f.name ?? ''),
        version: String(f.version ?? ''),
        category: String(f.category) as NxFileCategory,
        sizeBytes: bytes > 0 ? bytes : num(f.size) * 1024,
        date: num(f.date)
      }
    })
    .sort((a, b) => b.date - a.date)
}

export async function downloadLinks(
  o: NxClientOpts,
  key: string,
  domain: string,
  modId: number,
  fileId: number,
  nxm?: { key: string; expires: number }
): Promise<string[]> {
  assertId(modId, 'mod')
  assertId(fileId, 'file')
  let url = `${V1_ROOT}games/${encodeURIComponent(domain)}/mods/${modId}/files/${fileId}/download_link.json`
  if (nxm) {
    url += `?key=${encodeURIComponent(nxm.key)}&expires=${encodeURIComponent(String(nxm.expires))}`
  }
  const res = await send(o, url, { headers: headersFor(o, url, key) })
  if (res.status === 403) throw new NxPremiumRequiredError()
  if (res.status === 401) throw new NxRejectedKeyError()
  if (res.status === 410) {
    throw new Error('This Nexus download link has expired. Click "Mod Manager Download" again.')
  }
  if (res.status === 400) throw new Error("This Nexus download link isn't valid for your account.")
  if (res.status === 404) throw new Error('That file is no longer on Nexus Mods.')
  if (res.status === 429) throwRateLimit(res)
  if (!res.ok) throw new Error(`Nexus Mods returned HTTP ${res.status}.`)
  const list = (await res.json()) as { URI?: unknown }[]
  return (Array.isArray(list) ? list : [])
    .map((l) => l.URI)
    .filter((u): u is string => typeof u === 'string' && u.startsWith('https://'))
}

export async function downloadFile(
  o: NxClientOpts,
  url: string,
  maxBytes = NX_MAX_DOWNLOAD
): Promise<Uint8Array> {
  if (!URL.canParse(url) || new URL(url).protocol !== 'https:') {
    throw new Error('Nexus Mods download links must use https.')
  }
  const res = await send(o, url, { headers: headersFor(o, url) }, DOWNLOAD_TIMEOUT_MS)
  if (!res.ok) throw new Error(`Download from Nexus Mods failed: HTTP ${res.status}.`)
  if (num(res.headers.get('content-length')) > maxBytes) {
    void res.body?.cancel().catch(() => undefined)
    throw new Error(TOO_BIG)
  }
  if (!res.body) throw new Error('Download from Nexus Mods failed: empty response.')
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined)
        throw new Error(TOO_BIG)
      }
      chunks.push(value)
    }
  } catch (e) {
    if (e instanceof Error && e.message === TOO_BIG) throw e
    throw new Error(
      isTimeout(e)
        ? TIMEOUT_ERROR
        : 'Download from Nexus Mods failed. Check your connection and try again.',
      { cause: e }
    )
  }
  const data = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    data.set(c, at)
    at += c.byteLength
  }
  return data
}
