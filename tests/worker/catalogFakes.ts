// In-memory KV + limiter fakes for the catalog Worker tests (same pattern as sync.test.ts).
import type { Env, KvLike } from '../../worker/src/index'
import eco from '../fixtures/ecosystem-min.json'

export interface MemEntry {
  value: Uint8Array
  metadata: unknown
}

export interface MemKv {
  kv: KvLike
  store: Map<string, MemEntry>
  puts: string[]
  text(key: string): string | null
  json<T>(key: string): T | null
  set(key: string, value: unknown, metadata?: unknown): void
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function shape(bytes: Uint8Array, type: string): unknown {
  if (type === 'text') return dec.decode(bytes)
  if (type === 'stream')
    return new ReadableStream({
      start(c) {
        c.enqueue(bytes.slice())
        c.close()
      }
    })
  return bytes.slice().buffer
}

export function memKv(): MemKv {
  const store = new Map<string, MemEntry>()
  const puts: string[] = []
  const kv = {
    async get(key: string, type: string) {
      const e = store.get(key)
      return e ? shape(e.value, type) : null
    },
    async getWithMetadata(key: string, type: string) {
      const e = store.get(key)
      return e
        ? { value: shape(e.value, type), metadata: e.metadata }
        : { value: null, metadata: null }
    },
    async put(
      key: string,
      value: string | ArrayBuffer | Uint8Array,
      opts?: { metadata?: unknown }
    ) {
      puts.push(key)
      const bytes =
        typeof value === 'string'
          ? enc.encode(value)
          : new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value))
      store.set(key, { value: bytes, metadata: opts?.metadata ?? null })
    }
  } as unknown as KvLike
  const text = (key: string): string | null => {
    const e = store.get(key)
    return e ? dec.decode(e.value) : null
  }
  return {
    kv,
    store,
    puts,
    text,
    json: <T>(key: string): T | null => {
      const t = text(key)
      return t === null ? null : (JSON.parse(t) as T)
    },
    set: (key, value, metadata = null) =>
      store.set(key, {
        value: enc.encode(typeof value === 'string' ? value : JSON.stringify(value)),
        metadata
      })
  }
}

export function makeCatalogEnv(
  mem: MemKv = memKv(),
  catalogOk: () => boolean = () => true
): { env: Env; mem: MemKv; limitKeys: string[] } {
  const ok = { limit: async () => ({ success: true }) }
  const limitKeys: string[] = []
  const env: Env = {
    PROFILES: mem.kv,
    UPLOAD_LIMITER: ok,
    DOWNLOAD_LIMITER: ok,
    SYNC_CHECK_LIMITER: ok,
    SYNC_PUBLISH_LIMITER: ok,
    CATALOG_LIMITER: {
      async limit({ key }) {
        limitKeys.push(key)
        return { success: catalogOk() }
      }
    },
    GITHUB_TOKEN: 'tok'
  }
  return { env, mem, limitKeys }
}

/** The ecosystem fixture plus a `stonewards` community. */
export function ecosystem(): unknown {
  const e = structuredClone(eco) as { games: Record<string, unknown> }
  e.games.stonewards = { label: 'stonewards', r2modman: [{ internalFolderName: 'Stonewards' }] }
  e.games.noloader = { label: 'noloader', r2modman: null }
  return e
}

export function repoNode(
  id: number,
  owner: string,
  name: string,
  games: string[] = ['repo'],
  version = '1.0.0',
  counts: { stars?: number; downloads?: number } = {}
): unknown {
  const manifest = JSON.stringify({
    schema: 1,
    mods: [{ id: name.toLowerCase(), name, description: 'd', games }]
  })
  return {
    __typename: 'Repository',
    databaseId: id,
    name,
    stargazerCount: counts.stars ?? 1,
    createdAt: '2026-01-01T00:00:00Z',
    isArchived: false,
    owner: { id: `O-${owner}`, login: owner, avatarUrl: `https://a.test/${owner}` },
    defaultBranchRef: { name: 'main' },
    object: { text: manifest, byteSize: manifest.length },
    releases: {
      nodes: [
        {
          tagName: `v${version}`,
          isDraft: false,
          isPrerelease: false,
          publishedAt: '2026-02-01T00:00:00Z',
          releaseAssets: {
            nodes: [{ name: `${name}.zip`, size: 10, downloadCount: counts.downloads ?? 3 }]
          }
        }
      ]
    }
  }
}

export type PageSpec = unknown[]

/**
 * Fake fetch: SCHEMA_URL returns `ecosystem()`; GraphQL pages are served by cursor
 * (null -> pages[0], "c1" -> pages[1], ...). `fail(cursor, first, call)` may return an
 * HTTP status to fail that request with.
 */
export function fakeFetch(
  pages: PageSpec[],
  fail: (cursor: string | null, first: number, call: number) => number | null = () => null
): {
  fetchFn: typeof fetch
  gql: { cursor: string | null; first: number }[]
  schemaCalls: { count: number }
} {
  const gql: { cursor: string | null; first: number }[] = []
  const schemaCalls = { count: 0 }
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://thunderstore.io/')) {
      schemaCalls.count++
      return new Response(JSON.stringify(ecosystem()))
    }
    const { variables } = JSON.parse(init!.body as string) as {
      variables: { cursor: string | null; first: number }
    }
    gql.push(variables)
    const status = fail(variables.cursor, variables.first, gql.length)
    if (status !== null) return new Response('bad', { status })
    const i = variables.cursor === null ? 0 : Number(variables.cursor.slice(1))
    const last = i === pages.length - 1
    return new Response(
      JSON.stringify({
        data: {
          search: {
            repositoryCount: pages.flat().length,
            pageInfo: { hasNextPage: !last, endCursor: last ? null : `c${i + 1}` },
            nodes: pages[i]
          }
        }
      })
    )
  }) as unknown as typeof fetch
  return { fetchFn, gql, schemaCalls }
}
