import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadCatalog } from '../../../src/main/catalog/catalog'
import { parseEcosystem } from '../../../src/main/catalog/ecosystem'
import { makePaths } from '../../../src/main/store/paths'
import { readJson, writeJsonAtomic } from '../../../src/main/store/json'

const fixture = path.resolve(__dirname, '../../fixtures/ecosystem-min.json')
let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-cat-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

const raw = async (): Promise<unknown> => JSON.parse(await fs.readFile(fixture, 'utf8'))
const okFetch = async (): Promise<typeof fetch> =>
  vi.fn(async () => ({ ok: true, json: async () => raw() })) as unknown as typeof fetch

describe('loadCatalog', () => {
  it('uses fresh cache without fetching', async () => {
    const paths = makePaths(tmp)
    const cat = { ...parseEcosystem(await raw()), fetchedAt: new Date(1_000).toISOString() }
    await writeJsonAtomic(paths.schemaCache, cat)
    const fetchFn = vi.fn() as unknown as typeof fetch
    const got = await loadCatalog(paths, fetchFn, fixture, 86_400_000, () => 2_000)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(got).toEqual(cat)
  })

  it('fetches and writes cache when stale or missing', async () => {
    const paths = makePaths(tmp)
    const fetchFn = await okFetch()
    const got = await loadCatalog(paths, fetchFn, '/nonexistent', 1000, () => 5_000)
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(got.fetchedAt).toBe(new Date(5_000).toISOString())
    expect((await readJson<{ fetchedAt: string }>(paths.schemaCache))?.fetchedAt).toBe(
      got.fetchedAt
    )
  })

  it('falls back to cache when fetch fails', async () => {
    const paths = makePaths(tmp)
    const cat = { ...parseEcosystem(await raw()), fetchedAt: new Date(0).toISOString() }
    await writeJsonAtomic(paths.schemaCache, cat)
    const fetchFn = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await loadCatalog(paths, fetchFn, '/nonexistent', 1000, () => 10_000_000)).toEqual(cat)
  })

  it('treats non-OK response as failure', async () => {
    const paths = makePaths(tmp)
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
    const got = await loadCatalog(paths, fetchFn, fixture)
    expect(got.games.map((g) => g.label)).toContain('repo')
    expect(await readJson(paths.schemaCache)).toBeNull()
  })

  it('falls back to snapshot with no cache', async () => {
    const paths = makePaths(tmp)
    const fetchFn = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const got = await loadCatalog(paths, fetchFn, fixture)
    expect(got.games.map((g) => g.label).sort()).toEqual(['bonelab', 'repo'])
  })

  it('returns fresh catalog when cache write fails', async () => {
    const paths = makePaths(tmp)
    await fs.mkdir(path.dirname(paths.schemaCache), { recursive: true })
    await fs.mkdir(paths.schemaCache) // a directory blocks the rename
    const got = await loadCatalog(paths, await okFetch(), '/nonexistent', 1000, () => 5_000)
    expect(got.games.map((g) => g.label).sort()).toEqual(['bonelab', 'repo'])
  })

  it('ignores wrong-shape and future-dated caches', async () => {
    const paths = makePaths(tmp)
    await writeJsonAtomic(paths.schemaCache, {
      games: 'nope',
      fetchedAt: new Date(1000).toISOString()
    })
    const fetchFn = await okFetch()
    await loadCatalog(paths, fetchFn, fixture, 86_400_000, () => 2000)
    expect(fetchFn).toHaveBeenCalledOnce()
    const cat = { ...parseEcosystem(await raw()), fetchedAt: new Date(9_000_000).toISOString() }
    await writeJsonAtomic(paths.schemaCache, cat)
    const fetch2 = await okFetch()
    await loadCatalog(paths, fetch2, fixture, 86_400_000, () => 2000)
    expect(fetch2).toHaveBeenCalledOnce()
  })

  it('falls back when cache file is corrupt', async () => {
    const paths = makePaths(tmp)
    await fs.mkdir(path.dirname(paths.schemaCache), { recursive: true })
    await fs.writeFile(paths.schemaCache, '{not json')
    const fetchFn = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect((await loadCatalog(paths, fetchFn, fixture)).games.length).toBe(2)
  })
})

describe('json store', () => {
  it('writeJsonAtomic leaves no temp file and creates parents', async () => {
    const file = path.join(tmp, 'a', 'b', 'x.json')
    await writeJsonAtomic(file, { a: 1 })
    expect(await readJson(file)).toEqual({ a: 1 })
    expect(await fs.readdir(path.dirname(file))).toEqual(['x.json'])
  })

  it('readJson returns null for missing and invalid files', async () => {
    expect(await readJson(path.join(tmp, 'nope.json'))).toBeNull()
    await fs.writeFile(path.join(tmp, 'bad.json'), 'xx{')
    expect(await readJson(path.join(tmp, 'bad.json'))).toBeNull()
  })
})

describe('makePaths', () => {
  it('derives locations from root', () => {
    const p = makePaths('/r')
    expect(p.schemaCache).toBe(path.join('/r', 'cache', 'ecosystem.json'))
    expect(p.downloads).toBe(path.join('/r', 'cache', 'downloads'))
    expect(p.profileDir('repo', 'x')).toBe(path.join('/r', 'games', 'repo', 'profiles', 'x'))
  })
})
