import { promises as fs } from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'
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

export interface ZipEntries {
  names: string[]
  read(name: string): Uint8Array
}

export function readZipEntries(data: Uint8Array): ZipEntries {
  const files = unzipSync(data)
  const names = Object.keys(files).filter((n) => !n.endsWith('/'))
  return {
    names,
    read(name) {
      const f = files[name]
      if (!f) throw new Error(`No such zip entry: ${name}`)
      return f
    }
  }
}

export function detectPackageMeta(
  zip: ZipEntries,
  fallbackName: string
): { name: string; version: string } | null {
  const candidates = zip.names.filter((n) => {
    const segs = n.replace(/\\/g, '/').split('/')
    return segs[segs.length - 1].toLowerCase() === 'manifest.json' && segs.length <= 2
  })
  const entry = candidates.sort((a, b) => a.length - b.length)[0]
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

async function removeFiles(root: string, files: string[]): Promise<void> {
  for (const f of files) {
    const abs = path.resolve(root, f)
    if (!abs.startsWith(root + path.sep)) continue
    await fs.rm(abs, { force: true })
    await fs.rm(abs + '.old', { force: true })
  }
  await pruneEmptyDirs(root, files)
}

export async function installZip(
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
  } = {}
): Promise<InstalledMod> {
  const profile = await getProfile(paths, game.label, profileId)
  const root = path.resolve(paths.profileDir(game.label, profileId))
  const zip = data instanceof Uint8Array ? await readArchive(data) : data
  const fallback = fallbackNameFor(source)
  const meta = detectPackageMeta(zip, fallback)

  const packageId = opts.packageId ?? meta?.name ?? fallback
  assertSafePackageId(packageId)
  const version = opts.version ?? meta?.version ?? '0.0.0'
  const name = opts.name ?? meta?.name ?? packageId

  const deploy = game.loader === 'deploy'
  const loaderPackage = deploy
    ? undefined
    : findLoaderPackage(game, catalog, zip, packageId, meta?.name)
  const plan = deploy
    ? planDeploy(zip.names)
    : planInstall(zip.names, { packageId, rules: game.installRules, loaderPackage })

  // Duplicate destinations: last write wins, recorded once.
  const byTo = new Map<string, { from: string; disableable: boolean }>()
  for (const f of plan.files) {
    const abs = path.resolve(root, f.to)
    if (!abs.startsWith(root + path.sep)) throw new UnsafeEntryError(f.from)
    byTo.delete(f.to)
    byTo.set(f.to, { from: f.from, disableable: f.disableable })
  }

  // Everything validated; only now touch the profile.
  // The previous version is the mod under this id, any mod this install replaces, and for a
  // loader package a local install recorded under the loader's alias (its manifest name).
  const replaced = new Set([packageId, ...(opts.replaces ?? [])])
  if (loaderPackage) replaced.add(loaderAlias(loaderPackage.packageId))
  const previous = profile.mods.filter((m) => replaced.has(m.id))
  let keptOwned: string[] = []
  if (previous.length > 0) {
    // Upgrade: keep user config (non-disableable files) of regular mods; loader
    // packages are all non-disableable and must be replaced wholesale.
    const keep = new Set<string>()
    if (!loaderPackage) for (const p of previous) for (const f of p.files) keep.add(f)
    for (const p of previous) for (const d of p.disableable) keep.delete(d)
    keptOwned = [...keep]
    await removeFiles(
      root,
      previous.flatMap((p) => p.files).filter((f) => !keep.has(f))
    )
    await saveProfile(paths, {
      ...profile,
      mods: profile.mods.filter((m) => !replaced.has(m.id))
    })
  }
  const prior = previous.find((m) => m.id === packageId) ?? previous[0]
  const enabled = prior ? prior.enabled : true

  const written: string[] = []
  const files: string[] = []
  const disableable: string[] = []
  try {
    for (const [to, f] of byTo) {
      const abs = path.resolve(root, to)
      if (!f.disableable && (await exists(abs))) {
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
      ...(opts.github ? { github: opts.github } : {})
    }
    const current = await getProfile(paths, game.label, profileId)
    await saveProfile(paths, {
      ...current,
      mods: [...current.mods.filter((m) => !replaced.has(m.id)), mod]
    })
    return mod
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
  await removeFiles(root, mod.files)
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
  for (const f of mod.disableable) {
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
