import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  findUpdates,
  installedVersions,
  parseDependency,
  resolveInstall
} from '../../../src/main/thunderstore/resolve'
import type { InstalledMod, TsPackage } from '../../../src/shared/types'

function pkg(fullName: string, versions: Record<string, string[]>): TsPackage {
  const name = fullName.slice(fullName.indexOf('-') + 1)
  return {
    fullName,
    owner: fullName.slice(0, fullName.indexOf('-')),
    name,
    description: '',
    iconUrl: '',
    websiteUrl: '',
    packageUrl: '',
    categories: [],
    rating: 0,
    totalDownloads: 0,
    dateUpdated: '',
    isPinned: false,
    isDeprecated: false,
    nsfw: false,
    versions: Object.entries(versions)
      .sort((a, b) => compareVersions(b[0], a[0]))
      .map(([version, dependencies]) => ({
        version,
        dependencies,
        downloadUrl: `https://dl/${fullName}/${version}`,
        downloads: 0,
        fileSize: 0,
        dateCreated: ''
      }))
  }
}
const idx = (...p: TsPackage[]): Map<string, TsPackage> => new Map(p.map((x) => [x.fullName, x]))
const names = (r: { plan: { fullName: string; version: string }[] }): string[] =>
  r.plan.map((p) => `${p.fullName}@${p.version}`)

function mod(id: string, version: string, source: InstalledMod['source']): InstalledMod {
  return { id, name: id, version, source, enabled: true, files: [], disableable: [], installedAt: '' }
}
const ts = (fullName: string, version: string): InstalledMod =>
  mod(fullName, version, { kind: 'thunderstore', fullName })

describe('parseDependency', () => {
  it('splits on the last dash', () => {
    expect(parseDependency('BepInEx-BepInExPack-5.4.2100')).toEqual({
      fullName: 'BepInEx-BepInExPack',
      version: '5.4.2100'
    })
    expect(parseDependency('Some-Team-Mod-1.0.0')).toEqual({
      fullName: 'Some-Team-Mod',
      version: '1.0.0'
    })
  })
  it('rejects invalid strings', () => {
    for (const s of ['nodash', 'A-B-latest', 'A-B-1.0.x', '-1.0.0', 'A-B-', 'A-B-1..0'])
      expect(parseDependency(s)).toBeNull()
  })
})

describe('compareVersions', () => {
  it('compares numerically per segment', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.1', '1.0')).toBeGreaterThan(0)
  })
})

describe('resolveInstall', () => {
  it('orders a chain dependency-first', () => {
    const i = idx(
      pkg('O-A', { '1.0.0': ['O-B-1.0.0'] }),
      pkg('O-B', { '1.0.0': ['O-C-1.0.0'] }),
      pkg('O-C', { '1.0.0': [] })
    )
    const r = resolveInstall(i, { fullName: 'O-A' }, new Map())
    expect(names(r)).toEqual(['O-C@1.0.0', 'O-B@1.0.0', 'O-A@1.0.0'])
    expect(r.plan[0].downloadUrl).toBe('https://dl/O-C/1.0.0')
    expect(r.missing).toEqual([])
  })

  it('plans a diamond once at the highest required version', () => {
    const i = idx(
      pkg('O-A', { '1.0.0': ['O-B-1.0.0', 'O-C-1.0.0'] }),
      pkg('O-B', { '1.0.0': ['O-D-1.0.0'] }),
      pkg('O-C', { '1.0.0': ['O-D-2.0.0'] }),
      pkg('O-D', { '1.0.0': [], '2.0.0': [] })
    )
    const r = resolveInstall(i, { fullName: 'O-A' }, new Map())
    expect(r.plan.filter((p) => p.fullName === 'O-D')).toHaveLength(1)
    const order = names(r)
    expect(order).toContain('O-D@2.0.0')
    expect(order.indexOf('O-D@2.0.0')).toBeLessThan(order.indexOf('O-B@1.0.0'))
    expect(order.indexOf('O-D@2.0.0')).toBeLessThan(order.indexOf('O-C@1.0.0'))
    expect(order[order.length - 1]).toBe('O-A@1.0.0')
  })

  it('terminates on cycles with each package once', () => {
    const i = idx(pkg('O-A', { '1.0.0': ['O-B-1.0.0'] }), pkg('O-B', { '1.0.0': ['O-A-1.0.0'] }))
    const r = resolveInstall(i, { fullName: 'O-A' }, new Map())
    expect(r.plan.map((p) => p.fullName).sort()).toEqual(['O-A', 'O-B'])
  })

  it('reports missing dependencies and plans the rest', () => {
    const i = idx(
      pkg('O-A', { '1.0.0': ['O-Gone-1.0.0', 'O-B-1.0.0', 'O-B2-9.0.0'] }),
      pkg('O-B', { '1.0.0': [] }),
      pkg('O-B2', { '1.0.0': [] })
    )
    const r = resolveInstall(i, { fullName: 'O-A' }, new Map())
    expect(r.missing.sort()).toEqual(['O-B2-9.0.0', 'O-Gone-1.0.0'])
    expect(names(r)).toEqual(['O-B@1.0.0', 'O-A@1.0.0'])
  })

  it('uses the newest version when the required one is gone', () => {
    const i = idx(pkg('O-A', { '1.0.0': ['O-B-1.5.0'] }), pkg('O-B', { '1.0.0': [], '2.0.0': [] }))
    expect(names(resolveInstall(i, { fullName: 'O-A' }, new Map()))).toEqual([
      'O-B@2.0.0',
      'O-A@1.0.0'
    ])
  })

  it('skips a newer installed dependency and does not walk it', () => {
    const i = idx(
      pkg('O-A', { '1.0.0': ['O-B-1.0.0'] }),
      pkg('O-B', { '1.0.0': ['O-C-1.0.0'], '2.0.0': ['O-C-1.0.0'] }),
      pkg('O-C', { '1.0.0': [] })
    )
    const r = resolveInstall(i, { fullName: 'O-A' }, new Map([['O-B', '2.0.0']]))
    expect(names(r)).toEqual(['O-A@1.0.0'])
    expect(r.skipped).toEqual(['O-B'])
  })

  it('upgrades an older installed dependency', () => {
    const i = idx(pkg('O-A', { '1.0.0': ['O-B-2.0.0'] }), pkg('O-B', { '1.0.0': [], '2.0.0': [] }))
    const r = resolveInstall(i, { fullName: 'O-A' }, new Map([['O-B', '1.0.0']]))
    expect(names(r)).toEqual(['O-B@2.0.0', 'O-A@1.0.0'])
    expect(r.skipped).toEqual([])
  })

  it('upgrades an installed dependency when another requirer needs more', () => {
    const i = idx(
      pkg('O-A', { '1.0.0': ['O-B-1.0.0', 'O-C-1.0.0'] }),
      pkg('O-B', { '1.0.0': [], '2.0.0': [] }),
      pkg('O-C', { '1.0.0': ['O-B-2.0.0'] })
    )
    const r = resolveInstall(i, { fullName: 'O-A' }, new Map([['O-B', '1.5.0']]))
    expect(names(r)).toContain('O-B@2.0.0')
    expect(r.skipped).not.toContain('O-B')
  })

  it('skips a target already at the requested version', () => {
    const i = idx(pkg('O-A', { '1.0.0': ['O-B-1.0.0'] }), pkg('O-B', { '1.0.0': [] }))
    const r = resolveInstall(i, { fullName: 'O-A' }, new Map([['O-A', '1.0.0']]))
    expect(r.plan).toEqual([])
    expect(r.skipped).toEqual(['O-A'])
  })

  it('honours an explicit older target version', () => {
    const i = idx(pkg('O-A', { '1.0.0': [], '2.0.0': [] }))
    expect(names(resolveInstall(i, { fullName: 'O-A', version: '1.0.0' }, new Map()))).toEqual([
      'O-A@1.0.0'
    ])
  })

  it('throws for an unknown target or version', () => {
    const i = idx(pkg('O-A', { '1.0.0': [] }))
    expect(() => resolveInstall(i, { fullName: 'O-X' }, new Map())).toThrow(
      "O-X isn't on Thunderstore for this game."
    )
    expect(() => resolveInstall(i, { fullName: 'O-A', version: '9.9.9' }, new Map())).toThrow(
      "O-A 9.9.9 isn't available."
    )
  })

  it('is satisfied by the loader alias from a local BepInExPack install', () => {
    const i = idx(
      pkg('O-A', { '1.0.0': ['BepInEx-BepInExPack-5.4.2100'] }),
      pkg('BepInEx-BepInExPack', { '5.4.2100': [] })
    )
    const have = installedVersions(
      [mod('BepInExPack', '5.4.2100', { kind: 'local', fileName: 'x.zip', sha256: '' })],
      ['BepInEx-BepInExPack', 'bbepis-BepInExPack']
    )
    const r = resolveInstall(i, { fullName: 'O-A' }, have)
    expect(names(r)).toEqual(['O-A@1.0.0'])
    expect(r.skipped).toEqual(['BepInEx-BepInExPack'])
  })
})

describe('installedVersions', () => {
  it('maps thunderstore mods and loader aliases only', () => {
    const m = installedVersions(
      [
        ts('O-A', '1.0.0'),
        mod('x', '3.0.0', { kind: 'github', owner: 'o', repo: 'r', tag: 't', asset: 'a', sha256: '' }),
        ts('BepInEx-BepInExPack', '5.4.1')
      ],
      ['BepInEx-BepInExPack', 'bbepis-BepInExPack']
    )
    expect(m.get('O-A')).toBe('1.0.0')
    expect(m.get('BepInEx-BepInExPack')).toBe('5.4.1')
    expect(m.has('bbepis-BepInExPack')).toBe(false)
    expect(m.has('x')).toBe(false)
  })
})

describe('findUpdates', () => {
  it('returns only newer thunderstore mods in the index', () => {
    const i = idx(
      pkg('O-A', { '1.0.0': [], '1.2.0': [] }),
      pkg('O-B', { '1.0.0': [] }),
      pkg('O-L', { '9.0.0': [] })
    )
    const mods = [
      ts('O-A', '1.0.0'),
      ts('O-B', '1.0.0'),
      ts('O-Unknown', '1.0.0'),
      mod('O-L', '1.0.0', { kind: 'local', fileName: 'l.zip', sha256: '' })
    ]
    expect(findUpdates(mods, i)).toEqual([
      { modId: 'O-A', fullName: 'O-A', current: '1.0.0', latest: '1.2.0' }
    ])
  })
})
