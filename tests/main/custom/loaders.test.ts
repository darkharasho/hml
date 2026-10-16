import { describe, expect, it } from 'vitest'
import {
  findLoaderMod,
  loaderMatches,
  loaderSpec,
  LOADER_SPECS
} from '../../../src/main/custom/loaders'
import { matchesAssetPattern } from '../../../src/main/github/assets'
import type { InstalledMod } from '../../../src/shared/types'

const ghMod = (owner: string, repo: string, github?: InstalledMod['github']): InstalledMod => ({
  id: `${owner}-${repo}`,
  name: repo,
  version: '1.0.0',
  source: { kind: 'github', owner, repo, tag: 'v1', asset: 'a.zip', sha256: '' },
  enabled: true,
  files: [],
  disableable: [],
  installedAt: '',
  github
})

describe('loader specs', () => {
  it("asset patterns match BepInEx's real release files", () => {
    const p5 = LOADER_SPECS.bepinex5.assetPattern
    expect(matchesAssetPattern(p5, 'BepInEx_win_x64_5.4.23.5.zip')).toBe(true)
    expect(matchesAssetPattern(p5, 'BepInEx_win_x86_5.4.23.5.zip')).toBe(false)
    const mono = LOADER_SPECS['bepinex6-mono'].assetPattern
    expect(matchesAssetPattern(mono, 'BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip')).toBe(true)
    expect(matchesAssetPattern(mono, 'BepInEx-Unity.Mono-linux-x64-6.0.0-pre.2.zip')).toBe(false)
    const il2cpp = LOADER_SPECS['bepinex6-il2cpp'].assetPattern
    expect(matchesAssetPattern(il2cpp, 'BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip')).toBe(true)
  })

  it("loaderSpec('none') is null", () => {
    expect(loaderSpec('none')).toBeNull()
    expect(loaderSpec('bepinex5')).toBe(LOADER_SPECS.bepinex5)
  })

  it('findLoaderMod finds the BepInEx/BepInEx GitHub mod case-insensitively', () => {
    const loader = ghMod('bepinex', 'BEPINEX')
    expect(findLoaderMod([ghMod('a', 'b'), loader])).toBe(loader)
    expect(findLoaderMod([ghMod('a', 'b')])).toBeUndefined()
  })

  it('loaderMatches compares track and asset pattern', () => {
    const s5 = LOADER_SPECS.bepinex5
    const mod = ghMod('BepInEx', 'BepInEx', {
      updateMode: 'auto',
      assetPattern: s5.assetPattern,
      track: s5.track
    })
    expect(loaderMatches(mod, s5)).toBe(true)
    expect(loaderMatches(mod, LOADER_SPECS['bepinex6-mono'])).toBe(false)
    expect(loaderMatches(ghMod('BepInEx', 'BepInEx'), s5)).toBe(false)
  })
})
