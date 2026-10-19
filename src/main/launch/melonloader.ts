import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LaunchMode } from '../../shared/types'
import { toProtonPath } from './launchPlan'
import type { LinkedFiles } from './linkedFiles'

/**
 * MelonLoader's proxy DLLs at the profile root; a modded launch copies them next to the game's
 * exe, where the game loads them. v0.6+ ships `version.dll`; r2modman also takes `winhttp.dll`.
 */
export const MELON: LinkedFiles = {
  what: 'MelonLoader',
  files: ['version.dll', 'winhttp.dll'],
  marker: '.hml-melonloader.json'
}

const exists = (p: string): Promise<boolean> =>
  fs.lstat(p).then(
    () => true,
    () => false
  )

/** True when the profile has MelonLoader: a proxy DLL and the `MelonLoader` folder it starts. */
export async function hasMelonLoader(profileDir: string): Promise<boolean> {
  if (!(await exists(path.join(profileDir, 'MelonLoader')))) return false
  for (const f of MELON.files) if (await exists(path.join(profileDir, f))) return true
  return false
}

/**
 * Modded: `--melonloader.basedir` pointing at the profile, where MelonLoader and the mods are,
 * plus `--melonloader.agfregenerate` until MelonLoader has generated the game's assemblies there
 * (as r2modman does). Vanilla: `--no-mods`, in case MelonLoader is installed in the game itself.
 */
export async function melonLoaderArgs(i: {
  mode: LaunchMode
  profileDir: string
  proton: boolean
}): Promise<string[]> {
  if (i.mode === 'vanilla') return ['--no-mods']
  const args = ['--melonloader.basedir', i.proton ? toProtonPath(i.profileDir) : i.profileDir]
  const generated =
    (await exists(path.join(i.profileDir, 'MelonLoader', 'Managed', 'Assembly-CSharp.dll'))) ||
    (await exists(
      path.join(i.profileDir, 'MelonLoader', 'Il2CppAssemblies', 'Assembly-CSharp.dll')
    ))
  if (!generated) args.push('--melonloader.agfregenerate')
  return args
}

/** The log MelonLoader writes, under its base folder (the profile). */
export const melonLogFile = (profileDir: string): string =>
  path.join(profileDir, 'MelonLoader', 'Latest.log')
