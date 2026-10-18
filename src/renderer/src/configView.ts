import type { ConfigFile, InstalledMod } from '../../shared/types'

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

/** A config file's folder and file name, for a list grouped by folder. */
export function splitConfigPath(p: string): { dir: string; name: string } {
  const at = p.lastIndexOf('/')
  return at === -1 ? { dir: '', name: p } : { dir: p.slice(0, at), name: p.slice(at + 1) }
}

const NUMERIC = /^(u?int(16|32|64)?|s?byte|single|double|decimal|float)$/i
/** The form control a BepInEx setting gets. */
export type CfgControl = 'toggle' | 'select' | 'flags' | 'number' | 'text'

export function controlFor(entry: {
  type: string | null
  acceptable: string[] | null
  flags: boolean
}): CfgControl {
  if (entry.type?.toLowerCase() === 'boolean') return 'toggle'
  if (entry.acceptable && entry.acceptable.length > 0) return entry.flags ? 'flags' : 'select'
  if (entry.type && NUMERIC.test(entry.type)) return 'number'
  return 'text'
}

/** The values of a flags setting, as written (`A, B`). */
export const splitFlags = (value: string): string[] =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
