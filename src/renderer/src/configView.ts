export { configsForMod } from '../../shared/configMatch'

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
