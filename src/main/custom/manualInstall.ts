import { promises as fs } from 'node:fs'
import path from 'node:path'

export const MANUAL_LOADER_ENTRIES = [
  'BepInEx',
  'winhttp.dll',
  'doorstop_config.ini',
  '.doorstop_version',
  'changelog.txt'
]

const known = new Map(MANUAL_LOADER_ENTRIES.map((e) => [e.toLowerCase(), e]))

/**
 * The manual-loader entries present in `gameDir` when a `BepInEx` folder is there (case-insensitive
 * names, returned as on disk, sorted); null when there is no BepInEx folder. HML itself only puts the
 * doorstop files in the game folder, so a BepInEx folder means a hand install.
 */
export async function findManualLoader(gameDir: string): Promise<string[] | null> {
  let names: string[]
  try {
    names = await fs.readdir(gameDir)
  } catch {
    return null
  }
  const found = names.filter((n) => known.has(n.toLowerCase())).sort()
  return found.some((n) => n.toLowerCase() === 'bepinex') ? found : null
}

/**
 * Moves `entries` from `gameDir` into `backupDir` by copying, then deleting, so it works across
 * filesystems. Nothing is removed from the game folder unless every copy succeeded.
 */
export async function moveToBackup(
  gameDir: string,
  entries: string[],
  backupDir: string
): Promise<string> {
  for (const e of entries) {
    if (!known.has(e.toLowerCase()) || e.includes('/') || e.includes('\\')) {
      throw new Error(`Not a manual BepInEx entry: ${e}`)
    }
  }
  await fs.mkdir(path.dirname(backupDir), { recursive: true })
  try {
    // Non-recursive: fails if the backup folder exists, so rollback only removes what we created.
    await fs.mkdir(backupDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Backup folder already exists: ${backupDir}`, { cause: err })
    }
    throw err
  }
  try {
    for (const e of entries) {
      await fs.cp(path.join(gameDir, e), path.join(backupDir, e), {
        recursive: true,
        errorOnExist: true,
        force: false
      })
    }
  } catch (err) {
    await fs.rm(backupDir, { recursive: true, force: true })
    throw err
  }
  try {
    for (const e of entries) await fs.rm(path.join(gameDir, e), { recursive: true, force: true })
  } catch (err) {
    throw new Error(
      `The files were backed up to ${backupDir}, but some couldn't be removed from the game folder: ${(err as Error).message}`,
      { cause: err }
    )
  }
  return backupDir
}

/** 'YYYY-MM-DD-HHmmss' in local time. */
export function backupStamp(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${p(now.getFullYear(), 4)}-${p(now.getMonth() + 1)}-${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  )
}
