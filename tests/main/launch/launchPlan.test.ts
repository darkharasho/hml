import { describe, test, expect } from 'vitest'
import {
  buildLaunchPlan,
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
