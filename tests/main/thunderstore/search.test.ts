import { describe, it, expect } from 'vitest'
import { searchPackages, allCategories } from '../../../src/main/thunderstore/search'
import type { TsPackage, TsQuery } from '../../../src/shared/types'

const pkg = (o: Partial<TsPackage> & { name: string }): TsPackage => ({
  fullName: `${o.owner ?? 'Own'}-${o.name}`,
  owner: 'Own',
  description: '',
  iconUrl: '',
  websiteUrl: '',
  packageUrl: '',
  categories: [],
  rating: 0,
  totalDownloads: 0,
  dateUpdated: '2026-01-01T00:00:00Z',
  isPinned: false,
  isDeprecated: false,
  nsfw: false,
  versions: [],
  ...o
})
const q = (o: Partial<TsQuery> = {}): TsQuery => ({
  text: '',
  categories: [],
  sort: 'top',
  includeDeprecated: false,
  includeNsfw: false,
  offset: 0,
  limit: 50,
  ...o
})
const names = (r: { items: TsPackage[] }): string[] => r.items.map((p) => p.name)

describe('searchPackages text', () => {
  const pkgs = [
    pkg({ name: 'MoreUpgrades' }),
    pkg({ name: 'More_Upgrades2', owner: 'Zed' }),
    pkg({ name: 'Other', description: 'adds upgrades to more things' }),
    pkg({ name: 'Unrelated' })
  ]
  it('matches every term across name/owner/fullName/description, case-insensitive', () => {
    expect(names(searchPackages(pkgs, q({ text: 'MORE upgrades', sort: 'name' })))).toEqual([
      'More_Upgrades2',
      'MoreUpgrades',
      'Other'
    ])
    expect(names(searchPackages(pkgs, q({ text: 'zed' })))).toEqual(['More_Upgrades2'])
    expect(names(searchPackages(pkgs, q({ text: 'own-unrel' })))).toEqual(['Unrelated'])
  })
  it('matches underscores as spaces and removed', () => {
    expect(names(searchPackages(pkgs, q({ text: 'more upgrades2' })))).toEqual(['More_Upgrades2'])
    expect(names(searchPackages(pkgs, q({ text: 'moreupgrades2' })))).toEqual(['More_Upgrades2'])
  })
  it('requires all terms', () => {
    expect(searchPackages(pkgs, q({ text: 'more zzz' })).total).toBe(0)
  })
  it('empty text matches all', () => {
    expect(searchPackages(pkgs, q()).total).toBe(4)
  })
})

describe('searchPackages filters', () => {
  it('excludes deprecated and nsfw unless included', () => {
    const pkgs = [
      pkg({ name: 'a' }),
      pkg({ name: 'b', isDeprecated: true }),
      pkg({ name: 'c', nsfw: true })
    ]
    expect(names(searchPackages(pkgs, q({ sort: 'name' })))).toEqual(['a'])
    expect(names(searchPackages(pkgs, q({ sort: 'name', includeDeprecated: true })))).toEqual(['a', 'b'])
    expect(names(searchPackages(pkgs, q({ sort: 'name', includeNsfw: true })))).toEqual(['a', 'c'])
  })
  it('requires every listed category', () => {
    const pkgs = [
      pkg({ name: 'a', categories: ['Mods', 'Tools'] }),
      pkg({ name: 'b', categories: ['Mods'] })
    ]
    expect(names(searchPackages(pkgs, q({ categories: ['Mods', 'Tools'] })))).toEqual(['a'])
    expect(searchPackages(pkgs, q({ categories: ['Mods'] })).total).toBe(2)
  })
})

describe('searchPackages sort', () => {
  it('top: pinned, rating desc, downloads desc, ties in index order', () => {
    const pkgs = [
      pkg({ name: 'a', rating: 5, totalDownloads: 1 }),
      pkg({ name: 'b', rating: 5, totalDownloads: 9 }),
      pkg({ name: 'c', rating: 1, isPinned: true }),
      pkg({ name: 'd', rating: 5, totalDownloads: 9 })
    ]
    expect(names(searchPackages(pkgs, q()))).toEqual(['c', 'b', 'd', 'a'])
  })
  it('downloads', () => {
    const pkgs = [pkg({ name: 'a', totalDownloads: 1 }), pkg({ name: 'b', totalDownloads: 2 })]
    expect(names(searchPackages(pkgs, q({ sort: 'downloads' })))).toEqual(['b', 'a'])
  })
  it('updated', () => {
    const pkgs = [
      pkg({ name: 'a', dateUpdated: '2026-01-01T00:00:00Z' }),
      pkg({ name: 'b', dateUpdated: '2026-03-01T00:00:00Z' })
    ]
    expect(names(searchPackages(pkgs, q({ sort: 'updated' })))).toEqual(['b', 'a'])
  })
  it('name asc case-insensitive', () => {
    const pkgs = [pkg({ name: 'banana' }), pkg({ name: 'Apple' }), pkg({ name: 'cherry' })]
    expect(names(searchPackages(pkgs, q({ sort: 'name' })))).toEqual(['Apple', 'banana', 'cherry'])
  })
})

describe('searchPackages paging', () => {
  const pkgs = Array.from({ length: 250 }, (_, i) => pkg({ name: `p${String(i).padStart(3, '0')}` }))
  it('slices and reports total', () => {
    const r = searchPackages(pkgs, q({ sort: 'name', offset: 10, limit: 5 }))
    expect(r.total).toBe(250)
    expect(names(r)).toEqual(['p010', 'p011', 'p012', 'p013', 'p014'])
  })
  it('clamps limit to 1..100 and offset >= 0', () => {
    expect(searchPackages(pkgs, q({ limit: 1000 })).items).toHaveLength(100)
    expect(searchPackages(pkgs, q({ limit: 0 })).items).toHaveLength(1)
    expect(names(searchPackages(pkgs, q({ sort: 'name', offset: -5, limit: 1 })))).toEqual(['p000'])
  })
})

describe('allCategories', () => {
  it('returns sorted unique set', () => {
    const pkgs = [pkg({ name: 'a', categories: ['Tools', 'Mods'] }), pkg({ name: 'b', categories: ['Mods', 'Audio'] })]
    expect(allCategories(pkgs)).toEqual(['Audio', 'Mods', 'Tools'])
  })
})

describe('performance', () => {
  it('searches 50k packages with sort top in < 500ms', () => {
    const pkgs = Array.from({ length: 50_000 }, (_, i) =>
      pkg({
        name: i % 3 === 0 ? `Lib_${i}` : `Mod${i}`,
        description: `description number ${i} of a synthetic package`,
        rating: i % 100,
        totalDownloads: i * 7,
        isPinned: i % 1000 === 0
      })
    )
    const t = performance.now()
    const r = searchPackages(pkgs, q({ text: 'lib', limit: 50 }))
    const ms = performance.now() - t
    expect(r.items.length).toBeLessThanOrEqual(50)
    expect(r.total).toBeGreaterThan(16000)
    expect(ms).toBeLessThan(500)
  })
})
