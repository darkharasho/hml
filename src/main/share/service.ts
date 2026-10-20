import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { HmlApi } from '../../shared/ipc'
import type {
  Catalog,
  GameDef,
  HmlCustomGame,
  HmlExport,
  ImportResult,
  ModSource,
  ProfileManifest,
  UnresolvedMod
} from '../../shared/types'
import { normalizeSyncCode } from '../../shared/shareCode'
import { getProfile, RESERVED } from '../profiles/profiles'
import type { ServiceDeps } from '../services'
import { buildHmlFile, IMPORT_TOO_BIG, MAX_HML_BYTES, readHmlFile } from './hmlFile'
import {
  createEntryInstaller,
  errMsg,
  modName,
  writeConfigFiles,
  type ShareInstallers
} from './entries'
import { downloadShare, uploadShare } from './client'
import { downloadR2modman, isR2modmanCode, readR2modman } from './r2modman'

export type { ShareInstallers }

export interface ShareContext {
  deps: ServiceDeps
  getCatalog(): Promise<Catalog>
  requireGame(label: string): Promise<{ label: string }>
  serialize<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T>
  installers: ShareInstallers
  /** A stored folder game with this display name (case-insensitive). */
  findCustomGameByName(displayName: string): Promise<GameDef | undefined>
  /** A stored custom game whose game folder is this one. */
  findCustomGameByFolder(folder: string): Promise<GameDef | undefined>
  /** Whether Steam has this app installed on this PC. */
  isSteamAppInstalled(appId: string): Promise<boolean>
  /** The stored custom-game entry for a label, if it is one. */
  getCustomGame(label: string): Promise<HmlCustomGame | null>
  /** Icons and descriptions of mods shared for `game`, in order; never throws. */
  describeMods(game: string, sources: ModSource[]): ReturnType<HmlApi['shareModDetails']>
  /** Sync codes; bound late by services.ts. Without it, sync codes are refused. */
  sync?: ShareSync
}

export interface ShareSync {
  fetchLatest(code: string): Promise<{ revision: number; data: Uint8Array }>
  findByCode(code: string): Promise<{ game: string; profileId: string } | null>
  attachFollower(
    game: string,
    profileId: string,
    code: string,
    revision: number,
    configs: Map<string, Uint8Array>,
    opts?: { behind?: boolean }
  ): Promise<void>
}

type ShareApi = Pick<
  HmlApi,
  'exportProfileFile' | 'shareProfile' | 'previewShare' | 'shareModDetails' | 'importShare'
>

const PENDING_MS = 600_000
const EXPIRED = 'This import has expired. Open the code or file again.'
const R2_NO_GAME =
  "r2modman profiles don't say which game they're for. Open the game first, then import."
const SYNC_UNAVAILABLE = 'Syncing is unavailable right now.'
const NEXUS_PREFIX = 'nexus-'
const NEXUS_DOMAIN_RE = /^[a-z0-9_-]{1,64}$/

interface Pending {
  export: HmlExport
  configs: Map<string, Uint8Array>
  expiresAt: number
  /** A sync code's revision: importing makes the profile follow it. */
  sync?: { code: string; revision: number }
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
  const entries = createEntryInstaller({ deps, installers: api })

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
        // Already stored: used as-is, so the file can't change its name or loader.
        const stored = cg.steamAppId ? await findGame(`steam-${cg.steamAppId}`) : undefined
        if (stored) return stored.label
        return (
          await api.addCustomGame({
            source: 'steam',
            steamAppId: cg.steamAppId!,
            loaderChoice: cg.loaderChoice
          })
        ).label
      }
      if (!folder) throw new Error('Choose the game folder to import this profile.')
      // A folder that already belongs to a stored game keeps that game's name and loader.
      const owner = await ctx.findCustomGameByFolder(folder)
      if (owner) return owner.label
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
      let r2 = false
      let sync: Pending['sync']
      if (input && typeof input === 'object' && 'file' in input && input.file === true) {
        const files = await deps.dialog.pickFiles({
          title: 'Import profile',
          filters: [{ name: 'HML or r2modman profile', extensions: ['hml', 'r2z'] }]
        })
        if (files.length === 0) return null
        r2 = files[0].toLowerCase().endsWith('.r2z')
        // Checked before reading, so a huge file is never loaded into memory.
        if ((await fs.stat(files[0])).size > MAX_HML_BYTES) throw new Error(IMPORT_TOO_BIG)
        data = new Uint8Array(await fs.readFile(files[0]))
      } else if (input && typeof input === 'object' && 'code' in input) {
        const code = String(input.code)
        const syncCode = normalizeSyncCode(code)
        if (syncCode) {
          if (!ctx.sync) throw new Error(SYNC_UNAVAILABLE)
          // Already followed here: the UI offers to open that profile instead of a second copy.
          const existing = await ctx.sync.findByCode(syncCode)
          // A profile deleted since it was found falls through to a normal preview.
          const profile =
            existing &&
            (await getProfile(deps.paths, existing.game, existing.profileId).catch(() => null))
          if (existing && profile) {
            const def = await findGame(existing.game)
            return {
              token: '',
              game: existing.game,
              gameName: def?.displayName ?? existing.game,
              profileName: profile.name,
              mods: [],
              configFiles: 0,
              sync: true,
              existing
            }
          }
          const latest = await ctx.sync.fetchLatest(syncCode)
          data = latest.data
          sync = { code: syncCode, revision: latest.revision }
        } else {
          r2 = isR2modmanCode(code)
          data = r2
            ? await downloadR2modman({ fetch: deps.fetch }, code)
            : await downloadShare({ fetch: deps.fetch, base: deps.shareBaseUrl }, code)
        }
      } else {
        throw new Error('Expected a share code or a file.')
      }
      // An r2modman profile doesn't name its game, so it goes to the open one, as in r2modman.
      let r2game: string | null = null
      if (r2) {
        const label = typeof input.game === 'string' ? input.game : ''
        if (!label || !(await findGame(label))) throw new Error(R2_NO_GAME)
        r2game = label
      }
      const read = r2game
        ? readR2modman(data, r2game)
        : await readHmlFile(data, { forImport: true })
      const exp = read.export
      const def = await findGame(exp.game)
      const domain = def || exp.customGame ? null : nexusDomainOf(exp.game)
      if (!def && !domain && !exp.customGame) throw unknownGame(exp.game)
      const plan = !def && exp.customGame ? await customPlan(exp.customGame) : null
      dropExpired()
      const token = randomUUID()
      pending.set(token, { ...read, expiresAt: now() + PENDING_MS, ...(sync ? { sync } : {}) })
      return {
        token,
        game: exp.game,
        // A Nexus game that isn't added yet is named by its domain until the import adds it.
        gameName:
          def?.displayName ?? plan?.def?.displayName ?? exp.customGame?.displayName ?? domain!,
        profileName: exp.profileName,
        mods: exp.mods.map((m) => ({ name: modName(m), version: m.version, kind: m.source.kind })),
        configFiles: read.configs.size,
        ...(plan?.needsFolder ? { needsFolder: true } : {}),
        ...(r2game ? { fromR2modman: true as const } : {}),
        ...(sync ? { sync: true as const } : {})
      }
    },

    async shareModDetails(token) {
      const held = typeof token === 'string' ? pending.get(token) : undefined
      if (!held || held.expiresAt <= now()) throw new Error(EXPIRED)
      const exp = held.export
      return ctx.describeMods(
        exp.game,
        exp.mods.map((m) => m.source)
      )
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
      const refreshOnce = entries.refresher(game)

      // Installs call the service methods directly: each takes this profile's lock itself, and
      // the lock isn't re-entrant, so wrapping them here would deadlock.
      const unresolved: UnresolvedMod[] = []
      const warnings: string[] = []
      const installedIds: (string | null)[] = []
      const total = exp.mods.length
      for (const [i, entry] of exp.mods.entries()) {
        deps.emit({ type: 'progress', message: `Importing ${modName(entry)}`, done: i, total })
        const r = await entries.installEntry(game, profileId, entry, refreshOnce)
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
      warnings.push(...(await entries.repinThunderstore(game, profileId, exp.mods, installedIds)))

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
          ...(await serialize(game, profileId, () =>
            writeConfigFiles(deps.paths.profileDir(game, profileId), held.configs)
          ))
        )
      } catch (e) {
        warnings.push(`The config files couldn't be restored: ${errMsg(e)}`)
      }
      if (held.sync) {
        try {
          if (!ctx.sync) throw new Error(SYNC_UNAVAILABLE)
          await ctx.sync.attachFollower(
            game,
            profileId,
            held.sync.code,
            held.sync.revision,
            held.configs,
            // A mod that didn't install is retried by the next check (the owner's local mods are
            // never synced, so they don't count).
            { behind: unresolved.some((u) => u.kind !== 'local') }
          )
        } catch (e) {
          warnings.push(`This profile couldn't be set to follow its sync code: ${errMsg(e)}`)
        }
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
