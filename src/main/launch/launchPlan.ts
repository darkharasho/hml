import path from 'node:path'
import type { DoorstopVersion, LaunchMode, Runner } from '../../shared/types'

export type { DoorstopVersion, LaunchMode }

export interface LaunchInput {
  platform: 'win32' | 'linux'
  mode: LaunchMode
  steamRoot: string
  steamAppId: string
  flatpak: boolean
  proton: boolean
  profileDir: string
  preloaderRelPath: string
  doorstop: DoorstopVersion
}

/** Profile-relative paths. */
export interface LaunchPlan {
  command: string
  args: string[]
  copyToGameDir: string[]
  env?: Record<string, string>
  cwd?: string
  /** What is being started, for the spawn error message. */
  what: string
}

const DOORSTOP_FILES = ['winhttp.dll', 'doorstop_config.ini', '.doorstop_version']
const IL2CPP_PRELOADER = 'BepInEx/core/BepInEx.Unity.IL2CPP.dll'

/** '/home/u/a b' -> 'Z:\\home\\u\\a b' (Proton maps the host root to Z:). */
export function toProtonPath(p: string): string {
  return 'Z:' + p.replace(/\//g, '\\')
}

export function doorstopArgs(i: {
  mode: LaunchMode
  doorstop: DoorstopVersion
  profileDir: string
  preloaderRelPath: string
  windowsPaths: 'native' | 'proton'
  platform: 'win32' | 'linux'
}): string[] {
  const p = i.platform === 'win32' ? path.win32 : path.posix
  const enableFlag = i.doorstop === 4 ? '--doorstop-enabled' : '--doorstop-enable'
  const targetFlag = i.doorstop === 4 ? '--doorstop-target-assembly' : '--doorstop-target'
  if (i.mode === 'vanilla') return [enableFlag, 'false']

  const hostPath = (...segments: string[]): string => {
    const joined = p.join(i.profileDir, ...segments)
    return i.windowsPaths === 'proton' ? toProtonPath(joined) : joined
  }
  const args = [enableFlag, 'true', targetFlag, hostPath(...i.preloaderRelPath.split('/'))]
  if (i.doorstop === 4 && i.preloaderRelPath === IL2CPP_PRELOADER) {
    args.push(
      '--doorstop-clr-corlib-dir',
      hostPath('dotnet'),
      '--doorstop-clr-runtime-coreclr-path',
      hostPath('dotnet', 'coreclr.dll')
    )
  }
  return args
}

function steamCommand(i: {
  platform: 'win32' | 'linux'
  steamRoot: string
  steamAppId: string
  flatpak: boolean
}): { command: string; args: string[] } {
  const p = i.platform === 'win32' ? path.win32 : path.posix
  const args: string[] = []
  let command: string
  if (i.platform === 'win32') {
    command = p.join(i.steamRoot, 'steam.exe')
  } else if (i.flatpak) {
    command = 'flatpak'
    args.push('run', 'com.valvesoftware.Steam')
  } else {
    command = 'steam'
  }
  args.push('-applaunch', i.steamAppId)
  return { command, args }
}

export function buildLaunchPlan(i: LaunchInput): LaunchPlan {
  const { command, args } = steamCommand(i)
  args.push(
    ...doorstopArgs({
      mode: i.mode,
      doorstop: i.doorstop,
      profileDir: i.profileDir,
      preloaderRelPath: i.preloaderRelPath,
      windowsPaths: i.proton ? 'proton' : 'native',
      platform: i.platform
    })
  )
  return {
    command,
    args,
    copyToGameDir: i.mode === 'vanilla' ? [] : [...DOORSTOP_FILES],
    what: 'Steam'
  }
}

/** Launches a Steam game with no loader: no doorstop arguments, nothing to copy. */
export function buildSteamPlainPlan(i: {
  platform: 'win32' | 'linux'
  steamRoot: string
  steamAppId: string
  flatpak: boolean
}): LaunchPlan {
  const { command, args } = steamCommand(i)
  return { command, args, copyToGameDir: [], what: 'Steam' }
}

export interface DirectLaunchInput {
  platform: 'win32' | 'linux'
  mode: LaunchMode
  gameDir: string
  exeName: string
  runner: Runner | null
  prefixDir: string
  steamRoot: string | null
  loader: { profileDir: string; preloaderRelPath: string; doorstop: DoorstopVersion } | null
}

/** Launches a game's exe directly (Windows) or through Proton/Wine (Linux). */
export function buildDirectLaunchPlan(i: DirectLaunchInput): LaunchPlan {
  const p = i.platform === 'win32' ? path.win32 : path.posix
  const exePath = p.join(i.gameDir, i.exeName)
  const doorstop = i.loader
    ? doorstopArgs({
        mode: i.mode,
        doorstop: i.loader.doorstop,
        profileDir: i.loader.profileDir,
        preloaderRelPath: i.loader.preloaderRelPath,
        windowsPaths: i.platform === 'linux' ? 'proton' : 'native',
        platform: i.platform
      })
    : []
  const copyToGameDir = i.loader && i.mode === 'modded' ? [...DOORSTOP_FILES] : []
  const base = { copyToGameDir, cwd: i.gameDir }
  if (i.platform === 'win32') {
    return { ...base, command: exePath, args: doorstop, what: 'the game' }
  }
  if (!i.runner) throw new Error('Choose how to run this game (Proton or Wine) from the game menu.')
  if (i.runner.kind === 'proton') {
    return {
      ...base,
      command: p.join(i.runner.path, 'proton'),
      args: ['run', exePath, ...doorstop],
      env: {
        STEAM_COMPAT_DATA_PATH: i.prefixDir,
        STEAM_COMPAT_CLIENT_INSTALL_PATH: i.steamRoot ?? '',
        WINEDLLOVERRIDES: 'winhttp=n,b'
      },
      what: 'Proton'
    }
  }
  return {
    ...base,
    command: 'wine',
    args: [exePath, ...doorstop],
    env: { WINEDLLOVERRIDES: 'winhttp=n,b' },
    what: 'Wine'
  }
}
