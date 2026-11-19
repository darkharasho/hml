import { describe, expect, it } from 'vitest'
import type { DeploymentStatus, InstalledMod, ModSource } from '../../src/shared/types'
import {
  canPlayDeployGame,
  deploymentLabel,
  fileCategoryLabel,
  formatCount,
  installedNexusMod,
  nexusModUrl,
  nxInAppHint,
  openWebsiteToast,
  pendingNexusHeading,
  pendingNexusRows,
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

describe('nxInAppHint', () => {
  it('says what happens after one page or several', () => {
    const base = 'Click "Mod Manager Download" in the Nexus Mods window.'
    expect(nxInAppHint(1)).toBe(`${base} HML installs the file when the download starts.`)
    expect(nxInAppHint(3)).toBe(`${base} HML installs each file and opens the next page.`)
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

describe('canPlayDeployGame', () => {
  it('plays custom games and deploy games with a Steam app id, not others', () => {
    expect(canPlayDeployGame({ custom: undefined, steamAppId: '3883570' })).toBe(true)
    expect(canPlayDeployGame({ custom: { source: 'folder' } as never, steamAppId: null })).toBe(
      true
    )
    expect(canPlayDeployGame({ custom: undefined, steamAppId: null })).toBe(false)
  })
})

describe('pendingNexusRows', () => {
  const waiting = [
    { name: 'Cool', version: '1.0.0', domain: 'repo', modId: 42, fileId: 7 },
    { name: 'Other', version: '2.0.0', domain: 'repo', modId: 43, fileId: 8 }
  ]
  it("lists an import's Nexus mods not installed since, with their file pages", () => {
    const rows = pendingNexusRows({
      mods: [mod({ kind: 'nexus', domain: 'repo', modId: 42, fileId: 9 })],
      pendingNexus: waiting
    })
    expect(rows).toEqual([
      {
        key: 'repo/43',
        name: 'Other',
        version: '2.0.0',
        url: 'https://www.nexusmods.com/repo/mods/43?tab=files&file_id=8',
        modId: 43
      }
    ])
  })
  it("lists a follower's manual downloads, which can't be dismissed", () => {
    const url = 'https://www.nexusmods.com/repo/mods/42?tab=files&file_id=7'
    expect(
      pendingNexusRows({
        mods: [],
        pendingNexus: waiting,
        sync: { role: 'follower', code: 'c', revision: 1, manual: [{ name: 'Cool', url }] }
      })
    ).toEqual([{ key: url, name: 'Cool', version: '', url, modId: null }])
  })
  it('is empty without a list', () => {
    expect(pendingNexusRows({ mods: [] })).toEqual([])
  })
  it('heads the list', () => {
    expect(pendingNexusHeading(1)).toBe('1 Nexus mod to install')
    expect(pendingNexusHeading(2)).toBe('2 Nexus mods to install')
  })
})
