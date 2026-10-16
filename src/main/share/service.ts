import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { HmlApi } from '../../shared/ipc'
import type {
  Catalog,
  GameDef,
  HmlCustomGame,
  HmlExport,
  HmlExportMod,
  ImportResult,
  ProfileManifest,
  TsPackage,
  UnresolvedMod
} from '../../shared/types'
import { compareVersions } from '../../shared/version'
import { getProfile, RESERVED } from '../profiles/profiles'
import type { ServiceDeps } from '../services'
import type { GhInstallOptions } from '../github/service'
import { buildHmlFile, IMPORT_TOO_BIG, MAX_HML_BYTES, readHmlFile } from './hmlFile'
import { downloadShare, uploadShare } from './client'

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

export interface ShareContext {
  deps: ServiceDeps
  getCatalog(): Promise<Catalog>
  requireGame(label: string): Promise<{ label: string }>
  serialize<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T>
  installers: ShareInstallers
  /** A stored folder game with this display name (case-insensitive). */
  findCustomGameByName(displayName: string): Promise<GameDef | undefined>
  /** Whether Steam has this app installed on this PC. */
  isSteamAppInstalled(appId: string): Promise<boolean>
  /** The stored custom-game entry for a label, if it is one. */
  getCustomGame(label: string): Promise<HmlCustomGame | null>
}

type ShareApi = Pick<HmlApi, 'exportProfileFile' | 'shareProfile' | 'previewShare' | 'importShare'>

const PENDING_MS = 600_000
const EXPIRED = 'This import has expired. Open the code or file again.'
const NEXUS_PREFIX = 'nexus-'
const NEXUS_DOMAIN_RE = /^[a-z0-9_-]{1,64}$/
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** GitHub install errors that mean the release or its file is gone, not that GitHub is unreachable. */
const GH_GONE = [/ has no release /, / has no file named /, / failed: HTTP 404$/]

const missingWarning = (fullName: string, missing: string[]): string[] =>
  missing.length > 0 ? [`${fullName}: missing dependencies ${missing.join(', ')}.`] : []

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
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
  if (!cleaned) return 'profile'
  return RESERVED.test(cleaned) ? `_${cleaned}` : cleaned
}

export function createShareServices(ctx: ShareContext): ShareApi {
  const { deps, requireGame, serialize, installers: api } = ctx
  const now = deps.now ?? Date.now

  // Previewed profiles, in memory only; an entry is checked for expiry whenever it is read.
  const pending = new Map<string, Pending>()
  // Tokens whose import is under way; a second import of one is refused until it settles.
  const inFlight = new Set<string>()
  const dropExpired = (): void => {
    for (const [token, p] of pending) if (p.expiresAt <= now()) pending.delete(token)
  }

  const findGame = async (label: string): Promise<GameDef | undefined> =>
    (await ctx.getCatalog()).games.find((g) => g.label === label)

  /** What importing an export for a game this PC doesn't have would do, or why it can't. */
  async function customPlan(cg: HmlCustomGame): Promise<{ def?: GameDef; needsFolder: boolean }> {
    if (cg.source === 'steam') {
      if (!cg.steamAppId || !(await ctx.isSteamAppInstalled(cg.steamAppId))) {
        throw new Error(
          `This profile is for ${cg.displayName}, which isn't installed through Steam on this PC.`
        )
      }
      return { needsFolder: false }
    }
    const def = await ctx.findCustomGameByName(cg.displayName)
    return def ? { def, needsFolder: false } : { needsFolder: true }
  }

  /**
   * The game the export is for: a known label, a custom game added from the export's own
   * description, or a `nexus-<domain>` game added when it's missing.
   */
  async function resolveGame(exp: HmlExport, folder?: string): Promise<string> {
    const game = exp.game
    if (await findGame(game)) return game
    const cg = exp.customGame
    if (cg) {
      const plan = await customPlan(cg)
      if (plan.def) return plan.def.label
      if (cg.source === 'steam') {
        return (
          await api.addCustomGame({
            source: 'steam',
            steamAppId: cg.steamAppId!,
            loaderChoice: cg.loaderChoice
          })
        ).label
      }
      if (!folder) throw new Error('Choose the game folder to import this profile.')
      return (
        await api.addCustomGame({
          source: 'folder',
          folder,
          displayName: cg.displayName,
          loaderChoice: cg.loaderChoice
        })
      ).label
    }
    const domain = nexusDomainOf(game)
    if (!domain) throw unknownGame(game)
    return (await api.addNexusGame(domain)).label
  }

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
            r = await api.ghInstall(game, profileId, url, { provides })
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

  /**
   * Writes the shared config files over whatever the installs created. A file that can't be
   * written doesn't stop the rest; it comes back as a warning.
   */
  async function writeConfigs(
    game: string,
    profileId: string,
    configs: Map<string, Uint8Array>
  ): Promise<string[]> {
    const root = path.resolve(deps.paths.profileDir(game, profileId))
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

  /** Reads the manifest and zips the profile under the profile lock, so installs can't interleave. */
  async function build(
    game: string,
    profileId: string
  ): Promise<{ profile: ProfileManifest; data: Uint8Array }> {
    const def = await requireGame(game)
    return serialize(def.label, profileId, async () => {
      const profile = await getProfile(deps.paths, def.label, profileId)
      const customGame = (await ctx.getCustomGame(def.label)) ?? undefined
      const data = await buildHmlFile(profile, deps.paths.profileDir(def.label, profileId), {
        customGame
      })
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
      // Write beside the target and rename, so a failed write never leaves a half-written file.
      const tmp = `${target}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(tmp, data)
        await fs.rename(tmp, target)
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
        throw e
      }
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
        // Checked before reading, so a huge file is never loaded into memory.
        if ((await fs.stat(files[0])).size > MAX_HML_BYTES) throw new Error(IMPORT_TOO_BIG)
        data = new Uint8Array(await fs.readFile(files[0]))
      } else if (input && typeof input === 'object' && 'code' in input) {
        data = await downloadShare(
          { fetch: deps.fetch, base: deps.shareBaseUrl },
          String(input.code)
        )
      } else {
        throw new Error('Expected a share code or a file.')
      }
      const read = await readHmlFile(data, { forImport: true })
      const exp = read.export
      const def = await findGame(exp.game)
      const domain = def || exp.customGame ? null : nexusDomainOf(exp.game)
      if (!def && !domain && !exp.customGame) throw unknownGame(exp.game)
      const plan = !def && exp.customGame ? await customPlan(exp.customGame) : null
      dropExpired()
      const token = randomUUID()
      pending.set(token, { ...read, expiresAt: now() + PENDING_MS })
      return {
        token,
        game: exp.game,
        // A Nexus game that isn't added yet is named by its domain until the import adds it.
        gameName:
          def?.displayName ?? plan?.def?.displayName ?? exp.customGame?.displayName ?? domain!,
        profileName: exp.profileName,
        mods: exp.mods.map((m) => ({ name: modName(m), version: m.version, kind: m.source.kind })),
        configFiles: read.configs.size,
        ...(plan?.needsFolder ? { needsFolder: true } : {})
      }
    },

    async importShare(token, name, folder) {
      // Looked up, checked and claimed synchronously, so two imports of one token can't both run.
      const held = typeof token === 'string' ? pending.get(token) : undefined
      if (!held || inFlight.has(token)) throw new Error(EXPIRED)
      if (held.expiresAt <= now()) {
        pending.delete(token)
        throw new Error(EXPIRED)
      }
      inFlight.add(token)
      const exp = held.export
      let game: string
      let created: ProfileManifest
      try {
        game = await resolveGame(exp, typeof folder === 'string' ? folder : undefined)
        const wanted = typeof name === 'string' ? name.trim() : ''
        created = await api.createProfile(game, wanted || exp.profileName)
      } finally {
        inFlight.delete(token)
      }
      // Only spent once the profile exists: an earlier failure (Nexus unreachable) can be retried.
      pending.delete(token)
      const profileId = created.id

      // At most one forced Thunderstore index refresh per import, shared by every entry.
      let refreshed: Promise<void> | null = null
      const refreshOnce = (): Promise<void> =>
        (refreshed ??= api.tsRefresh(game).then(
          () => undefined,
          () => undefined
        ))

      // Installs call the service methods directly: each takes this profile's lock itself, and
      // the lock isn't re-entrant, so wrapping them here would deadlock.
      const unresolved: UnresolvedMod[] = []
      const warnings: string[] = []
      const installedIds: (string | null)[] = []
      const total = exp.mods.length
      for (const [i, entry] of exp.mods.entries()) {
        deps.emit({ type: 'progress', message: `Importing ${modName(entry)}`, done: i, total })
        const r = await installEntry(game, profileId, entry, refreshOnce)
        if ('unresolved' in r) {
          unresolved.push(r.unresolved)
          installedIds.push(null)
        } else {
          installedIds.push(r.modId)
          warnings.push(...r.warnings)
        }
      }

      // A later install can move a listed Thunderstore mod to another version through its
      // dependencies; the version the export records wins.
      for (const [i, entry] of exp.mods.entries()) {
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
        warnings.push(
          ...(await serialize(game, profileId, () => writeConfigs(game, profileId, held.configs)))
        )
      } catch (e) {
        warnings.push(`The config files couldn't be restored: ${errMsg(e)}`)
      }
      deps.emit({ type: 'progress', message: 'Done', done: total, total })

      // The profile exists by now, so a failed read falls back to the created manifest.
      let profile: ProfileManifest
      try {
        profile = await getProfile(deps.paths, game, profileId)
      } catch (e) {
        profile = created
        warnings.push(`The imported profile couldn't be read back: ${errMsg(e)}`)
      }

      return {
        game,
        profile,
        installed: installedIds.filter((id) => id !== null).length,
        unresolved,
        warnings
      } satisfies ImportResult
    }
  }
}
