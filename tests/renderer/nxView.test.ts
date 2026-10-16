import { describe, expect, it } from 'vitest'
import type { DeploymentStatus, InstalledMod, ModSource } from '../../src/shared/types'
import {
  deploymentLabel,
  fileCategoryLabel,
  formatCount,
  installedNexusMod,
  nexusModUrl,
  openWebsiteToast,
  relativeDate
} from '../../src/renderer/src/nxView'

function mod(source: ModSource): InstalledMod {
  return {
    id: 'nexus-42',
    name: 'Cool',
    version: '1.0.0',
    source,
    enabled: true,
    files: [],
    disableable: [],
    installedAt: '2026-10-15T00:00:00Z'
  }
}

describe('nexusModUrl', () => {
  it('builds the mod page address', () => {
    expect(nexusModUrl('repo', 42)).toBe('https://www.nexusmods.com/repo/mods/42')
  })
})

describe('fileCategoryLabel', () => {
  it('labels every category', () => {
    expect(fileCategoryLabel('MAIN')).toBe('Main')
    expect(fileCategoryLabel('UPDATE')).toBe('Update')
    expect(fileCategoryLabel('OPTIONAL')).toBe('Optional')
    expect(fileCategoryLabel('MISCELLANEOUS')).toBe('Miscellaneous')
    expect(fileCategoryLabel('OLD_VERSION')).toBe('Old version')
    expect(fileCategoryLabel('REMOVED')).toBe('Removed')
    expect(fileCategoryLabel('ARCHIVED')).toBe('Archived')
  })
})

describe('formatCount', () => {
  it('formats small, thousands and millions', () => {
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1234)).toBe('1.2K')
    expect(formatCount(3_400_000)).toBe('3.4M')
    expect(formatCount(-1)).toBe('0')
  })
})

describe('relativeDate', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  const ago = (days: number): number => Math.floor(now / 1000) - days * 86400
  it('reads in days, months and years', () => {
    expect(relativeDate(ago(0), now)).toBe('today')
    expect(relativeDate(ago(0.5), now)).toBe('today')
    expect(relativeDate(ago(1), now)).toBe('yesterday')
    expect(relativeDate(ago(3), now)).toBe('3 days ago')
    expect(relativeDate(ago(29), now)).toBe('29 days ago')
    expect(relativeDate(ago(30), now)).toBe('1 month ago')
    expect(relativeDate(ago(65), now)).toBe('2 months ago')
    expect(relativeDate(ago(365), now)).toBe('1 year ago')
    expect(relativeDate(ago(800), now)).toBe('2 years ago')
  })
  it('treats future dates as today', () => {
    expect(relativeDate(ago(-2), now)).toBe('today')
  })
})

describe('installedNexusMod', () => {
  it('finds the mod installed from that Nexus mod id', () => {
    const nx = mod({ kind: 'nexus', domain: 'repo', modId: 42, fileId: 7 })
    expect(installedNexusMod([nx], 42)).toBe(nx)
    expect(installedNexusMod([nx], 43)).toBeNull()
    expect(
      installedNexusMod([mod({ kind: 'local', fileName: 'a.zip', sha256: '' })], 42)
    ).toBeNull()
  })
})

describe('openWebsiteToast', () => {
  const base =
    'Click "Mod Manager Download" on Nexus Mods. HML installs it when the download starts.'
  it('asks to turn on the handler unless HML is registered', () => {
    expect(openWebsiteToast('registered')).toBe(base)
    expect(openWebsiteToast('not-registered')).toBe(
      `${base} Turn on "Use HML for Nexus downloads" in Settings first.`
    )
    expect(openWebsiteToast('unavailable')).toBe(
      `${base} Turn on "Use HML for Nexus downloads" in Settings first.`
    )
  })
})

describe('deploymentLabel', () => {
  const status = (over: Partial<DeploymentStatus> = {}): DeploymentStatus => ({
    profileId: 'p1',
    profileName: 'Default',
    files: 12,
    deployedAt: '2026-10-16T00:00:00Z',
    ...over
  })
  it('reports nothing deployed', () => {
    expect(deploymentLabel(null, 'p1')).toBe("Mods aren't deployed.")
    expect(deploymentLabel(null, null)).toBe("Mods aren't deployed.")
  })
  it('reports the current profile with its file count', () => {
    expect(deploymentLabel(status(), 'p1')).toBe('This profile is deployed (12 files).')
    expect(deploymentLabel(status({ files: 1 }), 'p1')).toBe('This profile is deployed (1 file).')
  })
  it('names another deployed profile, or says another profile when it is gone', () => {
    expect(deploymentLabel(status({ profileName: 'Hardcore' }), 'p2')).toBe('Hardcore is deployed.')
    expect(deploymentLabel(status({ profileName: null }), 'p2')).toBe(
      'Another profile is deployed.'
    )
    expect(deploymentLabel(status(), null)).toBe('Default is deployed.')
  })
})
