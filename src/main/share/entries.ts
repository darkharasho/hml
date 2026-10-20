import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { HmlApi } from '../../shared/ipc'
import type { HmlExportMod, TsPackage, UnresolvedMod } from '../../shared/types'
import { compareVersions } from '../../shared/version'
import { getProfile } from '../profiles/profiles'
import type { ServiceDeps } from '../services'
import type { GhInstallOptions } from '../github/service'

/** The in-process service methods an import uses; each takes the profile lock itself. */
export type ShareInstallers = Pick<
  HmlApi,
  | 'tsGetPackage'
  | 'tsRefresh'
  | 'tsInstall'
  | 'nxInstall'
  | 'nxGetDomain'
  | 'setModEnabled'
  | 'createProfile'
  | 'addNexusGame'
  | 'addCustomGame'
> & {
  ghInstall(
    game: string,
    profileId: string,
    url: string,
    opts: GhInstallOptions
  ): ReturnType<HmlApi['ghInstall']>
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** GitHub install errors that mean the release or its file is gone, not that GitHub is unreachable. */
const GH_GONE = [/ has no release /, / has no file named /, / failed: HTTP 404$/]

const missingWarning = (fullName: string, missing: string[]): string[] =>
  missing.length > 0 ? [`${fullName}: missing dependencies ${missing.join(', ')}.`] : []

/** The shown name of an exported mod: its recorded name, else one derived from its source. */
export function modName(m: HmlExportMod): string {
  if (m.name) return m.name
  const s = m.source
  switch (s.kind) {
    case 'thunderstore':
      return s.fullName
    case 'github':
      return `${s.owner}/${s.repo}`
    case 'nexus':
      return `Nexus mod ${s.modId}`
    case 'local':
      return s.fileName
  }
}

/**
 * Writes the shared config files over whatever the installs created. A file that can't be
 * written doesn't stop the rest; it comes back as a warning.
 */
export async function writeConfigFiles(
  profileDir: string,
  configs: Map<string, Uint8Array>
): Promise<string[]> {
  const root = path.resolve(profileDir)
  const warnings: string[] = []
  for (const [rel, data] of configs) {
    const target = path.resolve(root, ...rel.split('/'))
    const inside = path.relative(root, target)
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, data)
    } catch {
      warnings.push(`Couldn't write ${rel}.`)
    }
  }
  return warnings
}

export function createEntryInstaller(ctx: { deps: ServiceDeps; installers: ShareInstallers }): {
  installEntry(
    game: string,
    profileId: string,
    entry: HmlExportMod,
    refreshOnce: () => Promise<void>
  ): Promise<{ modId: string; warnings: string[] } | { unresolved: UnresolvedMod }>
  tsModAt(game: string, profileId: string, fullName: string, version: string): Promise<boolean>
  refresher(game: string): () => Promise<void>
  repinThunderstore(
    game: string,
    profileId: string,
    entries: HmlExportMod[],
    installedIds: (string | null)[]
  ): Promise<string[]>
} {
  const { deps, installers: api } = ctx

  /**
   * The Thunderstore package of an exported mod. When the cached index lacks the package or the
   * exact version, the index is refreshed (once per import) and checked again.
   */
  async function findPackage(
    game: string,
    fullName: string,
    version: string,
    refreshOnce: () => Promise<void>
  ): Promise<TsPackage | null> {
    const hasVersion = (p: TsPackage | null): boolean =>
      !!p && p.versions.some((v) => compareVersions(v.version, version) === 0)
    const pkg = await api.tsGetPackage(game, fullName)
    if (hasVersion(pkg)) return pkg
    await refreshOnce()
    return api.tsGetPackage(game, fullName)
  }

  /** Installs one exported mod. Never throws: a failure comes back as an unresolved entry. */
  async function installEntry(
    game: string,
    profileId: string,
    entry: HmlExportMod,
    refreshOnce: () => Promise<void>
  ): Promise<{ modId: string; warnings: string[] } | { unresolved: UnresolvedMod }> {
    const unresolved = (reason: string, url?: string): { unresolved: UnresolvedMod } => ({
      unresolved: {
        name: modName(entry),
        version: entry.version,
        kind: entry.source.kind,
        reason,
        ...(url !== undefined ? { url } : {})
      }
    })
    const s = entry.source
    try {
      switch (s.kind) {
        case 'thunderstore': {
          const pkg = await findPackage(game, s.fullName, entry.version, refreshOnce)
          if (!pkg) return unresolved('Not on Thunderstore anymore.')
          if (!pkg.versions.some((v) => compareVersions(v.version, entry.version) === 0)) {
            return unresolved(`Version ${entry.version} is no longer on Thunderstore.`)
          }
          // Already there at this version (pulled in as a dependency): nothing to install.
          if (await tsModAt(game, profileId, s.fullName, entry.version)) {
            return { modId: s.fullName, warnings: [] }
          }
          const r = await api.tsInstall(game, profileId, s.fullName, entry.version)
          return { modId: s.fullName, warnings: missingWarning(s.fullName, r.missing) }
        }
        case 'github': {
          const tag = s.tag.split('/').map(encodeURIComponent).join('/')
          const url = `https://github.com/${s.owner}/${s.repo}/releases/download/${tag}/${encodeURIComponent(s.asset)}`
          const provides = await onThunderstore(game, entry.provides ?? [])
          let r
          try {
            r = await api.ghInstall(game, profileId, url, {
              provides,
              prereleases: entry.prereleases === true
            })
          } catch (e) {
            // A network failure or rate limit keeps GitHub's own message, which says what to do.
            const msg = errMsg(e)
            if (!GH_GONE.some((re) => re.test(msg))) return unresolved(msg)
            return unresolved(`Release ${s.tag} isn't available on GitHub anymore.`)
          }
          if (r.kind !== 'installed') {
            return unresolved(`Release ${s.tag} isn't available on GitHub anymore.`)
          }
          const got = r.mod.source.kind === 'github' ? r.mod.source.sha256 : ''
          return {
            modId: r.mod.id,
            warnings:
              got.toLowerCase() !== s.sha256.toLowerCase()
                ? [
                    `${s.owner}/${s.repo} ${s.tag}: the release file changed since this profile was shared.`
                  ]
                : []
          }
        }
        case 'nexus': {
          const domain = await api.nxGetDomain(game)
          if (domain === null) {
            return unresolved(
              `HML couldn't confirm this game's Nexus Mods domain (${s.domain}). Set it in the game's menu, then import again.`
            )
          }
          if (domain !== s.domain) {
            return unresolved(`This mod is for a different game on Nexus Mods (${s.domain}).`)
          }
          const r = await api.nxInstall(game, profileId, s.modId, s.fileId)
          if (r.kind === 'open-website') {
            return unresolved('Needs Nexus Mods Premium. Download it from the website.', r.url)
          }
          return { modId: r.mod.id, warnings: [] }
        }
        case 'local':
          return unresolved(`Local file (${s.fileName}). Files aren't included in share codes.`)
      }
    } catch (e) {
      // Includes Nexus's "Add your Nexus Mods API key in Settings to download." and a 404.
      return unresolved(errMsg(e))
    }
  }

  /** The fullNames that are packages in the game's Thunderstore index; none if it can't load. */
  async function onThunderstore(game: string, fullNames: string[]): Promise<string[]> {
    const out: string[] = []
    for (const fullName of new Set(fullNames)) {
      try {
        if (await api.tsGetPackage(game, fullName)) out.push(fullName)
      } catch {
        // No index (offline or no Thunderstore listing): nothing is recorded.
      }
    }
    return out
  }

  async function tsModAt(
    game: string,
    profileId: string,
    fullName: string,
    version: string
  ): Promise<boolean> {
    const { mods } = await getProfile(deps.paths, game, profileId)
    return mods.some(
      (m) =>
        m.source.kind === 'thunderstore' &&
        m.source.fullName === fullName &&
        compareVersions(m.version, version) === 0
    )
  }

  /** importShare's "export's version wins" pass: re-installs listed Thunderstore mods a dependency moved. */
  async function repinThunderstore(
    game: string,
    profileId: string,
    entries: HmlExportMod[],
    installedIds: (string | null)[]
  ): Promise<string[]> {
    const warnings: string[] = []
    for (const [i, entry] of entries.entries()) {
      const s = entry.source
      if (s.kind !== 'thunderstore' || installedIds[i] === null) continue
      try {
        if (!(await tsModAt(game, profileId, s.fullName, entry.version))) {
          const r = await api.tsInstall(game, profileId, s.fullName, entry.version)
          warnings.push(...missingWarning(s.fullName, r.missing))
        }
      } catch (e) {
        warnings.push(`${modName(entry)}: ${errMsg(e)}`)
      }
    }
    return warnings
  }

  /** A once-per-run Thunderstore refresh for `game`: at most one forced index refresh, shared by every entry. */
  function refresher(game: string): () => Promise<void> {
    let refreshed: Promise<void> | null = null
    return () =>
      (refreshed ??= api.tsRefresh(game).then(
        () => undefined,
        () => undefined
      ))
  }

  return { installEntry, tsModAt, refresher, repinThunderstore }
}
