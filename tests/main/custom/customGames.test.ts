import { mkdtempSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BEPINEX_INSTALL_RULES,
  createCustomGames,
  customGameDef,
  folderLabel,
  type StoredCustomGame
} from '../../../src/main/custom/customGames'
import { makePaths, type AppPaths } from '../../../src/main/store/paths'

let tmp: string
let paths: AppPaths
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-custom-'))
  paths = makePaths(tmp)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const trash: StoredCustomGame = {
  label: 'steam-3314580',
  source: 'steam',
  displayName: 'Trash Day',
  steamAppId: '3314580',
  loaderChoice: 'bepinex5',
  exeName: 'Trash.exe',
  dataFolderName: 'Trash_Data'
}

describe('folderLabel', () => {
  it('slugs the folder name and avoids taken labels', () => {
    expect(folderLabel('Trash Day!', new Set())).toBe('custom-trash-day')
    expect(folderLabel('Trash Day!', new Set(['custom-trash-day']))).toBe('custom-trash-day-2')
    expect(folderLabel('???', new Set())).toBe('custom-game')
  })
})

describe('customGameDef', () => {
  it('maps a BepInEx Steam game', () => {
    const d = customGameDef(trash)
    expect(d).toMatchObject({
      label: 'steam-3314580',
      loader: 'bepinex',
      exeNames: ['Trash.exe'],
      packageIndex: null,
      steamFolderName: '',
      supported: true,
      custom: { source: 'steam', loaderChoice: 'bepinex5', runner: null, added: true }
    })
    expect(d.installRules).toEqual(BEPINEX_INSTALL_RULES)
    expect(d.iconUrl).toContain('/3314580/library_600x900.jpg')
  })
  it('uses a chosen cover image first, then the Steam art', () => {
    const d = customGameDef({ ...trash, cover: { ext: 'png', at: 42 } })
    expect(d.iconUrl).toBe('hml-art://custom/steam-3314580?v=42')
    expect(d.iconFallbacks).toEqual([
      'https://cdn.cloudflare.steamstatic.com/steam/apps/3314580/library_600x900.jpg'
    ])
    expect(d.custom?.image).toBe(true)
    const folder = customGameDef({
      ...trash,
      label: 'custom-x',
      source: 'folder',
      steamAppId: null,
      cover: { ext: 'jpg', at: 1 }
    })
    expect(folder.iconUrl).toBe('hml-art://custom/custom-x?v=1')
    expect(folder.iconFallbacks).toBeUndefined()
    expect(customGameDef(trash).custom?.image).toBe(false)
  })
  it('maps a no-loader game to deploy', () => {
    const d = customGameDef({ ...trash, loaderChoice: 'none' })
    expect(d.loader).toBe('deploy')
    expect(d.installRules).toEqual([])
  })
})

describe('store', () => {
  it('put, get, list and remove round-trip through custom-games.json', async () => {
    const s = createCustomGames(paths)
    expect(await s.list()).toEqual([])
    await s.put(trash)
    await s.put({ ...trash, displayName: 'Trash Night' })
    expect(await s.list()).toHaveLength(1)
    expect((await s.get('steam-3314580'))?.displayName).toBe('Trash Night')
    expect(await s.get('nope')).toBeNull()
    await s.remove('steam-3314580')
    expect(await s.list()).toEqual([])
    await expect(fs.readFile(paths.customGames, 'utf8')).resolves.toBe('[]')
  })
  it('list drops malformed entries', async () => {
    await fs.writeFile(
      paths.customGames,
      JSON.stringify([{ label: 'x' }, trash, { ...trash, label: 'steam-1', loaderChoice: 'melon' }])
    )
    expect(await createCustomGames(paths).list()).toEqual([trash])
  })
  it('list keeps a game whose cover record is malformed, without the cover', async () => {
    await fs.writeFile(
      paths.customGames,
      JSON.stringify([{ ...trash, cover: { ext: '../../x', at: 1 } }])
    )
    expect((await createCustomGames(paths).list())[0].cover).toBeUndefined()
  })
})
