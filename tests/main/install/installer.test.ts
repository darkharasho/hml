import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { parseEcosystem } from '../../../src/main/catalog/ecosystem'
import { makePaths, type AppPaths } from '../../../src/main/store/paths'
import { createProfile, getProfile } from '../../../src/main/profiles/profiles'
import { UnsafeEntryError } from '../../../src/main/install/planInstall'
import {
  installZip,
  uninstallMod,
  setModEnabled,
  detectPackageMeta,
  readZipEntries
} from '../../../src/main/install/installer'
import type { Catalog, GameDef, ModSource } from '../../../src/shared/types'

const catalog: Catalog = parseEcosystem(
  JSON.parse(readFileSync(path.join(__dirname, '../../fixtures/ecosystem-min.json'), 'utf8'))
)
const game = catalog.games.find((g) => g.label === 'repo') as GameDef
const src: ModSource = { kind: 'thunderstore', fullName: 'A-Mod' }
const manifest = (name: string, v: string): Uint8Array =>
  strToU8(JSON.stringify({ name, version_number: v }))

let tmp: string
let paths: AppPaths
let pid: string
let profDir: string

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-inst-'))
  paths = makePaths(tmp)
  pid = (await createProfile(paths, 'repo', 'p')).id
  profDir = paths.profileDir('repo', pid)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const modZip = (v: string, extra: Record<string, Uint8Array> = {}): Uint8Array =>
  zipSync({
    'manifest.json': manifest('Mod', v),
    'Mod.dll': strToU8('dll' + v),
    'config/mod.cfg': strToU8('cfg' + v),
    ...extra
  })
const snapshot = (dir: string): string[] =>
  (readdirSync(dir, { recursive: true }) as string[]).map((s) => s.toString()).sort()

describe('installer', () => {
  test('installs and records files', async () => {
    const mod = await installZip(paths, game, catalog, pid, modZip('1.0.0'), src, {
      packageId: 'A-Mod'
    })
    expect(mod.id).toBe('A-Mod')
    expect(mod.version).toBe('1.0.0')
    expect(mod.enabled).toBe(true)
    expect(mod.files).toContain('BepInEx/plugins/A-Mod/Mod.dll')
    expect(mod.files).toContain('BepInEx/config/mod.cfg')
    expect(mod.disableable).toContain('BepInEx/plugins/A-Mod/Mod.dll')
    expect(mod.disableable).not.toContain('BepInEx/config/mod.cfg')
    expect(readFileSync(path.join(profDir, 'BepInEx/plugins/A-Mod/Mod.dll'), 'utf8')).toBe(
      'dll1.0.0'
    )
    expect((await getProfile(paths, 'repo', pid)).mods).toHaveLength(1)
  })

  test('reinstall replaces old files', async () => {
    await installZip(paths, game, catalog, pid, modZip('1', { 'Old.dll': strToU8('o') }), src, {
      packageId: 'A-Mod'
    })
    expect(existsSync(path.join(profDir, 'BepInEx/plugins/A-Mod/Old.dll'))).toBe(true)
    await installZip(paths, game, catalog, pid, modZip('2'), src, { packageId: 'A-Mod' })
    expect(existsSync(path.join(profDir, 'BepInEx/plugins/A-Mod/Old.dll'))).toBe(false)
    expect(readFileSync(path.join(profDir, 'BepInEx/plugins/A-Mod/Mod.dll'), 'utf8')).toBe('dll2')
    expect((await getProfile(paths, 'repo', pid)).mods).toHaveLength(1)
  })

  test('reinstall keeps disabled state and existing config', async () => {
    await installZip(paths, game, catalog, pid, modZip('1'), src, { packageId: 'A-Mod' })
    await setModEnabled(paths, game, pid, 'A-Mod', false)
    const cfg = path.join(profDir, 'BepInEx/config/mod.cfg')
    writeFileSync(cfg, 'user')
    const mod = await installZip(paths, game, catalog, pid, modZip('2'), src, {
      packageId: 'A-Mod'
    })
    expect(mod.enabled).toBe(false)
    expect(existsSync(path.join(profDir, 'BepInEx/plugins/A-Mod/Mod.dll.old'))).toBe(true)
    expect(existsSync(path.join(profDir, 'BepInEx/plugins/A-Mod/Mod.dll'))).toBe(false)
    expect(readFileSync(cfg, 'utf8')).toBe('user')
  })

  test('existing config is not overwritten nor owned', async () => {
    const cfg = path.join(profDir, 'BepInEx/config/mod.cfg')
    mkdirSync(path.dirname(cfg), { recursive: true })
    writeFileSync(cfg, 'user')
    const mod = await installZip(paths, game, catalog, pid, modZip('1'), src, {
      packageId: 'A-Mod'
    })
    expect(readFileSync(cfg, 'utf8')).toBe('user')
    expect(mod.files).not.toContain('BepInEx/config/mod.cfg')
    await uninstallMod(paths, game, pid, 'A-Mod')
    expect(readFileSync(cfg, 'utf8')).toBe('user')
  })

  test('disable renames to .old, enable restores, config untouched', async () => {
    await installZip(paths, game, catalog, pid, modZip('1'), src, { packageId: 'A-Mod' })
    const dll = path.join(profDir, 'BepInEx/plugins/A-Mod/Mod.dll')
    const cfg = path.join(profDir, 'BepInEx/config/mod.cfg')
    await setModEnabled(paths, game, pid, 'A-Mod', false)
    expect(existsSync(dll)).toBe(false)
    expect(existsSync(dll + '.old')).toBe(true)
    expect(existsSync(cfg)).toBe(true)
    expect((await getProfile(paths, 'repo', pid)).mods[0].enabled).toBe(false)
    await setModEnabled(paths, game, pid, 'A-Mod', false) // idempotent
    expect(existsSync(dll + '.old')).toBe(true)
    await setModEnabled(paths, game, pid, 'A-Mod', true)
    expect(existsSync(dll)).toBe(true)
    expect(existsSync(dll + '.old')).toBe(false)
  })

  test("uninstall removes files and empty dirs but keeps other mods' files", async () => {
    await installZip(paths, game, catalog, pid, modZip('1'), src, { packageId: 'A-Mod' })
    await installZip(paths, game, catalog, pid, zipSync({ 'B.dll': strToU8('b') }), src, {
      packageId: 'B-Mod'
    })
    await setModEnabled(paths, game, pid, 'A-Mod', false)
    await uninstallMod(paths, game, pid, 'A-Mod')
    expect(existsSync(path.join(profDir, 'BepInEx/plugins/A-Mod'))).toBe(false)
    expect(existsSync(path.join(profDir, 'BepInEx/config'))).toBe(false)
    expect(existsSync(path.join(profDir, 'BepInEx/plugins/B-Mod/B.dll'))).toBe(true)
    expect((await getProfile(paths, 'repo', pid)).mods.map((m) => m.id)).toEqual(['B-Mod'])
  })

  test('installs BepInExPack to profile root', async () => {
    const zip = zipSync({
      'manifest.json': manifest('BepInExPack', '5.4.2100'),
      'BepInExPack/winhttp.dll': strToU8('w'),
      'BepInExPack/BepInEx/core/BepInEx.dll': strToU8('c')
    })
    const mod = await installZip(paths, game, catalog, pid, zip, src, {
      packageId: 'bbepis-BepInExPack'
    })
    expect(existsSync(path.join(profDir, 'winhttp.dll'))).toBe(true)
    expect(existsSync(path.join(profDir, 'BepInEx/core/BepInEx.dll'))).toBe(true)
    expect(mod.disableable).toEqual([])
  })

  test('local BepInExPack zip is detected by manifest name', async () => {
    const zip = zipSync({
      'manifest.json': manifest('BepInExPack', '5.4.2100'),
      'BepInExPack/winhttp.dll': strToU8('w')
    })
    await installZip(paths, game, catalog, pid, zip, {
      kind: 'local',
      fileName: 'x.zip',
      sha256: ''
    })
    expect(existsSync(path.join(profDir, 'winhttp.dll'))).toBe(true)
  })

  test('a Thunderstore loader replaces the local loader recorded under its alias', async () => {
    const pack = (v: string): Uint8Array =>
      zipSync({
        'manifest.json': manifest('BepInExPack', v),
        'BepInExPack/winhttp.dll': strToU8('w' + v),
        'BepInExPack/BepInEx/core/BepInEx.dll': strToU8('c' + v),
        ...(v === '5.4.2100' ? { 'BepInExPack/old-only.txt': strToU8('o') } : {})
      })
    await installZip(paths, game, catalog, pid, pack('5.4.2100'), {
      kind: 'local',
      fileName: 'x.zip',
      sha256: ''
    })
    await setModEnabled(paths, game, pid, 'BepInExPack', false)
    const mod = await installZip(
      paths,
      game,
      catalog,
      pid,
      pack('5.4.2200'),
      { kind: 'thunderstore', fullName: 'BepInEx-BepInExPack' },
      { packageId: 'BepInEx-BepInExPack', name: 'BepInExPack', version: '5.4.2200' }
    )
    const mods = (await getProfile(paths, 'repo', pid)).mods
    expect(mods.map((m) => `${m.id}@${m.version}`)).toEqual(['BepInEx-BepInExPack@5.4.2200'])
    expect(mod.enabled).toBe(false)
    expect(readFileSync(path.join(profDir, 'winhttp.dll'), 'utf8')).toBe('w5.4.2200')
    expect(readFileSync(path.join(profDir, 'BepInEx/core/BepInEx.dll'), 'utf8')).toBe('c5.4.2200')
    expect(existsSync(path.join(profDir, 'old-only.txt'))).toBe(false)
    expect(mod.files.sort()).toEqual(['BepInEx/core/BepInEx.dll', 'winhttp.dll'])
    await uninstallMod(paths, game, pid, 'BepInEx-BepInExPack')
    expect(existsSync(path.join(profDir, 'winhttp.dll'))).toBe(false)
    expect(existsSync(path.join(profDir, 'BepInEx/core/BepInEx.dll'))).toBe(false)
  })

  test('replaces: another mod id is upgraded in place, keeping config and enabled', async () => {
    const local: ModSource = { kind: 'local', fileName: 'Mod.zip', sha256: '' }
    await installZip(paths, game, catalog, pid, modZip('1.0.0'), local)
    writeFileSync(path.join(profDir, 'BepInEx/config/mod.cfg'), 'user')
    await setModEnabled(paths, game, pid, 'Mod', false)
    const mod = await installZip(paths, game, catalog, pid, modZip('2.0.0'), src, {
      packageId: 'A-Mod',
      replaces: ['Mod']
    })
    const mods = (await getProfile(paths, 'repo', pid)).mods
    expect(mods.map((m) => m.id)).toEqual(['A-Mod'])
    expect(mod.enabled).toBe(false)
    expect(readFileSync(path.join(profDir, 'BepInEx/config/mod.cfg'), 'utf8')).toBe('user')
    expect(mod.files).toContain('BepInEx/config/mod.cfg')
    expect(existsSync(path.join(profDir, 'BepInEx/plugins/Mod'))).toBe(false)
  })

  test('unsafe zip writes nothing', async () => {
    const before = snapshot(profDir)
    const zip = zipSync({ 'Good.dll': strToU8('g'), '../evil.dll': strToU8('e') })
    await expect(
      installZip(paths, game, catalog, pid, zip, src, { packageId: 'A-Mod' })
    ).rejects.toBeInstanceOf(UnsafeEntryError)
    expect(snapshot(profDir)).toEqual(before)
  })

  test('unsafe zip does not uninstall the old version', async () => {
    await installZip(paths, game, catalog, pid, modZip('1'), src, { packageId: 'A-Mod' })
    const zip = zipSync({ '../evil.dll': strToU8('e') })
    await expect(
      installZip(paths, game, catalog, pid, zip, src, { packageId: 'A-Mod' })
    ).rejects.toBeInstanceOf(UnsafeEntryError)
    expect(existsSync(path.join(profDir, 'BepInEx/plugins/A-Mod/Mod.dll'))).toBe(true)
  })

  test.each(['../x', 'a/b', 'a\\b', '..', '.', 'a\0b'])(
    'unsafe packageId %j rejected',
    async (id) => {
      const before = snapshot(profDir)
      await expect(
        installZip(paths, game, catalog, pid, modZip('1'), src, { packageId: id })
      ).rejects.toBeInstanceOf(UnsafeEntryError)
      expect(snapshot(profDir)).toEqual(before)
    }
  )

  test('write failure rolls back files written so far and rethrows', async () => {
    // plugins/ is written first; a regular file blocks the patchers destination dir.
    mkdirSync(path.join(profDir, 'BepInEx/patchers'), { recursive: true })
    writeFileSync(path.join(profDir, 'BepInEx/patchers/A-Mod'), 'blocker')
    const before = snapshot(profDir)
    const zip = zipSync({ 'plugins/A.dll': strToU8('a'), 'patchers/P.dll': strToU8('p') })
    await expect(
      installZip(paths, game, catalog, pid, zip, src, { packageId: 'A-Mod' })
    ).rejects.toThrow()
    expect(existsSync(path.join(profDir, 'BepInEx/plugins/A-Mod/A.dll'))).toBe(false)
    expect(snapshot(profDir)).toEqual(before)
    expect((await getProfile(paths, 'repo', pid)).mods).toHaveLength(0)
  })

  test('upgrade keeps config ownership so uninstall removes it', async () => {
    await installZip(paths, game, catalog, pid, modZip('1'), src, { packageId: 'A-Mod' })
    const mod = await installZip(paths, game, catalog, pid, modZip('2'), src, {
      packageId: 'A-Mod'
    })
    expect(mod.files).toContain('BepInEx/config/mod.cfg')
    await uninstallMod(paths, game, pid, 'A-Mod')
    expect(existsSync(path.join(profDir, 'BepInEx/config/mod.cfg'))).toBe(false)
  })

  test('manifest with BOM parses', () => {
    const bom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...strToU8('{"name":"M","version_number":"1.2.3"}')
    ])
    const z = readZipEntries(zipSync({ 'wrap/manifest.json': bom, 'wrap/': new Uint8Array() }))
    expect(z.names).toEqual(['wrap/manifest.json'])
    expect(detectPackageMeta(z, 'fb')).toEqual({ name: 'M', version: '1.2.3' })
    expect(detectPackageMeta(readZipEntries(zipSync({ 'a.dll': strToU8('x') })), 'fb')).toBeNull()
  })

  test('falls back to zip filename and 0.0.0', async () => {
    const mod = await installZip(paths, game, catalog, pid, zipSync({ 'a.dll': strToU8('x') }), {
      kind: 'local',
      fileName: 'Cool.zip',
      sha256: ''
    })
    expect(mod.id).toBe('Cool')
    expect(mod.version).toBe('0.0.0')
  })

  test('duplicate destinations are recorded once', async () => {
    const zip = zipSync({ 'plugins/A.dll': strToU8('1'), 'A.dll': strToU8('2') })
    const mod = await installZip(paths, game, catalog, pid, zip, src, { packageId: 'A-Mod' })
    expect(mod.files.filter((f) => f.endsWith('A.dll'))).toHaveLength(1)
    expect(readFileSync(path.join(profDir, 'BepInEx/plugins/A-Mod/A.dll'), 'utf8')).toBe('2')
  })

  test('installs a deploy game zip as-is with every file disableable', async () => {
    const deployGame: GameDef = { ...game, label: 'nexus-x', loader: 'deploy', installRules: [] }
    const p = (await createProfile(paths, 'nexus-x', 'p')).id
    const zip = zipSync({ 'Wrap/Data/a.esp': strToU8('esp'), 'Wrap/readme.txt': strToU8('r') })
    const mod = await installZip(paths, deployGame, catalog, p, zip, src, { packageId: 'nexus-1' })
    expect(mod.files.sort()).toEqual(['nexus-1/Data/a.esp', 'nexus-1/readme.txt'])
    expect(mod.disableable.sort()).toEqual(['nexus-1/Data/a.esp', 'nexus-1/readme.txt'])
    expect(
      readFileSync(path.join(paths.profileDir('nexus-x', p), 'nexus-1/Data/a.esp'), 'utf8')
    ).toBe('esp')
  })

  test('a deploy game strips a Data folder that equals its deploy root', async () => {
    const deployGame: GameDef = {
      ...game,
      label: 'nexus-x',
      loader: 'deploy',
      installRules: [],
      deployRoot: 'Data'
    }
    const p = (await createProfile(paths, 'nexus-x', 'p')).id
    const zip = zipSync({ 'Mod/Data/x.esp': strToU8('esp'), 'Mod/Data/meshes/a.nif': strToU8('n') })
    const mod = await installZip(paths, deployGame, catalog, p, zip, src, { packageId: 'nexus-1' })
    expect(mod.files.sort()).toEqual(['nexus-1/meshes/a.nif', 'nexus-1/x.esp'])
  })

  test('a deploy game refuses a package id that is not one safe path segment', async () => {
    const deployGame: GameDef = { ...game, label: 'nexus-x', loader: 'deploy', installRules: [] }
    const p = (await createProfile(paths, 'nexus-x', 'p')).id
    const zip = zipSync({ 'a.esp': strToU8('esp') })
    for (const packageId of ['..', '.', 'a b', 'a/b', 'a\\b', '']) {
      await expect(
        installZip(paths, deployGame, catalog, p, zip, src, { packageId })
      ).rejects.toThrow(UnsafeEntryError)
    }
    expect((await getProfile(paths, 'nexus-x', p)).mods).toEqual([])
  })

  test('a deploy game makes a local file name safe as its mod folder', async () => {
    const deployGame: GameDef = { ...game, label: 'nexus-x', loader: 'deploy', installRules: [] }
    const p = (await createProfile(paths, 'nexus-x', 'p')).id
    const zip = zipSync({ 'a.esp': strToU8('esp') })
    const local = { kind: 'local' as const, fileName: 'My Mod (1).zip', sha256: 'x' }
    const mod = await installZip(paths, deployGame, catalog, p, zip, local)
    expect(mod.id).toBe('My_Mod__1_')
    expect(mod.name).toBe('My Mod (1)')
    expect(mod.files).toEqual(['My_Mod__1_/a.esp'])
  })

  test('deploy game mods sharing a path each keep their own copy', async () => {
    const deployGame: GameDef = { ...game, label: 'nexus-x', loader: 'deploy', installRules: [] }
    const p = (await createProfile(paths, 'nexus-x', 'p')).id
    const dir = paths.profileDir('nexus-x', p)
    const z = (v: string): Uint8Array => zipSync({ 'readme.txt': strToU8(v) })
    await installZip(paths, deployGame, catalog, p, z('one'), src, { packageId: 'nexus-1' })
    await installZip(paths, deployGame, catalog, p, z('two'), src, { packageId: 'nexus-2' })
    await setModEnabled(paths, deployGame, p, 'nexus-2', false)
    expect(readFileSync(path.join(dir, 'nexus-1/readme.txt'), 'utf8')).toBe('one')
    await uninstallMod(paths, deployGame, p, 'nexus-2')
    expect(readFileSync(path.join(dir, 'nexus-1/readme.txt'), 'utf8')).toBe('one')
    expect(existsSync(path.join(dir, 'nexus-2'))).toBe(false)
    // Reinstalling replaces the mod's old folder.
    await installZip(paths, deployGame, catalog, p, zipSync({ 'b.txt': strToU8('b') }), src, {
      packageId: 'nexus-1'
    })
    expect(existsSync(path.join(dir, 'nexus-1/readme.txt'))).toBe(false)
    expect(readFileSync(path.join(dir, 'nexus-1/b.txt'), 'utf8')).toBe('b')
  })

  test('installs a zip that starts with a 16-byte junk prefix', async () => {
    const zip = modZip('1.0.0')
    const prefixed = new Uint8Array(16 + zip.length)
    prefixed.fill(0x41, 0, 16)
    prefixed.set(zip, 16)
    const mod = await installZip(paths, game, catalog, pid, prefixed, src, { packageId: 'A-Mod' })
    expect(mod.files).toContain('BepInEx/plugins/A-Mod/Mod.dll')
  })

  test('accepts a ZipEntries object instead of bytes', async () => {
    const entries = readZipEntries(modZip('1.0.0'))
    const mod = await installZip(paths, game, catalog, pid, entries, src, { packageId: 'A-Mod' })
    expect(mod.files).toContain('BepInEx/plugins/A-Mod/Mod.dll')
  })

  describe('a raw BepInEx release (GitHub)', () => {
    const ghSrc: ModSource = {
      kind: 'github',
      owner: 'BepInEx',
      repo: 'BepInEx',
      tag: 'v5.4.23.2',
      asset: 'BepInEx_win_x64_5.4.23.2.zip',
      sha256: ''
    }
    const official = (prefix = ''): Uint8Array =>
      zipSync({
        [`${prefix}BepInEx/core/BepInEx.Preloader.dll`]: strToU8('pre'),
        [`${prefix}BepInEx/core/BepInEx.dll`]: strToU8('core'),
        [`${prefix}winhttp.dll`]: strToU8('w'),
        [`${prefix}doorstop_config.ini`]: strToU8('[General]'),
        [`${prefix}changelog.txt`]: strToU8('c')
      })
    const opts = { packageId: 'BepInEx-BepInEx', version: '5.4.23.2' }

    test('installs as the loader at the profile root, nothing disableable', async () => {
      const mod = await installZip(paths, game, catalog, pid, official(), ghSrc, opts)
      expect(readFileSync(path.join(profDir, 'BepInEx/core/BepInEx.Preloader.dll'), 'utf8')).toBe(
        'pre'
      )
      expect(existsSync(path.join(profDir, 'winhttp.dll'))).toBe(true)
      expect(existsSync(path.join(profDir, 'doorstop_config.ini'))).toBe(true)
      expect(mod.disableable).toEqual([])
      expect(mod.files.sort()).toEqual([
        'BepInEx/core/BepInEx.Preloader.dll',
        'BepInEx/core/BepInEx.dll',
        'changelog.txt',
        'doorstop_config.ini',
        'winhttp.dll'
      ])
      expect(mod.provides).toEqual([catalog.modloaderPackages[0].packageId])
    })

    test('one sole wrapper folder is stripped', async () => {
      const mod = await installZip(paths, game, catalog, pid, official('BepInEx_x64/'), ghSrc, opts)
      expect(existsSync(path.join(profDir, 'BepInEx/core/BepInEx.Preloader.dll'))).toBe(true)
      expect(existsSync(path.join(profDir, 'winhttp.dll'))).toBe(true)
      expect(mod.provides).toHaveLength(1)
    })

    test('without doorstop or winhttp at the root it is a normal mod', async () => {
      const zip = zipSync({ 'BepInEx/core/Thing.dll': strToU8('t') })
      const mod = await installZip(paths, game, catalog, pid, zip, ghSrc, opts)
      expect(mod.files).toEqual(['BepInEx/core/BepInEx-BepInEx/Thing.dll'])
      expect(mod.provides).toBeUndefined()
    })

    test('replaces an installed Thunderstore loader instead of skipping its files', async () => {
      await installZip(
        paths,
        game,
        catalog,
        pid,
        zipSync({
          'manifest.json': manifest('BepInExPack', '5.4.2100'),
          'BepInExPack/winhttp.dll': strToU8('old'),
          'BepInExPack/BepInEx/core/BepInEx.Preloader.dll': strToU8('old')
        }),
        { kind: 'thunderstore', fullName: 'BepInEx-BepInExPack' },
        { packageId: 'BepInEx-BepInExPack', name: 'BepInExPack', version: '5.4.2100' }
      )
      const mod = await installZip(paths, game, catalog, pid, official(), ghSrc, opts)
      const mods = (await getProfile(paths, 'repo', pid)).mods
      expect(mods.map((m) => m.id)).toEqual(['BepInEx-BepInEx'])
      expect(readFileSync(path.join(profDir, 'winhttp.dll'), 'utf8')).toBe('w')
      expect(mod.files).toContain('winhttp.dll')
    })
  })
})
