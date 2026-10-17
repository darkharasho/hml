import { describe, expect, it } from 'vitest'
import type { GhUpdateMode, InstalledMod } from '../../src/shared/types'
import {
  canFollowPrereleases,
  formatBytes,
  isPrereleaseInstall,
  ghInstallToast,
  ghSubline,
  ghUpdatedToast,
  githubRepoUrl,
  updateModeLabel
} from '../../src/renderer/src/ghView'

function ghMod(mode: GhUpdateMode | undefined, version = '1.2.0'): InstalledMod {
  return {
    id: 'Owner-Repo',
    name: 'CoolMod',
    version,
    source: {
      kind: 'github',
      owner: 'Owner',
      repo: 'Repo',
      tag: 'v1.2.0',
      asset: 'a.zip',
      sha256: ''
    },
    enabled: true,
    files: [],
    disableable: [],
    installedAt: '2026-10-15T00:00:00Z',
    github: mode ? { updateMode: mode, assetPattern: null } : undefined
  }
}

describe('formatBytes', () => {
  it('shows bytes below 1 KB as whole numbers', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })
  it('shows larger sizes with one decimal', () => {
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(12.3 * 1024 * 1024)).toBe('12.3 MB')
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5 GB')
  })
  it('moves up a unit instead of showing 1024.0', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB')
  })
})

describe('updateModeLabel', () => {
  it('names each mode', () => {
    expect(updateModeLabel('auto')).toBe('Auto-install updates')
    expect(updateModeLabel('notify')).toBe('Notify only')
    expect(updateModeLabel('pinned')).toBe('Pinned')
  })
})

describe('githubRepoUrl', () => {
  it('builds the repository link', () => {
    expect(githubRepoUrl({ owner: 'BepInEx', repo: 'BepInEx' })).toBe(
      'https://github.com/BepInEx/BepInEx'
    )
  })
})

describe('ghSubline', () => {
  const source = { owner: 'Owner', repo: 'Repo', tag: 'v1.2.0' }
  it('shows repo and tag, plus the mode when it is not auto', () => {
    expect(ghSubline(source, 'auto')).toBe('Owner/Repo · v1.2.0')
    expect(ghSubline(source, 'notify')).toBe('Owner/Repo · v1.2.0 · Notify only')
    expect(ghSubline(source, 'pinned')).toBe('Owner/Repo · v1.2.0 · Pinned')
  })
})

describe('ghInstallToast', () => {
  it('names the installed mod and version', () => {
    expect(ghInstallToast(ghMod('auto'), [])).toBe('Installed CoolMod 1.2.0')
    expect(ghInstallToast(ghMod(undefined), [])).toBe('Installed CoolMod 1.2.0')
  })
  it('mentions a pinned release and replaced mods', () => {
    expect(ghInstallToast(ghMod('pinned'), [])).toBe(
      'Installed CoolMod 1.2.0 (pinned to this release)'
    )
    expect(ghInstallToast(ghMod('auto'), ['CoolMod', 'Old-Repo'])).toBe(
      'Installed CoolMod 1.2.0, replaced CoolMod, Old-Repo'
    )
    expect(ghInstallToast(ghMod('pinned'), ['CoolMod'])).toBe(
      'Installed CoolMod 1.2.0 (pinned to this release), replaced CoolMod'
    )
  })
})

describe('ghUpdatedToast', () => {
  it('names a single mod and its tag, or counts several', () => {
    expect(ghUpdatedToast([{ name: 'CoolMod', tag: 'v2.0.0' }])).toBe('Updated CoolMod to v2.0.0')
    expect(
      ghUpdatedToast([
        { name: 'A', tag: 'v1' },
        { name: 'B', tag: 'v2' }
      ])
    ).toBe('Updated 2 GitHub mods')
  })
})

describe('pre-release helpers', () => {
  const base = ghMod('auto')
  const withConfig = (github: InstalledMod['github']): InstalledMod => ({ ...base, github })

  it('isPrereleaseInstall is true only when the install recorded a pre-release', () => {
    expect(
      isPrereleaseInstall(
        withConfig({ updateMode: 'auto', assetPattern: null, installedPrerelease: true })
      )
    ).toBe(true)
    expect(isPrereleaseInstall(base)).toBe(false)
    expect(isPrereleaseInstall(withConfig(undefined))).toBe(false)
    const local: InstalledMod = { ...base, source: { kind: 'local', fileName: 'f', sha256: '' } }
    expect(isPrereleaseInstall(local)).toBe(false)
  })

  it('canFollowPrereleases excludes loader mods on a release track and non-GitHub mods', () => {
    expect(canFollowPrereleases(base)).toBe(true)
    expect(canFollowPrereleases(withConfig(undefined))).toBe(true)
    expect(
      canFollowPrereleases(
        withConfig({
          updateMode: 'auto',
          assetPattern: null,
          track: { major: 5, prerelease: false }
        })
      )
    ).toBe(false)
    const ts: InstalledMod = { ...base, source: { kind: 'thunderstore', fullName: 'a-b' } }
    expect(canFollowPrereleases(ts)).toBe(false)
  })
})
