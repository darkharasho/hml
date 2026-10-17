import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProfileManifest } from '../../shared/types'
import type { AppPaths } from '../store/paths'
import { readJson, writeJsonAtomic } from '../store/json'
import { withReadableName } from '../custom/loaders'

const MANIFEST = 'hml-profile.json'
export const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const SAFE_SEGMENT = /^[a-z0-9._-]+$/i

/** game and id come from the renderer; they must never escape the data root. */
function assertSafe(kind: string, value: string): void {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value) || /^\.+$/.test(value)) {
    throw new Error(`Invalid ${kind}: ${JSON.stringify(value)}`)
  }
}

export function slugifyProfileName(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[. \t\r\n]+$/, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^\.+/, '')
    .slice(0, 64)
    .replace(/[-. ]+$/, '')
  if (!s) return 'profile'
  const dot = s.indexOf('.')
  const base = dot === -1 ? s : s.slice(0, dot)
  if (RESERVED.test(base)) s = `${base}-1${dot === -1 ? '' : s.slice(dot)}`
  return s
}

const manifestPath = (paths: AppPaths, game: string, id: string): string =>
  path.join(paths.profileDir(game, id), MANIFEST)

/** A manifest as read: loaders saved under their raw id get their readable name (kept on next save). */
const readable = (m: ProfileManifest): ProfileManifest =>
  Array.isArray(m.mods)
    ? {
        ...m,
        // A hand-edited entry without a source is left as it is.
        mods: m.mods.map((mod) =>
          mod && typeof mod === 'object' && mod.source ? withReadableName(mod) : mod
        )
      }
    : m

export async function createProfile(
  paths: AppPaths,
  game: string,
  name: string
): Promise<ProfileManifest> {
  assertSafe('game', game)
  const slug = slugifyProfileName(name)
  // `__deploy__` is the deploy lock's key (see services.ts).
  if (slug === '__deploy__') throw new Error('That profile name is reserved.')
  await fs.mkdir(paths.profilesDir(game), { recursive: true })
  for (let n = 1; ; n++) {
    const id = n === 1 ? slug : `${slug}-${n}`
    try {
      // Non-recursive mkdir is atomic: it fails if the id is taken.
      await fs.mkdir(paths.profileDir(game, id))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    const manifest: ProfileManifest = {
      formatVersion: 1,
      id,
      name,
      game,
      createdAt: new Date().toISOString(),
      mods: []
    }
    await writeJsonAtomic(manifestPath(paths, game, id), manifest)
    return manifest
  }
}

function isValidManifest(m: unknown, dirName: string): m is ProfileManifest {
  if (typeof m !== 'object' || m === null) return false
  const o = m as Record<string, unknown>
  return (
    typeof o.createdAt === 'string' &&
    typeof o.name === 'string' &&
    Array.isArray(o.mods) &&
    o.id === dirName
  )
}

export async function listProfiles(paths: AppPaths, game: string): Promise<ProfileManifest[]> {
  assertSafe('game', game)
  let entries: string[]
  try {
    const dirents = await fs.readdir(paths.profilesDir(game), { withFileTypes: true })
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const found: ProfileManifest[] = []
  for (const id of entries) {
    const m = await readJson<ProfileManifest>(manifestPath(paths, game, id))
    if (isValidManifest(m, id)) found.push(readable(m))
  }
  return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function getProfile(
  paths: AppPaths,
  game: string,
  id: string
): Promise<ProfileManifest> {
  assertSafe('game', game)
  assertSafe('profile id', id)
  const m = await readJson<ProfileManifest>(manifestPath(paths, game, id))
  if (!m) throw new Error(`Profile not found: ${game}/${id}`)
  return readable(m)
}

export async function saveProfile(paths: AppPaths, m: ProfileManifest): Promise<void> {
  assertSafe('game', m.game)
  assertSafe('profile id', m.id)
  try {
    await fs.stat(paths.profileDir(m.game, m.id))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Profile not found: ${m.game}/${m.id}`, { cause: e })
    }
    throw e
  }
  await writeJsonAtomic(manifestPath(paths, m.game, m.id), m)
}

export async function renameProfile(
  paths: AppPaths,
  game: string,
  id: string,
  name: string
): Promise<void> {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Profile name must not be empty.')
  }
  const m = await getProfile(paths, game, id)
  await saveProfile(paths, { ...m, name })
}

export async function deleteProfile(paths: AppPaths, game: string, id: string): Promise<void> {
  assertSafe('game', game)
  assertSafe('profile id', id)
  await fs.rm(paths.profileDir(game, id), { recursive: true, force: true })
}
