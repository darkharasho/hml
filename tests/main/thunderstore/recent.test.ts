import { describe, expect, it, vi } from 'vitest'
import { communityOf, overlayRecent } from '../../../src/main/thunderstore/recent'
import type { TsPackage } from '../../../src/shared/types'

const LISTING = 'https://thunderstore.io/api/cyberstorm/listing/repo/'
const page1 = `${LISTING}?ordering=last-updated&deprecated=true&nsfw=true`
const page2 = `${LISTING}?deprecated=True&nsfw=True&ordering=last-updated&page=2`
const pkgUrl = (ns: string, name: string): string =>
  `https://thunderstore.io/api/experimental/package/${ns}/${name}/`

function indexed(fullName: string, versions: string[], dateUpdated: string): TsPackage {
  const [owner, name] = fullName.split('-')
  return {
    fullName,
    owner,
    name,
    description: 'old',
    iconUrl: '',
    websiteUrl: '',
    packageUrl: `https://thunderstore.io/c/repo/p/${owner}/${name}/`,
    categories: ['Mods'],
    rating: 1,
    totalDownloads: 2,
    dateUpdated,
    isPinned: false,
    isDeprecated: false,
    nsfw: false,
    versions: versions.map((version) => ({
      version,
      dependencies: [],
      downloadUrl: `https://dl/${fullName}/${version}`,
      downloads: 1,
      fileSize: 1,
      dateCreated: dateUpdated
    }))
  }
}

const row = (ns: string, name: string, lastUpdated: string, pinned = false): unknown => ({
  namespace: ns,
  name,
  last_updated: lastUpdated,
  categories: [{ id: '1', name: 'Tools', slug: 'tools' }],
  is_pinned: pinned,
  is_deprecated: false,
  is_nsfw: false,
  size: 99
})

const latest = (ns: string, name: string, version: string, deps: string[] = []): unknown => ({
  namespace: ns,
  name,
  full_name: `${ns}-${name}`,
  rating_score: 7,
  total_downloads: 50,
  latest: {
    version_number: version,
    description: `${name} ${version}`,
    icon: 'icon.png',
    dependencies: deps,
    download_url: `https://dl/${ns}-${name}/${version}`,
    downloads: 3,
    date_created: '2026-10-19T03:00:00Z',
    website_url: '',
    is_active: true
  }
})

function fakeFetch(map: Record<string, unknown>): typeof fetch & ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (!(url in map)) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => map[url] }
  }) as never
}

const base = [
  indexed('Own-Mod', ['1.0.0'], '2026-10-19T01:00:00Z'),
  indexed('Old-Lib', ['2.0.0'], '2026-10-18T00:00:00Z')
]

describe('communityOf', () => {
  it('reads the community from a package-listing index URL', () => {
    expect(communityOf('https://thunderstore.io/c/repo/api/v1/package-listing-index/')).toBe('repo')
    expect(communityOf('https://thunderstore.io/c/hades-ii/api/v1/package-listing-index/')).toBe(
      'hades-ii'
    )
    expect(communityOf('https://ts.test/index')).toBeNull()
  })
})

describe('overlayRecent', () => {
  it('adds a newer version and a new mod, newer than the index, and stops at the index', async () => {
    const fetchFn = fakeFetch({
      [page1]: {
        next: page2,
        results: [
          row('BepInEx', 'Pack', '2026-01-01T00:00:00Z', true),
          row('New', 'Thing', '2026-10-19T03:30:00Z'),
          row('Own', 'Mod', '2026-10-19T03:00:00Z'),
          row('Old', 'Lib', '2026-10-18T00:00:00Z')
        ]
      },
      [page2]: { next: null, results: [row('Never', 'Read', '2026-10-19T04:00:00Z')] },
      [pkgUrl('New', 'Thing')]: latest('New', 'Thing', '0.1.0', ['Own-Mod-1.1.0']),
      [pkgUrl('Own', 'Mod')]: latest('Own', 'Mod', '1.1.0')
    })
    const r = await overlayRecent({
      packages: base,
      community: 'repo',
      fetch: fetchFn,
      memo: new Map()
    })
    expect(r.changed).toBe(2)
    expect(r.packages.map((p) => p.fullName)).toEqual(['New-Thing', 'Own-Mod', 'Old-Lib'])
    const own = r.packages[1]
    expect(own.versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0'])
    expect(own.versions[0]).toMatchObject({
      downloadUrl: 'https://dl/Own-Mod/1.1.0',
      fileSize: 99
    })
    expect(own).toMatchObject({
      description: 'Mod 1.1.0',
      dateUpdated: '2026-10-19T03:00:00Z',
      categories: ['Tools'],
      packageUrl: 'https://thunderstore.io/c/repo/p/Own/Mod/'
    })
    const added = r.packages[0]
    expect(added.packageUrl).toBe('https://thunderstore.io/c/repo/p/New/Thing/')
    expect(added.versions[0].dependencies).toEqual(['Own-Mod-1.1.0'])
    expect(r.packages[2]).toBe(base[1])
    expect(fetchFn.mock.calls.map((c) => c[0])).not.toContain(page2)
  })

  it('reads further pages while everything on one is newer', async () => {
    const fetchFn = fakeFetch({
      [page1]: { next: page2, results: [row('Own', 'Mod', '2026-10-19T03:00:00Z')] },
      [page2]: { next: null, results: [row('New', 'Thing', '2026-10-19T02:00:00Z')] },
      [pkgUrl('New', 'Thing')]: latest('New', 'Thing', '0.1.0'),
      [pkgUrl('Own', 'Mod')]: latest('Own', 'Mod', '1.1.0')
    })
    const r = await overlayRecent({
      packages: base,
      community: 'repo',
      fetch: fetchFn,
      memo: new Map()
    })
    expect(r.changed).toBe(2)
  })

  it('remembers latest versions, so a repeat check only reads the listing', async () => {
    const fetchFn = fakeFetch({
      [page1]: { next: null, results: [row('Own', 'Mod', '2026-10-19T03:00:00Z')] },
      [pkgUrl('Own', 'Mod')]: latest('Own', 'Mod', '1.1.0')
    })
    const memo = new Map<string, TsPackage | null>()
    await overlayRecent({ packages: base, community: 'repo', fetch: fetchFn, memo })
    const r = await overlayRecent({ packages: base, community: 'repo', fetch: fetchFn, memo })
    expect(r.packages[0].versions[0].version).toBe('1.1.0')
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([page1, pkgUrl('Own', 'Mod'), page1])
  })

  it('keeps the index entry when a package fails to load, and tries it again next time', async () => {
    const fetchFn = fakeFetch({
      [page1]: { next: null, results: [row('Own', 'Mod', '2026-10-19T03:00:00Z')] }
    })
    const memo = new Map<string, TsPackage | null>()
    const r = await overlayRecent({ packages: base, community: 'repo', fetch: fetchFn, memo })
    expect(r).toEqual({ packages: base, changed: 0 })
    expect(memo.size).toBe(0)
  })

  it('returns the index untouched when nothing is newer', async () => {
    const fetchFn = fakeFetch({
      [page1]: { next: null, results: [row('Own', 'Mod', '2026-10-19T01:00:00Z')] }
    })
    const r = await overlayRecent({
      packages: base,
      community: 'repo',
      fetch: fetchFn,
      memo: new Map()
    })
    expect(r.packages).toBe(base)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('throws when the live listing cannot be read', async () => {
    await expect(
      overlayRecent({ packages: base, community: 'repo', fetch: fakeFetch({}), memo: new Map() })
    ).rejects.toThrow('HTTP 404')
  })
})
