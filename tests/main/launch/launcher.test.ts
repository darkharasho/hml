import { EventEmitter } from 'node:events'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  detectDoorstopVersion,
  findPreloader,
  isProtonGame,
  launchWarnings,
  launch
} from '../../../src/main/launch/launcher'
import type { GameDef } from '../../../src/shared/types'

let tmp: string
let profile: string
let gameDir: string
let steamRoot: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-launch-'))
  profile = path.join(tmp, 'profile')
  gameDir = path.join(tmp, 'game')
  steamRoot = path.join(tmp, 'steam')
  await fs.mkdir(profile, { recursive: true })
  await fs.mkdir(gameDir, { recursive: true })
})
afterEach(() => fs.rm(tmp, { recursive: true, force: true }))

const game = {
  label: 'repo',
  steamAppId: '3241660',
  exeNames: ['REPO.exe'],
  loader: 'bepinex'
} as GameDef

async function writeLaunchOptions(value: string): Promise<void> {
  const dir = path.join(steamRoot, 'userdata', '1', 'config')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'localconfig.vdf'),
    `"UserLocalConfigStore"\n{\n"Software"\n{\n"Valve"\n{\n"Steam"\n{\n"apps"\n{\n"3241660"\n{\n"LaunchOptions"\t\t"${value}"\n}\n}\n}\n}\n}\n}\n`
  )
}

async function addPreloader(): Promise<void> {
  const dir = path.join(profile, 'BepInEx', 'core')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'BepInEx.Preloader.dll'), 'x')
}

describe('detectDoorstopVersion / findPreloader / isProtonGame', () => {
  test('detects doorstop 4 from [General]', async () => {
    await fs.writeFile(path.join(profile, 'doorstop_config.ini'), '[General]\nenabled=true\n')
    expect(await detectDoorstopVersion(profile)).toBe(4)
  })
  test('doorstop 3 when no [General] or no ini', async () => {
    expect(await detectDoorstopVersion(profile)).toBe(3)
    await fs.writeFile(path.join(profile, 'doorstop_config.ini'), '[UnityDoorstop]\n')
    expect(await detectDoorstopVersion(profile)).toBe(3)
  })
  test('findPreloader returns first existing or null', async () => {
    expect(await findPreloader(profile)).toBeNull()
    await addPreloader()
    expect(await findPreloader(profile)).toBe('BepInEx/core/BepInEx.Preloader.dll')
  })
  test('isProtonGame needs linux and an exe', async () => {
    expect(await isProtonGame('linux', gameDir, ['REPO.exe'])).toBe(false)
    await fs.writeFile(path.join(gameDir, 'REPO.exe'), '')
    expect(await isProtonGame('linux', gameDir, ['REPO.exe'])).toBe(true)
    expect(await isProtonGame('win32', gameDir, ['REPO.exe'])).toBe(false)
  })
})

describe('launchWarnings', () => {
  const input = (): Parameters<typeof launchWarnings>[0] => ({
    platform: 'linux',
    game,
    gameDir,
    profileDir: profile,
    steamRoot
  })

  test('proton warning when launch options missing', async () => {
    await addPreloader()
    await fs.writeFile(path.join(gameDir, 'REPO.exe'), '')
    expect(await launchWarnings(input())).toEqual(['proton-launch-options'])
    await writeLaunchOptions('-foo')
    expect(await launchWarnings(input())).toEqual(['proton-launch-options'])
  })

  test('no warning when present', async () => {
    await addPreloader()
    await fs.writeFile(path.join(gameDir, 'REPO.exe'), '')
    await writeLaunchOptions('WINEDLLOVERRIDES=winhttp=n,b %command%')
    expect(await launchWarnings(input())).toEqual([])
  })

  test('no proton warning when steamAppId is null', async () => {
    await addPreloader()
    await fs.writeFile(path.join(gameDir, 'REPO.exe'), '')
    expect(
      await launchWarnings({ ...input(), game: { ...game, steamAppId: null } as GameDef })
    ).toEqual([])
  })

  test('game-not-found, no-bepinex and loader-unsupported', async () => {
    expect(await launchWarnings({ ...input(), gameDir: null })).toEqual([
      'game-not-found',
      'no-bepinex'
    ])
    await fs.writeFile(path.join(gameDir, 'REPO.exe'), '')
    await writeLaunchOptions('WINEDLLOVERRIDES=winhttp=n,b %command%')
    expect(
      await launchWarnings({ ...input(), game: { ...game, loader: 'other' } as GameDef })
    ).toEqual(['loader-unsupported', 'no-bepinex'])
  })

  test('native-linux-unsupported when a linux game has no Proton exe', async () => {
    await addPreloader()
    expect(await launchWarnings(input())).toEqual(['native-linux-unsupported'])
    expect(await launchWarnings({ ...input(), platform: 'win32' })).toEqual([])
    await fs.writeFile(path.join(gameDir, 'REPO.exe'), '')
    await writeLaunchOptions('WINEDLLOVERRIDES=winhttp=n,b %command%')
    expect(await launchWarnings(input())).toEqual([])
  })

  test('flatpak-filesystem when Steam is the Flatpak install', async () => {
    await addPreloader()
    await fs.writeFile(path.join(gameDir, 'REPO.exe'), '')
    const flatpakRoot = path.join(
      tmp,
      '.var',
      'app',
      'com.valvesoftware.Steam',
      '.local',
      'share',
      'Steam'
    )
    steamRoot = flatpakRoot
    await writeLaunchOptions('WINEDLLOVERRIDES=winhttp=n,b %command%')
    expect(await launchWarnings(input())).toEqual(['flatpak-filesystem'])
  })
})

describe('launch', () => {
  function fakeChild(event: 'spawn' | 'error'): {
    calls: unknown[][]
    child: EventEmitter & { unref: ReturnType<typeof vi.fn> }
    fake: never
  } {
    const calls: unknown[][] = []
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const fake = ((...a: unknown[]) => {
      calls.push(a)
      queueMicrotask(() =>
        event === 'spawn'
          ? child.emit('spawn')
          : child.emit('error', new Error('spawn steam ENOENT'))
      )
      return child
    }) as never
    return { calls, child, fake }
  }

  test('copies existing files then spawns detached without shell', async () => {
    await fs.writeFile(path.join(profile, 'winhttp.dll'), 'dll')
    await fs.writeFile(path.join(profile, 'doorstop_config.ini'), 'ini')
    const { calls, child, fake } = fakeChild('spawn')
    await launch(
      {
        command: 'steam',
        args: ['-applaunch', '1'],
        copyToGameDir: ['winhttp.dll', 'doorstop_config.ini', '.doorstop_version']
      },
      profile,
      gameDir,
      fake
    )
    expect((await fs.readdir(gameDir)).sort()).toEqual(['doorstop_config.ini', 'winhttp.dll'])
    expect(calls).toEqual([
      ['steam', ['-applaunch', '1'], { detached: true, stdio: 'ignore', shell: false }]
    ])
    expect(child.unref).toHaveBeenCalled()
  })

  test('rejects when the child emits error', async () => {
    const { fake } = fakeChild('error')
    await expect(
      launch({ command: 'steam', args: [], copyToGameDir: [] }, profile, gameDir, fake)
    ).rejects.toThrow('ENOENT')
  })

  test('rejects non-basename copy entries before copying or spawning', async () => {
    await fs.writeFile(path.join(profile, 'winhttp.dll'), 'dll')
    const { calls, fake } = fakeChild('spawn')
    for (const bad of ['../x', 'a/b', 'a\\b', '..', '.']) {
      await expect(
        launch(
          { command: 'steam', args: [], copyToGameDir: ['winhttp.dll', bad] },
          profile,
          gameDir,
          fake
        )
      ).rejects.toThrow('Invalid copy entry')
    }
    expect(await fs.readdir(gameDir)).toEqual([])
    expect(calls).toEqual([])
  })
})
