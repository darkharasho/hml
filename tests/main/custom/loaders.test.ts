import { describe, expect, it } from 'vitest'
import {
  findLoaderMod,
  loaderMatches,
  loaderModName,
  loaderSpec,
  LOADER_SPECS,
  withReadableName
} from '../../../src/main/custom/loaders'
import { matchesAssetPattern } from '../../../src/main/github/assets'
import type { InstalledMod } from '../../../src/shared/types'

const ghMod = (
  owner: string,
  repo: string,
  github?: InstalledMod['github'],
  asset = 'a.zip'
): InstalledMod => ({
  id: `${owner}-${repo}`,
  name: repo,
  version: '1.0.0',
  source: { kind: 'github', owner, repo, tag: 'v1', asset, sha256: '' },
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

  it('loaderMatches goes by the installed asset name, so a pinned install with no track matches', () => {
    const s5 = LOADER_SPECS.bepinex5
    const pinned5 = ghMod('BepInEx', 'BepInEx', undefined, 'BepInEx_win_x64_5.4.23.5.zip')
    expect(loaderMatches(pinned5, s5)).toBe(true)
    expect(loaderMatches(pinned5, LOADER_SPECS['bepinex6-mono'])).toBe(false)
    const mono6 = ghMod(
      'BepInEx',
      'BepInEx',
      { updateMode: 'pinned', assetPattern: null },
      'BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip'
    )
    expect(loaderMatches(mono6, s5)).toBe(false)
    expect(loaderMatches(mono6, LOADER_SPECS['bepinex6-mono'])).toBe(true)
    expect(loaderMatches(mono6, LOADER_SPECS['bepinex6-il2cpp'])).toBe(false)
    expect(loaderMatches(ghMod('BepInEx', 'BepInEx'), s5)).toBe(false)
  })
})

describe('loader names', () => {
  const raw = (asset: string): InstalledMod => ({
    ...ghMod('BepInEx', 'BepInEx', undefined, asset),
    name: 'BepInEx-BepInEx'
  })
  it('names the loader by its build, from the installed asset', () => {
    expect(loaderModName(raw('BepInEx_win_x64_5.4.23.5.zip').source)).toBe('BepInEx 5 (Mono)')
    expect(loaderModName(raw('BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip').source)).toBe(
      'BepInEx 6 (Mono)'
    )
    expect(loaderModName(raw('BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip').source)).toBe(
      'BepInEx 6 (IL2CPP)'
    )
    expect(loaderModName(raw('BepInEx_linux_x64_5.4.23.5.zip').source)).toBe('BepInEx')
    expect(loaderModName(ghMod('a', 'b').source)).toBeNull()
    expect(loaderModName({ kind: 'thunderstore', fullName: 'BepInEx-BepInExPack' })).toBeNull()
  })
  it('renames only a loader still called by its raw id', () => {
    expect(withReadableName(raw('BepInEx_win_x64_5.4.23.5.zip')).name).toBe('BepInEx 5 (Mono)')
    const named = { ...raw('BepInEx_win_x64_5.4.23.5.zip'), name: 'My BepInEx' }
    expect(withReadableName(named)).toBe(named)
    const other = ghMod('a', 'b')
    expect(withReadableName(other)).toBe(other)
  })
})
