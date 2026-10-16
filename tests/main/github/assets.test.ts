import { describe, it, expect, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import {
  assetPattern,
  chooseAsset,
  matchesAssetPattern,
  type GhReleaseAsset
} from '../../../src/main/github/assets'

const asset = (name: string, size = 10): GhReleaseAsset => ({
  id: 1,
  name,
  size,
  downloadUrl: `https://github.com/o/r/releases/download/v1/${name}`,
  apiUrl: 'https://api.github.com/repos/o/r/releases/assets/1',
  digest: null
})
const withManifest = zipSync({
  'manifest.json': strToU8(JSON.stringify({ name: 'M', version_number: '1.0.0' }))
})
const noManifest = zipSync({ 'a.dll': strToU8('x') })

describe('assetPattern', () => {
  it('replaces versions', () => {
    expect(assetPattern('BepInEx_linux_x64_5.4.23.5.zip', 'v5.4.23.5')).toBe(
      'BepInEx_linux_x64_{version}.zip'
    )
    expect(assetPattern('MyMod-v1.2.zip', 'v1.2')).toBe('MyMod-{version}.zip')
    expect(assetPattern('mod-r42.zip', 'r42')).toBe('mod-{version}.zip')
    expect(assetPattern('Plugin.zip', 'v3')).toBe('Plugin.zip')
  })
  it('matches the pattern', () => {
    const p = 'BepInEx_linux_x64_{version}.zip'
    expect(matchesAssetPattern(p, 'BepInEx_linux_x64_5.4.24.0.zip')).toBe(true)
    expect(matchesAssetPattern(p, 'BepInEx_linux_x86_5.4.24.0.zip')).toBe(false)
    expect(matchesAssetPattern(p, 'bepinex_LINUX_x64_5.4.24.0.ZIP')).toBe(true)
  })
  it('matches only version-like text for {version}', () => {
    expect(matchesAssetPattern('Mod-{version}.zip', 'Mod-1.2.3.zip')).toBe(true)
    expect(matchesAssetPattern('Mod-{version}.zip', 'Mod-1.2.3-debug.zip')).toBe(false)
    expect(matchesAssetPattern('Mod-{version}.zip', 'Mod-latest.zip')).toBe(false)
    expect(matchesAssetPattern('Mod-{version}.zip', 'Mod-.zip')).toBe(false)
    for (const v of [
      'v5.4.23.5',
      '5.4.23.5',
      '1.0.0-beta.2',
      '2.0-rc1',
      '1.0.0-alpha',
      'r43',
      '3'
    ]) {
      expect(matchesAssetPattern('Mod-{version}.zip', `Mod-${v}.zip`)).toBe(true)
    }
    // patterns built from real tags still match the next release
    const p = assetPattern('BepInEx_win_x64_v5.4.23.5.zip', 'v5.4.23.5')
    expect(matchesAssetPattern(p, 'BepInEx_win_x64_v5.4.23.6.zip')).toBe(true)
    const beta = assetPattern('Mod-1.0.0-beta.2.zip', '1.0.0-beta.2')
    expect(beta).toBe('Mod-{version}.zip')
    expect(matchesAssetPattern(beta, 'Mod-1.0.0-beta.3.zip')).toBe(true)
    expect(matchesAssetPattern(beta, 'Mod-1.0.0.zip')).toBe(true)
    expect(matchesAssetPattern(beta, 'Mod-1.0.0-debug.zip')).toBe(false)
  })
})

describe('chooseAsset', () => {
  it('picks the only zip over a dll with one download', async () => {
    const download = vi.fn(async () => noManifest)
    const r = await chooseAsset([asset('a.dll'), asset('a.zip')], null, download)
    expect(r).toMatchObject({ asset: { name: 'a.zip' } })
    expect(download).toHaveBeenCalledTimes(1)
  })
  it('probes multiple zips for a manifest', async () => {
    const data: Record<string, Uint8Array> = { 'a.zip': noManifest, 'b.zip': withManifest }
    const download = vi.fn(async (a: GhReleaseAsset) => data[a.name])
    const r = await chooseAsset([asset('a.zip'), asset('b.zip')], null, download)
    expect(r).toMatchObject({ asset: { name: 'b.zip' }, data: withManifest })
    expect(download).toHaveBeenCalledTimes(2)
  })
  it('asks when no zip has a manifest', async () => {
    const r = await chooseAsset([asset('a.zip'), asset('b.zip')], null, async () => noManifest)
    expect(r).toMatchObject({ ask: [{ name: 'a.zip' }, { name: 'b.zip' }] })
  })
  it('uses a lone dll, asks for several', async () => {
    const download = async (): Promise<Uint8Array> => noManifest
    expect(await chooseAsset([asset('a.dll')], null, download)).toMatchObject({
      asset: { name: 'a.dll' }
    })
    expect(await chooseAsset([asset('a.dll'), asset('b.dll')], null, download)).toMatchObject({
      ask: [{ name: 'a.dll' }, { name: 'b.dll' }]
    })
  })
  it('throws when nothing is installable', async () => {
    await expect(
      chooseAsset([asset('Mod-src.zip'), asset('Mod.tar.gz')], null, async () => noManifest)
    ).rejects.toThrow('This release has no .zip or .dll file to install.')
  })
  it('uses a pattern when it matches exactly one, else falls back', async () => {
    const download = vi.fn(async () => noManifest)
    const two = [asset('Mod-linux-1.0.zip'), asset('Mod-win-1.0.zip')]
    const r = await chooseAsset(two, 'Mod-win-{version}.zip', download)
    expect(r).toMatchObject({ asset: { name: 'Mod-win-1.0.zip' } })
    expect(download).toHaveBeenCalledTimes(1)
    const r2 = await chooseAsset(two, 'Nope-{version}.zip', async () => noManifest)
    expect(r2).toMatchObject({ ask: [{}, {}] })
  })
  it('probes at most 5 zips', async () => {
    const download = vi.fn(async () => noManifest)
    const zips = Array.from({ length: 6 }, (_, i) => asset(`m${i}.zip`))
    const r = await chooseAsset(zips, null, download)
    expect(download).toHaveBeenCalledTimes(5)
    expect(r).toHaveProperty('ask')
    if ('ask' in r) expect(r.ask).toHaveLength(6)
  })
  it('does not probe zips over 100 MB', async () => {
    const download = vi.fn(async () => withManifest)
    const r = await chooseAsset(
      [asset('big.zip', 104_857_601), asset('small.zip', 5)],
      null,
      download
    )
    expect(download).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ asset: { name: 'small.zip' } })
  })
  it('treats an unreadable zip as having no manifest', async () => {
    const data: Record<string, Uint8Array> = {
      'bad.zip': strToU8('not a zip'),
      'good.zip': withManifest
    }
    const r = await chooseAsset(
      [asset('bad.zip'), asset('good.zip')],
      null,
      async (a) => data[a.name]
    )
    expect(r).toMatchObject({ asset: { name: 'good.zip' } })
  })
  it('counts upper-case .ZIP as a zip', async () => {
    const r = await chooseAsset([asset('A.ZIP'), asset('a.dll')], null, async () => noManifest)
    expect(r).toMatchObject({ asset: { name: 'A.ZIP' } })
  })
  it('ignores pattern hits that are not zip or dll', async () => {
    const r = await chooseAsset(
      [asset('Mod-1.0.txt'), asset('Mod-1.0.zip')],
      'Mod-{version}.txt',
      async () => noManifest
    )
    expect(r).toMatchObject({ asset: { name: 'Mod-1.0.zip' } })
  })
})
