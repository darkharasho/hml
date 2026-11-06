import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makePaths, type AppPaths } from '../../../src/main/store/paths'
import { createProfile, getProfile, saveProfile } from '../../../src/main/profiles/profiles'
import { copyMods } from '../../../src/main/profiles/copyMods'
import type { InstalledMod } from '../../../src/shared/types'

const GAME = 'repo'
let tmp: string
let paths: AppPaths

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-copymods-'))
  paths = makePaths(tmp)
  await createProfile(paths, GAME, 'From')
  await createProfile(paths, GAME, 'To')
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const dir = (id: string): string => paths.profileDir(GAME, id)
const write = async (id: string, rel: string, text: string): Promise<void> => {
  const abs = path.join(dir(id), rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, text)
}
const read = (id: string, rel: string): Promise<string> =>
  fs.readFile(path.join(dir(id), rel), 'utf8')
const exists = (id: string, rel: string): Promise<boolean> =>
  fs.access(path.join(dir(id), rel)).then(
    () => true,
    () => false
  )

const DLL = 'BepInEx/plugins/Author-Cool/Cool.dll'
const README = 'BepInEx/plugins/Author-Cool/README.md'
const CFG = 'BepInEx/config/com.author.Cool.cfg'

function mod(over: Partial<InstalledMod> = {}): InstalledMod {
  return {
    id: 'Author-Cool',
    name: 'Cool',
    version: '1.2.0',
    source: { kind: 'thunderstore', fullName: 'Author-Cool' } as InstalledMod['source'],
    enabled: true,
    files: [DLL, README],
    disableable: [DLL],
    installedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

async function setMods(id: string, mods: InstalledMod[]): Promise<void> {
  await saveProfile(paths, { ...(await getProfile(paths, GAME, id)), mods })
}

describe('copyMods', () => {
  test('copies the files, the entry and the config at the same version, enabled', async () => {
    await write('from', DLL, 'dll v1.2')
    await write('from', README, 'readme')
    await write('from', CFG, 'speed = 2')
    await setMods('from', [mod({ held: true })])

    const result = await copyMods(paths, GAME, 'from', 'to', ['Author-Cool'])
    expect(result).toEqual({ copied: ['Author-Cool'], replaced: [], configs: 1 })
    expect(await read('to', DLL)).toBe('dll v1.2')
    expect(await read('to', README)).toBe('readme')
    expect(await read('to', CFG)).toBe('speed = 2')
    const [copied] = (await getProfile(paths, GAME, 'to')).mods
    expect(copied).toMatchObject({
      id: 'Author-Cool',
      version: '1.2.0',
      enabled: true,
      held: true,
      files: [DLL, README],
      disableable: [DLL]
    })
    // The source is untouched.
    expect((await getProfile(paths, GAME, 'from')).mods).toHaveLength(1)
  })

  test("a disabled source mod's files are copied under their real names and turned on", async () => {
    await write('from', DLL + '.old', 'dll')
    await write('from', README, 'readme')
    await setMods('from', [mod({ enabled: false })])

    await copyMods(paths, GAME, 'from', 'to', ['Author-Cool'])
    expect(await read('to', DLL)).toBe('dll')
    expect(await exists('to', DLL + '.old')).toBe(false)
    expect((await getProfile(paths, GAME, 'to')).mods[0].enabled).toBe(true)
  })

  test("replacing keeps the target's on/off state and its own config", async () => {
    await write('from', DLL, 'dll v1.2')
    await write('from', README, 'new readme')
    await write('from', CFG, 'speed = 2')
    await setMods('from', [mod()])
    await write('to', DLL + '.old', 'dll v1.0')
    await write('to', README, 'old readme')
    await write('to', CFG, 'speed = 9')
    await setMods('to', [mod({ version: '1.0.0', enabled: false })])

    const result = await copyMods(paths, GAME, 'from', 'to', ['Author-Cool'])
    expect(result).toEqual({ copied: ['Author-Cool'], replaced: ['Author-Cool'], configs: 0 })
    expect(await read('to', DLL + '.old')).toBe('dll v1.2')
    expect(await exists('to', DLL)).toBe(false)
    expect(await read('to', README)).toBe('old readme')
    expect(await read('to', CFG)).toBe('speed = 9')
    const mods = (await getProfile(paths, GAME, 'to')).mods
    expect(mods).toHaveLength(1)
    expect(mods[0]).toMatchObject({ version: '1.2.0', enabled: false })
  })

  test('copies dependencies alongside, keeping the other mods of the target', async () => {
    const dep = mod({
      id: 'Lib-Core',
      name: 'Core',
      version: '3.0.0',
      source: { kind: 'thunderstore', fullName: 'Lib-Core' } as InstalledMod['source'],
      files: ['BepInEx/plugins/Lib-Core/Core.dll'],
      disableable: ['BepInEx/plugins/Lib-Core/Core.dll']
    })
    const other = mod({ id: 'Other-Thing', name: 'Thing', files: [], disableable: [] })
    await write('from', DLL, 'dll')
    await write('from', 'BepInEx/plugins/Lib-Core/Core.dll', 'core')
    await setMods('from', [mod(), dep])
    await setMods('to', [other])

    await copyMods(paths, GAME, 'from', 'to', ['Author-Cool', 'Lib-Core'])
    expect(await read('to', 'BepInEx/plugins/Lib-Core/Core.dll')).toBe('core')
    expect((await getProfile(paths, GAME, 'to')).mods.map((m) => m.id)).toEqual([
      'Other-Thing',
      'Author-Cool',
      'Lib-Core'
    ])
  })

  test('refuses the same profile, a missing mod, and paths outside the profile', async () => {
    await setMods('from', [mod({ files: ['../../escape.dll'], disableable: [] })])
    await expect(copyMods(paths, GAME, 'from', 'from', ['Author-Cool'])).rejects.toThrow(
      'different profile'
    )
    await expect(copyMods(paths, GAME, 'from', 'to', ['Nope'])).rejects.toThrow(
      "Nope isn't installed in From."
    )
    await copyMods(paths, GAME, 'from', 'to', ['Author-Cool'])
    expect((await getProfile(paths, GAME, 'to')).mods[0].files).toEqual([])
    await expect(fs.access(path.join(tmp, 'escape.dll'))).rejects.toThrow()
  })
})
