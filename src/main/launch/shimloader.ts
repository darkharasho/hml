import { promises as fs } from 'node:fs'
import path from 'node:path'
import { toProtonPath } from './launchPlan'
import { linkFiles, unlinkFiles, type LinkedFiles } from './linkedFiles'

/** unreal_shimloader's files at the profile root; a modded launch copies them next to the exe. */
export const SHIM_FILES = ['dwmapi.dll', 'ue4ss.dll', 'UE4SS-settings.ini']
/** The profile folders shimloader is pointed at, under `shimloader/`. It wants all of them. */
const SHIM_DIRS = ['mod', 'pak', 'cfg', 'overlay']
const SHIM: LinkedFiles = {
  what: 'shimloader',
  files: SHIM_FILES,
  marker: '.hml-shimloader.json'
}

const exists = (p: string): Promise<boolean> =>
  fs.lstat(p).then(
    () => true,
    () => false
  )

/** The folder an Unreal game's exe (and so the shim) lives in: `<data folder>/Binaries/Win64`. */
export function shimBinDir(gameDir: string, dataFolderName: string): string {
  return path.join(gameDir, dataFolderName, 'Binaries', 'Win64')
}

/** True when the profile has the shim and UE4SS, the two files the game needs to load mods. */
export async function hasShimloader(profileDir: string): Promise<boolean> {
  return (
    (await exists(path.join(profileDir, 'dwmapi.dll'))) &&
    (await exists(path.join(profileDir, 'ue4ss.dll')))
  )
}

/** `--mod-dir`, `--pak-dir`, `--cfg-dir` and `--overlay-dir`, pointing into the profile. */
export function shimloaderArgs(i: {
  profileDir: string
  platform: 'win32' | 'linux'
  proton: boolean
}): string[] {
  const p = i.platform === 'win32' ? path.win32 : path.posix
  return SHIM_DIRS.flatMap((d) => {
    const dir = p.join(i.profileDir, 'shimloader', d)
    return [`--${d}-dir`, i.proton ? toProtonPath(dir) : dir]
  })
}

/**
 * Puts the profile's shim files next to the game's exe and creates the folders shimloader is
 * pointed at. A file of the same name that HML didn't put there (a hand install of UE4SS) is
 * moved to `<name>.hml-backup` first, and a vanilla launch puts it back.
 */
export async function linkShimloader(profileDir: string, binDir: string): Promise<void> {
  for (const d of SHIM_DIRS) {
    await fs.mkdir(path.join(profileDir, 'shimloader', d), { recursive: true })
  }
  try {
    if (!(await fs.stat(binDir)).isDirectory()) throw new Error('not a folder')
  } catch {
    throw new Error(`HML couldn't find the game's Binaries/Win64 folder (${binDir}).`)
  }
  await linkFiles(SHIM, profileDir, binDir)
}

/** Takes HML's shim files back out of the exe's folder and restores any it moved aside. */
export async function unlinkShimloader(binDir: string): Promise<void> {
  await unlinkFiles(SHIM, binDir)
}
