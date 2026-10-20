import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { HmlApi } from '../../shared/ipc'
import type {
  HmlExport,
  InstalledMod,
  ModSource,
  SyncChangeSummary,
  UnresolvedMod
} from '../../shared/types'
import { compareVersions } from '../../shared/version'
import { isSafeConfigPath } from '../share/hmlFile'
import type { createEntryInstaller, ShareInstallers } from '../share/entries'
import { getProfile } from '../profiles/profiles'
import type { ServiceDeps } from '../services'
import { readBases, writeBases } from './bases'
import { mergeConfig } from './configMerge'

export function modKey(s: ModSource): string {
  switch (s.kind) {
    case 'thunderstore':
      return `ts:${s.fullName}`
    case 'github':
      return `gh:${s.owner}/${s.repo}`.toLowerCase()
    case 'nexus':
      return `nx:${s.domain}:${s.modId}`
    case 'local':
      return `local:${s.fileName}`
  }
}

export interface SyncApplyResult extends SyncChangeSummary {
  manual: { name: string; url: string }[]
  failed: UnresolvedMod[]
}

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
  rev: { export: HmlExport; configs: Map<string, Uint8Array> }
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
    failed: []
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
  for (const entry of desired) {
    const key = modKey(entry.source)
    const have = before.get(key)
    if (have && compareVersions(have.version, entry.version) === 0) {
      installedIds.push(have.id)
      continue
    }
    const r = await entries.installEntry(game, profileId, entry, refreshOnce)
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
    else result.added++
  }

  // 4. A later install can move a listed Thunderstore mod through its dependencies.
  await entries.repinThunderstore(game, profileId, desired, installedIds)

  // 5. Enabled states, against what is installed now.
  const now = await readMods()
  for (const entry of desired) {
    const mod = now.get(modKey(entry.source))
    if (!mod || mod.enabled === entry.enabled) continue
    await installers.setModEnabled(game, profileId, mod.id, entry.enabled)
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

  return result
}
