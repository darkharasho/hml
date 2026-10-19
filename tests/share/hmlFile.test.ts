import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHmlFile, MAX_HML_BYTES, readHmlFile } from '../../src/main/share/hmlFile'
import type { InstalledMod, ProfileManifest } from '../../src/shared/types'

const DAMAGED = 'This HML profile file is damaged or from a newer HML.'
const TOO_BIG = "This profile's config files are too large to share (over 10 MB)."

function mod(name: string, source: InstalledMod['source'], enabled = true): InstalledMod {
  return {
    id: name,
    name,
    version: '1.0.0',
    source,
    enabled,
    files: [],
    disableable: [],
    installedAt: ''
  }
}

const profile: ProfileManifest = {
  formatVersion: 1,
  id: 'p1',
  name: 'My Profile',
  game: 'repo',
  createdAt: '',
  mods: [
    mod('A', { kind: 'thunderstore', fullName: 'o-A' }),
    mod(
      'B',
      { kind: 'github', owner: 'o', repo: 'r', tag: 'v1', asset: 'a.zip', sha256: 'ab' },
      false
    ),
    mod('C', { kind: 'nexus', domain: 'repo', modId: 1, fileId: 2 })
  ]
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hml-share-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeCfg(rel: string, text: string): Promise<void> {
  const f = join(dir, 'BepInEx', 'config', rel)
  await mkdir(join(f, '..'), { recursive: true })
  await writeFile(f, text)
}

const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
const validExport = JSON.stringify({ formatVersion: 1, game: 'repo', profileName: 'x', mods: [] })

describe('hml files', () => {
  it('customGame round-trips through an .hml file', async () => {
    const customGame = {
      source: 'folder' as const,
      displayName: 'My Game',
      steamAppId: null,
      loaderChoice: 'bepinex6-mono' as const
    }
    const out = await readHmlFile(await buildHmlFile(profile, dir, { customGame }))
    expect(out.export.customGame).toEqual(customGame)
  })

  it('an .hml file without customGame still reads', async () => {
    const out = await readHmlFile(await buildHmlFile(profile, dir))
    expect(out.export.customGame).toBeUndefined()
    expect(out.export.game).toBe('repo')
  })

  it('round trips mods and configs', async () => {
    await writeCfg('a.cfg', 'AAA')
    await writeCfg('sub/b.cfg', 'BBB')
    const out = await readHmlFile(await buildHmlFile(profile, dir))
    expect(out.export).toEqual({
      formatVersion: 1,
      game: 'repo',
      profileName: 'My Profile',
      mods: profile.mods.map((m) => ({
        name: m.name,
        source: m.source,
        version: m.version,
        enabled: m.enabled
      }))
    })
    expect([...out.configs.keys()].sort()).toEqual([
      'BepInEx/config/a.cfg',
      'BepInEx/config/sub/b.cfg'
    ])
    expect(new TextDecoder().decode(out.configs.get('BepInEx/config/sub/b.cfg'))).toBe('BBB')
  })

  it("carries MelonLoader's UserData settings, but not its other data", async () => {
    const put = async (rel: string, text: string): Promise<void> => {
      const f = join(dir, 'UserData', rel)
      await mkdir(join(f, '..'), { recursive: true })
      await writeFile(f, text)
    }
    await writeCfg('a.cfg', 'AAA')
    await put('MelonPreferences.cfg', 'M')
    await put('Some-Mod/settings.json', 'J')
    await put('Some-Mod/prefs.TOML', 'T')
    await put('Some-Mod/cache.bin', 'x')
    await put('Some-Mod/bundle.assets', 'x')
    const out = await readHmlFile(await buildHmlFile(profile, dir))
    expect([...out.configs.keys()].sort()).toEqual([
      'BepInEx/config/a.cfg',
      'UserData/MelonPreferences.cfg',
      'UserData/Some-Mod/prefs.TOML',
      'UserData/Some-Mod/settings.json'
    ])
    expect(new TextDecoder().decode(out.configs.get('UserData/MelonPreferences.cfg'))).toBe('M')
  })

  it('puts export.json first and holds only it when there is no config folder', async () => {
    // The first local file header's name: length at offset 26 (uint16 LE), bytes from 30.
    const firstName = (zip: Uint8Array): string =>
      new TextDecoder().decode(zip.subarray(30, 30 + (zip[26] | (zip[27] << 8))))
    const bare = await buildHmlFile(profile, dir)
    expect(firstName(bare)).toBe('export.json')
    expect((await readHmlFile(bare)).configs.size).toBe(0)
    await writeCfg('a.cfg', 'AAA')
    expect(firstName(await buildHmlFile(profile, dir))).toBe('export.json')
  })

  it.skipIf(process.platform === 'win32')('skips symlinks in the config folder', async () => {
    await writeCfg('a.cfg', 'AAA')
    await writeFile(join(dir, 'secret.txt'), 'nope')
    await symlink(join(dir, 'secret.txt'), join(dir, 'BepInEx', 'config', 'link.cfg'))
    const out = await readHmlFile(await buildHmlFile(profile, dir))
    expect([...out.configs.keys()]).toEqual(['BepInEx/config/a.cfg'])
  })

  it('refuses configs over the cap when building and reading', async () => {
    await writeCfg('big.cfg', 'x'.repeat(5000))
    await expect(buildHmlFile(profile, dir, { maxBytes: 1000 })).rejects.toThrow(TOO_BIG)
    const data = await buildHmlFile(profile, dir)
    await expect(readHmlFile(data, { maxBytes: 1000 })).rejects.toThrow(TOO_BIG)
    expect(MAX_HML_BYTES).toBe(10485760)
  })

  it('words a too-large file for an import when reading for one', async () => {
    const IMPORT_TOO_BIG = 'This HML profile file is too large to import (over 10 MB).'
    await writeCfg('big.cfg', 'x'.repeat(5000))
    const data = await buildHmlFile(profile, dir)
    await expect(readHmlFile(data, { maxBytes: 1000, forImport: true })).rejects.toThrow(
      IMPORT_TOO_BIG
    )
    // A file over the cap is refused before it is unzipped (these bytes aren't a zip at all).
    await expect(
      readHmlFile(new Uint8Array(MAX_HML_BYTES + 1), { forImport: true })
    ).rejects.toThrow(IMPORT_TOO_BIG)
  })

  it('ignores unsafe and unrelated entries', async () => {
    const out = await readHmlFile(
      zipOf({
        'export.json': validExport,
        '../evil': 'x',
        'BepInEx/config/../../x': 'x',
        'BepInEx\\config\\win.cfg': 'x',
        'BepInEx/plugins/p.dll': 'x',
        'notes.txt': 'x',
        'UserData/../x': 'x',
        'UserData/': 'x',
        'BepInEx/config/ok.cfg': 'ok',
        'UserData/ok.cfg': 'ok'
      })
    )
    expect([...out.configs.keys()]).toEqual(['BepInEx/config/ok.cfg', 'UserData/ok.cfg'])
  })

  it('accepts mods without a name and ignores unknown fields', async () => {
    const json = JSON.stringify({
      formatVersion: 1,
      game: 'repo',
      profileName: 'x',
      extra: 1,
      mods: [
        {
          source: { kind: 'local', fileName: 'f', sha256: 's' },
          version: '1',
          enabled: true,
          more: 2
        }
      ]
    })
    const out = await readHmlFile(zipOf({ 'export.json': json }))
    expect(out.export.mods[0].name).toBeUndefined()
  })

  it('exports and reads what a mod provides; files without it still read', async () => {
    const withProvides: ProfileManifest = {
      ...profile,
      mods: [{ ...profile.mods[1], provides: ['Dep-Lib'] }, profile.mods[0]]
    }
    const out = await readHmlFile(await buildHmlFile(withProvides, dir))
    expect(out.export.mods[0].provides).toEqual(['Dep-Lib'])
    expect('provides' in out.export.mods[1]).toBe(false)
    const bad = JSON.stringify({
      formatVersion: 1,
      game: 'g',
      profileName: 'p',
      mods: [
        {
          source: { kind: 'local', fileName: 'f', sha256: 's' },
          version: '1',
          enabled: true,
          provides: [1]
        }
      ]
    })
    await expect(readHmlFile(zipOf({ 'export.json': bad }))).rejects.toThrow(DAMAGED)
  })

  it("carries a GitHub mod's prerelease setting; files without it read as off", async () => {
    const gh = profile.mods[1]
    const withPre: ProfileManifest = {
      ...profile,
      mods: [
        { ...gh, github: { updateMode: 'auto', assetPattern: null, prereleases: true } },
        { ...gh, id: 'B2', github: { updateMode: 'auto', assetPattern: null } },
        profile.mods[0]
      ]
    }
    const out = await readHmlFile(await buildHmlFile(withPre, dir))
    expect(out.export.mods[0].prereleases).toBe(true)
    expect('prereleases' in out.export.mods[1]).toBe(false)
    expect('prereleases' in out.export.mods[2]).toBe(false)
    const odd = JSON.stringify({
      formatVersion: 1,
      game: 'g',
      profileName: 'p',
      mods: [
        {
          source: { kind: 'local', fileName: 'f', sha256: 's' },
          version: '1',
          enabled: true,
          prereleases: 'yes'
        }
      ]
    })
    const read = await readHmlFile(zipOf({ 'export.json': odd }))
    expect(read.export.mods[0].prereleases).toBeUndefined()
  })

  it('rejects a missing export.json, a newer format and bad export.json', async () => {
    await expect(readHmlFile(zipOf({ 'a.txt': 'x' }))).rejects.toThrow(DAMAGED)
    await expect(
      readHmlFile(
        zipOf({
          'export.json': JSON.stringify({ formatVersion: 2, game: 'g', profileName: 'p', mods: [] })
        })
      )
    ).rejects.toThrow(DAMAGED)
    await expect(readHmlFile(zipOf({ 'export.json': 'not json' }))).rejects.toThrow(DAMAGED)
    await expect(
      readHmlFile(
        zipOf({
          'export.json': JSON.stringify({
            formatVersion: 1,
            game: 'g',
            profileName: 'p',
            mods: [{ source: { kind: 'x' }, version: '1', enabled: true }]
          })
        })
      )
    ).rejects.toThrow(DAMAGED)
  })

  it('rejects non-zip input such as 7z', async () => {
    const sevenZ = new Uint8Array([
      0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 1, 2, 3, 4, 5, 6, 7, 8
    ])
    await expect(readHmlFile(sevenZ)).rejects.toThrow("This isn't an HML profile file.")
  })
})
