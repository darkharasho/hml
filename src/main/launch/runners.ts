import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Runner } from '../../shared/types'
import type { ExecFilePort } from '../steam/steam'

type ProtonRunner = Extract<Runner, { kind: 'proton' }>

function versionParts(name: string): number[] {
  return (name.match(/\d+/g) ?? []).map(Number)
}

function compareNewestFirst(a: string, b: string): number {
  const pa = versionParts(a)
  const pb = versionParts(b)
  if (pa.length === 0 || pb.length === 0) {
    if (pa.length !== pb.length) return pa.length === 0 ? 1 : -1
    return a.localeCompare(b)
  }
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const d = (pb[k] ?? 0) - (pa[k] ?? 0)
    if (d !== 0) return d
  }
  return a.localeCompare(b)
}

async function scan(dir: string, onlyProtonNames: boolean, out: ProtonRunner[]): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (onlyProtonNames && !name.startsWith('Proton')) continue
    const full = path.join(dir, name)
    try {
      await fs.access(path.join(full, 'proton'))
    } catch {
      continue
    }
    out.push({ kind: 'proton', name, path: full })
  }
}

/** Proton builds in the libraries' steamapps/common (names starting "Proton") and in <steamRoot>/compatibilitytools.d, each a folder with a `proton` file; newest first. */
export async function findProtonVersions(
  steamRoot: string | null,
  libraries: string[]
): Promise<ProtonRunner[]> {
  const found: ProtonRunner[] = []
  for (const lib of libraries) await scan(path.join(lib, 'steamapps', 'common'), true, found)
  if (steamRoot) await scan(path.join(steamRoot, 'compatibilitytools.d'), false, found)
  return found.sort((a, b) => compareNewestFirst(a.name, b.name))
}

export async function wineAvailable(execFile: ExecFilePort): Promise<boolean> {
  try {
    await execFile('wine', ['--version'])
    return true
  } catch {
    return false
  }
}

export function defaultRunner(protons: Runner[], wine: boolean): Runner | null {
  if (protons.length > 0) return protons[0]
  return wine ? { kind: 'wine' } : null
}
