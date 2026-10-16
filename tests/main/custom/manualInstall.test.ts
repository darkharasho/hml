import { mkdtempSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backupStamp, findManualLoader, moveToBackup } from '../../../src/main/custom/manualInstall'

let tmp: string
let game: string
let backup: string
beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-manual-'))
  game = path.join(tmp, 'game')
  backup = path.join(tmp, 'backup', 'stamp')
  await fs.mkdir(path.join(game, 'BepInEx', 'plugins'), { recursive: true })
  await fs.writeFile(path.join(game, 'BepInEx', 'plugins', 'a.dll'), 'dll')
  for (const f of ['winhttp.dll', 'doorstop_config.ini', 'changelog.txt', 'Trash.exe']) {
    await fs.writeFile(path.join(game, f), f)
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

const names = (): Promise<string[]> => fs.readdir(game).then((l) => l.sort())

describe('findManualLoader', () => {
  it('finds a hand-installed BepInEx and its doorstop files', async () => {
    expect(await findManualLoader(game)).toEqual([
      'BepInEx',
      'changelog.txt',
      'doorstop_config.ini',
      'winhttp.dll'
    ])
  })
  it('doorstop files without a BepInEx folder are not a manual install', async () => {
    await fs.rm(path.join(game, 'BepInEx'), { recursive: true })
    expect(await findManualLoader(game)).toBeNull()
  })
})

describe('moveToBackup', () => {
  it('moves everything and keeps the files', async () => {
    const entries = (await findManualLoader(game))!
    expect(await moveToBackup(game, entries, backup)).toBe(backup)
    expect(await names()).toEqual(['Trash.exe'])
    expect(await fs.readFile(path.join(backup, 'BepInEx', 'plugins', 'a.dll'), 'utf8')).toBe('dll')
    expect(await fs.readFile(path.join(backup, 'winhttp.dll'), 'utf8')).toBe('winhttp.dll')
  })
  it('works when rename would cross devices', async () => {
    const rename = vi
      .spyOn(fs, 'rename')
      .mockRejectedValue(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }))
    await moveToBackup(game, (await findManualLoader(game))!, backup)
    expect(rename).not.toHaveBeenCalled()
    expect(await names()).toEqual(['Trash.exe'])
    expect(await fs.readFile(path.join(backup, 'BepInEx', 'plugins', 'a.dll'), 'utf8')).toBe('dll')
  })
  it('leaves the game folder untouched when a copy fails', async () => {
    const entries = (await findManualLoader(game))!
    const before = await names()
    const real = fs.cp.bind(fs)
    let n = 0
    vi.spyOn(fs, 'cp').mockImplementation(async (...a: Parameters<typeof fs.cp>) => {
      if (++n === 2) throw new Error('disk full')
      return real(...a)
    })
    await expect(moveToBackup(game, entries, backup)).rejects.toThrow('disk full')
    expect(await names()).toEqual(before)
    await expect(fs.stat(backup)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses entries outside the manual-loader list', async () => {
    await fs.mkdir(path.join(game, 'Trash_Data'))
    await expect(moveToBackup(game, ['BepInEx', 'Trash_Data'], backup)).rejects.toThrow()
    await expect(moveToBackup(game, ['../x'], backup)).rejects.toThrow()
    expect(await names()).toContain('BepInEx')
    expect(await names()).toContain('Trash_Data')
  })
})

describe('backupStamp', () => {
  it('formats local time', () => {
    expect(backupStamp(new Date(2026, 9, 16, 9, 5, 7))).toBe('2026-10-16-090507')
  })
})
