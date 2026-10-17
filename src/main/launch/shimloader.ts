import { promises as fs } from 'node:fs'
import path from 'node:path'
import { toProtonPath } from './launchPlan'

/** unreal_shimloader's files at the profile root; a modded launch copies them next to the exe. */
export const SHIM_FILES = ['dwmapi.dll', 'ue4ss.dll', 'UE4SS-settings.ini']
/** The profile folders shimloader is pointed at, under `shimloader/`. It wants all of them. */
const SHIM_DIRS = ['mod', 'pak', 'cfg', 'overlay']
/** Records, in the exe's folder, the files HML put there. */
const MARKER = '.hml-shimloader.json'
/** A hand-installed file HML moved aside, restored by a vanilla launch. */
const BACKUP = '.hml-backup'

const exists = (p: string): Promise<boolean> =>
  fs.lstat(p).then(
    () => true,
    () => false
  )

const isShimFile = (name: string): boolean =>
  SHIM_FILES.some((f) => f.toLowerCase() === name.toLowerCase())

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

async function readMarker(binDir: string): Promise<string[]> {
  try {
    const list: unknown = JSON.parse(await fs.readFile(path.join(binDir, MARKER), 'utf8'))
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
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
  const ours = await readMarker(binDir)
  const entries = await fs.readdir(binDir)
  const files: string[] = []
  for (const name of SHIM_FILES) {
    if (await exists(path.join(profileDir, name))) files.push(name)
  }
  try {
    for (const name of files) {
      for (const e of entries.filter((x) => x.toLowerCase() === name.toLowerCase())) {
        const at = path.join(binDir, e)
        if (ours.includes(e) || (await exists(at + BACKUP))) await fs.rm(at, { force: true })
        else await fs.rename(at, at + BACKUP)
      }
    }
    // Recorded before copying, so a copy that fails part way is still cleaned up.
    await fs.writeFile(path.join(binDir, MARKER), JSON.stringify(files))
    for (const name of files) {
      await fs.copyFile(path.join(profileDir, name), path.join(binDir, name))
    }
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `Couldn't put shimloader into the game folder. If the game is running, close it and try again. (${msg})`,
      { cause }
    )
  }
}

/** Takes HML's shim files back out of the exe's folder and restores any it moved aside. */
export async function unlinkShimloader(binDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(binDir)
  } catch {
    return
  }
  for (const name of await readMarker(binDir)) {
    if (isShimFile(name)) await fs.rm(path.join(binDir, name), { force: true })
  }
  for (const e of entries) {
    if (!e.endsWith(BACKUP)) continue
    const original = e.slice(0, -BACKUP.length)
    if (isShimFile(original)) await fs.rename(path.join(binDir, e), path.join(binDir, original))
  }
  await fs.rm(path.join(binDir, MARKER), { force: true })
}
