import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { isSafeConfigPath } from '../share/hmlFile'

/** The owner's config files as last applied: the common ancestor of the 3-way merge. */
const baseDir = (profileDir: string): string => path.join(profileDir, '.hml-sync', 'base')

/** The file for `rel` under `root`, or null when it isn't a safe config path inside it. */
function safeTarget(root: string, rel: string): string | null {
  if (!isSafeConfigPath(rel)) return null
  const target = path.resolve(root, ...rel.split('/'))
  const inside = path.relative(root, target)
  return !inside || inside.startsWith('..') || path.isAbsolute(inside) ? null : target
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFiles(path.join(dir, e.name), rel)))
    else if (e.isFile()) out.push(rel)
  }
  return out
}

export async function readBases(profileDir: string): Promise<Map<string, Uint8Array>> {
  const root = path.resolve(baseDir(profileDir))
  const out = new Map<string, Uint8Array>()
  for (const rel of await listFiles(root)) {
    const target = safeTarget(root, rel)
    if (target) out.set(rel, new Uint8Array(await fs.readFile(target)))
  }
  return out
}

/**
 * Replaces the whole stored set with `configs`. The new set is written beside the old one and
 * swapped in, so a failed write leaves the old bases intact.
 */
export async function writeBases(
  profileDir: string,
  configs: Map<string, Uint8Array>
): Promise<void> {
  const final = path.resolve(baseDir(profileDir))
  const tmp = `${final}.tmp-${randomBytes(6).toString('hex')}`
  try {
    await fs.mkdir(tmp, { recursive: true })
    for (const [rel, data] of configs) {
      const target = safeTarget(tmp, rel)
      if (!target) continue
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, data)
    }
    await fs.rm(final, { recursive: true, force: true })
    await fs.rename(tmp, final)
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    throw e
  }
}

export async function clearBases(profileDir: string): Promise<void> {
  await fs.rm(baseDir(profileDir), { recursive: true, force: true })
}
