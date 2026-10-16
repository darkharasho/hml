import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  Catalog,
  GameDef,
  InstalledMod,
  LaunchMode,
  LaunchWarning,
  Settings
} from '../shared/types'
import type { GameSummary, HmlApi } from '../shared/ipc'
import type { AppPaths } from './store/paths'
import { loadCatalog } from './catalog/catalog'
import { rankGame, searchGames } from './catalog/ecosystem'
import {
  findSteamRoot,
  isFlatpakSteam,
  readWinSteamPath,
  steamRootCandidates,
  type ExecFilePort
} from './steam/steam'
import { loadSettings, resolveGameDir, saveSettings } from './store/settings'
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  renameProfile
} from './profiles/profiles'
import { installZip, setModEnabled, uninstallMod } from './install/installer'
import { buildLaunchPlan } from './launch/launchPlan'
import {
  detectDoorstopVersion,
  findPreloader,
  isProtonGame,
  launch,
  launchWarnings,
  NATIVE_LINUX_UNSUPPORTED
} from './launch/launcher'

export interface DialogPort {
  pickFiles(opts: {
    title: string
    filters: { name: string; extensions: string[] }[]
  }): Promise<string[]>
  pickFolder(title: string): Promise<string | null>
}
export interface ShellPort {
  /** Resolves to an error message, or '' on success (Electron's shell.openPath). */
  openPath(p: string): Promise<string>
}
export type SpawnPort = typeof nodeSpawn

export interface ServiceDeps {
  paths: AppPaths
  fetch: typeof fetch
  snapshotPath: string
  platform: NodeJS.Platform
  home: string
  dialog: DialogPort
  shell: ShellPort
  spawn: SpawnPort
  /** Used for the Windows registry lookup of Steam (`reg query`). */
  execFile: ExecFilePort
}

const DEFAULT_PRELOADER = 'BepInEx/core/BepInEx.Preloader.dll'

async function assertZipFile(file: string): Promise<void> {
  const name = path.basename(file)
  if (!path.isAbsolute(file)) throw new Error(`${name}: expected an absolute file path.`)
  if (!file.toLowerCase().endsWith('.zip')) {
    throw new Error(`${name} is not a .zip file. HML installs mods from zip archives.`)
  }
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error(`${name} was not found or is not a file.`)
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createServices(deps: ServiceDeps): HmlApi {
  const { paths } = deps
  const platform: 'win32' | 'linux' = deps.platform === 'win32' ? 'win32' : 'linux'

  let catalogPromise: Promise<Catalog> | null = null
  const getCatalog = (): Promise<Catalog> => {
    catalogPromise ??= loadCatalog(paths, deps.fetch, deps.snapshotPath).catch((e) => {
      catalogPromise = null
      throw e
    })
    return catalogPromise
  }

  async function requireGame(label: string): Promise<GameDef> {
    const game = (await getCatalog()).games.find((g) => g.label === label)
    if (!game) throw new Error(`Unknown game: ${label}`)
    return game
  }

  let steamRootPromise: Promise<string | null> | null = null
  const invalidateSteamRoot = (): void => {
    steamRootPromise = null
  }
  const getSteamRoot = (): Promise<string | null> => {
    steamRootPromise ??= (async () => {
      const { steamRootOverride } = await loadSettings(paths)
      if (steamRootOverride) return steamRootOverride
      const winSteamPath = deps.platform === 'win32' ? await readWinSteamPath(deps.execFile) : null
      return findSteamRoot(steamRootCandidates(deps.platform, deps.home, winSteamPath ?? undefined))
    })().catch((e) => {
      steamRootPromise = null
      throw e
    })
    return steamRootPromise
  }

  // Serializes mutating operations on one profile.
  const tails = new Map<string, Promise<void>>()
  function serialize<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${game}/${profileId}`
    const run = (tails.get(key) ?? Promise.resolve()).then(fn)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }

  async function setGamePath(label: string, dir: string | null): Promise<void> {
    await requireGame(label)
    const settings = await loadSettings(paths)
    const overrides = { ...settings.gamePathOverrides }
    if (dir) overrides[label] = dir
    else delete overrides[label]
    await saveSettings(paths, { ...settings, gamePathOverrides: overrides })
    invalidateSteamRoot()
  }

  /** Installs zips sequentially on the profile's queue, with source kind 'local'. */
  async function installLocalFiles(
    def: GameDef,
    profileId: string,
    files: string[]
  ): Promise<InstalledMod[]> {
    const catalog = await getCatalog()
    return serialize(def.label, profileId, async () => {
      const installed: InstalledMod[] = []
      for (const file of files) {
        const fileName = path.basename(file)
        try {
          const data = await fs.readFile(file)
          const sha256 = createHash('sha256').update(data).digest('hex')
          installed.push(
            await installZip(paths, def, catalog, profileId, data, {
              kind: 'local',
              fileName,
              sha256
            })
          )
        } catch (e) {
          throw new Error(`Could not install ${fileName}: ${errMsg(e)}`, { cause: e })
        }
      }
      return installed
    })
  }

  return {
    async searchGames(query: string): Promise<GameSummary[]> {
      const catalog = await getCatalog()
      const ranked = searchGames(catalog.games, query)
      const settings = await loadSettings(paths)
      const steamRoot = await getSteamRoot()
      const summaries = await Promise.all(
        ranked.map(async (g): Promise<GameSummary> => ({
          ...g,
          installDir: await resolveGameDir(g, settings, steamRoot).catch(() => null)
        }))
      )
      // Rank group first, then installed before not installed, then searchGames' own order.
      const q = query.trim().toLowerCase()
      return summaries
        .map((g, i) => ({ g, i, rank: q ? rankGame(g, q) : 0, installed: g.installDir ? 0 : 1 }))
        .sort((a, b) => a.rank - b.rank || a.installed - b.installed || a.i - b.i)
        .map((x) => x.g)
    },

    async refreshCatalog(): Promise<void> {
      catalogPromise = null
      // Force a refetch by bypassing the cache age (maxAge 0).
      const fresh = loadCatalog(paths, deps.fetch, deps.snapshotPath, 0)
      catalogPromise = fresh.catch((e) => {
        catalogPromise = null
        throw e
      })
      await catalogPromise
    },

    setGamePath,

    async pickGamePath(label: string): Promise<string | null> {
      const game = await requireGame(label)
      const dir = await deps.dialog.pickFolder(`Select the ${game.displayName} install folder`)
      if (!dir) return null
      await setGamePath(label, dir)
      return dir
    },

    listProfiles: (game) => listProfiles(paths, game),
    createProfile: (game, name) => createProfile(paths, game, name),
    renameProfile: (game, id, name) =>
      serialize(game, id, () => renameProfile(paths, game, id, name)),
    deleteProfile: (game, id) => serialize(game, id, () => deleteProfile(paths, game, id)),

    async installFromFile(game: string, profileId: string): Promise<InstalledMod[]> {
      const def = await requireGame(game)
      const files = await deps.dialog.pickFiles({
        title: 'Select mod zip files',
        filters: [{ name: 'Zip archives', extensions: ['zip'] }]
      })
      if (files.length === 0) return []
      return installLocalFiles(def, profileId, files)
    },

    async installFromPaths(
      game: string,
      profileId: string,
      files: string[]
    ): Promise<InstalledMod[]> {
      const def = await requireGame(game)
      if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
        throw new Error('Expected a list of file paths.')
      }
      // Validate every path before installing any, so a bad drop installs nothing.
      for (const file of files) await assertZipFile(file)
      return installLocalFiles(def, profileId, files)
    },

    async setModEnabled(game, profileId, modId, enabled): Promise<void> {
      const def = await requireGame(game)
      return serialize(game, profileId, () => setModEnabled(paths, def, profileId, modId, enabled))
    },

    async uninstallMod(game, profileId, modId): Promise<void> {
      const def = await requireGame(game)
      return serialize(game, profileId, () => uninstallMod(paths, def, profileId, modId))
    },

    async getLaunchWarnings(game: string, profileId: string): Promise<LaunchWarning[]> {
      const def = await requireGame(game)
      await getProfile(paths, game, profileId)
      const steamRoot = await getSteamRoot()
      if (!steamRoot) return ['steam-not-found']
      const gameDir = await resolveGameDir(def, await loadSettings(paths), steamRoot)
      return launchWarnings({
        platform,
        game: def,
        gameDir,
        profileDir: paths.profileDir(game, profileId),
        steamRoot
      })
    },

    async launch(game: string, profileId: string | null, mode: LaunchMode): Promise<void> {
      if (mode !== 'modded' && mode !== 'vanilla') {
        throw new Error(`Unknown launch mode: ${String(mode)}`)
      }
      if (mode === 'modded' && !profileId) {
        throw new Error('Select a profile to launch with mods.')
      }
      const def = await requireGame(game)
      if (!def.steamAppId)
        throw new Error(`${def.displayName} has no Steam app id, so HML cannot launch it.`)
      const steamRoot = await getSteamRoot()
      if (!steamRoot) throw new Error('Steam was not found. Set the Steam folder in settings.')
      const gameDir = await resolveGameDir(def, await loadSettings(paths), steamRoot)
      if (!gameDir) {
        throw new Error(`${def.displayName} was not found. Choose its install folder first.`)
      }
      if (def.loader !== 'bepinex') {
        throw new Error(`${def.displayName} uses a mod loader HML does not support yet.`)
      }
      const proton = await isProtonGame(platform, gameDir, def.exeNames)
      if (mode === 'modded' && platform === 'linux' && !proton) {
        throw new Error(NATIVE_LINUX_UNSUPPORTED)
      }
      // Vanilla launches only toggle doorstop off, so no profile directory is involved; the
      // doorstop version comes from the ini already in the game install.
      const profileDir = profileId ? paths.profileDir(game, profileId) : paths.gameDir(game)
      if (profileId) await getProfile(paths, game, profileId)
      const modded = mode === 'modded'
      const preloader = (modded && (await findPreloader(profileDir))) || DEFAULT_PRELOADER
      const plan = buildLaunchPlan({
        platform,
        mode,
        steamRoot,
        steamAppId: def.steamAppId,
        flatpak: isFlatpakSteam(steamRoot),
        proton,
        profileDir,
        preloaderRelPath: preloader,
        doorstop: await detectDoorstopVersion(modded ? profileDir : gameDir)
      })
      try {
        await launch(plan, profileDir, gameDir, deps.spawn)
      } catch (e) {
        throw new Error(`Could not start Steam: ${errMsg(e)}`, { cause: e })
      }
    },

    async openProfileFolder(game: string, profileId: string): Promise<void> {
      await getProfile(paths, game, profileId)
      const error = await deps.shell.openPath(paths.profileDir(game, profileId))
      if (error) throw new Error(`Could not open the profile folder: ${error}`)
    },

    getSettings: () => loadSettings(paths),

    async saveSettings(s: Settings): Promise<void> {
      await saveSettings(paths, s)
      invalidateSteamRoot()
    },

    getGamesDataDir: async () => paths.gamesDir
  }
}
