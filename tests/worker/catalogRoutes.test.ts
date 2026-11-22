import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestJsonSchema } from '../../src/shared/hmlManifest'
import { runCrawl } from '../../worker/src/catalog/crawl'
import { createHandler } from '../../worker/src/index'
import { fakeFetch, makeCatalogEnv, memKv, repoNode } from './catalogFakes'

const T0 = Date.parse('2026-11-22T00:00:00Z')
const BASE = 'https://x.test/v1/catalog'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

async function crawled(limiterOk = true): Promise<ReturnType<typeof makeCatalogEnv>> {
  const mem = memKv()
  mem.set('catalog:games', { fetchedAt: new Date(T0).toISOString(), slugs: ['repo'] })
  mem.set('catalog:blocklist', [{ target: 'evil/bad', reason: 'malware', at: '2026-01-01' }])
  const made = makeCatalogEnv(mem, () => limiterOk)
  const pages = [[repoNode(1, 'Alice', 'Cool'), repoNode(9, 'evil', 'bad')]]
  await runCrawl(made.env, fakeFetch(pages).fetchFn, () => T0)
  // The blocked repo is renamed; the alias stays in the served blocklist.
  await runCrawl(made.env, fakeFetch([[repoNode(9, 'evil', 'renamed')]]).fetchFn, () => T0 + 1)
  await runCrawl(made.env, fakeFetch(pages).fetchFn, () => T0 + 2)
  return made
}

const h = createHandler()
const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${BASE}${path}`, { headers: { 'CF-Connecting-IP': '1.2.3.4', ...headers } })

describe('/v1/catalog', () => {
  it('serves a game index with an ETag and answers If-None-Match with 304', async () => {
    const { env } = await crawled()
    const a = await h.fetch(get('/repo'), env)
    expect(a.status).toBe(200)
    expect(a.headers.get('cache-control')).toBe('public, max-age=300')
    const etag = a.headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)
    const body = (await a.json()) as { game: string; builtAt: string; mods: { key: string }[] }
    expect(body.game).toBe('repo')
    expect(body.builtAt).toBe(new Date(T0 + 2).toISOString())
    expect(body.mods.map((m) => m.key)).toEqual(['Alice/Cool/cool'])
    const b = await h.fetch(get('/repo', { 'if-none-match': etag }), env)
    expect(b.status).toBe(304)
    expect(b.headers.get('etag')).toBe(etag)
    expect(b.headers.get('cache-control')).toBe('public, max-age=300')
    const c = await h.fetch(get('/repo', { 'if-none-match': '"other"' }), env)
    expect(c.status).toBe(200)
  })

  it('gives an empty list for an unknown game', async () => {
    const { env } = await crawled()
    const res = await h.fetch(get('/nope'), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ game: 'nope', mods: [] })
  })

  it('rejects malformed game names with 404', async () => {
    const { env } = await crawled()
    expect((await h.fetch(get('/Bad_Game'), env)).status).toBe(404)
    expect((await h.fetch(get('/repo/extra'), env)).status).toBe(404)
  })

  it('serves a repo status case-insensitively, else 404 not-crawled', async () => {
    const { env } = await crawled()
    const ok = await h.fetch(get('/status/alice/cool'), env)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ owner: 'Alice', repo: 'Cool' })
    const blocked = await h.fetch(get('/status/evil/bad'), env)
    expect(await blocked.json()).toMatchObject({ rejected: 'blocked' })
    const miss = await h.fetch(get('/status/bob/none'), env)
    expect(miss.status).toBe(404)
    expect(await miss.json()).toEqual({ error: 'not-crawled' })
  })

  it('serves the blocklist with rename aliases', async () => {
    const { env } = await crawled()
    const res = await h.fetch(get('/blocklist'), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      entries: [{ names: ['evil/bad', 'evil/renamed'], reason: 'malware' }]
    })
  })

  it('serves an empty blocklist when none is stored', async () => {
    const { env } = makeCatalogEnv()
    expect(await (await h.fetch(get('/blocklist'), env)).json()).toEqual({ entries: [] })
  })

  it('serves the manifest JSON schema', async () => {
    const { env } = makeCatalogEnv()
    const res = await h.fetch(get('/schema.json'), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(manifestJsonSchema())
  })

  it('rate-limits per IP with 429', async () => {
    const { env, limitKeys } = await crawled(false)
    const res = await h.fetch(get('/repo'), env)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'rate-limited' })
    expect(limitKeys).toEqual(['1.2.3.4'])
  })

  it('answers non-GET with 405', async () => {
    const { env } = makeCatalogEnv()
    const res = await h.fetch(new Request(`${BASE}/repo`, { method: 'POST', body: '{}' }), env)
    expect(res.status).toBe(405)
    expect(await res.json()).toEqual({ error: 'method-not-allowed' })
  })
})
