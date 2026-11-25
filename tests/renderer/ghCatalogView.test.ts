import { describe, expect, it } from 'vitest'
import type { CatalogEntry } from '../../src/shared/ghCatalog'
import type { InstalledMod } from '../../src/shared/types'
import {
  catCategories,
  catInstallState,
  catInstallToast,
  catReportUrl,
  confirmOwnersBody,
  filterCatalog,
  joinOwners,
  listedFromPrerelease,
  type CatSort
} from '../../src/renderer/src/ghCatalogView'

function entry(o: Partial<CatalogEntry> & { key: string }): CatalogEntry {
  const [owner, repo, id] = o.key.split('/')
  return {
    owner,
    repo,
    id,
    name: id,
    description: '',
    categories: [],
    dependencies: [],
    nsfw: false,
    stars: 0,
    repoCreatedAt: '2025-01-01T00:00:00Z',
    ownerAvatar: '',
    downloads: 0,
    updatedAt: '2026-01-01T00:00:00Z',
    games: ['repo'],
    ...o,
    latest: {
      tag: 'v1.0.0',
      version: '1.0.0',
      publishedAt: '2026-01-01T00:00:00Z',
      prerelease: false,
      assetName: 'a.zip',
      size: 1,
      ...o.latest
    }
  }
}

function ghMod(owner: string, repo: string, tag: string): InstalledMod {
  return {
    id: `${owner}-${repo}`,
    name: repo,
    version: tag,
    source: { kind: 'github', owner, repo, tag, asset: 'a.zip', sha256: '' },
    enabled: true,
    files: [],
    disableable: [],
    installedAt: '2026-01-01T00:00:00Z'
  }
}

const q = (
  o: Partial<Parameters<typeof filterCatalog>[1]> = {}
): Parameters<typeof filterCatalog>[1] => ({
  text: '',
  category: null,
  sort: 'updated',
  nsfw: false,
  ...o
})

describe('filterCatalog', () => {
  const mods = [
    entry({ key: 'alice/tools/speed', name: 'Speedy', description: 'Run faster' }),
    entry({ key: 'bob/pack/hats', name: 'Hat Pack', categories: ['Cosmetics'] }),
    entry({ key: 'carol/x/lewd', name: 'Spicy', nsfw: true })
  ]
  const keys = (list: CatalogEntry[]): string[] => list.map((m) => m.key)

  it('matches name, description, owner and category, case-insensitively', () => {
    expect(keys(filterCatalog(mods, q({ text: 'speedy' })))).toEqual(['alice/tools/speed'])
    expect(keys(filterCatalog(mods, q({ text: 'RUN FAST' })))).toEqual(['alice/tools/speed'])
    expect(keys(filterCatalog(mods, q({ text: 'Bob' })))).toEqual(['bob/pack/hats'])
    expect(keys(filterCatalog(mods, q({ text: 'cosmetic' })))).toEqual(['bob/pack/hats'])
    expect(filterCatalog(mods, q({ text: 'nothing like this' }))).toEqual([])
  })

  it('filters by category', () => {
    expect(keys(filterCatalog(mods, q({ category: 'Cosmetics' })))).toEqual(['bob/pack/hats'])
  })

  it('hides nsfw entries unless asked', () => {
    expect(keys(filterCatalog(mods, q()))).not.toContain('carol/x/lewd')
    expect(keys(filterCatalog(mods, q({ nsfw: true })))).toContain('carol/x/lewd')
  })

  it('orders by each sort', () => {
    const list = [
      entry({
        key: 'a/a/a',
        stars: 5,
        downloads: 100,
        repoCreatedAt: '2024-01-01T00:00:00Z',
        latest: { publishedAt: '2026-03-01T00:00:00Z' } as CatalogEntry['latest']
      }),
      entry({
        key: 'b/b/b',
        stars: 50,
        downloads: 10,
        repoCreatedAt: '2026-01-01T00:00:00Z',
        latest: { publishedAt: '2026-01-01T00:00:00Z' } as CatalogEntry['latest']
      }),
      entry({
        key: 'c/c/c',
        stars: 1,
        downloads: 1000,
        repoCreatedAt: '2025-01-01T00:00:00Z',
        latest: { publishedAt: '2026-02-01T00:00:00Z' } as CatalogEntry['latest']
      })
    ]
    const order = (sort: CatSort): string[] => keys(filterCatalog(list, q({ sort })))
    expect(order('updated')).toEqual(['a/a/a', 'c/c/c', 'b/b/b'])
    expect(order('downloads')).toEqual(['c/c/c', 'a/a/a', 'b/b/b'])
    expect(order('stars')).toEqual(['b/b/b', 'a/a/a', 'c/c/c'])
    expect(order('newest')).toEqual(['b/b/b', 'c/c/c', 'a/a/a'])
  })

  it('does not reorder the given list', () => {
    const copy = [...mods]
    filterCatalog(mods, q({ sort: 'stars' }))
    expect(mods).toEqual(copy)
  })
})

describe('catCategories', () => {
  it('lists each category once, sorted', () => {
    expect(
      catCategories([
        entry({ key: 'a/a/a', categories: ['Tools', 'Cosmetics'] }),
        entry({ key: 'b/b/b', categories: ['Cosmetics', 'Audio'] })
      ])
    ).toEqual(['Audio', 'Cosmetics', 'Tools'])
  })
})

describe('catInstallState', () => {
  it('counts a URL-installed mod of a single-mod repo as installed', () => {
    const e = entry({ key: 'Alice/Tools/tools' })
    expect(catInstallState(e, [ghMod('alice', 'tools', 'v1.0.0')])).toBe('installed')
  })
  it('offers an update when the installed tag is older', () => {
    const e = entry({
      key: 'alice/tools/tools',
      latest: { tag: 'v1.2.0' } as CatalogEntry['latest']
    })
    expect(catInstallState(e, [ghMod('alice', 'tools', 'v1.0.0')])).toBe('update')
  })
  it('matches monorepo mods by tag prefix', () => {
    const e = entry({
      key: 'alice/mono/energy',
      tagPrefix: 'energy-v',
      latest: { tag: 'energy-v1.1.0' } as CatalogEntry['latest']
    })
    expect(catInstallState(e, [ghMod('alice', 'mono', 'flight-v2.0.0')])).toBe('none')
    expect(catInstallState(e, [ghMod('alice', 'mono', 'energy-v1.1.0')])).toBe('installed')
    expect(catInstallState(e, [ghMod('alice', 'mono', 'energy-v1.0.0')])).toBe('update')
  })
  it('matches by repo alone when the entry has no tagPrefix but its tags have one', () => {
    const e = entry({
      key: 'alice/tools/tools',
      latest: { tag: 'tools-v1.0.0' } as CatalogEntry['latest']
    })
    expect(catInstallState(e, [ghMod('alice', 'tools', 'tools-v1.0.0')])).toBe('installed')
  })
  it('is none when nothing matches', () => {
    expect(catInstallState(entry({ key: 'a/b/c' }), [])).toBe('none')
  })
})

describe('confirm copy', () => {
  it('joins owners naturally', () => {
    expect(joinOwners(['a'])).toBe('a')
    expect(joinOwners(['a', 'b'])).toBe('a and b')
    expect(joinOwners(['a', 'b', 'c'])).toBe('a, b and c')
  })
  it('uses publishes for one owner and publish for several', () => {
    expect(confirmOwnersBody(['alice'])).toBe(
      "alice publishes on GitHub, not Thunderstore or Nexus Mods. HML doesn't review GitHub mods. Only install mods from authors you trust."
    )
    expect(confirmOwnersBody(['alice', 'bob'])).toBe(
      "alice and bob publish on GitHub, not Thunderstore or Nexus Mods. HML doesn't review GitHub mods. Only install mods from authors you trust."
    )
  })
})

describe('catReportUrl', () => {
  it('encodes the title', () => {
    expect(catReportUrl('alice', 'my repo')).toBe(
      'https://github.com/darkharasho/hml/issues/new?template=catalog-report.yml&title=Report%3A%20alice%2Fmy%20repo'
    )
  })
})

describe('catInstallToast', () => {
  const e = entry({ key: 'alice/tools/tools', name: 'Tools' })
  it('names the mod and its dependencies', () => {
    const mod = { ...ghMod('alice', 'tools', 'v1.0.0'), name: 'Tools', version: '1.0.0' }
    expect(catInstallToast(e, [mod], [])).toEqual({
      kind: 'success',
      message: 'Installed Tools 1.0.0'
    })
    expect(catInstallToast(e, [ghMod('x', 'dep', 'v1'), mod], [])).toEqual({
      kind: 'success',
      message: 'Installed Tools 1.0.0 and 1 dependency'
    })
  })
  it('lists unavailable dependencies', () => {
    expect(catInstallToast(e, [ghMod('alice', 'tools', 'v1.0.0')], ['github:z/z'])).toEqual({
      kind: 'info',
      message: 'Installed tools v1.0.0 — missing dependencies: github:z/z'
    })
  })
  it('points to the profile for Nexus files to download by hand', () => {
    const mod = { ...ghMod('alice', 'tools', 'v1.0.0'), name: 'Tools', version: '1.0.0' }
    expect(catInstallToast(e, [mod], [], [{ name: 'BepInEx' }])).toEqual({
      kind: 'info',
      message:
        "Installed Tools 1.0.0. Download BepInEx from Nexus Mods: it's listed in this profile."
    })
  })
  it('says when nothing needed installing', () => {
    expect(catInstallToast(e, [], [])).toEqual({
      kind: 'info',
      message: 'Tools is already installed'
    })
  })
})

describe('listedFromPrerelease', () => {
  it('is true only for an entry listed from a pre-release', () => {
    const pre = entry({ key: 'a/b/c', latest: { prerelease: true } as CatalogEntry['latest'] })
    expect(listedFromPrerelease(pre)).toBe(true)
    expect(listedFromPrerelease(entry({ key: 'a/b/c' }))).toBe(false)
  })
})
