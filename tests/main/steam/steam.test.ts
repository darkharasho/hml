import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  steamRootCandidates,
  findSteamRoot,
  isFlatpakSteam,
  listLibraries,
  findAppInstall,
  readLaunchOptions,
  readWinSteamPath
} from '../../../src/main/steam/steam'

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-steam-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

async function makeRoot(libs: string[]): Promise<string> {
  const root = path.join(tmp, 'Steam')
  const entries = libs.map((p, i) => `"${i + 1}" { "path" "${p}" }`).join('\n')
  await write(path.join(root, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { ${entries} }`)
  return root
}

describe('steam locator', () => {
  test('finds app in second library', async () => {
    const lib1 = path.join(tmp, 'lib1')
    const root = await makeRoot([path.join(tmp, 'lib0'), lib1])
    await fs.mkdir(path.join(tmp, 'lib0'), { recursive: true })
    await write(
      path.join(lib1, 'steamapps', 'appmanifest_3241660.acf'),
      '"AppState" { "appid" "3241660" "installdir" "REPO" }'
    )
    expect(await findAppInstall(root, '3241660')).toBe(
      path.join(lib1, 'steamapps', 'common', 'REPO')
    )
  })

  test('supports library paths with spaces', async () => {
    const lib = path.join(tmp, 'My Games', 'Steam Library')
    const root = await makeRoot([lib])
    await write(
      path.join(lib, 'steamapps', 'appmanifest_1.acf'),
      '"AppState" { "installdir" "Some Game" }'
    )
    expect(await findAppInstall(root, '1')).toBe(path.join(lib, 'steamapps', 'common', 'Some Game'))
  })

  test('supports legacy libraryfolders format and always includes root', async () => {
    const lib = path.join(tmp, 'legacy')
    await fs.mkdir(lib)
    const root = path.join(tmp, 'Steam')
    await write(
      path.join(root, 'steamapps', 'libraryfolders.vdf'),
      `"LibraryFolders" { "TimeNextStatsReport" "123" "1" "${lib}" }`
    )
    const libs = await listLibraries(root)
    expect(libs).toEqual([await fs.realpath(root), await fs.realpath(lib)])
  })

  test('deduplicates and skips missing libraries', async () => {
    const root = await makeRoot([path.join(tmp, 'Steam'), path.join(tmp, 'gone')])
    expect(await listLibraries(root)).toEqual([await fs.realpath(root)])
  })

  test('returns null when app missing', async () => {
    const root = await makeRoot([])
    expect(await findAppInstall(root, '999')).toBeNull()
  })

  test('detects flatpak root', () => {
    expect(isFlatpakSteam('/home/u/.var/app/com.valvesoftware.Steam/.local/share/Steam')).toBe(true)
    expect(isFlatpakSteam('/home/u/.local/share/Steam')).toBe(false)
  })

  test('linux candidate order', () => {
    expect(steamRootCandidates('linux', '/home/u')).toEqual([
      '/home/u/.steam/steam',
      '/home/u/.local/share/Steam',
      '/home/u/.var/app/com.valvesoftware.Steam/.local/share/Steam'
    ])
  })

  test('windows candidate order', () => {
    expect(steamRootCandidates('win32', 'C:\\Users\\u', 'D:\\Steam')).toEqual([
      'D:\\Steam',
      'C:\\Program Files (x86)\\Steam'
    ])
    expect(steamRootCandidates('win32', 'C:\\Users\\u')).toEqual(['C:\\Program Files (x86)\\Steam'])
  })

  test('findSteamRoot returns first valid candidate and collapses symlinks', async () => {
    const root = await makeRoot([])
    const link = path.join(tmp, 'link')
    await fs.symlink(root, link)
    expect(await findSteamRoot([path.join(tmp, 'nope'), link, root])).toBe(await fs.realpath(root))
    expect(await findSteamRoot([path.join(tmp, 'nope')])).toBeNull()
  })

  test('reads launch options case-insensitively', async () => {
    const root = await makeRoot([])
    await write(path.join(root, 'userdata', '111', 'config', 'localconfig.vdf'), '"broken" { "x')
    await write(
      path.join(root, 'userdata', '222', 'config', 'localconfig.vdf'),
      `"UserLocalConfigStore" { "software" { "valve" { "STEAM" { "Apps" { "3241660" { "launchoptions" "WINEDLLOVERRIDES=winhttp=n,b %command%" } } } } } }`
    )
    expect(await readLaunchOptions(root, '3241660')).toBe('WINEDLLOVERRIDES=winhttp=n,b %command%')
    expect(await readLaunchOptions(root, '5')).toBeNull()
  })
})

describe('readWinSteamPath', () => {
  const OUT =
    '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n\r\n'

  test('queries HKCU SteamPath with reg and parses REG_SZ', async () => {
    const calls: [string, string[]][] = []
    const value = await readWinSteamPath(async (file, args) => {
      calls.push([file, args])
      return { stdout: OUT }
    })
    expect(value).toBe('c:/program files (x86)/steam')
    expect(calls).toEqual([['reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']]])
  })

  test('null on failure or unexpected output', async () => {
    expect(
      await readWinSteamPath(async () => {
        throw new Error('ERROR: The system was unable to find the specified registry key')
      })
    ).toBeNull()
    expect(await readWinSteamPath(async () => ({ stdout: 'nothing here' }))).toBeNull()
    expect(
      await readWinSteamPath(async () => ({ stdout: '    SteamPath    REG_SZ    \r\n' }))
    ).toBeNull()
  })
})
