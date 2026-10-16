import path from 'node:path'
import type { DoorstopVersion, LaunchMode } from '../../shared/types'

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
}

const DOORSTOP_FILES = ['winhttp.dll', 'doorstop_config.ini', '.doorstop_version']
const IL2CPP_PRELOADER = 'BepInEx/core/BepInEx.Unity.IL2CPP.dll'

/** '/home/u/a b' -> 'Z:\\home\\u\\a b' (Proton maps the host root to Z:). */
export function toProtonPath(p: string): string {
  return 'Z:' + p.replace(/\//g, '\\')
}

export function buildLaunchPlan(i: LaunchInput): LaunchPlan {
  const p = i.platform === 'win32' ? path.win32 : path.posix
  let command: string
  const args: string[] = []
  if (i.platform === 'win32') {
    command = p.join(i.steamRoot, 'steam.exe')
  } else if (i.flatpak) {
    command = 'flatpak'
    args.push('run', 'com.valvesoftware.Steam')
  } else {
    command = 'steam'
  }
  args.push('-applaunch', i.steamAppId)

  const enableFlag = i.doorstop === 4 ? '--doorstop-enabled' : '--doorstop-enable'
  const targetFlag = i.doorstop === 4 ? '--doorstop-target-assembly' : '--doorstop-target'

  if (i.mode === 'vanilla') {
    args.push(enableFlag, 'false')
    return { command, args, copyToGameDir: [] }
  }

  const hostPath = (...segments: string[]): string => {
    const joined = p.join(i.profileDir, ...segments)
    return i.proton ? toProtonPath(joined) : joined
  }
  args.push(enableFlag, 'true', targetFlag, hostPath(...i.preloaderRelPath.split('/')))
  if (i.doorstop === 4 && i.preloaderRelPath === IL2CPP_PRELOADER) {
    args.push(
      '--doorstop-clr-corlib-dir',
      hostPath('dotnet'),
      '--doorstop-clr-runtime-coreclr-path',
      hostPath('dotnet', 'coreclr.dll')
    )
  }
  return { command, args, copyToGameDir: [...DOORSTOP_FILES] }
}
