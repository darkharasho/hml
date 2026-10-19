import { promises as fs } from 'node:fs'
import path from 'node:path'

/** A hand-installed file HML moved aside, restored by a vanilla launch. */
const BACKUP = '.hml-backup'

/** Profile-root files a loader copies into a game folder, and the marker recording them. */
export interface LinkedFiles {
  /** The loader, for error messages. */
  what: string
  files: string[]
  /** Records, in the game folder, the files HML put there. */
  marker: string
}

const exists = (p: string): Promise<boolean> =>
  fs.lstat(p).then(
    () => true,
    () => false
  )

const isOneOf = (spec: LinkedFiles, name: string): boolean =>
  spec.files.some((f) => f.toLowerCase() === name.toLowerCase())

async function readMarker(dir: string, marker: string): Promise<string[]> {
  try {
    const list: unknown = JSON.parse(await fs.readFile(path.join(dir, marker), 'utf8'))
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

/**
 * Copies the profile's copies of `spec.files` into `dir`. A file of the same name that HML didn't
 * put there (a hand install of the loader) is moved to `<name>.hml-backup` first, and
 * unlinkFiles puts it back.
 */
export async function linkFiles(spec: LinkedFiles, profileDir: string, dir: string): Promise<void> {
  const ours = await readMarker(dir, spec.marker)
  const entries = await fs.readdir(dir)
  const files: string[] = []
  for (const name of spec.files) {
    if (await exists(path.join(profileDir, name))) files.push(name)
  }
  try {
    for (const name of files) {
      for (const e of entries.filter((x) => x.toLowerCase() === name.toLowerCase())) {
        const at = path.join(dir, e)
        if (ours.includes(e) || (await exists(at + BACKUP))) await fs.rm(at, { force: true })
        else await fs.rename(at, at + BACKUP)
      }
    }
    // Recorded before copying, so a copy that fails part way is still cleaned up.
    await fs.writeFile(path.join(dir, spec.marker), JSON.stringify(files))
    for (const name of files) {
      await fs.copyFile(path.join(profileDir, name), path.join(dir, name))
    }
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `Couldn't put ${spec.what} into the game folder. If the game is running, close it and try again. (${msg})`,
      { cause }
    )
  }
}

/** Takes HML's copies back out of `dir` and restores any files it moved aside. */
export async function unlinkFiles(spec: LinkedFiles, dir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  for (const name of await readMarker(dir, spec.marker)) {
    if (isOneOf(spec, name)) await fs.rm(path.join(dir, name), { force: true })
  }
  for (const e of entries) {
    if (!e.endsWith(BACKUP)) continue
    const original = e.slice(0, -BACKUP.length)
    if (isOneOf(spec, original)) await fs.rename(path.join(dir, e), path.join(dir, original))
  }
  await fs.rm(path.join(dir, spec.marker), { force: true })
}
