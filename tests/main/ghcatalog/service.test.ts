/* eslint-disable @typescript-eslint/no-unused-vars -- fake fetches take (url, init) so call args type-check */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCatalogServices, type CatalogServices } from '../../../src/main/ghcatalog/service'
import { makePaths } from '../../../src/main/store/paths'
import { writeJsonAtomic } from '../../../src/main/store/json'
import type { CatalogIndex } from '../../../src/shared/ghCatalog'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-catsvc-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const RAW = 'https://raw.githubusercontent.com/a/b/HEAD/README.md'

async function seed(fetchFn: typeof fetch): Promise<CatalogServices> {
  const paths = makePaths(dir)
  const idx: CatalogIndex = {
    game: 'repo',
    builtAt: 'x',
    mods: [
      { key: 'a/b/m', owner: 'a', repo: 'b', id: 'm', readme: RAW },
      { key: 'a/b/evil', owner: 'a', repo: 'b', id: 'evil', readme: 'https://evil.test/r.md' },
      { key: 'a/b/pre', owner: 'a', repo: 'b', id: 'pre', tagPrefix: 'pre-' }
    ] as unknown as CatalogIndex['mods']
  }
  await writeJsonAtomic(paths.catalogCache('repo'), {
    fetchedAt: new Date(1000).toISOString(),
    etag: null,
    mods: idx.mods
  })
  return createCatalogServices({
    paths,
    fetch: fetchFn,
    shareBaseUrl: 'https://w.test',
    now: () => 1000
  })
}

describe('catReadme', () => {
  it('fetches raw markdown', async () => {
    const f = vi.fn(async (..._a: unknown[]) => new Response('# hi'))
    const svc = await seed(f as unknown as typeof fetch)
    expect(await svc.catReadme('repo', 'a/b/m')).toBe('# hi')
    expect(f.mock.calls[0][0]).toBe(RAW)
  })

  it('rejects non-raw hosts without fetching', async () => {
    const f = vi.fn(async (..._a: unknown[]) => new Response('x'))
    const svc = await seed(f as unknown as typeof fetch)
    await expect(svc.catReadme('repo', 'a/b/evil')).rejects.toThrow()
    await expect(svc.catReadme('repo', 'a/b/missing')).rejects.toThrow()
    expect(f).not.toHaveBeenCalled()
  })

  it('caps the size at 1 MB', async () => {
    const f = vi.fn(async (..._a: unknown[]) => new Response('a'.repeat(1_100_000)))
    const svc = await seed(f as unknown as typeof fetch)
    expect((await svc.catReadme('repo', 'a/b/m')).length).toBe(1_048_576)
  })
})

describe('catStatus', () => {
  it('returns the status', async () => {
    const f = vi.fn(
      async (..._a: unknown[]) => new Response(JSON.stringify({ owner: 'a', repo: 'b' }))
    )
    const svc = await seed(f as unknown as typeof fetch)
    expect(await svc.catStatus('a/b')).toMatchObject({ owner: 'a' })
    expect(f.mock.calls[0][0]).toBe('https://w.test/v1/catalog/status/a/b')
  })

  it('returns null on 404, errors and bad input', async () => {
    const f = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 404 }))
    const svc = await seed(f as unknown as typeof fetch)
    expect(await svc.catStatus('a/b')).toBeNull()
    expect(await svc.catStatus('nonsense')).toBeNull()
    const g = vi.fn(async (..._a: unknown[]) => {
      throw new Error('down')
    })
    const svc2 = await seed(g as unknown as typeof fetch)
    expect(await svc2.catStatus('a/b')).toBeNull()
  })
})

describe('cachedEntry', () => {
  it('reads the disk cache only, matching tagPrefix', async () => {
    const f = vi.fn()
    const svc = await seed(f as unknown as typeof fetch)
    expect((await svc.cachedEntry('repo', 'A', 'B', 'pre-'))?.id).toBe('pre')
    expect((await svc.cachedEntry('repo', 'a', 'b', ''))?.id).toBe('m')
    expect(await svc.cachedEntry('repo', 'a', 'b', 'zzz')).toBeNull()
    expect(await svc.cachedEntry('nogame', 'a', 'b', '')).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })
})
