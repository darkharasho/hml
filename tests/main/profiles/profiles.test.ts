import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makePaths, type AppPaths } from '../../../src/main/store/paths'
import {
  createProfile,
  deleteProfile,
  duplicateProfile,
  getProfile,
  listProfiles,
  renameProfile,
  saveProfile,
  slugifyProfileName
} from '../../../src/main/profiles/profiles'

let tmp: string
let paths: AppPaths

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-profiles-'))
  paths = makePaths(tmp)
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  )

describe('profiles', () => {
  test('reads a hand-edited manifest whose mod has no source', async () => {
    await createProfile(paths, 'repo', 'Default')
    const file = path.join(paths.profileDir('repo', 'default'), 'hml-profile.json')
    const m = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify({ ...m, mods: [{ id: 'x', name: 'x' }, null] }))
    expect((await getProfile(paths, 'repo', 'default')).mods).toEqual([
      { id: 'x', name: 'x' },
      null
    ])
    expect((await listProfiles(paths, 'repo'))[0].mods).toHaveLength(2)
  })

  test('reads the BepInEx loader mod with a readable name', async () => {
    const m = await createProfile(paths, 'repo', 'Default')
    const loader = {
      id: 'BepInEx-BepInEx',
      name: 'BepInEx-BepInEx',
      version: '5.4.23.5',
      source: {
        kind: 'github' as const,
        owner: 'BepInEx',
        repo: 'BepInEx',
        tag: 'v5.4.23.5',
        asset: 'BepInEx_win_x64_5.4.23.5.zip',
        sha256: ''
      },
      enabled: true,
      files: [],
      disableable: [],
      installedAt: ''
    }
    await saveProfile(paths, { ...m, mods: [loader] })
    expect((await getProfile(paths, 'repo', 'default')).mods[0].name).toBe('BepInEx 5 (Mono)')
    expect((await listProfiles(paths, 'repo'))[0].mods[0].name).toBe('BepInEx 5 (Mono)')
  })

  test('creates dir and manifest', async () => {
    const m = await createProfile(paths, 'repo', 'Default')
    expect(m).toMatchObject({
      formatVersion: 1,
      id: 'default',
      name: 'Default',
      game: 'repo',
      mods: []
    })
    expect(Number.isNaN(Date.parse(m.createdAt))).toBe(false)
    const dir = paths.profileDir('repo', 'default')
    expect(await exists(path.join(dir, 'hml-profile.json'))).toBe(true)
    expect(await getProfile(paths, 'repo', 'default')).toEqual(m)
  })

  test('duplicate names get suffixed ids', async () => {
    const a = await createProfile(paths, 'repo', 'Default')
    const b = await createProfile(paths, 'repo', 'Default')
    const c = await createProfile(paths, 'repo', 'Default')
    expect([a.id, b.id, c.id]).toEqual(['default', 'default-2', 'default-3'])
  })

  test('slug strips illegal chars', () => {
    expect(slugifyProfileName('My: Pack?')).toBe('my-pack')
    expect(slugifyProfileName('a  b\tc')).toBe('a-b-c')
    expect(slugifyProfileName('name. . ')).toBe('name')
    expect(slugifyProfileName('???')).toBe('profile')
    expect(slugifyProfileName('..')).toBe('profile')
  })

  test('reserved name', () => {
    expect(slugifyProfileName('CON')).toBe('con-1')
    expect(slugifyProfileName('nul')).toBe('nul-1')
    expect(slugifyProfileName('COM3')).toBe('com3-1')
    expect(slugifyProfileName('lpt9')).toBe('lpt9-1')
    expect(slugifyProfileName('con.txt')).toBe('con-1.txt')
    expect(slugifyProfileName('console')).toBe('console')
  })

  test('rename keeps id', async () => {
    await createProfile(paths, 'repo', 'Default')
    await renameProfile(paths, 'repo', 'default', 'Renamed')
    const m = await getProfile(paths, 'repo', 'default')
    expect(m.id).toBe('default')
    expect(m.name).toBe('Renamed')
  })

  test('rename rejects non-string and blank names, keeping the old name', async () => {
    await createProfile(paths, 'repo', 'Default')
    for (const bad of [42, null, undefined, {}, '', '   \t']) {
      await expect(
        renameProfile(paths, 'repo', 'default', bad as unknown as string)
      ).rejects.toThrow('Profile name must not be empty.')
    }
    expect((await getProfile(paths, 'repo', 'default')).name).toBe('Default')
  })

  test('saveProfile persists mods', async () => {
    const m = await createProfile(paths, 'repo', 'Default')
    m.mods.push({
      id: 'a-b',
      name: 'b',
      version: '1.0.0',
      source: { kind: 'thunderstore', fullName: 'a-b' },
      enabled: true,
      files: ['BepInEx/plugins/b.dll'],
      disableable: [],
      installedAt: new Date().toISOString()
    })
    await saveProfile(paths, m)
    expect((await getProfile(paths, 'repo', 'default')).mods).toHaveLength(1)
  })

  test('duplicate copies mods, configs and files under a new id and name', async () => {
    const m = await createProfile(paths, 'repo', 'Default')
    const mod = {
      id: 'a-b',
      name: 'b',
      version: '1.0.0',
      source: { kind: 'thunderstore' as const, fullName: 'a-b' },
      enabled: false,
      files: ['BepInEx/plugins/b.dll'],
      disableable: [],
      installedAt: '2020-01-01T00:00:00.000Z'
    }
    await saveProfile(paths, { ...m, mods: [mod] })
    const src = paths.profileDir('repo', 'default')
    await fs.mkdir(path.join(src, 'BepInEx', 'config'), { recursive: true })
    await fs.mkdir(path.join(src, 'BepInEx', 'plugins'), { recursive: true })
    await fs.writeFile(path.join(src, 'BepInEx', 'config', 'b.cfg'), 'x = 1')
    await fs.writeFile(path.join(src, 'BepInEx', 'plugins', 'b.dll'), 'dll')

    const copy = await duplicateProfile(paths, 'repo', 'default', 'Default copy')
    expect(copy.id).toBe('default-copy')
    expect(copy.name).toBe('Default copy')
    expect(copy.mods).toEqual([mod])
    const dst = paths.profileDir('repo', copy.id)
    expect(await fs.readFile(path.join(dst, 'BepInEx', 'config', 'b.cfg'), 'utf8')).toBe('x = 1')
    expect(await fs.readFile(path.join(dst, 'BepInEx', 'plugins', 'b.dll'), 'utf8')).toBe('dll')
    expect(await getProfile(paths, 'repo', copy.id)).toEqual(copy)

    // The source is untouched, and editing the copy leaves it alone.
    await fs.writeFile(path.join(dst, 'BepInEx', 'config', 'b.cfg'), 'x = 2')
    expect(await fs.readFile(path.join(src, 'BepInEx', 'config', 'b.cfg'), 'utf8')).toBe('x = 1')
    expect((await getProfile(paths, 'repo', 'default')).name).toBe('Default')
  })

  test('duplicate refuses a missing profile and leaves no folder behind', async () => {
    await expect(duplicateProfile(paths, 'repo', 'nope', 'Copy')).rejects.toThrow(/not found/i)
    expect(await exists(paths.profileDir('repo', 'copy'))).toBe(false)
    await expect(duplicateProfile(paths, 'repo', '../x', 'Copy')).rejects.toThrow()
  })

  test('delete removes dir', async () => {
    await createProfile(paths, 'repo', 'Default')
    await deleteProfile(paths, 'repo', 'default')
    expect(await exists(paths.profileDir('repo', 'default'))).toBe(false)
  })

  test('list skips dirs without manifest, sorted by createdAt', async () => {
    expect(await listProfiles(paths, 'repo')).toEqual([])
    const a = await createProfile(paths, 'repo', 'B')
    const b = await createProfile(paths, 'repo', 'A')
    await saveProfile(paths, { ...a, createdAt: '2020-01-01T00:00:00.000Z' })
    await saveProfile(paths, { ...b, createdAt: '2021-01-01T00:00:00.000Z' })
    await fs.mkdir(path.join(paths.profilesDir('repo'), 'stray'), { recursive: true })
    expect((await listProfiles(paths, 'repo')).map((p) => p.id)).toEqual(['b', 'a'])
  })

  test('getProfile throws for missing profile', async () => {
    await expect(getProfile(paths, 'repo', 'nope')).rejects.toThrow(/not found/i)
  })

  test('accepts mixed-case labels', async () => {
    const m = await createProfile(paths, 'Risk-Of-Rain2', 'x')
    expect(m.game).toBe('Risk-Of-Rain2')
  })

  test('rejects traversal in game and id, deleting nothing', async () => {
    await createProfile(paths, 'repo', 'Default')
    const victim = path.join(paths.profilesDir('repo'), 'x')
    await fs.mkdir(victim, { recursive: true })
    await fs.writeFile(path.join(victim, 'keep.txt'), 'k')
    const bad = ['../x', '..', '.', 'a/b', 'a\\b', '', 'a b', '..\\x']
    for (const id of bad) {
      await expect(getProfile(paths, 'repo', id)).rejects.toThrow()
      await expect(deleteProfile(paths, 'repo', id)).rejects.toThrow()
      await expect(renameProfile(paths, 'repo', id, 'n')).rejects.toThrow()
    }
    await expect(listProfiles(paths, '../repo')).rejects.toThrow()
    await expect(createProfile(paths, '../repo', 'n')).rejects.toThrow()
    await expect(deleteProfile(paths, '../games', 'default')).rejects.toThrow()
    await expect(
      saveProfile(paths, {
        formatVersion: 1,
        id: '../x',
        name: 'n',
        game: 'repo',
        createdAt: '',
        mods: []
      })
    ).rejects.toThrow()
    expect(await exists(path.join(victim, 'keep.txt'))).toBe(true)
    expect(await exists(paths.profileDir('repo', 'default'))).toBe(true)
  })

  test('list ignores stray files in profiles dir', async () => {
    await createProfile(paths, 'repo', 'Default')
    await fs.writeFile(path.join(paths.profilesDir('repo'), 'stray.txt'), 'x')
    expect((await listProfiles(paths, 'repo')).map((p) => p.id)).toEqual(['default'])
  })

  test('list skips malformed manifests and id/dir mismatches', async () => {
    await createProfile(paths, 'repo', 'Good')
    const write = async (dir: string, data: unknown): Promise<void> => {
      const d = path.join(paths.profilesDir('repo'), dir)
      await fs.mkdir(d, { recursive: true })
      await fs.writeFile(path.join(d, 'hml-profile.json'), JSON.stringify(data))
    }
    const ok = { id: 'x', name: 'n', createdAt: '2020', mods: [] }
    await write('null', null)
    await write('arr', [])
    await write('nocreated', { ...ok, id: 'nocreated', createdAt: undefined })
    await write('noname', { ...ok, id: 'noname', name: 5 })
    await write('nomods', { ...ok, id: 'nomods', mods: {} })
    await write('mismatch', { ...ok, id: 'other' })
    expect((await listProfiles(paths, 'repo')).map((p) => p.id)).toEqual(['good'])
  })

  test('saveProfile does not resurrect a deleted profile', async () => {
    const m = await createProfile(paths, 'repo', 'Default')
    await deleteProfile(paths, 'repo', 'default')
    await expect(saveProfile(paths, m)).rejects.toThrow(/Profile not found/)
    expect(await exists(paths.profileDir('repo', 'default'))).toBe(false)
  })

  test('slug is capped at 64 chars with no trailing separator', () => {
    expect(slugifyProfileName('a'.repeat(100))).toBe('a'.repeat(64))
    const s = slugifyProfileName('a'.repeat(63) + '-bbb')
    expect(s).toBe('a'.repeat(63))
    expect(slugifyProfileName('a'.repeat(63) + '.bbb')).toBe('a'.repeat(63))
  })
})

test('createProfile reserves the deploy lock id', async () => {
  await expect(createProfile(paths, 'g', '__deploy__')).rejects.toThrow(
    'That profile name is reserved.'
  )
})
