import { describe, expect, it } from 'vitest'
import type { InstalledMod, TsPackage } from '../../src/shared/types'
import {
  compactCount,
  displayName,
  initials,
  installState,
  progressLabel,
  relativeTime,
  splitDependency
} from '../../src/renderer/src/tsView'

function pkg(fullName: string, versions: string[]): TsPackage {
  const [owner, name] = fullName.split('-')
  return {
    fullName,
    owner,
    name,
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
    versions: versions.map((version) => ({
      version,
      dependencies: [],
      downloadUrl: '',
      downloads: 0,
      fileSize: 0,
      dateCreated: ''
    }))
  }
}

function mod(id: string, version: string): InstalledMod {
  return {
    id,
    name: id,
    version,
    source: { kind: 'thunderstore', fullName: id },
    enabled: true,
    files: [],
    disableable: [],
    installedAt: ''
  }
}

describe('compactCount', () => {
  it('formats small, thousands and millions', () => {
    expect(compactCount(950)).toBe('950')
    expect(compactCount(1234)).toBe('1.2K')
    expect(compactCount(1_250_000)).toBe('1.3M')
    expect(compactCount(-5)).toBe('0')
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-10-15T12:00:00Z')
  it('picks the largest whole unit', () => {
    expect(relativeTime('2026-10-15T11:59:30Z', now)).toBe('just now')
    expect(relativeTime('2026-10-15T11:55:00Z', now)).toBe('5 minutes ago')
    expect(relativeTime('2026-10-15T09:00:00Z', now)).toBe('3 hours ago')
    expect(relativeTime('2026-10-14T11:00:00Z', now)).toBe('yesterday')
    expect(relativeTime('2026-07-01T00:00:00Z', now)).toBe('3 months ago')
  })
  it('treats future and invalid times gracefully', () => {
    expect(relativeTime('2026-10-16T00:00:00Z', now)).toBe('just now')
    expect(relativeTime('nope', now)).toBe('an unknown time')
  })
})

describe('installState', () => {
  const p = pkg('Owner-Mod', ['1.10.0', '1.9.0'])
  it('is install when the profile lacks the mod', () => {
    expect(installState(p, [mod('Other-Mod', '1.0.0')])).toEqual({ kind: 'install' })
  })
  it('is update when the installed version is older than the newest', () => {
    expect(installState(p, [mod('Owner-Mod', '1.9.0')])).toEqual({
      kind: 'update',
      installed: '1.9.0',
      latest: '1.10.0'
    })
  })
  it('is installed when current or newer', () => {
    expect(installState(p, [mod('Owner-Mod', '1.10.0')])).toEqual({
      kind: 'installed',
      version: '1.10.0'
    })
    expect(installState(p, [mod('Owner-Mod', '2.0.0')])).toEqual({
      kind: 'installed',
      version: '2.0.0'
    })
  })
})

describe('progressLabel', () => {
  it('numbers the current step and clears when done', () => {
    const e = { type: 'progress' as const, message: 'Installing BepInExPack 5.4.2100', total: 3 }
    expect(progressLabel({ ...e, done: 0 })).toBe('Installing BepInExPack 5.4.2100 (1/3)')
    expect(progressLabel({ ...e, done: 3, message: 'Done' })).toBeNull()
  })
})

describe('splitDependency', () => {
  it('splits owner, name and version, allowing dashes in the owner', () => {
    expect(splitDependency('BepInEx-BepInExPack-5.4.2100')).toEqual({
      fullName: 'BepInEx-BepInExPack',
      owner: 'BepInEx',
      name: 'BepInExPack',
      version: '5.4.2100'
    })
    expect(splitDependency('my-team-Cool_Mod-1.0.0').owner).toBe('my-team')
  })
})

describe('initials and displayName', () => {
  it('builds initials and replaces underscores', () => {
    expect(initials('More_Upgrades')).toBe('MU')
    expect(initials('REPOLib')).toBe('RE')
    expect(displayName('More_Upgrades')).toBe('More Upgrades')
  })
})
