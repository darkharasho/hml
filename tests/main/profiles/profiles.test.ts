import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makePaths, type AppPaths } from '../../../src/main/store/paths'
import {
  createProfile,
  deleteProfile,
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
  test('creates dir and manifest', async () => {
    const m = await createProfile(paths, 'repo', 'Default')
    expect(m).toMatchObject({ formatVersion: 1, id: 'default', name: 'Default', game: 'repo', mods: [] })
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
      saveProfile(paths, { formatVersion: 1, id: '../x', name: 'n', game: 'repo', createdAt: '', mods: [] })
    ).rejects.toThrow()
    expect(await exists(path.join(victim, 'keep.txt'))).toBe(true)
    expect(await exists(paths.profileDir('repo', 'default'))).toBe(true)
  })
})
