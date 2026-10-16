import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  slimPackage,
  decodeMaybeGzip,
  loadPackageIndex
} from '../../../src/main/thunderstore/packageIndex'
import { makePaths } from '../../../src/main/store/paths'
import { readJson } from '../../../src/main/store/json'

const fx = (n: string): unknown[] =>
  JSON.parse(readFileSync(path.resolve(__dirname, `../../fixtures/${n}.json`), 'utf8'))

const IDX = 'https://ts.test/index'
const A = 'https://ts.test/chunk-a'
const B = 'https://ts.test/chunk-b'
const gz = (v: unknown): Uint8Array => gzipSync(Buffer.from(JSON.stringify(v)))
let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-tsidx-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

function fakeFetch(
  map: Record<string, Uint8Array | 'fail' | number>
): typeof fetch & ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    const b = map[url]
    if (b === 'fail' || b === undefined) throw new Error('network down')
    if (typeof b === 'number') return { ok: false, status: b }
    const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    return { ok: true, status: 200, arrayBuffer: async () => buf }
  }) as never
}
const goodMap = (): Record<string, Uint8Array> => ({
  [IDX]: gz([A, B]),
  [A]: gz(fx('ts-chunk-a')),
  [B]: gz(fx('ts-chunk-b'))
})

describe('slimPackage', () => {
  it('maps fields and drops inactive versions', () => {
    const p = slimPackage(fx('ts-chunk-a')[0])!
    expect(p.fullName).toBe('A-Alpha')
    expect(p.description).toBe('Alpha desc 1.1.0')
    expect(p.iconUrl).toBe('https://ccdn.thunderstore.io/Alpha.png')
    expect(p.websiteUrl).toBe('https://example.com/a')
    expect(p.versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0'])
    expect(p.totalDownloads).toBe(15)
    const beta = slimPackage(fx('ts-chunk-a')[1])!
    expect(beta.versions.map((v) => v.version)).toEqual(['1.0.0'])
    expect(beta.totalDownloads).toBe(10)
    expect(slimPackage(fx('ts-chunk-a')[2])!.isDeprecated).toBe(true)
  })
  it('returns null for malformed or fully inactive packages', () => {
    expect(slimPackage({})).toBeNull()
    expect(slimPackage(null)).toBeNull()
    const raw = fx('ts-chunk-a')[1] as { versions: { is_active: boolean }[] }
    const dead = { ...raw, versions: raw.versions.map((v) => ({ ...v, is_active: false })) }
    expect(slimPackage(dead)).toBeNull()
  })
})

describe('decodeMaybeGzip', () => {
  it('handles gzipped and plain bodies', () => {
    expect(decodeMaybeGzip(gz(['x']))).toEqual(['x'])
    expect(decodeMaybeGzip(Buffer.from('["y"]'))).toEqual(['y'])
  })
})

describe('loadPackageIndex', () => {
  const base = (
    f: typeof fetch,
    extra: Partial<Parameters<typeof loadPackageIndex>[0]> = {}
  ): Parameters<typeof loadPackageIndex>[0] => ({
    paths: makePaths(tmp),
    label: 'repo',
    indexUrl: IDX,
    fetch: f,
    ...extra
  })

  it('fetches index and chunks, merges, and writes cache', async () => {
    const f = fakeFetch(goodMap())
    const r = await loadPackageIndex(base(f, { now: () => 5_000 }))
    expect(r.packages.map((p) => p.fullName)).toEqual([
      'A-Alpha',
      'A-Beta',
      'A-Gamma',
      'A-Delta',
      'A-Eps',
      'A-Zeta'
    ])
    expect(r.stale).toBe(false)
    const cache = await readJson<{ chunkUrls: string[]; fetchedAt: string }>(
      makePaths(tmp).tsIndexCache('repo')
    )
    expect(cache!.chunkUrls).toEqual([A, B])
    expect(cache!.fetchedAt).toBe(new Date(5_000).toISOString())
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('writes the cache compact, without indentation', async () => {
    await loadPackageIndex(base(fakeFetch(goodMap()), { now: () => 5_000 }))
    const text = readFileSync(makePaths(tmp).tsIndexCache('repo'), 'utf8')
    expect(text).not.toContain('\n')
    expect(JSON.parse(text).packages).toHaveLength(6)
  })

  it('does not fetch with a fresh cache', async () => {
    await loadPackageIndex(base(fakeFetch(goodMap()), { now: () => 1_000 }))
    const f = fakeFetch({})
    const r = await loadPackageIndex(base(f, { now: () => 2_000 }))
    expect(f).not.toHaveBeenCalled()
    expect(r.packages).toHaveLength(6)
  })

  it('stale cache with unchanged chunk urls only fetches the index', async () => {
    await loadPackageIndex(base(fakeFetch(goodMap()), { now: () => 1_000 }))
    const f = fakeFetch({ [IDX]: gz([A, B]) })
    const r = await loadPackageIndex(base(f, { now: () => 10_000_000 }))
    expect(f).toHaveBeenCalledTimes(1)
    expect(r.packages).toHaveLength(6)
    expect(r.fetchedAt).toBe(new Date(10_000_000).toISOString())
  })

  it('force ignores freshness but reuses unchanged chunks', async () => {
    await loadPackageIndex(base(fakeFetch(goodMap()), { now: () => 1_000 }))
    const f = fakeFetch({ [IDX]: gz([A, B]) })
    const r = await loadPackageIndex(base(f, { now: () => 2_000, force: true }))
    expect(f).toHaveBeenCalledTimes(1)
    expect(r.fetchedAt).toBe(new Date(2_000).toISOString())
  })

  it('refetches chunks when the chunk list changes', async () => {
    await loadPackageIndex(base(fakeFetch(goodMap()), { now: () => 1_000 }))
    const f = fakeFetch({ [IDX]: gz([A]), [A]: gz(fx('ts-chunk-a')) })
    const r = await loadPackageIndex(base(f, { now: () => 10_000_000 }))
    expect(r.packages).toHaveLength(3)
  })

  it.each([
    ['index throws', { [IDX]: 'fail' }],
    ['index non-OK', { [IDX]: 503 }],
    [
      'chunk throws',
      { [IDX]: gz([A, 'https://ts.test/new']), [A]: gz([]), 'https://ts.test/new': 'fail' }
    ],
    ['chunk non-OK', { [IDX]: gz(['https://ts.test/new']), 'https://ts.test/new': 500 }],
    ['index not strings', { [IDX]: gz([1, 2]) }],
    ['chunk not array', { [IDX]: gz(['https://ts.test/new']), 'https://ts.test/new': gz({}) }]
  ] as [string, Record<string, Uint8Array | 'fail' | number>][])(
    'falls back to stale cache when %s',
    async (_n, map) => {
      await loadPackageIndex(base(fakeFetch(goodMap()), { now: () => 1_000 }))
      const file = makePaths(tmp).tsIndexCache('repo')
      const before = await fs.readFile(file, 'utf8')
      const r = await loadPackageIndex(base(fakeFetch(map), { now: () => 10_000_000 }))
      expect(r.stale).toBe(true)
      expect(r.packages).toHaveLength(6)
      expect(await fs.readFile(file, 'utf8')).toBe(before)
    }
  )

  it('rejects readably with no cache', async () => {
    await expect(loadPackageIndex(base(fakeFetch({})))).rejects.toThrow(
      "Couldn't reach Thunderstore. Check your connection and try again."
    )
  })

  it('skips malformed packages in a chunk', async () => {
    const f = fakeFetch({ [IDX]: gz([A]), [A]: gz([{}, 7, ...fx('ts-chunk-b')]) })
    const r = await loadPackageIndex(base(f))
    expect(r.packages).toHaveLength(3)
  })

  it('treats a corrupt cache as missing', async () => {
    const file = makePaths(tmp).tsIndexCache('repo')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{not json')
    const f = fakeFetch(goodMap())
    const r = await loadPackageIndex(base(f))
    expect(f).toHaveBeenCalledTimes(3)
    expect(r.packages).toHaveLength(6)
  })

  it('limits chunk concurrency to 3', async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://ts.test/c${i}`)
    let cur = 0,
      max = 0
    const f = vi.fn(async (url: string) => {
      const body = url === IDX ? gz(urls) : gz([])
      cur++
      max = Math.max(max, cur)
      await new Promise((r) => setTimeout(r, 5))
      cur--
      const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      return { ok: true, status: 200, arrayBuffer: async () => buf }
    }) as unknown as typeof fetch
    await loadPackageIndex(base(f))
    expect(max).toBeLessThanOrEqual(3)
    expect(max).toBeGreaterThan(1)
  })
})
