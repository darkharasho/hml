/* eslint-disable @typescript-eslint/no-unused-vars -- fake fetches take (url, init) so call args type-check */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  blockedReason,
  CATALOG_MAX_AGE_MS,
  loadCatalogIndex,
  type CatalogClientOptions
} from '../../../src/main/ghcatalog/client'
import type { CatalogIndex } from '../../../src/shared/ghCatalog'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-cat-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const entry = (id: string): CatalogIndex['mods'][number] =>
  ({ key: `a/b/${id}`, owner: 'a', repo: 'b', id, name: id }) as CatalogIndex['mods'][number]
const index = (...ids: string[]): CatalogIndex => ({
  game: 'repo',
  builtAt: '2026-01-01T00:00:00.000Z',
  mods: ids.map(entry)
})

function opts(fetchFn: typeof fetch, clock: { t: number }): CatalogClientOptions {
  return {
    fetch: fetchFn,
    base: 'https://w.test/',
    now: () => clock.t,
    indexFile: path.join(dir, 'repo.json'),
    blocklistFile: path.join(dir, 'block.json')
  }
}
const ok = (body: unknown, headers: HeadersInit = { etag: '"e1"' }): Response =>
  new Response(JSON.stringify(body), { status: 200, headers })

describe('loadCatalogIndex', () => {
  it('fetches the first time and writes the cache', async () => {
    const f = vi.fn(async (..._a: unknown[]) => ok(index('x')))
    const clock = { t: 1_000_000 }
    const r = await loadCatalogIndex(opts(f as unknown as typeof fetch, clock), 'repo')
    expect(r.offline).toBe(false)
    expect(r.mods.map((m) => m.id)).toEqual(['x'])
    expect(r.fetchedAt).toBe(new Date(1_000_000).toISOString())
    expect(f.mock.calls[0][0]).toBe('https://w.test/v1/catalog/repo')
    await expect(fs.stat(path.join(dir, 'repo.json'))).resolves.toBeTruthy()
  })

  it('makes no request within 30 minutes', async () => {
    const f = vi.fn(async (..._a: unknown[]) => ok(index('x')))
    const clock = { t: 1_000_000 }
    const o = opts(f as unknown as typeof fetch, clock)
    await loadCatalogIndex(o, 'repo')
    clock.t += CATALOG_MAX_AGE_MS - 1
    const r = await loadCatalogIndex(o, 'repo')
    expect(f).toHaveBeenCalledTimes(1)
    expect(r.mods).toHaveLength(1)
    expect(r.offline).toBe(false)
  })

  it('revalidates with If-None-Match after 30 minutes; 304 refreshes fetchedAt', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(ok(index('x')))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const clock = { t: 1_000_000 }
    const o = opts(f as unknown as typeof fetch, clock)
    await loadCatalogIndex(o, 'repo')
    clock.t += CATALOG_MAX_AGE_MS
    const r = await loadCatalogIndex(o, 'repo')
    const init = f.mock.calls[1][1] as RequestInit
    expect(new Headers(init.headers).get('if-none-match')).toBe('"e1"')
    expect(r.mods.map((m) => m.id)).toEqual(['x'])
    expect(r.fetchedAt).toBe(new Date(clock.t).toISOString())
    expect(r.offline).toBe(false)
  })

  it('serves the cache as offline on a network error', async () => {
    const good = vi.fn(async (..._a: unknown[]) => ok(index('x')))
    const clock = { t: 1_000_000 }
    await loadCatalogIndex(opts(good as unknown as typeof fetch, clock), 'repo')
    clock.t += CATALOG_MAX_AGE_MS
    const bad = vi.fn(async (..._a: unknown[]) => {
      throw new Error('down')
    })
    const r = await loadCatalogIndex(opts(bad as unknown as typeof fetch, clock), 'repo')
    expect(r.offline).toBe(true)
    expect(r.mods).toHaveLength(1)
    expect(r.fetchedAt).toBe(new Date(1_000_000).toISOString())
  })

  it('is empty and offline with no cache on a network error', async () => {
    const bad = vi.fn(async (..._a: unknown[]) => {
      throw new Error('down')
    })
    const r = await loadCatalogIndex(opts(bad as unknown as typeof fetch, { t: 5 }), 'repo')
    expect(r).toEqual({ mods: [], fetchedAt: null, offline: true })
  })

  it('treats a garbage body or a 500 as offline and keeps the cache', async () => {
    const clock = { t: 1_000_000 }
    await loadCatalogIndex(
      opts(vi.fn(async (..._a: unknown[]) => ok(index('x'))) as unknown as typeof fetch, clock),
      'repo'
    )
    const before = await fs.readFile(path.join(dir, 'repo.json'), 'utf8')
    clock.t += CATALOG_MAX_AGE_MS
    for (const res of [
      () => new Response('<html>nope', { status: 200 }),
      () => ok({ mods: 'x' }),
      () => new Response('boom', { status: 500 })
    ]) {
      const r = await loadCatalogIndex(
        opts(vi.fn(async (..._a: unknown[]) => res()) as unknown as typeof fetch, clock),
        'repo'
      )
      expect(r.offline).toBe(true)
      expect(r.mods).toHaveLength(1)
    }
    expect(await fs.readFile(path.join(dir, 'repo.json'), 'utf8')).toBe(before)
  })

  it('force skips the 30 minute check', async () => {
    const f = vi.fn(async (..._a: unknown[]) => ok(index('x')))
    const clock = { t: 1_000_000 }
    const o = opts(f as unknown as typeof fetch, clock)
    await loadCatalogIndex(o, 'repo')
    await loadCatalogIndex(o, 'repo', true)
    expect(f).toHaveBeenCalledTimes(2)
  })
})

describe('blockedReason', () => {
  const list = {
    entries: [
      { names: ['evil/x'], reason: 'malware' },
      { names: ['badowner'], reason: 'owner banned' }
    ]
  }
  const mk = (): CatalogClientOptions =>
    opts(vi.fn(async (..._a: unknown[]) => ok(list)) as unknown as typeof fetch, { t: 1 })

  it('matches owner/repo case-insensitively', async () => {
    expect(await blockedReason(mk(), 'Evil', 'X')).toBe('malware')
    expect(await blockedReason(mk(), 'evil', 'y')).toBeNull()
  })

  it('an owner-level entry matches any repo', async () => {
    expect(await blockedReason(mk(), 'BadOwner', 'anything')).toBe('owner banned')
  })

  it('falls back to the cached copy when offline, and fails open with none', async () => {
    const clock = { t: 1 }
    const o = opts(vi.fn(async (..._a: unknown[]) => ok(list)) as unknown as typeof fetch, clock)
    await blockedReason(o, 'evil', 'x')
    clock.t += CATALOG_MAX_AGE_MS
    const down = opts(
      vi.fn(async (..._a: unknown[]) => {
        throw new Error('down')
      }) as unknown as typeof fetch,
      clock
    )
    expect(await blockedReason(down, 'evil', 'x')).toBe('malware')
    await fs.rm(path.join(dir, 'block.json'))
    expect(await blockedReason(down, 'evil', 'x')).toBeNull()
  })
})
