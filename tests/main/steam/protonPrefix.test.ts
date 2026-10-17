import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  addWinhttpOverride,
  ensureWinhttpOverride,
  findProtonUserReg,
  hasWinhttpOverride
} from '../../../src/main/steam/protonPrefix'

const REG = [
  'WINE REGISTRY Version 2',
  ';; All keys relative to REGISTRY\\\\User\\\\S-1-5-21-0-0-1000-1000',
  '',
  '#arch=win64',
  '',
  '[Software\\\\Wine\\\\AppDefaults\\\\Game.exe\\\\DllOverrides] 1769265482',
  '#time=1dc8d3f0b75c2f8',
  '"winhttp"="builtin"',
  '',
  '[Software\\\\Wine\\\\DllOverrides] 1769265482',
  '#time=1dc8d3f0b759fee',
  '"api-ms-win-crt-heap-l1-1-0"="native,builtin"',
  '"d3d11"="native"',
  '',
  '[Software\\\\Wine\\\\Drivers] 1769265482',
  '"Audio"="pulse"',
  ''
].join('\n')

describe('hasWinhttpOverride', () => {
  test('reads only the prefix-wide DllOverrides section', () => {
    // The AppDefaults section's builtin winhttp is a different key.
    expect(hasWinhttpOverride(REG)).toBe(false)
  })

  test('accepts native-first values, case-insensitively', () => {
    for (const v of ['native,builtin', 'n,b', 'native', 'Native, Builtin']) {
      const reg = REG.replace('"d3d11"="native"', `"WinHttp"="${v}"`)
      expect(hasWinhttpOverride(reg)).toBe(true)
    }
    expect(hasWinhttpOverride(REG.replace('"d3d11"="native"', '"winhttp"="builtin,native"'))).toBe(
      false
    )
  })

  test('is false without a DllOverrides section', () => {
    expect(hasWinhttpOverride('WINE REGISTRY Version 2\n')).toBe(false)
  })
})

describe('addWinhttpOverride', () => {
  test('adds the line after the section header and its #time line, touching nothing else', () => {
    const out = addWinhttpOverride(REG, 1800000000)
    expect(out).toBe(
      REG.replace('#time=1dc8d3f0b759fee\n', '#time=1dc8d3f0b759fee\n"winhttp"="native,builtin"\n')
    )
    expect(hasWinhttpOverride(out)).toBe(true)
  })

  test('replaces a builtin winhttp value in place', () => {
    const reg = REG.replace('"d3d11"="native"', '"winhttp"="builtin"')
    const out = addWinhttpOverride(reg, 1800000000)
    expect(out).toBe(REG.replace('"d3d11"="native"', '"winhttp"="native,builtin"'))
  })

  test('leaves a file that already has it unchanged', () => {
    const reg = REG.replace('"d3d11"="native"', '"winhttp"="n,b"')
    expect(addWinhttpOverride(reg, 1800000000)).toBe(reg)
  })

  test('creates the section when the prefix has none', () => {
    const out = addWinhttpOverride('WINE REGISTRY Version 2\n', 1800000000)
    expect(out).toBe(
      'WINE REGISTRY Version 2\n\n[Software\\\\Wine\\\\DllOverrides] 1800000000\n"winhttp"="native,builtin"\n'
    )
    expect(hasWinhttpOverride(out)).toBe(true)
  })

  test('keeps CRLF-free text intact around a section at the very end', () => {
    const reg = '[Software\\\\Wine\\\\DllOverrides] 1\n"x"="native"'
    expect(addWinhttpOverride(reg, 2)).toBe(
      '[Software\\\\Wine\\\\DllOverrides] 1\n"winhttp"="native,builtin"\n"x"="native"'
    )
  })
})

describe('the prefix on disk', () => {
  let tmp: string
  let root: string
  let lib: string
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-prefix-'))
    root = path.join(tmp, 'steam')
    lib = path.join(tmp, 'games')
    await fs.mkdir(path.join(root, 'steamapps'), { recursive: true })
    await fs.mkdir(path.join(lib, 'steamapps'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders" { "0" { "path" "${root}" } "1" { "path" "${lib}" } }`
    )
    await fs.writeFile(
      path.join(lib, 'steamapps', 'appmanifest_123.acf'),
      '"AppState" { "installdir" "Game" }'
    )
  })
  afterEach(() => fs.rm(tmp, { recursive: true, force: true }))

  const regIn = (base: string): string =>
    path.join(base, 'steamapps', 'compatdata', '123', 'pfx', 'user.reg')
  async function writeReg(base: string, text = REG): Promise<string> {
    const file = regIn(base)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
    return file
  }

  test('finds the prefix in the library the game is installed in', async () => {
    await writeReg(root)
    const inLib = await writeReg(lib)
    expect(await findProtonUserReg(root, '123')).toBe(await fs.realpath(inLib))
  })

  test('falls back to another library, and is null before the first launch', async () => {
    expect(await findProtonUserReg(root, '123')).toBeNull()
    const inRoot = await writeReg(root)
    expect(await findProtonUserReg(root, '123')).toBe(await fs.realpath(inRoot))
  })

  test('refuses a non-numeric app id', async () => {
    await expect(findProtonUserReg(root, '../x')).rejects.toThrow('Invalid Steam app id')
  })

  test('ensureWinhttpOverride writes once, keeps a backup, then reports already-set', async () => {
    expect(await ensureWinhttpOverride(root, '123', 1800000000)).toBe('no-prefix')
    const file = await writeReg(lib)
    expect(await ensureWinhttpOverride(root, '123', 1800000000)).toBe('set')
    expect(hasWinhttpOverride(await fs.readFile(file, 'utf8'))).toBe(true)
    expect(await fs.readFile(`${file}.hml-backup`, 'utf8')).toBe(REG)
    expect(await ensureWinhttpOverride(root, '123', 1800000000)).toBe('already-set')
    expect((await fs.readdir(path.dirname(file))).sort()).toEqual([
      'user.reg',
      'user.reg.hml-backup'
    ])
  })
})
