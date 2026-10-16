import { spawn as nodeSpawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DoorstopVersion, GameDef, LaunchWarning, Runner } from '../../shared/types'
import { isFlatpakSteam, readLaunchOptions } from '../steam/steam'
import type { LaunchPlan } from './launchPlan'

export const NATIVE_LINUX_UNSUPPORTED =
  "Native Linux games aren't supported for modded launch yet. Force Proton for this game in Steam (Properties → Compatibility)."

const PRELOADERS = [
  'BepInEx/core/BepInEx.Preloader.dll',
  'BepInEx/core/BepInEx.Unity.Mono.Preloader.dll',
  'BepInEx/core/BepInEx.Unity.IL2CPP.dll'
]

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function detectDoorstopVersion(profileDir: string): Promise<DoorstopVersion> {
  try {
    const ini = await fs.readFile(path.join(profileDir, 'doorstop_config.ini'), 'utf8')
    return /^\s*\[General\]\s*$/m.test(ini) ? 4 : 3
  } catch {
    return 3
  }
}

export async function findPreloader(profileDir: string): Promise<string | null> {
  for (const rel of PRELOADERS) {
    if (await exists(path.join(profileDir, ...rel.split('/')))) return rel
  }
  return null
}

export async function isProtonGame(
  platform: 'win32' | 'linux',
  gameDir: string,
  exeNames: string[]
): Promise<boolean> {
  if (platform !== 'linux') return false
  for (const exe of exeNames) {
    if (exe.toLowerCase().endsWith('.exe') && (await exists(path.join(gameDir, exe)))) return true
  }
  return false
}

export async function launchWarnings(input: {
  platform: 'win32' | 'linux'
  game: GameDef
  gameDir: string | null
  profileDir: string
  steamRoot: string
  /** True when a Flatpak override already lets Steam read HML's folder (see flatpakGrantsAccess). */
  flatpakAccessGranted?: boolean
  /** A folder game HML starts itself (no Steam), with its runner on Linux. */
  direct?: { runner: Runner | null }
  /** The profile's BepInEx isn't the one the game is set to. */
  loaderMismatch?: boolean
}): Promise<LaunchWarning[]> {
  if (input.direct) {
    // None of the Steam checks apply; the runner runs the .exe on Linux.
    const warnings: LaunchWarning[] = []
    if (input.gameDir === null) warnings.push('game-not-found')
    if (input.game.loader === 'bepinex') {
      if ((await findPreloader(input.profileDir)) === null) warnings.push('no-bepinex')
      if (input.loaderMismatch) warnings.push('loader-mismatch')
    }
    if (input.platform === 'linux' && input.direct.runner === null) warnings.push('no-runner')
    return warnings
  }
  // HML doesn't launch deploy games, so none of the launch checks apply.
  if (input.game.loader === 'deploy') return input.gameDir === null ? ['game-not-found'] : []
  const warnings: LaunchWarning[] = []
  if (input.gameDir === null) warnings.push('game-not-found')
  if (input.game.loader !== 'bepinex') warnings.push('loader-unsupported')
  if ((await findPreloader(input.profileDir)) === null) warnings.push('no-bepinex')
  if (input.loaderMismatch) warnings.push('loader-mismatch')
  if (input.gameDir !== null) {
    const proton = await isProtonGame(input.platform, input.gameDir, input.game.exeNames)
    if (input.platform === 'linux' && !proton) warnings.push('native-linux-unsupported')
    if (proton && input.game.steamAppId) {
      const opts = await readLaunchOptions(input.steamRoot, input.game.steamAppId)
      if (!opts || !opts.includes('winhttp=n,b')) warnings.push('proton-launch-options')
    }
  }
  if (
    input.platform === 'linux' &&
    isFlatpakSteam(input.steamRoot) &&
    !input.flatpakAccessGranted
  ) {
    warnings.push('flatpak-filesystem')
  }
  return warnings
}

/** Turns doorstop off in a config (v3 or v4) so a plain Steam launch loads nothing. */
export function disableDoorstopIni(text: string): string {
  return text.replace(/^(\s*enabled\s*=\s*)true\b/gim, '$1false')
}

export async function launch(
  plan: LaunchPlan,
  profileDir: string,
  gameDir: string,
  spawnFn: typeof nodeSpawn = nodeSpawn
): Promise<void> {
  for (const rel of plan.copyToGameDir) {
    if (rel === '.' || rel === '..' || rel.includes('/') || rel.includes('\\')) {
      throw new Error(`Invalid copy entry: ${rel}`)
    }
  }
  for (const rel of plan.copyToGameDir) {
    const src = path.join(profileDir, rel)
    if (!(await exists(src))) continue
    try {
      if (rel === 'doorstop_config.ini') {
        // HML's launch arguments enable doorstop; the file itself stays inert.
        const text = await fs.readFile(src, 'utf8')
        await fs.writeFile(path.join(gameDir, rel), disableDoorstopIni(text))
      } else {
        await fs.copyFile(src, path.join(gameDir, rel))
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause)
      throw new Error(
        `Couldn't copy ${rel} into the game folder. If the game is running, close it and try again. (${msg})`,
        { cause }
      )
    }
  }
  try {
    if (plan.env?.STEAM_COMPAT_DATA_PATH) {
      await fs.mkdir(plan.env.STEAM_COMPAT_DATA_PATH, { recursive: true })
    }
    const child = spawnFn(plan.command, plan.args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
      cwd: plan.cwd,
      env: plan.env ? { ...process.env, ...plan.env } : undefined
    })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Could not start ${plan.what}: ${msg}`, { cause })
  }
}
