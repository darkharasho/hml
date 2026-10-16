import { describe, test, expect } from 'vitest'
import {
  buildLaunchPlan,
  buildSteamPlainPlan,
  buildDirectLaunchPlan,
  type DirectLaunchInput,
  toProtonPath,
  type LaunchInput
} from '../../../src/main/launch/launchPlan'

const base: LaunchInput = {
  platform: 'linux',
  mode: 'modded',
  steamRoot: '/home/u/.steam/steam',
  steamAppId: '3241660',
  flatpak: false,
  proton: false,
  profileDir: '/home/u/profiles/p1',
  preloaderRelPath: 'BepInEx/core/BepInEx.Preloader.dll',
  doorstop: 4
}
const COPY = ['winhttp.dll', 'doorstop_config.ini', '.doorstop_version']

describe('buildLaunchPlan', () => {
  test('windows v3 modded', () => {
    const plan = buildLaunchPlan({
      ...base,
      platform: 'win32',
      steamRoot: 'C:\\Program Files (x86)\\Steam',
      profileDir: 'C:\\profiles\\p1',
      doorstop: 3
    })
    expect(plan.command).toBe('C:\\Program Files (x86)\\Steam\\steam.exe')
    expect(plan.args).toEqual([
      '-applaunch',
      '3241660',
      '--doorstop-enable',
      'true',
      '--doorstop-target',
      'C:\\profiles\\p1\\BepInEx\\core\\BepInEx.Preloader.dll'
    ])
    expect(plan.copyToGameDir).toEqual(COPY)
  })

  test('linux native v4 modded', () => {
    const plan = buildLaunchPlan(base)
    expect(plan.command).toBe('steam')
    expect(plan.args).toEqual([
      '-applaunch',
      '3241660',
      '--doorstop-enabled',
      'true',
      '--doorstop-target-assembly',
      '/home/u/profiles/p1/BepInEx/core/BepInEx.Preloader.dll'
    ])
    expect(plan.copyToGameDir).toEqual(COPY)
  })

  test('flatpak command', () => {
    const plan = buildLaunchPlan({ ...base, flatpak: true })
    expect(plan.command).toBe('flatpak')
    expect(plan.args.slice(0, 4)).toEqual([
      'run',
      'com.valvesoftware.Steam',
      '-applaunch',
      '3241660'
    ])
  })

  test('vanilla v4 disables and copies nothing', () => {
    const plan = buildLaunchPlan({ ...base, mode: 'vanilla' })
    expect(plan.args).toEqual(['-applaunch', '3241660', '--doorstop-enabled', 'false'])
    expect(plan.copyToGameDir).toEqual([])
  })

  test('vanilla v3 uses the v3 flag', () => {
    const plan = buildLaunchPlan({ ...base, mode: 'vanilla', doorstop: 3 })
    expect(plan.args).toEqual(['-applaunch', '3241660', '--doorstop-enable', 'false'])
  })

  test('proton target path with spaces', () => {
    const plan = buildLaunchPlan({
      ...base,
      proton: true,
      profileDir: '/home/u/.config/HML/games/repo/profiles/my pack'
    })
    expect(plan.args).toContain(
      'Z:\\home\\u\\.config\\HML\\games\\repo\\profiles\\my pack\\BepInEx\\core\\BepInEx.Preloader.dll'
    )
    expect(plan.args).toHaveLength(6)
  })
})

describe('IL2CPP doorstop 4', () => {
  const IL2CPP = 'BepInEx/core/BepInEx.Unity.IL2CPP.dll'

  test('linux native passes the coreclr dirs', () => {
    const plan = buildLaunchPlan({ ...base, preloaderRelPath: IL2CPP })
    expect(plan.args).toEqual([
      '-applaunch',
      '3241660',
      '--doorstop-enabled',
      'true',
      '--doorstop-target-assembly',
      '/home/u/profiles/p1/BepInEx/core/BepInEx.Unity.IL2CPP.dll',
      '--doorstop-clr-corlib-dir',
      '/home/u/profiles/p1/dotnet',
      '--doorstop-clr-runtime-coreclr-path',
      '/home/u/profiles/p1/dotnet/coreclr.dll'
    ])
  })

  test('windows uses windows paths', () => {
    const plan = buildLaunchPlan({
      ...base,
      platform: 'win32',
      steamRoot: 'C:\\Steam',
      profileDir: 'C:\\profiles\\p1',
      preloaderRelPath: IL2CPP
    })
    expect(plan.args.slice(-4)).toEqual([
      '--doorstop-clr-corlib-dir',
      'C:\\profiles\\p1\\dotnet',
      '--doorstop-clr-runtime-coreclr-path',
      'C:\\profiles\\p1\\dotnet\\coreclr.dll'
    ])
  })

  test('proton uses Z: paths', () => {
    const plan = buildLaunchPlan({
      ...base,
      proton: true,
      profileDir: '/home/u/HML/my pack',
      preloaderRelPath: IL2CPP
    })
    expect(plan.args.slice(-4)).toEqual([
      '--doorstop-clr-corlib-dir',
      'Z:\\home\\u\\HML\\my pack\\dotnet',
      '--doorstop-clr-runtime-coreclr-path',
      'Z:\\home\\u\\HML\\my pack\\dotnet\\coreclr.dll'
    ])
  })

  test('not added for doorstop 3, Mono preloaders, or vanilla', () => {
    expect(buildLaunchPlan({ ...base, preloaderRelPath: IL2CPP, doorstop: 3 }).args).toHaveLength(6)
    expect(
      buildLaunchPlan({
        ...base,
        preloaderRelPath: 'BepInEx/core/BepInEx.Unity.Mono.Preloader.dll'
      }).args
    ).toHaveLength(6)
    expect(buildLaunchPlan({ ...base, preloaderRelPath: IL2CPP, mode: 'vanilla' }).args).toEqual([
      '-applaunch',
      '3241660',
      '--doorstop-enabled',
      'false'
    ])
  })
})

describe('toProtonPath', () => {
  test('converts posix to Z: path', () => {
    expect(toProtonPath('/home/u/a b')).toBe('Z:\\home\\u\\a b')
  })
})

describe('buildSteamPlainPlan', () => {
  test('buildSteamPlainPlan launches the app with no doorstop arguments', () => {
    expect(
      buildSteamPlainPlan({
        platform: 'linux',
        steamRoot: '/s',
        steamAppId: '3314580',
        flatpak: false
      })
    ).toEqual({
      command: 'steam',
      args: ['-applaunch', '3314580'],
      copyToGameDir: [],
      what: 'Steam'
    })
  })
})

describe('buildLaunchPlan what', () => {
  test('is Steam', () => {
    expect(buildLaunchPlan(base).what).toBe('Steam')
  })
})

describe('buildDirectLaunchPlan', () => {
  const PRE = 'BepInEx/core/BepInEx.Preloader.dll'
  const direct: DirectLaunchInput = {
    platform: 'linux',
    mode: 'modded',
    gameDir: '/g',
    exeName: 'X.exe',
    runner: { kind: 'wine' },
    prefixDir: '/h/prefix',
    steamRoot: '/s',
    loader: { profileDir: '/h/p', preloaderRelPath: PRE, doorstop: 4 }
  }

  test('direct Windows launch runs the exe with doorstop arguments', () => {
    const plan = buildDirectLaunchPlan({
      ...direct,
      platform: 'win32',
      runner: null,
      gameDir: 'C:\\Games\\X',
      loader: { profileDir: 'C:\\hml\\p', preloaderRelPath: PRE, doorstop: 4 }
    })
    expect(plan.command).toBe('C:\\Games\\X\\X.exe')
    expect(plan.args).toEqual([
      '--doorstop-enabled',
      'true',
      '--doorstop-target-assembly',
      'C:\\hml\\p\\BepInEx\\core\\BepInEx.Preloader.dll'
    ])
    expect(plan.cwd).toBe('C:\\Games\\X')
    expect(plan.copyToGameDir).toEqual(COPY)
    expect(plan.what).toBe('the game')
  })

  test('direct Proton launch uses proton run with an HML prefix and winhttp override', () => {
    const plan = buildDirectLaunchPlan({
      ...direct,
      runner: { kind: 'proton', name: 'Proton 9.0', path: '/s/steamapps/common/Proton 9.0' }
    })
    expect(plan.command).toBe('/s/steamapps/common/Proton 9.0/proton')
    expect(plan.args.slice(0, 2)).toEqual(['run', '/g/X.exe'])
    expect(plan.args).toContain('Z:\\h\\p\\BepInEx\\core\\BepInEx.Preloader.dll')
    expect(plan.env).toEqual({
      STEAM_COMPAT_DATA_PATH: '/h/prefix',
      STEAM_COMPAT_CLIENT_INSTALL_PATH: '/s',
      WINEDLLOVERRIDES: 'winhttp=n,b'
    })
    expect(plan.cwd).toBe('/g')
    expect(plan.what).toBe('Proton')
  })

  test('direct Wine launch sets only the winhttp override', () => {
    const plan = buildDirectLaunchPlan(direct)
    expect(plan.command).toBe('wine')
    expect(plan.env).toEqual({ WINEDLLOVERRIDES: 'winhttp=n,b' })
    expect(plan.what).toBe('Wine')
  })

  test('a vanilla direct launch disables doorstop and copies nothing', () => {
    const plan = buildDirectLaunchPlan({
      ...direct,
      mode: 'vanilla',
      loader: { profileDir: '/h/p', preloaderRelPath: PRE, doorstop: 3 }
    })
    expect(plan.args.slice(-2)).toEqual(['--doorstop-enable', 'false'])
    expect(plan.copyToGameDir).toEqual([])
  })

  test('a no-loader direct launch has no doorstop arguments', () => {
    const plan = buildDirectLaunchPlan({ ...direct, loader: null })
    expect(plan.args).toEqual(['/g/X.exe'])
    expect(plan.copyToGameDir).toEqual([])
  })

  test('direct launch on Linux without a runner throws', () => {
    expect(() => buildDirectLaunchPlan({ ...direct, runner: null })).toThrow(
      'Choose how to run this game (Proton or Wine) from the game menu.'
    )
  })
})
