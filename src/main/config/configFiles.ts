import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ConfigFile } from '../../shared/types'

/** Text formats mods keep settings in. `.cfg` counts anywhere; the rest only in a config folder. */
const CONFIG_EXT = new Set(['.cfg', '.ini', '.toml', '.json', '.yaml', '.yml', '.xml'])
/** Folders whose files are settings (BepInEx/config, MelonLoader's UserData, ...). */
const CONFIG_DIRS = new Set(['config', 'configs', 'userdata'])
/** Folders that hold no settings: caches, the loader's own internals and HML's sync bookkeeping. */
const SKIP_DIRS = new Set(['cache', 'core', 'patchers', 'node_modules', '.git', '.hml-sync'])
const MAX_FILES = 2000
const MAX_DEPTH = 8
/** Bigger files are not settings someone edits by hand. */
export const MAX_CONFIG_BYTES = 2 * 1024 * 1024

function isConfig(rel: string): boolean {
  const segs = rel.split('/')
  const name = segs[segs.length - 1].toLowerCase()
  if (segs.length === 1 && name === 'hml-profile.json') return false
  const ext = path.extname(name)
  if (!CONFIG_EXT.has(ext)) return false
  return ext === '.cfg' || segs.slice(0, -1).some((s) => CONFIG_DIRS.has(s.toLowerCase()))
}

/** The profile's config files, by path relative to the profile (posix separators), sorted. */
export async function listConfigFiles(root: string): Promise<ConfigFile[]> {
  const out: ConfigFile[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) await walk(path.join(dir, e.name), r, depth + 1)
      } else if (e.isFile() && isConfig(r)) {
        const st = await fs.stat(path.join(dir, e.name)).catch(() => null)
        if (st && st.size <= MAX_CONFIG_BYTES) {
          out.push({ path: r, size: st.size, modifiedAt: st.mtime.toISOString() })
        }
      }
    }
  }
  await walk(root, '', 0)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * The absolute path of config file `rel` in the profile at `root`. `rel` comes from the renderer:
 * it must name a config file inside the profile, also after following symlinks.
 */
async function resolveConfig(root: string, rel: string): Promise<string> {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.includes('\\') || !isConfig(rel)) {
    throw new Error(`Not a config file: ${JSON.stringify(rel)}`)
  }
  const base = await fs.realpath(root)
  const abs = path.resolve(base, rel)
  if (!abs.startsWith(base + path.sep)) throw new Error(`Not a config file: ${JSON.stringify(rel)}`)
  const real = await fs.realpath(abs).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') throw new Error(`${rel} no longer exists.`, { cause: e })
    throw e
  })
  if (!real.startsWith(base + path.sep))
    throw new Error(`Not a config file: ${JSON.stringify(rel)}`)
  return real
}

export async function readConfigFile(root: string, rel: string): Promise<string> {
  const file = await resolveConfig(root, rel)
  const st = await fs.stat(file)
  if (st.size > MAX_CONFIG_BYTES) throw new Error(`${rel} is too big to edit in HML.`)
  return fs.readFile(file, 'utf8')
}

/** Replaces an existing config file's text, atomically. */
export async function writeConfigFile(root: string, rel: string, text: string): Promise<void> {
  if (typeof text !== 'string') throw new Error('Config text must be a string.')
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) throw new Error(`${rel} is too big.`)
  const file = await resolveConfig(root, rel)
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}
