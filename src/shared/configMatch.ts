import type { ConfigFile, InstalledMod } from './types'

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const stem = (p: string): string => {
  const name = p.slice(p.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * The config files that belong to `mod`: ones it installed, then ones whose name contains the
 * mod's (BepInEx names them by plugin GUID, like `com.author.ModName.cfg`).
 */
export function configsForMod(mod: InstalledMod, files: ConfigFile[]): ConfigFile[] {
  const own = new Set(mod.files)
  const name = squash(mod.name)
  const named = (f: ConfigFile): boolean => name.length >= 3 && squash(stem(f.path)).includes(name)
  return [
    ...files.filter((f) => own.has(f.path)),
    ...files.filter((f) => !own.has(f.path) && named(f))
  ]
}
