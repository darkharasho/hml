import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogIndex, RepoStatus } from '../../src/shared/ghCatalog'
import { CRAWL_PAGES_PER_RUN, runCrawl, type CrawlState } from '../../worker/src/catalog/crawl'
import { createHandler } from '../../worker/src/index'
import { fakeFetch, makeCatalogEnv, memKv, repoNode, type MemKv } from './catalogFakes'

const T0 = Date.parse('2026-11-22T00:00:00Z')
const HOUR = 3_600_000

let log: ReturnType<typeof vi.spyOn>
let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

function seeded(slugs = ['repo', 'stonewards', 'bonelab'], at = T0): MemKv {
  const mem = memKv()
  mem.set('catalog:games', { fetchedAt: new Date(at).toISOString(), slugs })
  return mem
}

const pagesOf = (n: number): unknown[][] =>
  Array.from({ length: n }, (_, i) => [repoNode(100 + i, 'alice', `mod-${i}`)])

const index = (mem: MemKv, game: string): CatalogIndex | null =>
  mem.json<CatalogIndex>(`catalog:index:${game}`)

describe('runCrawl', () => {
  it('does a 2-page pass in one run and writes the indexes', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    const { fetchFn, gql } = fakeFetch(pagesOf(2))
    const r = await runCrawl(env, fetchFn, () => T0)
    expect(r).toMatchObject({ pages: 2, repos: 2, finishedPass: true })
    expect(gql.map((g) => g.cursor)).toEqual([null, 'c1'])
    expect(index(mem, 'repo')!.mods.map((m) => m.key)).toEqual([
      'alice/mod-0/mod-0',
      'alice/mod-1/mod-1'
    ])
    const status = mem.json<Record<string, RepoStatus>>('catalog:status')!
    expect(Object.keys(status).sort()).toEqual(['alice/mod-0', 'alice/mod-1'])
    const state = mem.json<CrawlState>('catalog:state')!
    expect(state.cursor).toBeNull()
    expect(state.pass).toEqual({})
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"catalog":"run"'))
  })

  it('resumes a 5-page pass across runs and writes indexes only at the end', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    const { fetchFn, gql } = fakeFetch(pagesOf(5))
    const r1 = await runCrawl(env, fetchFn, () => T0)
    expect(CRAWL_PAGES_PER_RUN).toBe(3)
    expect(r1).toMatchObject({ pages: 3, finishedPass: false })
    expect(index(mem, 'repo')).toBeNull()
    expect(mem.json<CrawlState>('catalog:state')!.cursor).toBe('c3')
    const r2 = await runCrawl(env, fetchFn, () => T0 + HOUR / 2)
    expect(r2).toMatchObject({ pages: 2, finishedPass: true })
    expect(gql.map((g) => g.cursor)).toEqual([null, 'c1', 'c2', 'c3', 'c4'])
    expect(index(mem, 'repo')!.mods).toHaveLength(5)
  })

  it('writes nothing on a second identical pass', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    const { fetchFn } = fakeFetch(pagesOf(2))
    const first = await runCrawl(env, fetchFn, () => T0)
    expect(first.writes).toBeGreaterThan(0)
    mem.puts.length = 0
    const second = await runCrawl(env, fetchFn, () => T0 + HOUR)
    expect(second.writes).toBe(0)
    expect(mem.puts).toEqual([])
  })

  it('stores each value hash in its metadata', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    await runCrawl(env, fakeFetch(pagesOf(1)).fetchFn, () => T0)
    for (const key of ['catalog:index:repo', 'catalog:status', 'catalog:state'])
      expect((mem.store.get(key)!.metadata as { hash: string }).hash).toMatch(/^[0-9a-f]{64}$/)
    expect([...mem.store.keys()].some((k) => k.startsWith('catalog:hash:'))).toBe(false)
  })

  it('leaves blocked repos out of the index with rejected:blocked', async () => {
    const mem = seeded()
    mem.set('catalog:blocklist', [{ target: 'Evil', reason: 'malware', at: '2026-01-01' }])
    const { env } = makeCatalogEnv(mem)
    const pages = [[repoNode(1, 'alice', 'good'), repoNode(2, 'evil', 'bad')]]
    await runCrawl(env, fakeFetch(pages).fetchFn, () => T0)
    expect(index(mem, 'repo')!.mods.map((m) => m.repo)).toEqual(['good'])
    const status = mem.json<Record<string, RepoStatus>>('catalog:status')!
    expect(status['evil/bad']).toMatchObject({ listed: [], rejected: 'blocked' })
    const state = mem.json<CrawlState>('catalog:state')!
    expect(Object.keys(state.blocks.ids)).toEqual(['owner:O-evil'])
  })

  it('puts a multi-game mod in every game index', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    const pages = [[repoNode(1, 'alice', 'both', ['repo', 'stonewards'])]]
    await runCrawl(env, fakeFetch(pages).fetchFn, () => T0)
    expect(index(mem, 'repo')!.mods.map((m) => m.id)).toEqual(['both'])
    expect(index(mem, 'stonewards')!.mods.map((m) => m.id)).toEqual(['both'])
  })

  it('writes an empty index for a game that lost all its mods', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    await runCrawl(env, fakeFetch([[repoNode(1, 'alice', 'a', ['stonewards'])]]).fetchFn, () => T0)
    expect(index(mem, 'stonewards')!.mods).toHaveLength(1)
    await runCrawl(env, fakeFetch([[repoNode(1, 'alice', 'a', ['repo'])]]).fetchFn, () => T0 + HOUR)
    expect(index(mem, 'stonewards')!.mods).toEqual([])
    expect(index(mem, 'repo')!.mods).toHaveLength(1)
  })

  it('retries a 502 once with page size 15', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    const { fetchFn, gql } = fakeFetch(pagesOf(2), (c, first) =>
      c === 'c1' && first === 30 ? 502 : null
    )
    const r = await runCrawl(env, fetchFn, () => T0)
    expect(r.finishedPass).toBe(true)
    expect(gql).toEqual([
      { cursor: null, first: 30 },
      { cursor: 'c1', first: 30 },
      { cursor: 'c1', first: 15 }
    ])
    expect(index(mem, 'repo')!.mods).toHaveLength(2)
  })

  it('keeps the cursor when a page fails twice and resumes next run', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    let broken = true
    const { fetchFn, gql } = fakeFetch(pagesOf(3), (c) => (broken && c === 'c1' ? 504 : null))
    const r1 = await runCrawl(env, fetchFn, () => T0)
    expect(r1).toMatchObject({ pages: 1, finishedPass: false })
    expect(mem.json<CrawlState>('catalog:state')!.cursor).toBe('c1')
    expect(index(mem, 'repo')).toBeNull()
    broken = false
    gql.length = 0
    const r2 = await runCrawl(env, fetchFn, () => T0 + HOUR / 2)
    expect(r2.finishedPass).toBe(true)
    expect(gql[0]).toEqual({ cursor: 'c1', first: 30 })
    expect(index(mem, 'repo')!.mods).toHaveLength(3)
  })

  it('stops without retrying on other errors', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    const { fetchFn, gql } = fakeFetch(pagesOf(2), (c) => (c === 'c1' ? 401 : null))
    const r = await runCrawl(env, fetchFn, () => T0)
    expect(r.finishedPass).toBe(false)
    expect(gql).toHaveLength(2)
    expect(mem.json<CrawlState>('catalog:state')!.cursor).toBe('c1')
    expect(warn).toHaveBeenCalled()
  })

  it('refreshes ecosystem slugs only when missing or over 24 h old, and skips crawling that run', async () => {
    const { env, mem } = makeCatalogEnv(memKv())
    const f = fakeFetch(pagesOf(1))
    const r1 = await runCrawl(env, f.fetchFn, () => T0)
    expect(r1.pages).toBe(0)
    expect(f.schemaCalls.count).toBe(1)
    expect(f.gql).toHaveLength(0)
    const games = mem.json<{ fetchedAt: string; slugs: string[] }>('catalog:games')!
    expect(games.slugs.sort()).toEqual(['bonelab', 'repo', 'stonewards'])

    await runCrawl(env, f.fetchFn, () => T0 + 23 * HOUR)
    expect(f.schemaCalls.count).toBe(1)
    expect(f.gql).toHaveLength(1)

    await runCrawl(env, f.fetchFn, () => T0 + 25 * HOUR)
    expect(f.schemaCalls.count).toBe(2)
    expect(f.gql).toHaveLength(1)
  })

  it('rejects labels that are not known Thunderstore slugs', async () => {
    const { env, mem } = makeCatalogEnv(seeded(['repo']))
    await runCrawl(env, fakeFetch([[repoNode(1, 'alice', 'x', ['notagame'])]]).fetchFn, () => T0)
    expect(mem.json<Record<string, RepoStatus>>('catalog:status')!['alice/x'].rejected).toBe(
      'unknown-games'
    )
  })

  it('fails open on game labels when the slug fetch fails and nothing is cached', async () => {
    const { env, mem } = makeCatalogEnv(memKv())
    const f = fakeFetch([[repoNode(1, 'alice', 'x', ['anygame'])]])
    const fetchFn = (async (url: string, init?: RequestInit) =>
      url.startsWith('https://thunderstore.io/')
        ? new Response('down', { status: 503 })
        : f.fetchFn(url, init)) as unknown as typeof fetch
    const r = await runCrawl(env, fetchFn, () => T0)
    expect(r.finishedPass).toBe(true)
    expect(index(mem, 'anygame')!.mods).toHaveLength(1)
  })

  it('rewrites for star/download changes only after 6 hours', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    const page = (n: number): unknown[][] => [
      [repoNode(1, 'alice', 'a', ['repo'], '1.0.0', { stars: n, downloads: n })]
    ]
    await runCrawl(env, fakeFetch(page(1)).fetchFn, () => T0)
    mem.puts.length = 0
    const r1 = await runCrawl(env, fakeFetch(page(2)).fetchFn, () => T0 + HOUR)
    expect(r1.writes).toBe(0)
    expect(index(mem, 'repo')!.mods[0].downloads).toBe(1)
    const etag = (mem.store.get('catalog:index:repo')!.metadata as { hash: string }).hash
    const r2 = await runCrawl(env, fakeFetch(page(2)).fetchFn, () => T0 + 7 * HOUR)
    expect(r2.writes).toBe(2)
    expect(mem.puts.sort()).toEqual(['catalog:index:repo', 'catalog:status'])
    expect(index(mem, 'repo')!.mods[0]).toMatchObject({ downloads: 2, stars: 2 })
    const meta = mem.store.get('catalog:index:repo')!.metadata as Record<string, string>
    expect(meta.hash).not.toBe(etag)
    expect(meta.at).toBe(new Date(T0 + 7 * HOUR).toISOString())
  })

  it('writes at once when more than counts changed', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    await runCrawl(env, fakeFetch([[repoNode(1, 'alice', 'a')]]).fetchFn, () => T0)
    const r = await runCrawl(
      env,
      fakeFetch([[repoNode(1, 'alice', 'a', ['repo'], '1.1.0')]]).fetchFn,
      () => T0 + HOUR
    )
    expect(r.writes).toBe(2)
    expect(index(mem, 'repo')!.mods[0].latest.version).toBe('1.1.0')
  })

  it('does not rewrite when only the crawl order changed', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    const a = repoNode(1, 'alice', 'a')
    const b = repoNode(2, 'bob', 'b')
    await runCrawl(env, fakeFetch([[b, a]]).fetchFn, () => T0)
    expect(Object.keys(mem.json<Record<string, unknown>>('catalog:status')!)).toEqual([
      'alice/a',
      'bob/b'
    ])
    const r = await runCrawl(env, fakeFetch([[a, b]]).fetchFn, () => T0 + HOUR)
    expect(r.writes).toBe(0)
  })

  it('ends a pass early after 3 failed runs at one cursor, keeping last pass repos', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pass1 = [[repoNode(1, 'alice', 'a')], [repoNode(2, 'bob', 'b')]]
    await runCrawl(env, fakeFetch(pass1).fetchFn, () => T0)
    const pass2 = [
      [repoNode(1, 'alice', 'a'), repoNode(3, 'carol', 'c')],
      [repoNode(2, 'bob', 'b')]
    ]
    const { fetchFn } = fakeFetch(pass2, (c) => (c === 'c1' ? 401 : null))
    const r1 = await runCrawl(env, fetchFn, () => T0 + HOUR)
    expect(r1.finishedPass).toBe(false)
    expect(mem.json<CrawlState>('catalog:state')!).toMatchObject({ cursor: 'c1', failures: 1 })
    await runCrawl(env, fetchFn, () => T0 + 2 * HOUR)
    expect(mem.json<CrawlState>('catalog:state')!.failures).toBe(2)
    expect(error).not.toHaveBeenCalled()
    const r3 = await runCrawl(env, fetchFn, () => T0 + 3 * HOUR)
    expect(r3.finishedPass).toBe(true)
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({ catalog: 'stalled', cursor: 'c1', failures: 3 })
    )
    expect(index(mem, 'repo')!.mods.map((m) => m.repo)).toEqual(['a', 'b', 'c'])
    expect(Object.keys(mem.json<Record<string, unknown>>('catalog:status')!)).toEqual([
      'alice/a',
      'bob/b',
      'carol/c'
    ])
    expect(mem.json<CrawlState>('catalog:state')!).toMatchObject({
      cursor: null,
      pass: {},
      failures: 0
    })
  })

  it('resets the failure count after a successful page', async () => {
    const { env, mem } = makeCatalogEnv(seeded())
    let broken = true
    const { fetchFn } = fakeFetch(pagesOf(5), (c) => (broken && c === null ? 401 : null))
    await runCrawl(env, fetchFn, () => T0)
    await runCrawl(env, fetchFn, () => T0 + HOUR)
    expect(mem.json<CrawlState>('catalog:state')!.failures).toBe(2)
    broken = false
    await runCrawl(env, fetchFn, () => T0 + 2 * HOUR)
    expect(mem.json<CrawlState>('catalog:state')!).toMatchObject({ cursor: 'c3', failures: 0 })
  })

  it('warns when the search total exceeds 1000', async () => {
    const { env } = makeCatalogEnv(seeded())
    const f = fakeFetch(pagesOf(1))
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const res = await f.fetchFn(url, init)
      const body = (await res.json()) as { data: { search: { repositoryCount: number } } }
      body.data.search.repositoryCount = 1500
      return new Response(JSON.stringify(body))
    }) as unknown as typeof fetch
    await runCrawl(env, fetchFn, () => T0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1500'))
  })
})

describe('scheduled handler', () => {
  it('runs the crawl via ctx.waitUntil', async () => {
    const { env, mem } = makeCatalogEnv(seeded(['repo'], Date.now()))
    const { fetchFn } = fakeFetch(pagesOf(1))
    vi.stubGlobal('fetch', fetchFn)
    const waits: Promise<unknown>[] = []
    createHandler().scheduled({}, env, { waitUntil: (p) => waits.push(p) })
    expect(waits).toHaveLength(1)
    await waits[0]
    vi.unstubAllGlobals()
    expect(index(mem, 'repo')!.mods).toHaveLength(1)
  })
})
