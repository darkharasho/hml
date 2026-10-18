import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  Catalog,
  GameDef,
  GhModConfig,
  InstalledMod,
  ModSource,
  ModloaderPackage
} from '../../shared/types'
import type { AppPaths } from '../store/paths'
import { getProfile, saveProfile } from '../profiles/profiles'
import { planDeploy, planInstall, UnsafeEntryError } from './planInstall'
import { loaderAlias } from '../../shared/modIdentity'
import { readArchive } from './archive'
import { readZipEntries, type ZipEntries } from './zipEntries'

export { readZipEntries, type ZipEntries }

export function detectPackageMeta(
  zip: ZipEntries,
  fallbackName: string
): { name: string; version: string } | null {
  const norm = (n: string): string => n.replace(/\\/g, '/')
  const isManifest = (segs: string[]): boolean =>
    segs[segs.length - 1].toLowerCase() === 'manifest.json'
  // A root manifest is the package's own. A nested one counts only in a wrapped zip, where
  // every entry sits under the same folder; otherwise it belongs to something bundled inside.
  const root = zip.names.filter((n) => {
    const segs = norm(n).split('/')
    return segs.length === 1 && isManifest(segs)
  })
  const wrapped = zip.names.filter((n) => {
    const segs = norm(n).split('/')
    return (
      segs.length === 2 &&
      isManifest(segs) &&
      zip.names.every((o) => norm(o).startsWith(`${segs[0]}/`))
    )
  })
  const entry = [...root, ...wrapped][0]
  if (!entry) return null
  try {
    let text = new TextDecoder('utf-8').decode(zip.read(entry))
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const m = JSON.parse(text) as { name?: unknown; version_number?: unknown }
    return {
      name: typeof m.name === 'string' && m.name ? m.name : fallbackName,
      version: typeof m.version_number === 'string' && m.version_number ? m.version_number : '0.0.0'
    }
  } catch {
    return null
  }
}

function fallbackNameFor(source: ModSource): string {
  switch (source.kind) {
    case 'local':
      return path.basename(source.fileName, path.extname(source.fileName))
    case 'thunderstore':
      return source.fullName
    case 'github':
      return `${source.owner}-${source.repo}`
    case 'nexus':
      return `nexus-${source.modId}`
  }
}

function assertSafePackageId(id: string): void {
  if (typeof id !== 'string' || id === '' || id === '.' || id === '..' || /[/\\\0]/.test(id)) {
    throw new UnsafeEntryError(String(id))
  }
}

/** Deploy games keep each mod in its own profile folder, so the id must be one plain segment. */
/** A deploy-game mod folder name: unsafe characters become `_` (e.g. `My Mod (1)` → `My_Mod__1_`). */
function deployFolderId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return safe === '' ? 'mod' : safe
}

function assertDeployPackageId(id: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') throw new UnsafeEntryError(id)
}

function findLoaderPackage(
  game: GameDef,
  catalog: Catalog,
  zip: ZipEntries,
  packageId: string,
  manifestName: string | undefined
): ModloaderPackage | undefined {
  return catalog.modloaderPackages.find((p) => {
    if (p.loader !== game.loader) return false
    if (p.packageId === packageId) return true
    return (
      manifestName !== undefined &&
      manifestName === loaderAlias(p.packageId) &&
      zip.names.some((n) =>
        n.replace(/\\/g, '/').toLowerCase().startsWith(`${p.rootFolder.toLowerCase()}/`)
      )
    )
  })
}

const eqi = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * True for a raw BepInEx release (as published on GitHub): after stripping one sole wrapper
 * folder, entries under `BepInEx/core/` and a root `doorstop_config.ini` or `winhttp.dll`.
 */
function isRawBepInEx(names: string[]): boolean {
  let entries = names
    .map((n) =>
      n
        .replace(/\\/g, '/')
        .split('/')
        .filter((s) => s !== '' && s !== '.')
    )
    .filter((segs) => segs.length > 0)
  if (entries.length === 0) return false
  const top = entries[0][0]
  if (!eqi(top, 'BepInEx') && entries.every((s) => s.length >= 2 && eqi(s[0], top))) {
    entries = entries.map((s) => s.slice(1))
  }
  const core = entries.some((s) => s.length >= 3 && eqi(s[0], 'BepInEx') && eqi(s[1], 'core'))
  const doorstop = entries.some(
    (s) => s.length === 1 && (eqi(s[0], 'doorstop_config.ini') || eqi(s[0], 'winhttp.dll'))
  )
  return core && doorstop
}

const exists = (p: string): Promise<boolean> =>
  fs.lstat(p).then(
    () => true,
    () => false
  )

async function pruneEmptyDirs(root: string, files: string[]): Promise<void> {
  const dirs = new Set<string>()
  for (const f of files) {
    let d = path.dirname(path.resolve(root, f))
    while (d.startsWith(root + path.sep)) {
      dirs.add(d)
      d = path.dirname(d)
    }
  }
  // Deepest first so parents become empty.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      await fs.rmdir(d)
    } catch {
      // not empty or already gone
    }
  }
}

/** Files recorded by any mod outside `excluded`; removing or renaming them would break that mod. */
function filesOwnedByOthers(mods: InstalledMod[], excluded: Set<string>): Set<string> {
  const owned = new Set<string>()
  for (const m of mods) if (!excluded.has(m.id)) for (const f of m.files) owned.add(f)
  return owned
}

async function removeFiles(root: string, files: string[]): Promise<void> {
  for (const f of files) {
    const abs = path.resolve(root, f)
    if (!abs.startsWith(root + path.sep)) continue
    await fs.rm(abs, { force: true })
    await fs.rm(abs + '.old', { force: true })
  }
  await pruneEmptyDirs(root, files)
}

/**
 * The loader package a zip installs as: a catalog loader package, or a raw BepInEx release,
 * which isn't a catalog package but installs like one with its paths kept and stands in for the
 * game's loader packages (so Thunderstore doesn't add BepInExPack on top).
 */
function loaderKind(
  game: GameDef,
  catalog: Catalog,
  zip: ZipEntries,
  packageId: string,
  meta: { name: string } | null
): { loaderPackage: ModloaderPackage | undefined; rawLoader: boolean; loaderIds: string[] } {
  const deploy = game.loader === 'deploy'
  const catalogLoader = deploy
    ? undefined
    : findLoaderPackage(game, catalog, zip, packageId, meta?.name)
  const loaderIds = catalog.modloaderPackages
    .filter((p) => p.loader === game.loader)
    .map((p) => p.packageId)
  const rawLoader =
    !deploy && !catalogLoader && game.loader === 'bepinex' && isRawBepInEx(zip.names)
  const loaderPackage: ModloaderPackage | undefined =
    catalogLoader ??
    (rawLoader
      ? { packageId: loaderIds[0] ?? packageId, rootFolder: '', loader: game.loader }
      : undefined)
  return { loaderPackage, rawLoader, loaderIds }
}

/**
 * Ids treated as the previous version: the mod under this id, any mod the install replaces, and
 * for a loader package a local install recorded under the loader's alias (its manifest name).
 * A raw loader also replaces any installed mod that stands for a loader package; otherwise the
 * shared paths would be kept as that mod's files and the install would record none.
 */
function replacedIds(
  mods: InstalledMod[],
  packageId: string,
  replaces: string[],
  loaderPackage: ModloaderPackage | undefined,
  rawLoader: boolean,
  loaderIds: string[]
): Set<string> {
  const replaced = new Set([packageId, ...replaces])
  if (loaderPackage) replaced.add(loaderAlias(loaderPackage.packageId))
  if (rawLoader) {
    for (const m of mods) {
      const standsFor = m.source.kind === 'thunderstore' ? [m.source.fullName] : (m.provides ?? [])
      if (standsFor.some((id) => loaderIds.includes(id))) replaced.add(m.id)
    }
  }
  return replaced
}

/**
 * The installed mods (ids) an install of `zip` under `packageId` would replace, for a check made
 * before installing.
 */
export function installedModsReplaced(
  mods: InstalledMod[],
  game: GameDef,
  catalog: Catalog,
  zip: ZipEntries,
  packageId: string,
  replaces: string[] = []
): string[] {
  const meta = detectPackageMeta(zip, packageId)
  const { loaderPackage, rawLoader, loaderIds } = loaderKind(game, catalog, zip, packageId, meta)
  const ids = replacedIds(mods, packageId, replaces, loaderPackage, rawLoader, loaderIds)
  return mods.filter((m) => ids.has(m.id)).map((m) => m.id)
}

export async function installZip(
  ...args: Parameters<typeof installZipReporting>
): Promise<InstalledMod> {
  return (await installZipReporting(...args)).mod
}

/** installZip, also returning the ids of the installed mods it replaced (not the mod's own id). */
export async function installZipReporting(
  paths: AppPaths,
  game: GameDef,
  catalog: Catalog,
  profileId: string,
  data: Uint8Array | ZipEntries,
  source: ModSource,
  opts: {
    packageId?: string
    name?: string
    version?: string
    /**
     * Other mod ids this install supersedes (e.g. a local copy of the same package). They are
     * treated as the previous version: their files are replaced and their records dropped.
     */
    replaces?: string[]
    /** Recorded on the new mod in the same save (github-source mods). */
    github?: GhModConfig
    /** Thunderstore packages the new mod stands in for, recorded on it. */
    provides?: string[]
    /** Hold the mod at this version (or not); unset keeps the hold of the mod it replaces. */
    held?: boolean
  } = {}
): Promise<{ mod: InstalledMod; replaced: string[] }> {
  const profile = await getProfile(paths, game.label, profileId)
  const root = path.resolve(paths.profileDir(game.label, profileId))
  const zip = data instanceof Uint8Array ? await readArchive(data) : data
  const fallback = fallbackNameFor(source)
  const meta = detectPackageMeta(zip, fallback)

  const deploy = game.loader === 'deploy'
  const rawId = opts.packageId ?? meta?.name ?? fallback
  // Deploy games use the id as a folder name, so a local file name like `My Mod (1)` is made safe.
  const packageId = deploy && opts.packageId === undefined ? deployFolderId(rawId) : rawId
  assertSafePackageId(packageId)
  const version = opts.version ?? meta?.version ?? '0.0.0'
  const name = opts.name ?? meta?.name ?? rawId

  if (deploy) assertDeployPackageId(packageId)
  const { loaderPackage, rawLoader, loaderIds } = loaderKind(game, catalog, zip, packageId, meta)
  const provides = [
    ...new Set([...(opts.provides ?? []), ...(rawLoader && loaderIds[0] ? [loaderIds[0]] : [])])
  ]
  const plan = deploy
    ? planDeploy(zip.names, { root: game.deployRoot })
    : planInstall(zip.names, { packageId, rules: game.installRules, loaderPackage })
  // Deploy games store each mod in `<profile>/<packageId>/`, so mods that ship the same path
  // never share a file; deploy chooses between them.
  if (deploy) for (const f of plan.files) f.to = `${packageId}/${f.to}`

  // Duplicate destinations: last write wins, recorded once.
  const byTo = new Map<string, { from: string; disableable: boolean }>()
  for (const f of plan.files) {
    const abs = path.resolve(root, f.to)
    if (!abs.startsWith(root + path.sep)) throw new UnsafeEntryError(f.from)
    byTo.delete(f.to)
    byTo.set(f.to, { from: f.from, disableable: f.disableable })
  }

  // Everything validated; only now touch the profile.
  const replaced = replacedIds(
    profile.mods,
    packageId,
    opts.replaces ?? [],
    loaderPackage,
    rawLoader,
    loaderIds
  )
  const previous = profile.mods.filter((m) => replaced.has(m.id))
  let keptOwned: string[] = []
  // A loader's files that a surviving mod also records stay on disk; the new version still
  // overwrites them and records them as its own instead of leaving them stale and unowned.
  let loaderShared = new Set<string>()
  if (previous.length > 0) {
    // Upgrade: keep user config (non-disableable files) of regular mods; loader
    // packages are all non-disableable and must be replaced wholesale.
    const keep = new Set<string>()
    if (!loaderPackage) for (const p of previous) for (const f of p.files) keep.add(f)
    for (const p of previous) for (const d of p.disableable) keep.delete(d)
    keptOwned = [...keep]
    // Files another (surviving) mod also records stay; the replaced mods' own are removed.
    const shared = filesOwnedByOthers(profile.mods, replaced)
    if (loaderPackage) {
      loaderShared = new Set(previous.flatMap((p) => p.files).filter((f) => shared.has(f)))
    }
    await removeFiles(
      root,
      previous.flatMap((p) => p.files).filter((f) => !keep.has(f) && !shared.has(f))
    )
    await saveProfile(paths, {
      ...profile,
      mods: profile.mods.filter((m) => !replaced.has(m.id))
    })
  }
  const prior = previous.find((m) => m.id === packageId) ?? previous[0]
  const enabled = prior ? prior.enabled : true
  const held = opts.held ?? previous.some((m) => m.id === packageId && m.held === true)

  const written: string[] = []
  const files: string[] = []
  const disableable: string[] = []
  try {
    for (const [to, f] of byTo) {
      const abs = path.resolve(root, to)
      if (!f.disableable && !loaderShared.has(to) && (await exists(abs))) {
        // Keep user config; it stays owned only if a previous version owned it.
        if (keptOwned.includes(to)) files.push(to)
        continue
      }
      const target = f.disableable && !enabled ? abs + '.old' : abs
      await fs.mkdir(path.dirname(target), { recursive: true })
      written.push(target)
      await fs.writeFile(target, zip.read(f.from))
      files.push(to)
      if (f.disableable) disableable.push(to)
    }
    for (const k of keptOwned) {
      if (!files.includes(k) && (await exists(path.resolve(root, k)))) files.push(k)
    }
    const mod: InstalledMod = {
      id: packageId,
      name,
      version,
      source,
      enabled,
      files,
      disableable,
      installedAt: new Date().toISOString(),
      ...(opts.github ? { github: opts.github } : {}),
      ...(provides.length > 0 ? { provides } : {}),
      ...(held ? { held: true as const } : {})
    }
    const current = await getProfile(paths, game.label, profileId)
    await saveProfile(paths, {
      ...current,
      mods: [...current.mods.filter((m) => !replaced.has(m.id)), mod]
    })
    return { mod, replaced: previous.map((m) => m.id).filter((id) => id !== packageId) }
  } catch (e) {
    for (const w of written) await fs.rm(w, { force: true }).catch(() => undefined)
    await pruneEmptyDirs(
      root,
      written.map((w) => path.relative(root, w))
    ).catch(() => undefined)
    throw e
  }
}

export async function uninstallMod(
  paths: AppPaths,
  game: GameDef,
  profileId: string,
  modId: string
): Promise<void> {
  const profile = await getProfile(paths, game.label, profileId)
  const mod = profile.mods.find((m) => m.id === modId)
  if (!mod) return
  const root = path.resolve(paths.profileDir(game.label, profileId))
  const shared = filesOwnedByOthers(profile.mods, new Set([modId]))
  await removeFiles(
    root,
    mod.files.filter((f) => !shared.has(f))
  )
  await saveProfile(paths, { ...profile, mods: profile.mods.filter((m) => m.id !== modId) })
}

export async function setModEnabled(
  paths: AppPaths,
  game: GameDef,
  profileId: string,
  modId: string,
  enabled: boolean
): Promise<void> {
  const profile = await getProfile(paths, game.label, profileId)
  const mod = profile.mods.find((m) => m.id === modId)
  if (!mod) throw new Error(`Mod not installed: ${modId}`)
  const root = path.resolve(paths.profileDir(game.label, profileId))
  const shared = filesOwnedByOthers(profile.mods, new Set([modId]))
  for (const f of mod.disableable) {
    if (shared.has(f)) continue
    const abs = path.resolve(root, f)
    if (!abs.startsWith(root + path.sep)) continue
    const [from, to] = enabled ? [abs + '.old', abs] : [abs, abs + '.old']
    if (!(await exists(from)) || (await exists(to))) continue
    await fs.rename(from, to)
  }
  await saveProfile(paths, {
    ...profile,
    mods: profile.mods.map((m) => (m.id === modId ? { ...m, enabled } : m))
  })
}
