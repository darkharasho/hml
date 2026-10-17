import { EventEmitter } from 'node:events'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  detectDoorstopVersion,
  disableDoorstopIni,
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
    expect(await launchWarnings({ ...input(), flatpakAccessGranted: false })).toEqual([
      'flatpak-filesystem'
    ])
    expect(await launchWarnings({ ...input(), flatpakAccessGranted: true })).toEqual([])
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
        copyToGameDir: ['winhttp.dll', 'doorstop_config.ini', '.doorstop_version'],
        what: 'Steam'
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

  test("returns a promise of the started program's exit", async () => {
    const { child, fake } = fakeChild('spawn')
    const { exited } = await launch(
      { command: 'game.exe', args: [], copyToGameDir: [], what: 'the game' },
      profile,
      gameDir,
      fake
    )
    let done = false
    void exited.then(() => (done = true))
    await new Promise((r) => setTimeout(r, 0))
    expect(done).toBe(false)
    child.emit('exit', 1, null)
    await exited
    expect(done).toBe(true)
  })

  test('rejects when the child emits error', async () => {
    const { fake } = fakeChild('error')
    await expect(
      launch(
        { command: 'steam', args: [], copyToGameDir: [], what: 'Steam' },
        profile,
        gameDir,
        fake
      )
    ).rejects.toThrow('Could not start Steam: spawn steam ENOENT')
  })

  test('names the file when copying into the game folder fails, and does not spawn', async () => {
    await fs.writeFile(path.join(profile, 'winhttp.dll'), 'dll')
    // A directory in the way makes the copy fail the same way a locked file would.
    await fs.mkdir(path.join(gameDir, 'winhttp.dll'))
    const { calls, fake } = fakeChild('spawn')
    const err = await launch(
      { command: 'steam', args: [], copyToGameDir: ['winhttp.dll'], what: 'Steam' },
      profile,
      gameDir,
      fake
    ).catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(
      /^Couldn't copy winhttp\.dll into the game folder\. If the game is running, close it and try again\. \(.+\)$/
    )
    expect((err as Error).message).not.toContain('Could not start Steam')
    expect((err as Error).cause).toBeInstanceOf(Error)
    expect(calls).toEqual([])
  })

  test('names the file when the game folder is read-only', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    await fs.writeFile(path.join(profile, 'winhttp.dll'), 'dll')
    await fs.chmod(gameDir, 0o555)
    try {
      await expect(
        launch(
          { command: 'steam', args: [], copyToGameDir: ['winhttp.dll'], what: 'Steam' },
          profile,
          gameDir,
          fakeChild('spawn').fake
        )
      ).rejects.toThrow(/^Couldn't copy winhttp\.dll into the game folder/)
    } finally {
      await fs.chmod(gameDir, 0o755)
    }
  })

  test('rejects non-basename copy entries before copying or spawning', async () => {
    await fs.writeFile(path.join(profile, 'winhttp.dll'), 'dll')
    const { calls, fake } = fakeChild('spawn')
    for (const bad of ['../x', 'a/b', 'a\\b', '..', '.']) {
      await expect(
        launch(
          { command: 'steam', args: [], copyToGameDir: ['winhttp.dll', bad], what: 'Steam' },
          profile,
          gameDir,
          fake
        )
      ).rejects.toThrow('Invalid copy entry')
    }
    expect(await fs.readdir(gameDir)).toEqual([])
    expect(calls).toEqual([])
  })

  test('launch writes a disabled doorstop ini into the game folder', async () => {
    await fs.writeFile(path.join(profile, 'doorstop_config.ini'), '[General]\nenabled = true')
    await fs.writeFile(path.join(profile, 'winhttp.dll'), Buffer.from([1, 2, 3, 255]))
    await launch(
      {
        command: 'steam',
        args: [],
        copyToGameDir: ['winhttp.dll', 'doorstop_config.ini'],
        what: 'Steam'
      },
      profile,
      gameDir,
      fakeChild('spawn').fake
    )
    expect(await fs.readFile(path.join(gameDir, 'doorstop_config.ini'), 'utf8')).toBe(
      '[General]\nenabled = false'
    )
    expect(await fs.readFile(path.join(gameDir, 'winhttp.dll'))).toEqual(
      Buffer.from([1, 2, 3, 255])
    )
  })

  test('launch passes cwd and merged env to spawn, creating the compat data dir', async () => {
    const prefix = path.join(tmp, 'prefix', 'deep')
    const { calls, fake } = fakeChild('spawn')
    await launch(
      {
        command: 'wine',
        args: ['x.exe'],
        copyToGameDir: [],
        cwd: gameDir,
        env: { STEAM_COMPAT_DATA_PATH: prefix, WINEDLLOVERRIDES: 'winhttp=n,b' },
        what: 'Proton'
      },
      profile,
      gameDir,
      fake
    )
    const opts = calls[0][2] as { cwd: string; env: Record<string, string> }
    expect(opts.cwd).toBe(gameDir)
    expect(opts.env.WINEDLLOVERRIDES).toBe('winhttp=n,b')
    expect(opts.env.PATH).toBe(process.env.PATH)
    expect((await fs.stat(prefix)).isDirectory()).toBe(true)
  })

  test('spawn errors name what was being started', async () => {
    await expect(
      launch(
        { command: 'wine', args: [], copyToGameDir: [], what: 'Wine' },
        profile,
        gameDir,
        fakeChild('error').fake
      )
    ).rejects.toThrow('Could not start Wine: spawn steam ENOENT')
  })
})

describe('disableDoorstopIni', () => {
  test('disableDoorstopIni turns off doorstop 3 and 4 configs only', () => {
    expect(
      disableDoorstopIni(
        '[UnityDoorstop]\nenabled=true\ntargetAssembly=BepInEx\\core\\BepInEx.Preloader.dll\n'
      )
    ).toBe('[UnityDoorstop]\nenabled=false\ntargetAssembly=BepInEx\\core\\BepInEx.Preloader.dll\n')
    expect(
      disableDoorstopIni(
        '[General]\nenabled = true\ntarget_assembly = x\n[UnityMono]\ndebug_enabled = true\n'
      )
    ).toBe('[General]\nenabled = false\ntarget_assembly = x\n[UnityMono]\ndebug_enabled = true\n')
  })
})
