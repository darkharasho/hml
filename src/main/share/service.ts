import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { HmlApi } from '../../shared/ipc'
import type {
  Catalog,
  GameDef,
  HmlExport,
  HmlExportMod,
  ImportResult,
  ProfileManifest,
  UnresolvedMod
} from '../../shared/types'
import { compareVersions } from '../../shared/version'
import { getProfile } from '../profiles/profiles'
import type { ServiceDeps } from '../services'
import { buildHmlFile, readHmlFile } from './hmlFile'
import { downloadShare, uploadShare } from './client'

/** The in-process service methods an import uses; each takes the profile lock itself. */
export type ShareInstallers = Pick<
  HmlApi,
  | 'tsGetPackage'
  | 'tsInstall'
  | 'ghInstall'
  | 'nxInstall'
  | 'nxGetDomain'
  | 'setModEnabled'
  | 'createProfile'
  | 'addNexusGame'
>

export interface ShareContext {
  deps: ServiceDeps
  getCatalog(): Promise<Catalog>
  requireGame(label: string): Promise<{ label: string }>
  serialize<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T>
  installers: ShareInstallers
}

type ShareApi = Pick<HmlApi, 'exportProfileFile' | 'shareProfile' | 'previewShare' | 'importShare'>

const PENDING_MS = 600_000
const EXPIRED = 'This import has expired. Open the code or file again.'
const NEXUS_PREFIX = 'nexus-'
const NEXUS_DOMAIN_RE = /^[a-z0-9_-]{1,64}$/
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface Pending {
  export: HmlExport
  configs: Map<string, Uint8Array>
  expiresAt: number
}

/** The shown name of an exported mod: its recorded name, else one derived from its source. */
function modName(m: HmlExportMod): string {
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

const unknownGame = (game: string): Error =>
  new Error(`This profile is for a game HML doesn't know (${game}).`)

/** The Nexus domain of a `nexus-<domain>` label, or null. */
function nexusDomainOf(game: string): string | null {
  if (!game.startsWith(NEXUS_PREFIX)) return null
  const domain = game.slice(NEXUS_PREFIX.length)
  return NEXUS_DOMAIN_RE.test(domain) ? domain : null
}

/** Replaces characters that are unsafe in file names on Windows or Linux. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return cleaned || 'profile'
}

export function createShareServices(ctx: ShareContext): ShareApi {
  const { deps, requireGame, serialize, installers: api } = ctx
  const now = deps.now ?? Date.now

  // Previewed profiles, in memory only; an entry is checked for expiry whenever it is read.
  const pending = new Map<string, Pending>()
  const dropExpired = (): void => {
    for (const [token, p] of pending) if (p.expiresAt <= now()) pending.delete(token)
  }

  const findGame = async (label: string): Promise<GameDef | undefined> =>
    (await ctx.getCatalog()).games.find((g) => g.label === label)

  /** The catalog game the export is for, adding a `nexus-<domain>` game when it's missing. */
  async function resolveGame(game: string): Promise<string> {
    if (await findGame(game)) return game
    const domain = nexusDomainOf(game)
    if (!domain) throw unknownGame(game)
    return (await api.addNexusGame(domain)).label
  }

  /** Installs one exported mod. Never throws: a failure comes back as an unresolved entry. */
  async function installEntry(
    game: string,
    profileId: string,
    entry: HmlExportMod
  ): Promise<{ modId: string; warning?: string } | { unresolved: UnresolvedMod }> {
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
          const pkg = await api.tsGetPackage(game, s.fullName)
          if (!pkg) return unresolved('Not on Thunderstore anymore.')
          if (!pkg.versions.some((v) => compareVersions(v.version, entry.version) === 0)) {
            return unresolved(`Version ${entry.version} is no longer on Thunderstore.`)
          }
          // Already there at this version (pulled in as a dependency): nothing to install.
          if (!(await tsModAt(game, profileId, s.fullName, entry.version))) {
            await api.tsInstall(game, profileId, s.fullName, entry.version)
          }
          return { modId: s.fullName }
        }
        case 'github': {
          const tag = s.tag.split('/').map(encodeURIComponent).join('/')
          const url = `https://github.com/${s.owner}/${s.repo}/releases/download/${tag}/${encodeURIComponent(s.asset)}`
          let r
          try {
            r = await api.ghInstall(game, profileId, url)
          } catch {
            return unresolved(`Release ${s.tag} isn't available on GitHub anymore.`)
          }
          if (r.kind !== 'installed') {
            return unresolved(`Release ${s.tag} isn't available on GitHub anymore.`)
          }
          const got = r.mod.source.kind === 'github' ? r.mod.source.sha256 : ''
          return {
            modId: r.mod.id,
            ...(got.toLowerCase() !== s.sha256.toLowerCase()
              ? {
                  warning: `${s.owner}/${s.repo} ${s.tag}: the release file changed since this profile was shared.`
                }
              : {})
          }
        }
        case 'nexus': {
          const domain = await api.nxGetDomain(game)
          if (domain !== null && domain !== s.domain) {
            return unresolved(`This mod is for a different game on Nexus Mods (${s.domain}).`)
          }
          const r = await api.nxInstall(game, profileId, s.modId, s.fileId)
          if (r.kind === 'open-website') {
            return unresolved('Needs Nexus Mods Premium. Download it from the website.', r.url)
          }
          return { modId: r.mod.id }
        }
        case 'local':
          return unresolved(`Local file (${s.fileName}). Files aren't included in share codes.`)
      }
    } catch (e) {
      // Includes Nexus's "Add your Nexus Mods API key in Settings to download." and a 404.
      return unresolved(errMsg(e))
    }
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

  /** Writes the shared config files over whatever the installs created. */
  async function writeConfigs(
    game: string,
    profileId: string,
    configs: Map<string, Uint8Array>
  ): Promise<void> {
    const root = path.resolve(deps.paths.profileDir(game, profileId))
    for (const [rel, data] of configs) {
      const target = path.resolve(root, ...rel.split('/'))
      const inside = path.relative(root, target)
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, data)
    }
  }

  /** Reads the manifest and zips the profile under the profile lock, so installs can't interleave. */
  async function build(
    game: string,
    profileId: string
  ): Promise<{ profile: ProfileManifest; data: Uint8Array }> {
    const def = await requireGame(game)
    return serialize(def.label, profileId, async () => {
      const profile = await getProfile(deps.paths, def.label, profileId)
      const data = await buildHmlFile(profile, deps.paths.profileDir(def.label, profileId))
      return { profile, data }
    })
  }

  return {
    async exportProfileFile(game, profileId) {
      const def = await requireGame(game)
      // The dialog is modal, so it runs outside the lock; the build happens after it returns.
      const { name } = await getProfile(deps.paths, def.label, profileId)
      const target = await deps.dialog.saveFile({
        title: 'Export profile',
        defaultPath: `${safeFileName(name)}.hml`,
        filters: [{ name: 'HML profile', extensions: ['hml'] }]
      })
      if (!target) return null
      const { data } = await build(game, profileId)
      await fs.writeFile(target, data)
      return target
    },

    async shareProfile(game, profileId) {
      const { profile, data } = await build(game, profileId)
      // The upload can take up to its timeout, so it runs after the lock is released.
      const code = await uploadShare({ fetch: deps.fetch, base: deps.shareBaseUrl }, data)
      return { code, localMods: profile.mods.filter((m) => m.source.kind === 'local').length }
    },

    async previewShare(input) {
      let data: Uint8Array
      if (input && typeof input === 'object' && 'file' in input && input.file === true) {
        const files = await deps.dialog.pickFiles({
          title: 'Import profile',
          filters: [{ name: 'HML profile', extensions: ['hml'] }]
        })
        if (files.length === 0) return null
        data = new Uint8Array(await fs.readFile(files[0]))
      } else if (input && typeof input === 'object' && 'code' in input) {
        data = await downloadShare(
          { fetch: deps.fetch, base: deps.shareBaseUrl },
          String(input.code)
        )
      } else {
        throw new Error('Expected a share code or a file.')
      }
      const read = await readHmlFile(data)
      const exp = read.export
      const def = await findGame(exp.game)
      const domain = def ? null : nexusDomainOf(exp.game)
      if (!def && !domain) throw unknownGame(exp.game)
      dropExpired()
      const token = randomUUID()
      pending.set(token, { ...read, expiresAt: now() + PENDING_MS })
      return {
        token,
        game: exp.game,
        // A Nexus game that isn't added yet is named by its domain until the import adds it.
        gameName: def?.displayName ?? domain!,
        profileName: exp.profileName,
        mods: exp.mods.map((m) => ({ name: modName(m), version: m.version, kind: m.source.kind })),
        configFiles: read.configs.size
      }
    },

    async importShare(token, name) {
      const held = typeof token === 'string' ? pending.get(token) : undefined
      if (!held || held.expiresAt <= now()) {
        if (held) pending.delete(token)
        throw new Error(EXPIRED)
      }
      pending.delete(token)
      const exp = held.export
      const game = await resolveGame(exp.game)
      const wanted = typeof name === 'string' ? name.trim() : ''
      const created = await api.createProfile(game, wanted || exp.profileName)
      const profileId = created.id

      // Installs call the service methods directly: each takes this profile's lock itself, and
      // the lock isn't re-entrant, so wrapping them here would deadlock.
      const unresolved: UnresolvedMod[] = []
      const warnings: string[] = []
      const installedIds: (string | null)[] = []
      const total = exp.mods.length
      for (const [i, entry] of exp.mods.entries()) {
        deps.emit({ type: 'progress', message: `Importing ${modName(entry)}`, done: i, total })
        const r = await installEntry(game, profileId, entry)
        if ('unresolved' in r) {
          unresolved.push(r.unresolved)
          installedIds.push(null)
        } else {
          installedIds.push(r.modId)
          if (r.warning) warnings.push(r.warning)
        }
      }

      // A later install can move a listed Thunderstore mod to another version through its
      // dependencies; the version the export records wins.
      for (const [i, entry] of exp.mods.entries()) {
        const s = entry.source
        if (s.kind !== 'thunderstore' || installedIds[i] === null) continue
        try {
          if (!(await tsModAt(game, profileId, s.fullName, entry.version))) {
            await api.tsInstall(game, profileId, s.fullName, entry.version)
          }
        } catch (e) {
          warnings.push(`${modName(entry)}: ${errMsg(e)}`)
        }
      }

      for (const [i, entry] of exp.mods.entries()) {
        const modId = installedIds[i]
        if (entry.enabled || modId === null) continue
        try {
          await api.setModEnabled(game, profileId, modId, false)
        } catch (e) {
          warnings.push(`${modName(entry)}: ${errMsg(e)}`)
        }
      }

      try {
        await serialize(game, profileId, () => writeConfigs(game, profileId, held.configs))
      } catch (e) {
        warnings.push(`The config files couldn't be restored: ${errMsg(e)}`)
      }
      deps.emit({ type: 'progress', message: 'Done', done: total, total })

      return {
        game,
        profile: await getProfile(deps.paths, game, profileId),
        installed: installedIds.filter((id) => id !== null).length,
        unresolved,
        warnings
      } satisfies ImportResult
    }
  }
}
