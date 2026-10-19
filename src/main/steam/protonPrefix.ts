import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'
import { listLibraries } from './steam'

/** The key, in a Wine prefix's user.reg, that holds the prefix-wide DLL overrides. */
const SECTION = '[Software\\\\Wine\\\\DllOverrides]'
/**
 * The DLL a loader needs Wine to take from the game folder before its own: BepInEx's doorstop
 * `winhttp`, unreal_shimloader's `dwmapi`, or MelonLoader's `version`.
 */
export type ProxyDll = 'winhttp' | 'dwmapi' | 'version'
const overrideLine = (dll: ProxyDll): string => `"${dll}"="native,builtin"`
const valueRe = (dll: ProxyDll): RegExp => new RegExp(`^"${dll}"="([^"]*)"\\s*$`, 'i')

export type PrefixOverrideResult = 'set' | 'already-set' | 'no-prefix'

/** Start and end (exclusive) line indexes of the DllOverrides section's body, or null. */
function findSection(lines: string[]): { start: number; end: number } | null {
  const header = lines.findIndex(
    (l) => l.startsWith(SECTION) && (l.length === SECTION.length || l[SECTION.length] === ' ')
  )
  if (header < 0) return null
  let end = header + 1
  while (end < lines.length && !lines[end].startsWith('[')) end++
  return { start: header + 1, end }
}

/** True when the user.reg text loads `dll` native first (native,builtin / n,b / native). */
export function hasDllOverride(reg: string, dll: ProxyDll = 'winhttp'): boolean {
  const lines = reg.split('\n')
  const section = findSection(lines)
  if (!section) return false
  for (let i = section.start; i < section.end; i++) {
    const m = valueRe(dll).exec(lines[i])
    if (m) return ['native', 'n'].includes(m[1].split(',')[0].trim().toLowerCase())
  }
  return false
}

/**
 * The user.reg text with `dll` set to native,builtin: an existing value for it is replaced,
 * otherwise the line joins the DllOverrides section (created at the end if missing).
 */
export function addDllOverride(reg: string, nowSeconds: number, dll: ProxyDll = 'winhttp'): string {
  if (hasDllOverride(reg, dll)) return reg
  const lines = reg.split('\n')
  const section = findSection(lines)
  if (!section) {
    const body = reg.endsWith('\n') ? reg : `${reg}\n`
    return `${body}\n${SECTION} ${nowSeconds}\n${overrideLine(dll)}\n`
  }
  for (let i = section.start; i < section.end; i++) {
    if (valueRe(dll).test(lines[i])) {
      lines[i] = overrideLine(dll)
      return lines.join('\n')
    }
  }
  // After the header's `#time=` line, if any; Wine doesn't need the values sorted.
  let at = section.start
  while (at < section.end && lines[at].startsWith('#')) at++
  lines.splice(at, 0, overrideLine(dll))
  return lines.join('\n')
}

/**
 * The user.reg of a Steam game's Proton prefix (`steamapps/compatdata/<appid>/pfx`), looked for
 * in the library the game is installed in, then the Steam root. Null before the game's first
 * Proton launch creates it.
 */
export async function findProtonUserReg(root: string, appId: string): Promise<string | null> {
  if (!/^\d+$/.test(appId)) throw new Error(`Invalid Steam app id: ${appId}`)
  const libraries = await listLibraries(root)
  const owning: string[] = []
  for (const lib of libraries) {
    if (await exists(path.join(lib, 'steamapps', `appmanifest_${appId}.acf`))) owning.push(lib)
  }
  for (const lib of [...owning, ...libraries.filter((l) => !owning.includes(l))]) {
    const reg = path.join(lib, 'steamapps', 'compatdata', appId, 'pfx', 'user.reg')
    if (await exists(reg)) return reg
  }
  return null
}

/**
 * Makes the game's Proton prefix load the loader's `dll` from the game folder, so mods load
 * without Steam launch options. Wine reads user.reg when the game starts; the first change keeps
 * a `.hml-backup`.
 */
export async function ensureDllOverride(
  root: string,
  appId: string,
  nowSeconds: number,
  dll: ProxyDll = 'winhttp'
): Promise<PrefixOverrideResult> {
  const reg = await findProtonUserReg(root, appId)
  if (!reg) return 'no-prefix'
  const text = await fs.readFile(reg, 'utf8')
  if (hasDllOverride(text, dll)) return 'already-set'
  await backupOnce(reg)
  await writeAtomic(reg, addDllOverride(text, nowSeconds, dll))
  return 'set'
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Replaces `file` through a synced temporary file in the same folder, keeping its permissions.
 * A symlinked file is written through to its target, so the link stays.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  const target = await fs.realpath(file)
  const tmp = `${target}.hml-tmp`
  const { mode } = await fs.stat(target)
  await fs.rm(tmp, { force: true })
  const handle = await fs.open(tmp, 'wx', mode & 0o777)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(tmp, target)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}

/** Copies `file` to `<file>.hml-backup` unless a backup is already there. */
async function backupOnce(file: string): Promise<void> {
  try {
    await fs.copyFile(file, `${file}.hml-backup`, fsConstants.COPYFILE_EXCL)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
}
