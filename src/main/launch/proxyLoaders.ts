import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LaunchMode, LaunchWarning } from '../../shared/types'
import type { ProxyDll } from '../../shared/protonOptions'
import { toProtonPath } from './launchPlan'
import { linkFiles, unlinkFiles, type LinkedFiles } from './linkedFiles'
import { hasMelonLoader, MELON, melonLoaderArgs, melonLogFile } from './melonloader'

/**
 * A loader that starts from a proxy DLL at the profile root: a modded launch copies the DLL next
 * to the game's exe and tells the loader, through launch arguments, where the profile is; a
 * vanilla launch takes the DLL back out.
 */
export interface ProxyLoader {
  /** For messages. */
  name: string
  proxy: LinkedFiles
  /** Shown before launch when the profile doesn't have the loader. */
  missing: LaunchWarning
  has(profileDir: string): Promise<boolean>
  args(i: { mode: LaunchMode; profileDir: string; proton: boolean }): Promise<string[]>
  /** The log the loader writes, or null before it has written one. */
  logFile(profileDir: string): Promise<string | null>
}

const exists = (p: string): Promise<boolean> =>
  fs.lstat(p).then(
    () => true,
    () => false
  )

const hasAny = async (dir: string, files: string[]): Promise<boolean> => {
  for (const f of files) if (await exists(path.join(dir, f))) return true
  return false
}

const gamePath = (p: string, proton: boolean): string => (proton ? toProtonPath(p) : p)

const MELONLOADER: ProxyLoader = {
  name: 'MelonLoader',
  proxy: MELON,
  missing: 'no-melonloader',
  has: hasMelonLoader,
  args: melonLoaderArgs,
  logFile: async (profileDir) => melonLogFile(profileDir)
}

const LOVELY_FILES: LinkedFiles = {
  what: 'lovely',
  // 0.10+ ships winmm.dll; 0.9 shipped version.dll.
  files: ['winmm.dll', 'version.dll'],
  marker: '.hml-lovely.json'
}

/**
 * lovely (Balatro): pointed at the profile's `mods` folder, where r2modman installs its mods.
 * Vanilla passes `--vanilla`, in case lovely is installed in the game itself.
 */
const LOVELY: ProxyLoader = {
  name: 'lovely',
  proxy: LOVELY_FILES,
  missing: 'no-lovely',
  has: (profileDir) => hasAny(profileDir, LOVELY_FILES.files),
  args: async ({ mode, profileDir, proton }) =>
    mode === 'vanilla'
      ? ['--vanilla']
      : ['--mod-dir', gamePath(path.join(profileDir, 'mods'), proton)],
  logFile: (profileDir) => newestLog(path.join(profileDir, 'mods', 'lovely', 'log'))
}

const ROM_FILES: LinkedFiles = {
  what: 'Return of Modding',
  // ReturnOfModding ships version.dll; Hell2Modding (Hades II) ships d3d12.dll.
  files: ['version.dll', 'd3d12.dll'],
  marker: '.hml-returnofmodding.json'
}

/**
 * Return of Modding (Risk of Rain Returns, and Hell2Modding for Hades II): pointed at the
 * profile, which holds its `ReturnOfModding` folder. Vanilla turns it off.
 */
const RETURN_OF_MODDING: ProxyLoader = {
  name: 'Return of Modding',
  proxy: ROM_FILES,
  missing: 'no-returnofmodding',
  has: (profileDir) => hasAny(profileDir, ROM_FILES.files),
  args: async ({ mode, profileDir, proton }) =>
    mode === 'vanilla'
      ? ['--rom_enabled', 'false']
      : ['--rom_modding_root_folder', gamePath(profileDir, proton)],
  logFile: async (profileDir) => path.join(profileDir, 'ReturnOfModding', 'LogOutput.log')
}

/** The proxy loader a game's loader is, or null for loaders that work another way. */
export function proxyLoaderFor(loader: string): ProxyLoader | null {
  switch (loader) {
    case 'melonloader':
    case 'recursive-melonloader':
      return MELONLOADER
    case 'lovely':
      return LOVELY
    case 'return-of-modding':
      return RETURN_OF_MODDING
    default:
      return null
  }
}

/**
 * The DLLs Wine must load from the game folder for this profile: the loader's proxies the
 * profile has, or before it has any, the one current versions ship (the first listed).
 */
export async function proxyDlls(loader: ProxyLoader, profileDir: string): Promise<ProxyDll[]> {
  const present: string[] = []
  for (const f of loader.proxy.files) if (await exists(path.join(profileDir, f))) present.push(f)
  return (present.length > 0 ? present : loader.proxy.files.slice(0, 1)).map(
    (f) => f.replace(/\.dll$/i, '').toLowerCase() as ProxyDll
  )
}

export const linkProxyLoader = (
  loader: ProxyLoader,
  profileDir: string,
  gameDir: string
): Promise<void> => linkFiles(loader.proxy, profileDir, gameDir)

export const unlinkProxyLoader = (loader: ProxyLoader, gameDir: string): Promise<void> =>
  unlinkFiles(loader.proxy, gameDir)

/** The most recently changed `.log` file in `dir`, or null. lovely starts a new one each run. */
async function newestLog(dir: string): Promise<string | null> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return null
  }
  let best: { file: string; at: number } | null = null
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.log')) continue
    const file = path.join(dir, n)
    const st = await fs.stat(file).catch(() => null)
    if (st?.isFile() && (!best || st.mtimeMs > best.at)) best = { file, at: st.mtimeMs }
  }
  return best?.file ?? null
}
