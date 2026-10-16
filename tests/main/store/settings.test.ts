import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makePaths } from '../../../src/main/store/paths'
import { loadSettings, saveSettings, resolveGameDir } from '../../../src/main/store/settings'
import type { GameDef, Settings } from '../../../src/shared/types'

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-settings-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

function game(overrides: Partial<GameDef> = {}): GameDef {
  return {
    label: 'repo',
    displayName: 'R.E.P.O.',
    steamAppId: '3241660',
    steamFolderName: 'REPO',
    exeNames: ['REPO.exe'],
    dataFolderName: 'REPO_Data',
    loader: 'bepinex',
    installRules: [],
    packageIndex: null,
    searchStrings: [],
    iconUrl: null,
    supported: true,
    ...overrides
  }
}

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

async function makeSteamRoot(libs: string[]): Promise<string> {
  const root = path.join(tmp, 'Steam')
  const entries = libs.map((p, i) => `"${i + 1}" { "path" "${p}" }`).join('\n')
  await write(path.join(root, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { ${entries} }`)
  return root
}

describe('settings store', () => {
  test('defaults when file missing', async () => {
    const paths = makePaths(path.join(tmp, 'data'))
    expect(await loadSettings(paths)).toEqual({
      gamePathOverrides: {},
      steamRootOverride: null,
      lastGame: null,
      lastProfile: {},
      nexusDomainOverrides: {}
    })
  })

  test('round-trips', async () => {
    const paths = makePaths(path.join(tmp, 'data'))
    const s: Settings = {
      gamePathOverrides: { repo: '/games/repo' },
      steamRootOverride: '/opt/steam',
      lastGame: 'repo',
      lastProfile: { repo: 'default' },
      nexusDomainOverrides: {}
    }
    await saveSettings(paths, s)
    expect(await loadSettings(paths)).toEqual(s)
  })

  test('stored fields of the wrong type fall back to defaults field by field', async () => {
    const paths = makePaths(path.join(tmp, 'data'))
    await write(
      paths.settings,
      JSON.stringify({
        gamePathOverrides: 'not-an-object',
        steamRootOverride: 42,
        lastGame: 'repo',
        lastProfile: ['nope']
      })
    )
    expect(await loadSettings(paths)).toEqual({
      gamePathOverrides: {},
      steamRootOverride: null,
      lastGame: 'repo',
      lastProfile: {},
      nexusDomainOverrides: {}
    })
  })

  test('corrupt settings file yields defaults', async () => {
    const paths = makePaths(path.join(tmp, 'data'))
    await write(paths.settings, '{ not json')
    expect(await loadSettings(paths)).toEqual({
      gamePathOverrides: {},
      steamRootOverride: null,
      lastGame: null,
      lastProfile: {},
      nexusDomainOverrides: {}
    })
  })
})

describe('resolveGameDir', () => {
  const empty: Settings = {
    gamePathOverrides: {},
    steamRootOverride: null,
    lastGame: null,
    lastProfile: {},
    nexusDomainOverrides: {}
  }

  test('override beats steam detection', async () => {
    const lib = path.join(tmp, 'lib')
    const root = await makeSteamRoot([lib])
    await write(
      path.join(lib, 'steamapps', 'appmanifest_3241660.acf'),
      '"AppState" { "appid" "3241660" "installdir" "REPO" }'
    )
    const override = path.join(tmp, 'custom-repo')
    await fs.mkdir(override)
    const settings: Settings = { ...empty, gamePathOverrides: { repo: override } }
    expect(await resolveGameDir(game(), settings, root)).toBe(override)
  })

  test('nonexistent override falls through to steam detection', async () => {
    const lib = path.join(tmp, 'lib')
    const root = await makeSteamRoot([lib])
    await write(
      path.join(lib, 'steamapps', 'appmanifest_3241660.acf'),
      '"AppState" { "appid" "3241660" "installdir" "REPO" }'
    )
    const settings: Settings = {
      ...empty,
      gamePathOverrides: { repo: path.join(tmp, 'does-not-exist') }
    }
    expect(await resolveGameDir(game(), settings, root)).toBe(
      path.join(lib, 'steamapps', 'common', 'REPO')
    )
  })

  test('steam detection used when no override', async () => {
    const lib = path.join(tmp, 'lib')
    const root = await makeSteamRoot([lib])
    await write(
      path.join(lib, 'steamapps', 'appmanifest_3241660.acf'),
      '"AppState" { "appid" "3241660" "installdir" "REPO" }'
    )
    expect(await resolveGameDir(game(), empty, root)).toBe(
      path.join(lib, 'steamapps', 'common', 'REPO')
    )
  })

  test('returns null with no override, no steamAppId, or no steam root', async () => {
    const root = await makeSteamRoot([])
    expect(await resolveGameDir(game(), empty, root)).toBeNull()
    expect(await resolveGameDir(game({ steamAppId: null }), empty, root)).toBeNull()
    expect(await resolveGameDir(game(), empty, null)).toBeNull()
  })
})
