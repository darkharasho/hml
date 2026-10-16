import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DeploymentStatus, GameDef, InstalledMod } from '../../shared/types'
import type { AppPaths } from '../store/paths'
import { readJson, writeJsonAtomic } from '../store/json'
import { getProfile } from '../profiles/profiles'

/** 'backup': originals are being moved aside, nothing deployed yet. 'copy': files are being
 * copied in. 'done': complete, sizes and mtimes are recorded. */
type Phase = 'backup' | 'copy' | 'done'

interface DeployedFile {
  /** Path relative to the game folder, posix separators. */
  path: string
  mod: string
  /** -1 until the file has been copied and measured. */
  size: number
  mtimeMs: number
  backedUp: boolean
}

interface DeploymentManifest {
  formatVersion: 1
  profileId: string
  deployedAt: string
  gameDir: string
  phase?: Phase
  files: DeployedFile[]
  createdDirs: string[]
}

/** A relative posix path that stays inside its root, or null. */
function safeRel(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.includes('\0')) return null
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  return rel
}

/** Absolute path of rel inside root, or null when rel is unsafe or escapes the root. */
function within(root: string, rel: unknown): string | null {
  const safe = safeRel(rel)
  if (safe === null) return null
  const abs = path.resolve(root, ...safe.split('/'))
  return abs.startsWith(root + path.sep) ? abs : null
}

async function lstat(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.lstat(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await fs.copyFile(from, to)
    await fs.rm(from)
  }
}

async function readManifest(paths: AppPaths, game: GameDef): Promise<DeploymentManifest | null> {
  const m = await readJson<Partial<DeploymentManifest>>(paths.deployment(game.label))
  if (
    !m ||
    m.formatVersion !== 1 ||
    typeof m.profileId !== 'string' ||
    typeof m.gameDir !== 'string' ||
    !path.isAbsolute(m.gameDir) ||
    !Array.isArray(m.files)
  ) {
    return null
  }
  return {
    formatVersion: 1,
    profileId: m.profileId,
    deployedAt: typeof m.deployedAt === 'string' ? m.deployedAt : '',
    gameDir: m.gameDir,
    phase: m.phase === 'copy' || m.phase === 'done' ? m.phase : 'backup',
    files: m.files.filter(
      (f): f is DeployedFile =>
        typeof f === 'object' &&
        f !== null &&
        typeof f.path === 'string' &&
        typeof f.mod === 'string' &&
        typeof f.size === 'number' &&
        typeof f.mtimeMs === 'number'
    ),
    createdDirs: Array.isArray(m.createdDirs)
      ? m.createdDirs.filter((d): d is string => typeof d === 'string')
      : []
  }
}

export async function deploymentStatus(
  paths: AppPaths,
  game: GameDef
): Promise<DeploymentStatus | null> {
  const m = await readManifest(paths, game)
  if (!m) return null
  const profile = await getProfile(paths, game.label, m.profileId).catch(() => null)
  return {
    profileId: m.profileId,
    profileName: profile?.name ?? null,
    files: m.files.length,
    deployedAt: m.deployedAt
  }
}

/** Where a mod's file lives in the profile (disabled disableable files carry `.old`). */
function profileFile(mod: InstalledMod, rel: string): string {
  return !mod.enabled && mod.disableable.includes(rel) ? rel + '.old' : rel
}

/** Copies files the game changed since deploy back into their mods in the profile. */
async function copyBack(paths: AppPaths, game: GameDef, m: DeploymentManifest): Promise<void> {
  if (m.phase !== 'done') return
  const profile = await getProfile(paths, game.label, m.profileId).catch(() => null)
  if (!profile) return
  const profileRoot = path.resolve(paths.profileDir(game.label, m.profileId))
  const gameRoot = path.resolve(m.gameDir)
  for (const f of m.files) {
    if (f.size < 0) continue
    const mod = profile.mods.find((x) => x.id === f.mod)
    if (!mod || !mod.files.includes(f.path)) continue
    const src = within(gameRoot, f.path)
    const dst = within(profileRoot, profileFile(mod, f.path))
    if (!src || !dst) continue
    const st = await lstat(src)
    if (!st || !st.isFile()) continue
    if (st.size === f.size && st.mtimeMs === f.mtimeMs) continue
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.copyFile(src, dst)
  }
}

/** Undoes a deployment from its manifest. Touches only files the manifest names. */
async function removeFromManifest(
  paths: AppPaths,
  game: GameDef,
  m: DeploymentManifest
): Promise<void> {
  const gameRoot = path.resolve(m.gameDir)
  const backupRoot = path.resolve(paths.deployBackup(game.label))
  if (!(await lstat(gameRoot))) {
    throw new Error(
      `The folder ${gameRoot} no longer exists, so HML can't remove the deployment from it.`
    )
  }
  await copyBack(paths, game, m)

  const entries = m.files
    .map((f) => ({ f, game: within(gameRoot, f.path), backup: within(backupRoot, f.path) }))
    .filter((e): e is { f: DeployedFile; game: string; backup: string } => !!e.game && !!e.backup)

  // Before the backup phase finished nothing was copied, so a file at the path may be the
  // user's original. Only afterwards is a file at a planned path HML's.
  if (m.phase !== 'backup') {
    for (const e of entries) {
      const st = await lstat(e.game)
      if (st && !st.isDirectory()) await fs.rm(e.game)
    }
  }
  for (const e of entries) {
    if (!(await lstat(e.backup))) continue
    if (await lstat(e.game)) {
      throw new Error(`Can't restore ${e.f.path}: something else is in its place.`)
    }
    await fs.mkdir(path.dirname(e.game), { recursive: true })
    await moveFile(e.backup, e.game)
  }
  // Created dirs, deepest first; rmdir refuses a folder that isn't empty.
  const dirs = m.createdDirs
    .map((d) => within(gameRoot, d))
    .filter((d): d is string => d !== null)
    .sort((a, b) => b.length - a.length)
  for (const d of dirs) await fs.rmdir(d).catch(() => undefined)
  // Empty backup folders, deepest first.
  const backupDirs = new Set<string>()
  for (const e of entries) {
    for (let d = path.dirname(e.backup); d.startsWith(backupRoot + path.sep); d = path.dirname(d)) {
      backupDirs.add(d)
    }
  }
  for (const d of [...backupDirs].sort((a, b) => b.length - a.length)) {
    await fs.rmdir(d).catch(() => undefined)
  }
  await fs.rmdir(backupRoot).catch(() => undefined)
  await fs.rm(paths.deployment(game.label), { force: true })
}

/**
 * Restores the game folder to how it was before the current deployment. The caller serializes
 * on `<game>/__deploy__`. The folder recorded in the manifest is the one that is cleaned, even
 * if the game folder setting has changed since.
 */
export async function removeDeployment(
  paths: AppPaths,
  game: GameDef,
  gameDir: string
): Promise<void> {
  void gameDir
  const m = await readManifest(paths, game)
  if (!m) return
  await removeFromManifest(paths, game, m)
}

/**
 * Copies the profile's enabled mods into the game folder, after removing any current deployment.
 * Mods are applied in the profile's mod order, so the later-installed mod wins a conflict.
 * The caller serializes on the profile and then on `<game>/__deploy__`.
 */
export async function deployProfile(
  paths: AppPaths,
  game: GameDef,
  profileId: string,
  gameDir: string
): Promise<DeploymentStatus> {
  const gameRoot = path.resolve(gameDir)
  if (!(await fs.stat(gameRoot).catch(() => null))?.isDirectory()) {
    throw new Error(`The game folder ${gameRoot} doesn't exist.`)
  }
  const profile = await getProfile(paths, game.label, profileId)
  const profileRoot = path.resolve(paths.profileDir(game.label, profileId))
  const backupRoot = path.resolve(paths.deployBackup(game.label))

  await removeDeployment(paths, game, gameDir)
  if (await lstat(backupRoot)) {
    throw new Error(`${backupRoot} already exists. Remove it before deploying.`)
  }

  // Later mods overwrite earlier ones. Windows paths are case-insensitive.
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  const chosen = new Map<string, { rel: string; mod: string; src: string }>()
  for (const mod of profile.mods) {
    if (!mod.enabled) continue
    for (const rel of mod.files) {
      const dst = within(gameRoot, rel)
      const src = within(profileRoot, rel)
      if (!dst || !src) continue
      const st = await lstat(src)
      if (!st || !st.isFile()) continue
      chosen.delete(fold(rel))
      chosen.set(fold(rel), { rel, mod: mod.id, src })
    }
  }
  const planned = [...chosen.values()]

  // Folders to create, and originals to move aside; anything unexpected fails before any write.
  const createdDirs: string[] = []
  const seenDirs = new Set<string>()
  const existing = new Set<string>()
  for (const p of planned) {
    const parts = p.rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      const rel = parts.slice(0, i).join('/')
      if (seenDirs.has(fold(rel))) continue
      seenDirs.add(fold(rel))
      const st = await fs.stat(path.join(gameRoot, ...parts.slice(0, i))).catch(() => null)
      if (!st) createdDirs.push(rel)
      else if (!st.isDirectory()) throw new Error(`${rel} is a file in the game folder.`)
    }
    const st = await lstat(path.join(gameRoot, ...parts))
    if (st?.isDirectory()) throw new Error(`${p.rel} is a folder in the game folder.`)
    if (st) existing.add(p.rel)
  }

  const manifest: DeploymentManifest = {
    formatVersion: 1,
    profileId,
    deployedAt: new Date().toISOString(),
    gameDir: gameRoot,
    phase: 'backup',
    files: planned.map((p) => ({
      path: p.rel,
      mod: p.mod,
      size: -1,
      mtimeMs: -1,
      backedUp: false
    })),
    createdDirs
  }
  const save = (): Promise<void> => writeJsonAtomic(paths.deployment(game.label), manifest)
  await save()

  for (const f of manifest.files) {
    if (!existing.has(f.path)) continue
    const backup = within(backupRoot, f.path)
    if (!backup) throw new Error(`Unsafe path: ${f.path}`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    if (await lstat(backup)) throw new Error(`A backup of ${f.path} already exists.`)
    await moveFile(path.join(gameRoot, ...f.path.split('/')), backup)
    f.backedUp = true
  }
  manifest.phase = 'copy'
  await save()

  const realRoot = await fs.realpath(gameRoot)
  for (const rel of createdDirs) await fs.mkdir(path.join(gameRoot, ...rel.split('/')))
  for (const [i, p] of planned.entries()) {
    const dst = path.join(gameRoot, ...p.rel.split('/'))
    const realParent = await fs.realpath(path.dirname(dst))
    if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
      throw new Error(`${p.rel} would be written outside the game folder.`)
    }
    await fs.copyFile(p.src, dst)
    const st = await fs.stat(dst)
    manifest.files[i].size = st.size
    manifest.files[i].mtimeMs = st.mtimeMs
  }
  manifest.phase = 'done'
  await save()
  return {
    profileId,
    profileName: profile.name,
    files: manifest.files.length,
    deployedAt: manifest.deployedAt
  }
}
