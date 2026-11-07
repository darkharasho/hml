import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { HmlApi } from '../../shared/ipc'
import type {
  HmlExport,
  HmlExportMod,
  InstalledMod,
  ModSource,
  SyncChangeSummary,
  UnresolvedMod
} from '../../shared/types'
import { compareVersions } from '../../shared/version'
import { isSafeConfigPath } from '../share/hmlFile'
import { modName, type createEntryInstaller, type ShareInstallers } from '../share/entries'
import { getProfile } from '../profiles/profiles'
import type { ServiceDeps } from '../services'
import { readBases, writeBases } from './bases'
import { mergeConfig } from './configMerge'
import { tagPrefix } from '../../shared/ghTag'

export function modKey(s: ModSource): string {
  switch (s.kind) {
    case 'thunderstore':
      return `ts:${s.fullName}`
    case 'github': {
      // A monorepo's mods share owner/repo and differ by tag prefix.
      const prefix = tagPrefix(s.tag)
      return `gh:${s.owner}/${s.repo}${prefix ? `#${prefix}` : ''}`.toLowerCase()
    }
    case 'nexus':
      return `nx:${s.domain}:${s.modId}`
    case 'local':
      return `local:${s.fileName}`
  }
}

export interface SyncApplyResult extends SyncChangeSummary {
  manual: { name: string; url: string }[]
  failed: UnresolvedMod[]
  /** Names of the owner's synced mods the profile still lacks (at the owner's version). */
  missing: string[]
}

/**
 * How a follower's mods compare with the owner's list: the owner's total, its local mods (never
 * synced) and the synced mods this profile lacks at the owner's version.
 */
export function followerCounts(
  owner: readonly HmlExportMod[],
  have: readonly InstalledMod[]
): { total: number; local: string[]; missing: string[] } {
  const installed = new Map(have.map((m) => [modKey(m.source), m]))
  const local: string[] = []
  const missing: string[] = []
  for (const entry of owner) {
    if (entry.source.kind === 'local') {
      local.push(modName(entry))
      continue
    }
    const mod = installed.get(modKey(entry.source))
    if (!mod || compareVersions(mod.version, entry.version) !== 0) missing.push(modName(entry))
  }
  return { total: owner.length, local, missing }
}

/** Progress of one apply: `done` of `total` owner mods handled, `current` the one being installed. */
export type ApplyProgress = (p: { done: number; total: number; current?: string }) => void

export interface ApplyContext {
  deps: ServiceDeps
  serialize<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T>
  installers: ShareInstallers & Pick<HmlApi, 'uninstallMod'>
  entries: ReturnType<typeof createEntryInstaller>
}

const same = (a: Uint8Array | null, b: Uint8Array): boolean =>
  a !== null && Buffer.from(a).equals(Buffer.from(b))

async function readOrNull(file: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await fs.readFile(file))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * Makes a follower profile match the owner's revision: mods first (uninstall, install, enable
 * state), then the config files merged per setting. The owner's local mods are skipped.
 * Installs and uninstalls take the profile lock themselves, so only the config step is serialized.
 */
export async function applyRevision(
  ctx: ApplyContext,
  game: string,
  profileId: string,
  rev: { export: HmlExport; configs: Map<string, Uint8Array> },
  onProgress: ApplyProgress = () => undefined
): Promise<SyncApplyResult> {
  const { deps, installers, entries } = ctx
  const result: SyncApplyResult = {
    added: 0,
    removed: 0,
    updated: 0,
    enabled: 0,
    disabled: 0,
    configs: 0,
    manual: [],
    failed: [],
    missing: []
  }
  const readMods = async (): Promise<Map<string, InstalledMod>> =>
    new Map((await getProfile(deps.paths, game, profileId)).mods.map((m) => [modKey(m.source), m]))

  const desired = rev.export.mods.filter((m) => m.source.kind !== 'local')
  const wanted = new Set(desired.map((m) => modKey(m.source)))

  // 2. Remove what the owner no longer has.
  const before = await readMods()
  for (const [key, mod] of before) {
    if (wanted.has(key)) continue
    await installers.uninstallMod(game, profileId, mod.id)
    result.removed++
  }

  // 3. Install what's missing or at another version.
  const refreshOnce = entries.refresher(game)
  const installedIds: (string | null)[] = []
  const addedKeys = new Set<string>()
  const total = desired.length
  onProgress({ done: 0, total })
  for (const [i, entry] of desired.entries()) {
    const key = modKey(entry.source)
    const have = before.get(key)
    if (have && compareVersions(have.version, entry.version) === 0) {
      installedIds.push(have.id)
      onProgress({ done: i + 1, total })
      continue
    }
    onProgress({ done: i, total, current: modName(entry) })
    const r = await entries.installEntry(game, profileId, entry, refreshOnce)
    onProgress({ done: i + 1, total })
    if ('unresolved' in r) {
      installedIds.push(null)
      if (r.unresolved.url !== undefined) {
        result.manual.push({ name: r.unresolved.name, url: r.unresolved.url })
      } else {
        result.failed.push(r.unresolved)
      }
      continue
    }
    installedIds.push(r.modId)
    if (have) result.updated++
    else {
      result.added++
      addedKeys.add(key)
    }
  }

  // 4. A later install can move a listed Thunderstore mod through its dependencies.
  await entries.repinThunderstore(game, profileId, desired, installedIds)

  // 5. Enabled states, against what is installed now.
  const now = await readMods()
  for (const entry of desired) {
    const mod = now.get(modKey(entry.source))
    if (!mod || mod.enabled === entry.enabled) continue
    await installers.setModEnabled(game, profileId, mod.id, entry.enabled)
    // A new mod's state is part of arriving, not a separate change.
    if (addedKeys.has(modKey(entry.source))) continue
    if (entry.enabled) result.enabled++
    else result.disabled++
  }

  // 6. Config files: the owner's changes merged into the follower's own.
  const profileDir = deps.paths.profileDir(game, profileId)
  await ctx.serialize(game, profileId, async () => {
    const root = path.resolve(profileDir)
    const bases = await readBases(profileDir)
    for (const [rel, owner] of rev.configs) {
      if (!isSafeConfigPath(rel)) continue
      const target = path.resolve(root, ...rel.split('/'))
      const inside = path.relative(root, target)
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue
      const local = await readOrNull(target)
      const merged = mergeConfig(rel, bases.get(rel) ?? null, owner, local)
      if (same(local, merged)) continue
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, merged)
      result.configs++
    }
    await writeBases(profileDir, rev.configs)
  })

  result.missing = followerCounts(desired, [...(await readMods()).values()]).missing
  return result
}
