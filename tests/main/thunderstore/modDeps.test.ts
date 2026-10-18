import { describe, expect, it } from 'vitest'
import { buildModDeps } from '../../../src/main/thunderstore/modDeps'
import type { InstalledMod, TsPackage } from '../../../src/shared/types'

function pkg(fullName: string, versions: Record<string, string[]>): TsPackage {
  return {
    fullName,
    owner: '',
    name: fullName.slice(fullName.indexOf('-') + 1),
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
    versions: Object.entries(versions).map(([version, dependencies]) => ({
      version,
      dependencies,
      downloadUrl: '',
      downloads: 0,
      fileSize: 0,
      dateCreated: ''
    }))
  }
}

function mod(id: string, version: string, extra: Partial<InstalledMod> = {}): InstalledMod {
  return {
    id,
    name: id,
    version,
    source: { kind: 'thunderstore', fullName: id },
    enabled: true,
    files: [],
    disableable: [],
    installedAt: '',
    ...extra
  }
}

const LOADER = 'BepInEx-BepInExPack'

describe('buildModDeps', () => {
  it("uses the installed version's dependencies, through stand-ins and the loader alias", () => {
    const index = new Map(
      [
        pkg('a-App', {
          '2.0.0': ['a-Lib-1.0.0', `${LOADER}-5.4.0`],
          '1.0.0': ['a-Old-1.0.0', 'a-Gh-1.0.0', 'a-Missing-1.0.0', 'garbage']
        }),
        pkg('a-Lib', { '1.0.0': [] })
      ].map((p) => [p.fullName, p])
    )
    const gh = mod('gh', '1.0.0', {
      source: { kind: 'github', owner: 'o', repo: 'r', tag: 'v1', asset: 'x.zip', sha256: '' },
      provides: ['a-Gh']
    })
    const mods = [mod('a-App', '1.0.0'), mod('a-Old', '1.0.0'), gh, mod('BepInExPack', '5.4.0')]
    expect(buildModDeps(mods, index, [LOADER])).toEqual({
      deps: { 'a-App': ['a-Old', 'gh'] },
      loaders: ['BepInExPack']
    })

    // The newest version stands in for an installed version the index no longer lists.
    const gone = [mod('a-App', '0.1.0'), mod('a-Lib', '1.0.0'), mod('BepInExPack', '5.4.0')]
    expect(buildModDeps(gone, index, [LOADER]).deps).toEqual({
      'a-App': ['a-Lib', 'BepInExPack']
    })
  })
})
