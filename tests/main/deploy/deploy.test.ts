import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  utimesSync,
  statSync
} from 'node:fs'
import { promises as fsp } from 'node:fs'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { makePaths, type AppPaths } from '../../../src/main/store/paths'
import {
  createProfile,
  deleteProfile,
  saveProfile,
  getProfile
} from '../../../src/main/profiles/profiles'
import { installZip } from '../../../src/main/install/installer'
import { deployProfile, deploymentStatus, removeDeployment } from '../../../src/main/deploy/deploy'
import type { Catalog, GameDef, ModSource } from '../../../src/shared/types'

const game: GameDef = {
  label: 'nexus-x',
  displayName: 'X',
  steamAppId: null,
  steamFolderName: '',
  exeNames: [],
  dataFolderName: '',
  loader: 'deploy',
  installRules: [],
  packageIndex: null,
  searchStrings: [],
  iconUrl: null,
  supported: true
}
const catalog: Catalog = { games: [game], modloaderPackages: [], fetchedAt: '' }
const src: ModSource = { kind: 'nexus', domain: 'x', modId: 1, fileId: 1 }

let tmp: string
let paths: AppPaths
let gameDir: string
let pid: string

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-deploy-'))
  paths = makePaths(path.join(tmp, 'data'))
  gameDir = path.join(tmp, 'game')
  mkdirSync(gameDir)
  pid = (await createProfile(paths, game.label, 'p')).id
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

const install = (profile: string, id: string, files: Record<string, string>): Promise<unknown> =>
  installZip(
    paths,
    game,
    catalog,
    profile,
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))),
    src,
    { packageId: id }
  )
const read = (rel: string): string => readFileSync(path.join(gameDir, rel), 'utf8')
const has = (rel: string): boolean => existsSync(path.join(gameDir, rel))

describe('deploy', () => {
  test('copies only enabled mods; the later-installed mod wins a conflict', async () => {
    await install(pid, 'nexus-1', { 'Data/a.esp': 'one', 'Data/shared.txt': 'one' })
    await install(pid, 'nexus-2', { 'Data/b.esp': 'two', 'Data/shared.txt': 'two' })
    await install(pid, 'nexus-3', { 'Data/off.esp': 'off' })
    const profile = await getProfile(paths, game.label, pid)
    await saveProfile(paths, {
      ...profile,
      mods: profile.mods.map((m) => (m.id === 'nexus-3' ? { ...m, enabled: false } : m))
    })
    const status = await deployProfile(paths, game, pid, gameDir)
    expect(read('Data/a.esp')).toBe('one')
    expect(read('Data/b.esp')).toBe('two')
    expect(read('Data/shared.txt')).toBe('two')
    expect(has('Data/off.esp')).toBe(false)
    expect(status).toMatchObject({ profileId: pid, profileName: 'p', files: 3 })
    expect(await deploymentStatus(paths, game)).toMatchObject({ profileId: pid, files: 3 })
  })

  test('backs up pre-existing game files and remove restores them', async () => {
    mkdirSync(path.join(gameDir, 'Data'))
    writeFileSync(path.join(gameDir, 'Data/a.esp'), 'original')
    await install(pid, 'nexus-1', { 'Data/a.esp': 'mod' })
    await deployProfile(paths, game, pid, gameDir)
    expect(read('Data/a.esp')).toBe('mod')
    expect(readFileSync(path.join(paths.deployBackup(game.label), 'Data/a.esp'), 'utf8')).toBe(
      'original'
    )
    await removeDeployment(paths, game, gameDir)
    expect(read('Data/a.esp')).toBe('original')
    expect(existsSync(paths.deployBackup(game.label))).toBe(false)
    expect(existsSync(paths.deployment(game.label))).toBe(false)
    expect(await deploymentStatus(paths, game)).toBeNull()
  })

  test('in-game changes are copied back into the profile on remove', async () => {
    await install(pid, 'nexus-1', { 'Data/a.ini': 'short' })
    await deployProfile(paths, game, pid, gameDir)
    writeFileSync(path.join(gameDir, 'Data/a.ini'), 'a much longer edited value')
    await removeDeployment(paths, game, gameDir)
    expect(has('Data/a.ini')).toBe(false)
    expect(readFileSync(path.join(paths.profileDir(game.label, pid), 'Data/a.ini'), 'utf8')).toBe(
      'a much longer edited value'
    )
  })

  test('unchanged files are not copied back', async () => {
    await install(pid, 'nexus-1', { 'a.txt': 'same' })
    await deployProfile(paths, game, pid, gameDir)
    const spy = vi.spyOn(fsp, 'copyFile')
    await removeDeployment(paths, game, gameDir)
    expect(spy).not.toHaveBeenCalled()
  })

  test('remove deletes only what HML created', async () => {
    mkdirSync(path.join(gameDir, 'Empty'))
    mkdirSync(path.join(gameDir, 'Keep'))
    writeFileSync(path.join(gameDir, 'Keep/user.txt'), 'mine')
    await install(pid, 'nexus-1', {
      'Empty/a.txt': 'a',
      'New/deep/b.txt': 'b',
      'Keep/c.txt': 'c'
    })
    await deployProfile(paths, game, pid, gameDir)
    writeFileSync(path.join(gameDir, 'New/deep/extra.txt'), 'game made this')
    await removeDeployment(paths, game, gameDir)
    expect(has('Empty')).toBe(true)
    expect(has('Empty/a.txt')).toBe(false)
    expect(has('Keep/user.txt')).toBe(true)
    expect(has('Keep/c.txt')).toBe(false)
    // New/deep still holds a file HML didn't create, so the folders stay.
    expect(has('New/deep/extra.txt')).toBe(true)
    rmSync(path.join(gameDir, 'New/deep/extra.txt'))
  })

  test('created dirs are removed when empty', async () => {
    await install(pid, 'nexus-1', { 'New/deep/b.txt': 'b' })
    await deployProfile(paths, game, pid, gameDir)
    await removeDeployment(paths, game, gameDir)
    expect(has('New')).toBe(false)
    expect(existsSync(gameDir)).toBe(true)
  })

  test('deploying profile B while A is deployed removes A first', async () => {
    const b = (await createProfile(paths, game.label, 'b')).id
    mkdirSync(path.join(gameDir, 'Data'))
    writeFileSync(path.join(gameDir, 'Data/a.esp'), 'original')
    await install(pid, 'nexus-1', { 'Data/a.esp': 'A', 'Data/onlyA.esp': 'A' })
    await install(b, 'nexus-2', { 'Data/b.esp': 'B' })
    await deployProfile(paths, game, pid, gameDir)
    const status = await deployProfile(paths, game, b, gameDir)
    expect(status.profileId).toBe(b)
    expect(has('Data/onlyA.esp')).toBe(false)
    expect(read('Data/a.esp')).toBe('original')
    expect(read('Data/b.esp')).toBe('B')
    await removeDeployment(paths, game, gameDir)
    expect(read('Data/a.esp')).toBe('original')
    expect(has('Data/b.esp')).toBe(false)
  })

  test('an interrupted deploy leaves a manifest that remove cleans up', async () => {
    mkdirSync(path.join(gameDir, 'Data'))
    writeFileSync(path.join(gameDir, 'Data/a.esp'), 'original')
    await install(pid, 'nexus-1', { 'Data/a.esp': 'A', 'Data/b.esp': 'B', 'New/c.esp': 'C' })
    const real = fsp.copyFile.bind(fsp)
    let calls = 0
    vi.spyOn(fsp, 'copyFile').mockImplementation(async (...a) => {
      if (++calls === 2) throw new Error('disk full')
      return real(...a)
    })
    await expect(deployProfile(paths, game, pid, gameDir)).rejects.toThrow('disk full')
    expect(existsSync(paths.deployment(game.label))).toBe(true)
    vi.restoreAllMocks()
    await removeDeployment(paths, game, gameDir)
    expect(read('Data/a.esp')).toBe('original')
    expect(has('Data/b.esp')).toBe(false)
    expect(has('New')).toBe(false)
    expect(existsSync(paths.deployment(game.label))).toBe(false)
  })

  test('an interrupt before the backups finish never deletes an original', async () => {
    writeFileSync(path.join(gameDir, 'a.esp'), 'original')
    await install(pid, 'nexus-1', { 'a.esp': 'A' })
    // A manifest as left by a crash in the backup phase: a.esp not moved yet.
    await fsp.mkdir(paths.gameDir(game.label), { recursive: true })
    writeFileSync(
      paths.deployment(game.label),
      JSON.stringify({
        formatVersion: 1,
        profileId: pid,
        deployedAt: 'x',
        gameDir,
        phase: 'backup',
        files: [{ path: 'a.esp', mod: 'nexus-1', size: -1, mtimeMs: -1, backedUp: false }],
        createdDirs: []
      })
    )
    await removeDeployment(paths, game, gameDir)
    expect(read('a.esp')).toBe('original')
  })

  test('removing after the profile was deleted restores backups and deletes deployed files', async () => {
    writeFileSync(path.join(gameDir, 'a.esp'), 'original')
    await install(pid, 'nexus-1', { 'a.esp': 'A', 'b.esp': 'B' })
    await deployProfile(paths, game, pid, gameDir)
    await deleteProfile(paths, game.label, pid)
    expect(await deploymentStatus(paths, game)).toMatchObject({ profileId: pid, profileName: null })
    await removeDeployment(paths, game, gameDir)
    expect(read('a.esp')).toBe('original')
    expect(has('b.esp')).toBe(false)
  })

  test('manifest paths that escape the folder are ignored', async () => {
    const outside = path.join(tmp, 'outside.txt')
    writeFileSync(outside, 'precious')
    writeFileSync(path.join(gameDir, 'ok.txt'), 'ok')
    await fsp.mkdir(paths.gameDir(game.label), { recursive: true })
    const file = (p: string): object => ({
      path: p,
      mod: 'm',
      size: 0,
      mtimeMs: 0,
      backedUp: false
    })
    writeFileSync(
      paths.deployment(game.label),
      JSON.stringify({
        formatVersion: 1,
        profileId: pid,
        deployedAt: 'x',
        gameDir,
        phase: 'done',
        files: [file('../outside.txt'), file('/etc/passwd'), file('ok.txt')],
        createdDirs: ['..']
      })
    )
    await removeDeployment(paths, game, gameDir)
    expect(readFileSync(outside, 'utf8')).toBe('precious')
    expect(has('ok.txt')).toBe(false)
  })

  test('refuses to deploy over a folder or through a file', async () => {
    mkdirSync(path.join(gameDir, 'a.esp'))
    await install(pid, 'nexus-1', { 'a.esp': 'A' })
    await expect(deployProfile(paths, game, pid, gameDir)).rejects.toThrow(/is a folder/)
    expect(existsSync(paths.deployment(game.label))).toBe(false)
  })

  test('remove with nothing deployed is a no-op', async () => {
    await expect(removeDeployment(paths, game, gameDir)).resolves.toBeUndefined()
  })

  test('a retried remove never deletes an original the failed attempt restored', async () => {
    writeFileSync(path.join(gameDir, 'a.esp'), 'original-a')
    writeFileSync(path.join(gameDir, 'b.esp'), 'original-b')
    await install(pid, 'nexus-1', { 'a.esp': 'A', 'b.esp': 'B' })
    await deployProfile(paths, game, pid, gameDir)
    await deleteProfile(paths, game.label, pid)
    let calls = 0
    const move = async (from: string, to: string): Promise<void> => {
      if (++calls === 2) throw new Error('ENOSPC')
      await fsp.rename(from, to)
    }
    await expect(removeDeployment(paths, game, gameDir, { move })).rejects.toThrow('ENOSPC')
    await removeDeployment(paths, game, gameDir)
    expect(read('a.esp')).toBe('original-a')
    expect(read('b.esp')).toBe('original-b')
    expect(existsSync(paths.deployment(game.label))).toBe(false)
    expect(existsSync(paths.deployBackup(game.label))).toBe(false)
  })

  test('a half-finished restore copy is replaced from the backup on retry', async () => {
    writeFileSync(path.join(gameDir, 'a.esp'), 'original-a')
    await install(pid, 'nexus-1', { 'a.esp': 'A' })
    await deployProfile(paths, game, pid, gameDir)
    const move = async (_from: string, to: string): Promise<void> => {
      writeFileSync(to, 'orig') // truncated copy, then the crash
      throw new Error('crash')
    }
    await expect(removeDeployment(paths, game, gameDir, { move })).rejects.toThrow('crash')
    await removeDeployment(paths, game, gameDir)
    expect(read('a.esp')).toBe('original-a')
  })

  test('deploy refuses a symlinked folder that points outside the game before moving anything', async () => {
    const outside = path.join(tmp, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'a.esp'), 'outside original')
    symlinkSync(outside, path.join(gameDir, 'Data'))
    await install(pid, 'nexus-1', { 'Data/a.esp': 'A', 'Other/b.esp': 'B' })
    await expect(deployProfile(paths, game, pid, gameDir)).rejects.toThrow(
      /outside the game folder/
    )
    expect(readFileSync(path.join(outside, 'a.esp'), 'utf8')).toBe('outside original')
    expect(readdirSync(outside)).toEqual(['a.esp'])
    expect(existsSync(paths.deployment(game.label))).toBe(false)
    expect(existsSync(paths.deployBackup(game.label))).toBe(false)
    expect(has('Other')).toBe(false)
  })

  test('on a case-insensitive folder names differing in case are one entry; the flag is stored', async () => {
    await install(pid, 'nexus-1', { 'A.ESP': 'one' })
    await install(pid, 'nexus-2', { 'a.esp': 'two' })
    await deployProfile(paths, game, pid, gameDir, { caseInsensitive: true })
    const m = JSON.parse(readFileSync(paths.deployment(game.label), 'utf8'))
    expect(m.foldCase).toBe(true)
    expect(m.files).toHaveLength(1)
    expect(m.files[0]).toMatchObject({ path: 'a.esp', mod: 'nexus-2' })
    await removeDeployment(paths, game, gameDir)
    expect(has('a.esp')).toBe(false)
  })

  test('case sensitivity is detected on the real folder and the probe is cleaned up', async () => {
    await install(pid, 'nexus-1', { 'A.ESP': 'one' })
    await deployProfile(paths, game, pid, gameDir)
    const m = JSON.parse(readFileSync(paths.deployment(game.label), 'utf8'))
    expect(typeof m.foldCase).toBe('boolean')
    expect(readdirSync(gameDir).filter((n) => n.startsWith('.HML'))).toEqual([])
  })

  test('a cross-device backup and restore keeps the original mtime', async () => {
    const orig = path.join(gameDir, 'a.esp')
    writeFileSync(orig, 'original')
    const old = new Date('2001-02-03T04:05:06Z')
    utimesSync(orig, old, old)
    await install(pid, 'nexus-1', { 'a.esp': 'A' })
    const realRename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('deploy-backup') || String(to).includes('deploy-backup')) {
        throw Object.assign(new Error('x'), { code: 'EXDEV' })
      }
      return realRename(from, to)
    })
    await deployProfile(paths, game, pid, gameDir)
    await removeDeployment(paths, game, gameDir)
    expect(read('a.esp')).toBe('original')
    expect(Math.floor(statSync(orig).mtimeMs / 1000)).toBe(old.getTime() / 1000)
  })

  test('the cross-device fallback refuses a symlink', async () => {
    const target = path.join(tmp, 'target.txt')
    writeFileSync(target, 't')
    symlinkSync(target, path.join(gameDir, 'a.esp'))
    await install(pid, 'nexus-1', { 'a.esp': 'A' })
    const realRename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('deploy-backup')) {
        throw Object.assign(new Error('x'), { code: 'EXDEV' })
      }
      return realRename(from, to)
    })
    await expect(deployProfile(paths, game, pid, gameDir)).rejects.toThrow(/symbolic link/)
    expect(readFileSync(target, 'utf8')).toBe('t')
  })

  test('in the backup phase an original and its identical-size backup keep the original', async () => {
    writeFileSync(path.join(gameDir, 'a.esp'), 'original')
    mkdirSync(paths.deployBackup(game.label), { recursive: true })
    writeFileSync(path.join(paths.deployBackup(game.label), 'a.esp'), 'original')
    writeFileSync(
      paths.deployment(game.label),
      JSON.stringify({
        formatVersion: 1,
        profileId: pid,
        deployedAt: 'x',
        gameDir,
        phase: 'backup',
        files: [{ path: 'a.esp', mod: 'nexus-1', size: -1, mtimeMs: -1, backedUp: false }],
        createdDirs: []
      })
    )
    await removeDeployment(paths, game, gameDir)
    expect(read('a.esp')).toBe('original')
    expect(existsSync(paths.deployBackup(game.label))).toBe(false)
  })

  test('copy progress is saved every 50 files so edits survive an interrupted deploy', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i++) files[`f${String(i).padStart(2, '0')}.txt`] = 'x'
    await install(pid, 'nexus-1', files)
    const real = fsp.copyFile.bind(fsp)
    let calls = 0
    vi.spyOn(fsp, 'copyFile').mockImplementation(async (...a) => {
      if (++calls === 57) throw new Error('crash')
      return real(...a)
    })
    await expect(deployProfile(paths, game, pid, gameDir)).rejects.toThrow('crash')
    vi.restoreAllMocks()
    writeFileSync(path.join(gameDir, 'f00.txt'), 'edited in game, longer')
    await removeDeployment(paths, game, gameDir)
    expect(readFileSync(path.join(paths.profileDir(game.label, pid), 'f00.txt'), 'utf8')).toBe(
      'edited in game, longer'
    )
    expect(has('f00.txt')).toBe(false)
  })

  test('remove names the missing folder and where the backups are', async () => {
    await install(pid, 'nexus-1', { 'a.esp': 'A' })
    await deployProfile(paths, game, pid, gameDir)
    rmSync(gameDir, { recursive: true })
    await expect(removeDeployment(paths, game, gameDir)).rejects.toThrow(
      `HML's backups of your original game files are kept in ${paths.deployBackup(game.label)}. Restore the game folder to ${gameDir}, then try again.`
    )
    expect(existsSync(paths.deployment(game.label))).toBe(true)
  })

  test('same-size backup with different bytes keeps both files and reports a conflict', async () => {
    writeFileSync(path.join(gameDir, 'a.esp'), 'AAAA')
    mkdirSync(paths.deployBackup(game.label), { recursive: true })
    writeFileSync(path.join(paths.deployBackup(game.label), 'a.esp'), 'BBBB')
    writeFileSync(
      paths.deployment(game.label),
      JSON.stringify({
        formatVersion: 1,
        profileId: pid,
        deployedAt: 'x',
        gameDir,
        phase: 'backup',
        files: [{ path: 'a.esp', mod: 'nexus-1', size: -1, mtimeMs: -1, backedUp: false }],
        createdDirs: []
      })
    )
    await expect(removeDeployment(paths, game, gameDir)).rejects.toThrow(/something else/)
    expect(read('a.esp')).toBe('AAAA')
    expect(readFileSync(path.join(paths.deployBackup(game.label), 'a.esp'), 'utf8')).toBe('BBBB')
    expect(existsSync(paths.deployment(game.label))).toBe(true)
  })

  test('restore checks containment before creating folders', async () => {
    const outside = path.join(tmp, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, path.join(gameDir, 'Data'))
    mkdirSync(path.join(paths.deployBackup(game.label), 'Data/sub'), { recursive: true })
    writeFileSync(path.join(paths.deployBackup(game.label), 'Data/sub/a.esp'), 'orig')
    writeFileSync(
      paths.deployment(game.label),
      JSON.stringify({
        formatVersion: 1,
        profileId: pid,
        deployedAt: 'x',
        gameDir,
        phase: 'copy',
        files: [{ path: 'Data/sub/a.esp', mod: 'nexus-1', size: 1, mtimeMs: 1, backedUp: true }],
        createdDirs: []
      })
    )
    await expect(removeDeployment(paths, game, gameDir)).rejects.toThrow(/outside the game folder/)
    expect(readdirSync(outside)).toEqual([])
  })
})
