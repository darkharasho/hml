import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProfileManifest } from '../../shared/types'
import type { AppPaths } from '../store/paths'
import { readJson, writeJsonAtomic } from '../store/json'

const MANIFEST = 'hml-profile.json'
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/
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
    .replace(/[. ]+$/, '')
  if (!s) return 'profile'
  const dot = s.indexOf('.')
  const base = dot === -1 ? s : s.slice(0, dot)
  if (RESERVED.test(base)) s = `${base}-1${dot === -1 ? '' : s.slice(dot)}`
  return s
}

const manifestPath = (paths: AppPaths, game: string, id: string): string =>
  path.join(paths.profileDir(game, id), MANIFEST)

export async function createProfile(
  paths: AppPaths,
  game: string,
  name: string
): Promise<ProfileManifest> {
  assertSafe('game', game)
  const slug = slugifyProfileName(name)
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
    await saveProfile(paths, manifest)
    return manifest
  }
}

export async function listProfiles(paths: AppPaths, game: string): Promise<ProfileManifest[]> {
  assertSafe('game', game)
  let entries: string[]
  try {
    entries = await fs.readdir(paths.profilesDir(game))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const found: ProfileManifest[] = []
  for (const id of entries) {
    const m = await readJson<ProfileManifest>(manifestPath(paths, game, id))
    if (m) found.push(m)
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
  return m
}

export async function saveProfile(paths: AppPaths, m: ProfileManifest): Promise<void> {
  assertSafe('game', m.game)
  assertSafe('profile id', m.id)
  await writeJsonAtomic(manifestPath(paths, m.game, m.id), m)
}

export async function renameProfile(
  paths: AppPaths,
  game: string,
  id: string,
  name: string
): Promise<void> {
  const m = await getProfile(paths, game, id)
  await saveProfile(paths, { ...m, name })
}

export async function deleteProfile(paths: AppPaths, game: string, id: string): Promise<void> {
  assertSafe('game', game)
  assertSafe('profile id', id)
  await fs.rm(paths.profileDir(game, id), { recursive: true, force: true })
}
