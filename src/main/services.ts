import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  Catalog,
  GameDef,
  HmlEvent,
  InstalledMod,
  LaunchMode,
  LaunchWarning,
  LaunchWatchResult,
  Settings,
  TsPackage
} from '../shared/types'
import type { GameSummary, HmlApi } from '../shared/ipc'
import type { AppPaths } from './store/paths'
import { loadCatalog } from './catalog/catalog'
import { rankGame, searchGames } from './catalog/ecosystem'
import {
  findAppInstall,
  findSteamRoot,
  flatpakGrantsAccess,
  isFlatpakSteam,
  readWinSteamPath,
  steamRootCandidates,
  type ExecFilePort
} from './steam/steam'
import { isDirectory, loadSettings, resolveGameDir, updateSettings } from './store/settings'
import {
  createProfile,
  deleteProfile,
  duplicateProfile,
  getProfile,
  listProfiles,
  renameProfile,
  saveProfile
} from './profiles/profiles'
import { installZip, setModEnabled, uninstallMod } from './install/installer'
import { buildModDeps } from './thunderstore/modDeps'
import { listConfigFiles, readConfigFile, writeConfigFile } from './config/configFiles'
import { readLogFrom } from './logs/logTail'
import { buildDirectLaunchPlan, buildLaunchPlan, buildSteamPlainPlan } from './launch/launchPlan'
import {
  isGameProcessRunning,
  isGameRunning,
  waitForGameStart,
  type ProcFsPort
} from './launch/processes'
import {
  detectDoorstopVersion,
  findPreloader,
  isProtonGame,
  launch,
  launchWarnings,
  NATIVE_LINUX_UNSUPPORTED
} from './launch/launcher'
import { loadPackageIndex, type TsIndex } from './thunderstore/packageIndex'
import { allCategories, searchPackages } from './thunderstore/search'
import {
  compareVersions,
  findUpdates,
  githubByName,
  installedVersions,
  mergePlans,
  providedPackages,
  resolveInstall,
  type PlannedPackage,
  type StandIn
} from './thunderstore/resolve'
import { downloadPackage } from './thunderstore/download'
import { parseAllowedExternalUrl } from './security'
import type { SecretPort } from './github/token'
import { createGithubServices, unsupportedLoaderMessage } from './github/service'
import {
  deployedProfileId,
  deployProfile,
  deploymentStatus,
  otherDeploymentAt,
  removeDeployment
} from './deploy/deploy'
import { createNexusGames } from './nexus/games'
import {
  catalogTwin,
  createCustomGames,
  customGameDef,
  withInstalledSteamIds
} from './custom/customGames'
import { listInstalledApps, type InstalledApp } from './steam/installedApps'
import { createCustomGameServices, customLoaderSpec, loaderMismatch } from './custom/service'
import { createNexusServices } from './nexus/service'
import { createShareServices } from './share/service'
import { gameByDomain } from './nexus/api'
import { parseNxm, type HandlerPort } from './nexus/nxm'
import { findInstalledMod, providesPackage } from '../shared/modIdentity'
import {
  createSteamArt,
  findLibraryCover,
  findLibraryHero,
  isAppId,
  steamCdnCover,
  steamHeroUrls
} from './art/steamArt'
import { createTsIcons, modIconCandidates, modIconPath } from './art/modIcons'
import { ensureDllOverride, type ProxyDll } from './steam/protonPrefix'
import {
  hasShimloader,
  linkShimloader,
  shimBinDir,
  shimloaderArgs,
  unlinkShimloader
} from './launch/shimloader'
import { createTsDocs } from './thunderstore/docs'
import { pickAccent } from './art/accent'
import { ART_SCHEME, resolveArt, serveArt, steamArtUrl, type ArtSources } from './art/protocol'

export interface DialogPort {
  pickFiles(opts: {
    title: string
    filters: { name: string; extensions: string[] }[]
  }): Promise<string[]>
  pickFolder(title: string): Promise<string | null>
  /** Resolves to the chosen path, or null when cancelled. */
  saveFile(opts: {
    title: string
    defaultPath: string
    filters: { name: string; extensions: string[] }[]
  }): Promise<string | null>
}
export interface ShellPort {
  /** Resolves to an error message, or '' on success (Electron's shell.openPath). */
  openPath(p: string): Promise<string>
  openExternal(url: string): Promise<void>
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
  /** Progress events for long operations (sent to the renderer as hml:event). */
  emit(e: HmlEvent): void
  /** Encrypts the GitHub token at rest (Electron safeStorage). */
  secrets: SecretPort
  /** Clock for index freshness; defaults to Date.now. */
  now?: () => number
  /** Waits between checks while Steam shuts down; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>
  /** HML's version, sent to Nexus Mods in request headers. */
  appVersion: string
  /** OS details for the Nexus User-Agent. */
  os: { type: string; release: string; arch: string }
  /** Registers and reports HML as the operating system's `nxm://` handler. */
  nxmHandler: HandlerPort
  /** Base URL of the share-code Worker. */
  shareBaseUrl: string
  /** Folder of Flatpak's system-wide overrides; defaults to /var/lib/flatpak/overrides. */
  flatpakSystemOverridesDir?: string
  /**
   * Decodes a PNG or JPEG to RGBA pixels (Electron's nativeImage), for taking a game's accent
   * colour from its cover. Unset (as in tests) means no accent colours.
   */
  decodeImage?: (data: Buffer) => Uint8Array | null
  /** Linux process list for confirming a launch; defaults to the real /proc. */
  procFs?: ProcFsPort
  /** Clock and timer for waitForGame; default to the real ones. */
  launchWatch?: { now(): number; sleep(ms: number): Promise<void> }
}

interface LoadedIndex extends TsIndex {
  stale: boolean
  byName: Map<string, TsPackage>
  categories: string[]
  /** When this process loaded it (ms), for retrying a stale index. */
  loadedAt: number
}
interface IndexSlot {
  /** Whether this load was forced (a user refresh), so a second forced call can share it. */
  forced: boolean
  promise: Promise<LoadedIndex>
  /** Set once the load resolved. */
  value?: LoadedIndex
  /** An in-flight background refresh of an expired or stale value. */
  refreshing?: Promise<LoadedIndex>
}
const INDEX_LRU = 2
const INDEX_MAX_AGE_MS = 3_600_000
/** A stale (offline) index is retried at most this often. */
const STALE_RETRY_MS = 30_000

/** Cover downloads for accent colours give up after this long, or past this size. */
const ACCENT_FETCH_TIMEOUT_MS = 5_000
const ACCENT_MAX_BYTES = 8_000_000
/** How long the installed Steam apps are reused before they are looked up again. */
const INSTALLED_APPS_TTL_MS = 30_000
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

export function createServices(deps: ServiceDeps): HmlApi & {
  ghAutoUpdateAll(): Promise<void>
  handleNxm(raw: string): Promise<void>
  /** Answers an `hml-art://` request (the protocol handler in index.ts). */
  serveArt(url: string): Promise<Response>
  /** Stops every waitForGame (the window closed or reloaded, so nobody is waiting). */
  cancelLaunchWatches(): void
} {
  const { paths } = deps
  const platform: 'win32' | 'linux' = deps.platform === 'win32' ? 'win32' : 'linux'
  const now = deps.now ?? Date.now

  const nexusClient = { fetch: deps.fetch, appVersion: deps.appVersion, os: deps.os }
  const nexus = createNexusGames({ paths, client: nexusClient, now })

  const customGames = createCustomGames(paths)

  let catalogPromise: Promise<Catalog> | null = null
  const getBaseCatalog = (): Promise<Catalog> => {
    catalogPromise ??= loadCatalog(paths, deps.fetch, deps.snapshotPath).catch((e) => {
      catalogPromise = null
      throw e
    })
    return catalogPromise
  }
  /**
   * The installed Steam apps (none without Steam), looked up again after INSTALLED_APPS_TTL_MS or
   * when the Steam folder may have changed.
   */
  let appsCache: { at: number; apps: Promise<InstalledApp[]> } | null = null
  const installedApps = (): Promise<InstalledApp[]> => {
    if (!appsCache || now() - appsCache.at > INSTALLED_APPS_TTL_MS) {
      const apps = getSteamRoot()
        .then((root) => (root ? listInstalledApps(root) : []))
        .catch(() => [])
      appsCache = { at: now(), apps }
    }
    return appsCache.apps
  }

  /**
   * The ecosystem catalog plus the user's added Nexus-only and custom games, with Steam app ids
   * the catalog leaves out taken from the installed Steam apps.
   */
  const getCatalog = async (): Promise<Catalog> => {
    const base = await getBaseCatalog()
    const have = new Set(base.games.map((g) => g.label))
    const added = (await nexus.addedGames()).filter((g) => !have.has(g.label))
    const games = withInstalledSteamIds([...base.games, ...added], await installedApps())
    for (const g of await customGames.list()) {
      if (!games.some((x) => x.label === g.label)) games.push(customGameDef(g))
    }
    return { ...base, games }
  }

  /** A deploy game's folder: the override, when it is an existing folder. */
  const deployFolder = async (g: GameDef, settings: Settings): Promise<string | null> => {
    const dir = settings.gamePathOverrides[g.label]
    if (dir && (await isDirectory(dir))) return dir
    if (dir || !g.steamAppId) return null
    // A Steam game without a loader (custom) is found through Steam.
    const root = await getSteamRoot().catch(() => null)
    const found = root ? await findAppInstall(root, g.steamAppId).catch(() => null) : null
    return found && (await isDirectory(found)) ? found : null
  }

  const summarize = (
    g: GameDef,
    catalog: Catalog,
    settings: Settings,
    steamRoot: string | null
  ): Promise<GameSummary> =>
    g.loader === 'deploy'
      ? deployFolder(g, settings).then((installDir) => ({
          ...g,
          loaderPackageIds: [],
          installDir
        }))
      : resolveGameDir(g, settings, steamRoot)
          .catch(() => null)
          .then((installDir) => ({
            ...g,
            loaderPackageIds: catalog.modloaderPackages
              .filter((m) => m.loader === g.loader)
              .map((m) => m.packageId),
            installDir
          }))

  async function requireGame(label: string): Promise<GameDef> {
    const game = (await getCatalog()).games.find((g) => g.label === label)
    if (!game) throw new Error(`Unknown game: ${label}`)
    return game
  }

  let steamRootPromise: Promise<string | null> | null = null
  const invalidateSteamRoot = (): void => {
    steamRootPromise = null
    appsCache = null
  }
  const getSteamRoot = (): Promise<string | null> => {
    if (steamRootPromise) return steamRootPromise
    const p: Promise<string | null> = (async () => {
      const { steamRootOverride } = await loadSettings(paths)
      if (steamRootOverride) return steamRootOverride
      const winSteamPath = deps.platform === 'win32' ? await readWinSteamPath(deps.execFile) : null
      return findSteamRoot(steamRootCandidates(deps.platform, deps.home, winSteamPath ?? undefined))
    })().then(
      (root) => {
        // A Steam that isn't there yet (installed or mounted later) is looked for again.
        if (root === null && steamRootPromise === p) steamRootPromise = null
        return root
      },
      (e: unknown) => {
        if (steamRootPromise === p) steamRootPromise = null
        throw e
      }
    )
    steamRootPromise = p
    return p
  }

  const steamArt = createSteamArt({
    fetch: deps.fetch,
    getSteamRoot: () => getSteamRoot(),
    cacheFile: paths.steamArtCache,
    now
  })
  const tsIcons = createTsIcons({ fetch: deps.fetch, cacheFile: paths.tsIconCache, now })
  const tsDocs = createTsDocs({ fetch: deps.fetch })

  /**
   * Gives custom Steam games and installed Steam games in search the best Steam cover known now,
   * and every Steam game its banner URLs. Store capsules not cached yet are looked up in the
   * background (one batched request) and show from the next search on, so search never waits for
   * the store. A cover the user chose stays first.
   */
  async function withArt(games: GameSummary[]): Promise<GameSummary[]> {
    const ids = games.flatMap((g) => (g.custom && g.steamAppId ? [g.steamAppId] : []))
    const covers = ids.length > 0 ? await steamArt.covers(ids) : new Map<string, string[]>()
    return games.map((g) => {
      const heroes = g.steamAppId ? steamHeroUrls(g.steamAppId) : []
      const withHero = heroes.length > 0 ? { ...g, heroUrls: heroes } : g
      const art = g.custom && g.steamAppId ? covers.get(g.steamAppId) : undefined
      if (!art || art.length === 0) return withHero
      return g.custom?.image
        ? { ...withHero, iconFallbacks: art }
        : { ...withHero, iconUrl: art[0], iconFallbacks: art.slice(1) }
    })
  }

  /**
   * Games the picker leaves out because another entry is the same game. A Nexus-only game added
   * before HML knew it was a catalog game's twin stays usable, but the catalog game shows alone.
   * An added Steam game can be a catalog game HML didn't recognize when it was added; of the two,
   * the catalog game shows, unless HML can't mod it but the copy can.
   */
  async function hiddenTwins(
    catalog: Catalog,
    settings: Settings,
    steamRoot: string | null
  ): Promise<Set<string>> {
    const twins = new Set<string>()
    for (const g of catalog.games) {
      if (!g.label.startsWith('nexus-')) continue
      if (
        await nexus.twinOf(g.label.slice('nexus-'.length), catalog.games, settings, g.displayName)
      )
        twins.add(g.label)
    }
    const added = catalog.games.filter((g) => g.custom?.source === 'steam' && g.steamAppId)
    if (added.length > 0 && steamRoot) {
      const apps = await installedApps()
      for (const g of added) {
        const app = apps.find((a) => a.appId === g.steamAppId)
        const twin = app && catalogTwin(catalog.games, app)
        if (twin) twins.add(twin.supported ? g.label : twin.label)
      }
    }
    return twins
  }

  async function getGameSummary(label: string): Promise<GameSummary | null> {
    const catalog = await getCatalog()
    const def = catalog.games.find((g) => g.label === label)
    if (!def) return null
    const settings = await loadSettings(paths)
    const steamRoot = await getSteamRoot()
    const summary = await summarize(def, catalog, settings, steamRoot)
    const hidden = (await hiddenTwins(catalog, settings, steamRoot)).has(label)
    return (await withArt([hidden ? { ...summary, hidden } : summary]))[0]
  }

  /** Whether the user's Flatpak overrides already give Steam access to HML's games folder. */
  async function flatpakAccess(): Promise<boolean> {
    const app = 'com.valvesoftware.Steam'
    const read = (file: string): Promise<string> => fs.readFile(file, 'utf8').catch(() => '')
    const system = await read(
      path.join(deps.flatpakSystemOverridesDir ?? '/var/lib/flatpak/overrides', app)
    )
    const user = await read(path.join(deps.home, '.local', 'share', 'flatpak', 'overrides', app))
    // The user's file comes last so its `!` entries and grants are read after the system's.
    return flatpakGrantsAccess(`${system}\n${user}`, paths.gamesDir, deps.home)
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

  /**
   * Refuses to change a game's mods while it runs on Windows, which locks the files it has open.
   * When tasklist fails the game counts as closed, so a flaky check doesn't lock the user out.
   */
  async function assertGameClosed(def: GameDef): Promise<void> {
    if (await isGameRunning(deps.platform, deps.execFile, def.exeNames, false)) {
      throw new Error(`Close ${def.displayName} before changing its mods.`)
    }
  }

  const DEPLOY_KEY = '__deploy__'
  /** A deploy game, or the readable reason it isn't one. */
  async function requireDeployGame(game: string): Promise<GameDef> {
    const def = await requireGame(game)
    if (def.loader !== 'deploy') throw new Error(`${def.displayName} doesn't use deployment.`)
    return def
  }
  /** A deploy game and its folder (the override), or the readable reason it has none. */
  async function requireDeploy(game: string): Promise<{ def: GameDef; gameDir: string }> {
    const def = await requireDeployGame(game)
    const settings = await loadSettings(paths)
    // Custom Steam games without a loader have no override: Steam knows their folder.
    const gameDir =
      settings.gamePathOverrides[def.label] ||
      (def.steamAppId ? await deployFolder(def, settings) : null)
    if (!gameDir) throw new Error('Set the game folder first.')
    return { def, gameDir }
  }

  const LOCK_ATTEMPTS = 5
  const LOCK_BUSY = 'The deployment kept changing while HML waited for it. Try again.'
  /** The deployed profile, or null when there is none or its id can't be used as a lock key. */
  async function lockableDeployedProfile(def: GameDef): Promise<string | null> {
    const id = await deployedProfileId(paths, def)
    return id === DEPLOY_KEY ? null : id
  }
  /**
   * Removes the deployment under the deployed profile's lock (copy-back writes into that
   * profile), then the deploy key. If another deployment replaced it while waiting, tries again.
   */
  async function removeDeploymentLocked(def: GameDef): Promise<void> {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      const owner = await lockableDeployedProfile(def)
      const remove = (): Promise<boolean> =>
        serialize(def.label, DEPLOY_KEY, async () => {
          if ((await lockableDeployedProfile(def)) !== owner) return false
          await removeDeployment(paths, def)
          return true
        })
      if (await (owner === null ? remove() : serialize(def.label, owner, remove))) return
    }
    throw new Error(LOCK_BUSY)
  }

  /** Refuses a folder that another deploy game has mods deployed to. */
  async function assertNoOtherDeployment(def: GameDef, dir: string): Promise<void> {
    const other = await otherDeploymentAt(paths, def.label, dir)
    if (other === null) return
    const name = (await getCatalog()).games.find((g) => g.label === other)?.displayName ?? other
    throw new Error(`${name} has mods deployed to this folder. Remove them in HML first.`)
  }

  async function setGamePath(label: string, dir: string | null): Promise<void> {
    const def = await requireGame(label)
    if (dir && def.loader === 'deploy') await assertNoOtherDeployment(def, dir)
    await updateSettings(paths, (settings) => {
      const overrides = { ...settings.gamePathOverrides }
      if (dir) overrides[label] = dir
      else delete overrides[label]
      return { ...settings, gamePathOverrides: overrides }
    })
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

  // In-memory index per game label, least recently used evicted beyond INDEX_LRU.
  const indexes = new Map<string, IndexSlot>()
  // When each game's index last failed to load, so a non-forced call doesn't refetch every time.
  const failedAt = new Map<string, { at: number; error: unknown }>()
  const touchIndex = (label: string, slot: IndexSlot): void => {
    indexes.delete(label)
    indexes.set(label, slot)
    while (indexes.size > INDEX_LRU) indexes.delete(indexes.keys().next().value as string)
  }
  function requireListing(def: GameDef): string {
    if (def.packageIndex === null)
      throw new Error(`${def.displayName} has no Thunderstore listing.`)
    return def.packageIndex
  }
  const expired = (v: LoadedIndex): boolean =>
    v.stale
      ? now() - v.loadedAt >= STALE_RETRY_MS
      : !(now() - Date.parse(v.fetchedAt) < INDEX_MAX_AGE_MS)
  function startIndexLoad(def: GameDef, indexUrl: string, force: boolean): IndexSlot {
    const slot: IndexSlot = {
      forced: force,
      promise: loadPackageIndex({
        paths,
        label: def.label,
        indexUrl,
        fetch: deps.fetch,
        now,
        maxAgeMs: INDEX_MAX_AGE_MS,
        force
      }).then((idx) => {
        const value: LoadedIndex = {
          ...idx,
          byName: new Map(idx.packages.map((pkg) => [pkg.fullName, pkg])),
          categories: allCategories(idx.packages),
          loadedAt: now()
        }
        slot.value = value
        return value
      })
    }
    return slot
  }
  function loadIndex(def: GameDef, force: boolean): Promise<LoadedIndex> {
    const indexUrl = requireListing(def)
    const hit = indexes.get(def.label)
    if (hit && !force) {
      touchIndex(def.label, hit)
      if (hit.refreshing) return hit.refreshing
      if (!hit.value || !expired(hit.value)) return hit.promise
      // Expired or stale: refresh, keeping the old index in the slot until the refresh settles,
      // and fall back to it if the refresh fails.
      const old = hit.value
      const next = startIndexLoad(def, indexUrl, false)
      const refreshing = next.promise.then(
        (v) => {
          if (indexes.get(def.label) === hit) touchIndex(def.label, next)
          return v
        },
        () => old
      )
      hit.refreshing = refreshing
      void refreshing.then(() => {
        if (hit.refreshing === refreshing) hit.refreshing = undefined
      })
      return refreshing
    }
    if (force && hit?.forced && !hit.value) return hit.promise
    const failure = failedAt.get(def.label)
    if (!force && failure && now() - failure.at < STALE_RETRY_MS)
      return Promise.reject(failure.error)
    const slot = startIndexLoad(def, indexUrl, force)
    // A failed load must not poison the slot: restore the previous index, if any.
    slot.promise = slot.promise.then(
      (v) => {
        failedAt.delete(def.label)
        return v
      },
      (e) => {
        failedAt.set(def.label, { at: now(), error: e })
        if (indexes.get(def.label) === slot) {
          indexes.delete(def.label)
          if (hit) touchIndex(def.label, hit)
        }
        throw e
      }
    )
    touchIndex(def.label, slot)
    return slot.promise
  }
  function requireInstallable(def: GameDef): void {
    requireListing(def)
    if (!def.supported) {
      throw new Error(unsupportedLoaderMessage(def))
    }
  }

  /**
   * Installs a resolved plan in order (dependencies first), inside the profile's queue. A local
   * mod whose id is a planned package's manifest name, or a mod that `provides` the package, is
   * replaced by the Thunderstore copy. A package in `held` is held (or freed) as it installs.
   */
  async function installPlan(
    def: GameDef,
    profileId: string,
    plan: PlannedPackage[],
    held: ReadonlyMap<string, boolean> = new Map()
  ): Promise<{ installed: InstalledMod[]; replaced: string[] }> {
    const catalog = await getCatalog()
    const loaders = await loaderIds(def)
    const installed: InstalledMod[] = []
    const replaced: string[] = []
    const total = plan.length
    for (const [i, pkg] of plan.entries()) {
      deps.emit({
        type: 'progress',
        message: `Installing ${pkg.name} ${pkg.version}`,
        done: i,
        total
      })
      try {
        const data = await downloadPackage({
          url: pkg.downloadUrl,
          fullName: pkg.fullName,
          version: pkg.version,
          downloadsDir: paths.downloads,
          fetch: deps.fetch
        })
        const { mods } = await getProfile(paths, def.label, profileId)
        const supersedes = mods
          .filter(
            (m) =>
              (m.source.kind === 'local' && m.id === pkg.name) ||
              (m.id !== pkg.fullName && providesPackage(m, pkg.fullName, loaders))
          )
          .map((m) => m.id)
        installed.push(
          await installZip(
            paths,
            def,
            catalog,
            profileId,
            data,
            { kind: 'thunderstore', fullName: pkg.fullName },
            {
              packageId: pkg.fullName,
              name: pkg.name,
              version: pkg.version,
              replaces: supersedes,
              held: held.get(pkg.fullName)
            }
          )
        )
        replaced.push(...supersedes)
      } catch (e) {
        throw new Error(`${pkg.fullName}: ${errMsg(e)}`, { cause: e })
      }
    }
    deps.emit({ type: 'progress', message: 'Done', done: total, total })
    return { installed, replaced }
  }

  /** Turns on installed-but-disabled mods that satisfied dependencies; returns their fullNames. */
  async function enableSatisfied(
    def: GameDef,
    profileId: string,
    fullNames: string[],
    loaders: string[]
  ): Promise<string[]> {
    const { mods } = await getProfile(paths, def.label, profileId)
    const enabled: string[] = []
    for (const fullName of fullNames) {
      const mod = findInstalledMod(mods, fullName, loaders)
      if (mod && !mod.enabled) {
        await setModEnabled(paths, def, profileId, mod.id, true)
        enabled.push(fullName)
      }
    }
    return enabled
  }

  /** Records on each GitHub mod the dependencies it stood in for, so later lookups agree. */
  async function recordStandIns(
    def: GameDef,
    profileId: string,
    standIns: StandIn[]
  ): Promise<void> {
    if (standIns.length === 0) return
    const profile = await getProfile(paths, def.label, profileId)
    await saveProfile(paths, {
      ...profile,
      mods: profile.mods.map((m) => {
        const add = standIns.filter((s) => s.modId === m.id).map((s) => s.fullName)
        return add.length > 0
          ? { ...m, provides: [...new Set([...(m.provides ?? []), ...add])] }
          : m
      })
    })
  }

  async function loaderIds(def: GameDef): Promise<string[]> {
    return (await getCatalog()).modloaderPackages
      .filter((m) => m.loader === def.loader)
      .map((m) => m.packageId)
  }

  /**
   * Installs a Thunderstore package with its dependencies. With `guard`, replacing installed files
   * under a running game is refused; a share import installs into its new profile without it.
   */
  async function tsInstallChecked(
    game: string,
    profileId: string,
    fullName: string,
    version: string | undefined,
    guard: boolean
  ): ReturnType<HmlApi['tsInstall']> {
    const def = await requireGame(game)
    requireInstallable(def)
    const idx = await loadIndex(def, false)
    const loaders = await loaderIds(def)
    const resolve = (mods: InstalledMod[]): ReturnType<typeof resolveInstall> => {
      const installedNow = installedVersions(mods, loaders)
      const provided = providedPackages(mods, loaders)
      // Installing a provided package itself replaces the mod that stands in for it.
      const tsCopy = mods.some(
        (m) => m.source.kind === 'thunderstore' && m.source.fullName === fullName
      )
      if (provided.has(fullName) && !tsCopy) installedNow.delete(fullName)
      provided.delete(fullName)
      return resolveInstall(
        idx.byName,
        { fullName, version },
        installedNow,
        provided,
        githubByName(mods)
      )
    }
    // Replacing installed files under a running game is refused, as for updates; installing
    // packages the profile doesn't have yet is allowed. Checked outside the profile's queue.
    if (guard) {
      const before = (await getProfile(paths, game, profileId)).mods
      const replacesInstalled = resolve(before).plan.some(
        (p) =>
          findInstalledMod(before, p.fullName, loaders) !== undefined ||
          before.some((m) => m.source.kind === 'local' && m.id === p.name)
      )
      if (replacesInstalled) await assertGameClosed(def)
    }
    return serialize(game, profileId, async () => {
      const profile = await getProfile(paths, game, profileId)
      const { plan, skipped, missing, standIns } = resolve(profile.mods)
      await recordStandIns(def, profileId, standIns)
      const satisfied = skipped.filter((s) => s !== fullName)
      const enabled = await enableSatisfied(def, profileId, satisfied, loaders)
      // Picking an older version holds the mod there, so updates don't undo the rollback;
      // picking the newest frees it.
      const held = new Map<string, boolean>()
      const versions = idx.byName.get(fullName)?.versions ?? []
      if (version !== undefined && versions.length > 0)
        held.set(
          fullName,
          versions.some((v) => compareVersions(v.version, version) > 0)
        )
      const { installed, replaced } = await installPlan(def, profileId, plan, held)
      return { installed, skipped, missing, replaced, enabled }
    })
  }

  const tsServices: Pick<
    HmlApi,
    | 'tsSearch'
    | 'tsRefresh'
    | 'tsGetPackage'
    | 'tsInstall'
    | 'tsCheckUpdates'
    | 'tsUpdate'
    | 'getModDeps'
  > = {
    async tsSearch(game, q) {
      const idx = await loadIndex(await requireGame(game), false)
      return {
        ...searchPackages(idx.packages, q),
        categories: idx.categories,
        fetchedAt: idx.fetchedAt,
        stale: idx.stale
      }
    },

    async tsRefresh(game) {
      const idx = await loadIndex(await requireGame(game), true)
      return { count: idx.packages.length, fetchedAt: idx.fetchedAt, stale: idx.stale }
    },

    async tsGetPackage(game, fullName) {
      const idx = await loadIndex(await requireGame(game), false)
      return idx.byName.get(fullName) ?? null
    },

    tsInstall: (game, profileId, fullName, version) =>
      tsInstallChecked(game, profileId, fullName, version, true),

    async tsCheckUpdates(game, profileId) {
      const def = await requireGame(game)
      requireListing(def)
      const idx = await loadIndex(def, false)
      const profile = await getProfile(paths, game, profileId)
      return findUpdates(profile.mods, idx.byName)
    },

    async getModDeps(game, profileId) {
      const def = await requireGame(game)
      const { mods } = await getProfile(paths, game, profileId)
      let index = new Map<string, TsPackage>()
      if (def.packageIndex !== null) {
        try {
          index = (await loadIndex(def, false)).byName
        } catch (e) {
          // Without the index only the loader is known; the caller acts without a warning.
          console.warn(`Dependency lookup for ${game} failed: ${errMsg(e)}`)
        }
      }
      return buildModDeps(mods, index, await loaderIds(def))
    },

    async tsUpdate(game, profileId, modIds) {
      const def = await requireGame(game)
      requireInstallable(def)
      await assertGameClosed(def)
      const idx = await loadIndex(def, false)
      const loaders = await loaderIds(def)
      return serialize(game, profileId, async () => {
        const profile = await getProfile(paths, game, profileId)
        const wanted = new Set(modIds)
        const targets = findUpdates(profile.mods, idx.byName).filter((u) => wanted.has(u.modId))
        const installedNow = installedVersions(profile.mods, loaders)
        const provided = providedPackages(profile.mods, loaders)
        const ghByName = githubByName(profile.mods)
        const plans: PlannedPackage[][] = []
        const standIns: StandIn[] = []
        const skipped = new Set<string>()
        const missing = new Set<string>()
        for (const t of targets) {
          const r = resolveInstall(
            idx.byName,
            { fullName: t.fullName },
            installedNow,
            provided,
            ghByName
          )
          plans.push(r.plan)
          standIns.push(...r.standIns)
          r.skipped.forEach((s) => skipped.add(s))
          r.missing.forEach((m) => missing.add(m))
        }
        const plan = mergePlans(plans, idx.byName)
        const planned = new Set(plan.map((p) => p.fullName))
        const satisfied = [...skipped].filter((s) => !planned.has(s))
        await recordStandIns(def, profileId, standIns)
        const enabled = await enableSatisfied(def, profileId, satisfied, loaders)
        const { installed, replaced } = await installPlan(def, profileId, plan)
        return { installed, skipped: satisfied, missing: [...missing], replaced, enabled }
      })
    }
  }

  const { ghInstallWith, ...ghServices } = createGithubServices({
    deps,
    getCatalog,
    requireGame,
    serialize,
    // Fails closed: when tasklist fails, this round of auto-update skips the game.
    isGameRunning: (def) => isGameRunning(deps.platform, deps.execFile, def.exeNames)
  })

  const { installFromNxm, loggedInUserId, ...nexusApi } = createNexusServices({
    deps,
    client: nexusClient,
    games: nexus,
    getCatalog,
    requireGame,
    serialize
  })

  /**
   * Where the profile's mod loader logs: BepInEx runs from the profile, so its log is there;
   * UE4SS writes next to the game's exe. Null for other loaders.
   */
  async function modLogFile(game: string, profileId: string): Promise<string | null> {
    const def = await requireGame(game)
    await getProfile(paths, game, profileId)
    if (def.loader === 'bepinex') {
      return path.join(paths.profileDir(game, profileId), 'BepInEx', 'LogOutput.log')
    }
    if (def.loader === 'shimloader' && def.dataFolderName) {
      const steamRoot = await getSteamRoot()
      const gameDir = await resolveGameDir(def, await loadSettings(paths), steamRoot)
      return gameDir ? path.join(shimBinDir(gameDir, def.dataFolderName), 'UE4SS.log') : null
    }
    return null
  }

  async function setModEnabledService(
    game: string,
    profileId: string,
    modId: string,
    enabled: boolean
  ): Promise<void> {
    const def = await requireGame(game)
    return serialize(game, profileId, () => setModEnabled(paths, def, profileId, modId, enabled))
  }

  /** Adds a Nexus-only game, or returns the game HML already has for that Nexus domain. */
  async function addNexusGame(domain: string): Promise<GameSummary> {
    const settings = await loadSettings(paths)
    const d = String(domain).trim().toLowerCase()
    const games = (await getCatalog()).games
    const twin = await nexus.twinOf(d, games, settings)
    if (twin) return summarize(twin, await getCatalog(), settings, null)
    const added = await nexus.addGame(d)
    // Its Nexus name can show it is a game HML has under another name; that one is used.
    const named = await nexus.twinOf(d, games, settings, added.displayName)
    return summarize(named ?? added, await getCatalog(), settings, null)
  }

  async function nxGetDomain(game: string): Promise<string | null> {
    const def = await requireGame(game)
    const settings = await loadSettings(paths)
    try {
      return (await nexus.domainFor(def, settings))?.domain ?? null
    } catch {
      return nexus.cachedDomain(def, settings)
    }
  }

  const { steamCandidates, customCoverFile, ...customApi } = createCustomGameServices({
    deps,
    customGames,
    getCatalog,
    getBaseCatalog,
    getSteamRoot,
    summarize: async (def) => {
      const summary = await summarize(
        def,
        await getCatalog(),
        await loadSettings(paths),
        await getSteamRoot()
      )
      return (await withArt([summary]))[0]
    },
    nexus,
    requireGame,
    serialize,
    assertGameClosed,
    ghInstallWith
  })

  /** Running waitForGame calls by game label. */
  const launchWatches = new Map<string, AbortController>()
  /**
   * Exit of the program a direct launch started, by game label. Only folder games: a Steam
   * launch's process hands off to Steam and exits at once.
   */
  const directExits = new Map<string, Promise<void>>()

  /** A folder-added custom game, which HML starts itself (no Steam). */
  const isFolderGame = (def: GameDef): boolean => def.custom?.source === 'folder'

  /** Starts a folder game's exe directly (Windows) or through its runner (Linux). */
  async function launchFolderGame(
    def: GameDef,
    profileId: string | null,
    mode: LaunchMode
  ): Promise<void> {
    const bepinex = def.loader === 'bepinex'
    if (bepinex && mode === 'modded' && !profileId) {
      throw new Error('Select a profile to launch with mods.')
    }
    const gameDir = await deployFolder(def, await loadSettings(paths))
    if (!gameDir) {
      throw new Error(`${def.displayName} was not found. Choose its install folder first.`)
    }
    const exeName = def.exeNames[0]
    if (!exeName) {
      throw new Error(
        `HML couldn't tell which program starts ${def.displayName}. Remove the game and add it again.`
      )
    }
    const profileDir = profileId ? paths.profileDir(def.label, profileId) : paths.gameDir(def.label)
    if (profileId) await getProfile(paths, def.label, profileId)
    const modded = mode === 'modded'
    const plan = buildDirectLaunchPlan({
      platform,
      mode,
      gameDir,
      exeName,
      runner: def.custom?.runner ?? null,
      prefixDir: paths.winePrefix(def.label),
      steamRoot: platform === 'linux' ? await getSteamRoot().catch(() => null) : null,
      loader: bepinex
        ? {
            profileDir,
            preloaderRelPath: (modded && (await findPreloader(profileDir))) || DEFAULT_PRELOADER,
            doorstop: await detectDoorstopVersion(modded ? profileDir : gameDir)
          }
        : null
    })
    const { exited } = await launch(plan, profileDir, gameDir, deps.spawn)
    directExits.set(def.label, exited)
  }

  /**
   * Makes the game's Proton prefix load BepInEx's winhttp.dll, so mods load without Steam launch
   * options. Before the first launch there is no prefix yet; the proton-first-run warning covers it.
   */
  async function prepareProtonPrefix(
    def: GameDef,
    steamRoot: string,
    appId: string,
    dll: ProxyDll = 'winhttp'
  ): Promise<void> {
    try {
      await ensureDllOverride(steamRoot, appId, Math.floor(now() / 1000), dll)
    } catch (cause) {
      throw new Error(
        `Couldn't set up ${def.displayName}'s Proton prefix for mods (${errMsg(cause)}).`,
        { cause }
      )
    }
  }

  /**
   * Starts an unreal_shimloader game through Steam. Modded puts the profile's shim next to the
   * game's exe and points it at the profile's mod folders; vanilla takes the shim back out.
   */
  async function launchShimloader(
    def: GameDef & { steamAppId: string },
    mode: LaunchMode,
    at: { steamRoot: string; gameDir: string; profileDir: string; proton: boolean }
  ): Promise<void> {
    if (!def.dataFolderName) {
      throw new Error(`HML doesn't know where ${def.displayName}'s game files are.`)
    }
    const binDir = shimBinDir(at.gameDir, def.dataFolderName)
    const plan = buildSteamPlainPlan({
      platform,
      steamRoot: at.steamRoot,
      steamAppId: def.steamAppId,
      flatpak: isFlatpakSteam(at.steamRoot)
    })
    if (mode === 'modded') {
      if (!(await hasShimloader(at.profileDir))) {
        throw new Error('Install unreal_shimloader into this profile so mods can load.')
      }
      plan.args.push(...shimloaderArgs({ profileDir: at.profileDir, platform, proton: at.proton }))
      if (at.proton) await prepareProtonPrefix(def, at.steamRoot, def.steamAppId, 'dwmapi')
      await linkShimloader(at.profileDir, binDir)
    } else {
      await unlinkShimloader(binDir)
    }
    await launch(plan, at.profileDir, at.gameDir, deps.spawn)
  }

  /** Starts a custom Steam game without a loader: a plain Steam launch, whatever the mode. */
  async function launchSteamPlain(def: GameDef & { steamAppId: string }): Promise<void> {
    const steamRoot = await getSteamRoot()
    if (!steamRoot) throw new Error('Steam was not found. Set the Steam folder in settings.')
    const gameDir = await deployFolder(def, await loadSettings(paths))
    if (!gameDir) {
      throw new Error(`${def.displayName} was not found. Choose its install folder first.`)
    }
    const plan = buildSteamPlainPlan({
      platform,
      steamRoot,
      steamAppId: def.steamAppId,
      flatpak: isFlatpakSteam(steamRoot)
    })
    await launch(plan, paths.gameDir(def.label), gameDir, deps.spawn)
  }

  const shareApi = createShareServices({
    deps,
    getCatalog,
    requireGame,
    serialize,
    findCustomGameByName: async (displayName) => {
      const wanted = displayName.trim().toLowerCase()
      const found = (await customGames.list()).find(
        (g) => g.source === 'folder' && g.displayName.trim().toLowerCase() === wanted
      )
      return found ? customGameDef(found) : undefined
    },
    findCustomGameByFolder: async (folder) => {
      const overrides = (await loadSettings(paths)).gamePathOverrides
      const want = path.resolve(folder)
      const found = (await customGames.list()).find((g) => {
        const dir = overrides[g.label]
        return dir !== undefined && path.resolve(dir) === want
      })
      return found ? customGameDef(found) : undefined
    },
    isSteamAppInstalled: async (appId) => {
      const root = await getSteamRoot().catch(() => null)
      if (!root) return false
      return (await listInstalledApps(root)).some((a) => a.appId === appId)
    },
    getCustomGame: async (label) => {
      const g = await customGames.get(label)
      return g
        ? {
            source: g.source,
            displayName: g.displayName,
            steamAppId: g.steamAppId,
            loaderChoice: g.loaderChoice
          }
        : null
    },
    installers: {
      tsGetPackage: tsServices.tsGetPackage,
      tsRefresh: tsServices.tsRefresh,
      // The import's profile is new, so nothing in it can be locked by the running game.
      tsInstall: (game, profileId, fullName, version) =>
        tsInstallChecked(game, profileId, fullName, version, false),
      ghInstall: (game, profileId, url, opts) =>
        ghInstallWith(game, profileId, url, undefined, opts),
      nxInstall: nexusApi.nxInstall,
      nxGetDomain,
      setModEnabled: setModEnabledService,
      createProfile: (game, name) => createProfile(paths, game, name),
      addNexusGame,
      addCustomGame: customApi.addCustomGame
    }
  })

  const artSources: ArtSources = {
    async steamCover(appId) {
      const root = await getSteamRoot().catch(() => null)
      return root ? findLibraryCover(root, appId) : null
    },
    async steamHero(appId) {
      const root = await getSteamRoot().catch(() => null)
      return root ? findLibraryHero(root, appId) : null
    },
    customCover: customCoverFile,
    // getProfile refuses unsafe game and profile ids; the file comes from the mod's record.
    async modIcon(game, profileId, modId) {
      const mod = (await getProfile(paths, game, profileId)).mods.find((m) => m.id === modId)
      return mod ? modIconPath(paths.profileDir(game, profileId), mod) : null
    }
  }
  /** Bytes of a cover image: an hml-art:// file main looks up, or an https download. */
  async function imageBytes(url: string): Promise<Buffer | null> {
    if (url.startsWith(`${ART_SCHEME}:`)) {
      const file = await resolveArt(url, artSources)
      return file ? fs.readFile(file).catch(() => null) : null
    }
    if (!/^https:\/\//i.test(url)) return null
    try {
      const res = await deps.fetch(url, { signal: AbortSignal.timeout(ACCENT_FETCH_TIMEOUT_MS) })
      if (!res.ok) return null
      const data = Buffer.from(await res.arrayBuffer())
      return data.length <= ACCENT_MAX_BYTES ? data : null
    } catch {
      return null
    }
  }

  // Accents by cover URL list, so a changed cover is looked at again.
  const accents = new Map<string, Promise<string | null>>()
  /** The accent colour from the first of a game's covers that loads and decodes; null if none. */
  function coverAccent(urls: string[]): Promise<string | null> {
    const key = urls.join('\n')
    let p = accents.get(key)
    if (!p) {
      p = (async () => {
        const decode = deps.decodeImage
        if (!decode) return null
        for (const url of urls) {
          const data = await imageBytes(url)
          const pixels = data ? decode(data) : null
          if (pixels) return pickAccent(pixels)
        }
        return null
      })().catch(() => null)
      accents.set(key, p)
    }
    return p
  }

  async function getModIcons(game: string, profileId: string): Promise<Record<string, string[]>> {
    const def = await requireGame(game)
    const { mods } = await getProfile(paths, game, profileId)
    const indexed = def.packageIndex !== null
    const idx = indexed ? await loadIndex(def, false).catch(() => null) : null
    // Games without a package index (custom games) look packages up one by one. An indexed game
    // whose index failed to load (offline) goes without remote icons this time.
    const remote = indexed
      ? new Map<string, string>()
      : await tsIcons.icons(
          mods.flatMap((m) =>
            m.source.kind === 'thunderstore' ? [m.source.fullName] : (m.provides ?? [])
          )
        )
    const tsIcon = (fullName: string): string | undefined =>
      idx?.byName.get(fullName)?.iconUrl || remote.get(fullName)
    const out: Record<string, string[]> = {}
    for (const m of mods) {
      const urls = modIconCandidates(game, profileId, m, tsIcon)
      if (urls.length > 0) out[m.id] = urls
    }
    return out
  }

  /** Handles an `nxm://` link end to end. Never throws: the outcome is an event. */
  async function handleNxm(raw: string): Promise<void> {
    try {
      const link = parseNxm(raw)
      if (!link) throw new Error("That isn't a Nexus Mods download link.")
      // A link without a user id can't be shown to be this account's, so it counts as another's.
      const me = await loggedInUserId()
      if (me !== null && link.userId !== me) {
        throw new Error('This download link is for a different Nexus Mods account.')
      }
      const { game, profileId, mod } = await installFromNxm(link)
      deps.emit({
        type: 'nexus-installed',
        game,
        profileId,
        mod: { name: mod.name, version: mod.version }
      })
    } catch (e) {
      deps.emit({ type: 'nexus-failed', message: errMsg(e) })
    }
  }

  return {
    ...tsServices,
    ...ghServices,
    ...nexusApi,
    ...shareApi,
    ...customApi,
    handleNxm,
    serveArt: (url) => serveArt(url, artSources),
    cancelLaunchWatches() {
      for (const watch of launchWatches.values()) watch.abort()
    },
    getModIcons,
    tsGetDoc: (fullName, version, kind) => tsDocs.get(fullName, version, kind),
    // Replacing an installed mod under a running game is refused; a fresh install is allowed.
    ghInstall: (game, profileId, url, asset, opts) =>
      ghInstallWith(game, profileId, url, asset, {
        beforeReplacing: assertGameClosed,
        prereleases: opts?.prereleases === true
      }),
    async ghUpdate(game, profileId, modIds) {
      await assertGameClosed(await requireGame(game))
      return ghServices.ghUpdate(game, profileId, modIds)
    },
    async ghInstallRelease(game, profileId, modId, tag) {
      await assertGameClosed(await requireGame(game))
      return ghServices.ghInstallRelease(game, profileId, modId, tag)
    },
    async nxUpdate(game, profileId, modIds) {
      await assertGameClosed(await requireGame(game))
      return nexusApi.nxUpdate(game, profileId, modIds)
    },
    nxRegisterHandler: () => deps.nxmHandler.register(),
    async searchGames(query: string): Promise<GameSummary[]> {
      const catalog = await getCatalog()
      const settings = await loadSettings(paths)
      const steamRoot = await getSteamRoot()
      const twins = await hiddenTwins(catalog, settings, steamRoot)
      const ranked = searchGames(
        catalog.games.filter((g) => !twins.has(g.label)),
        query
      )
      const summaries = await Promise.all(
        ranked.map((g) => summarize(g, catalog, settings, steamRoot))
      )
      // Rank group first, then installed before not installed, then searchGames' own order.
      const q = query.trim().toLowerCase()
      const sorted = summaries
        .map((g, i) => ({ g, i, rank: q ? rankGame(g, q) : 0, installed: g.installDir ? 0 : 1 }))
        .sort((a, b) => a.rank - b.rank || a.installed - b.installed || a.i - b.i)
        .map((x) => x.g)
      const extra = await nexus.searchExtra(query, catalog, settings)
      const extras = await Promise.all(extra.map((g) => summarize(g, catalog, settings, steamRoot)))
      const installed = await steamCandidates(query, catalog, steamRoot)
      return withArt([...sorted, ...extras, ...installed])
    },

    getGame: getGameSummary,

    async getGameAccent(label) {
      const game = await getGameSummary(label)
      if (!game) return null
      // Electron can't decode WebP (Thunderstore's covers), so Steam's JPEG covers follow.
      const steam = game.steamAppId && isAppId(game.steamAppId) ? game.steamAppId : null
      const urls = [
        game.iconUrl,
        ...(game.iconFallbacks ?? []),
        ...(steam ? [steamArtUrl(steam), steamCdnCover(steam)] : [])
      ].filter((u, i, all): u is string => !!u && all.indexOf(u) === i)
      return urls.length > 0 ? coverAccent(urls) : null
    },

    addNexusGame,
    nxGetDomain,

    async nxSetDomain(game: string, domain: string | null): Promise<void> {
      const def = await requireGame(game)
      if (def.label.startsWith('nexus-')) {
        throw new Error('Nexus-only games always use their own Nexus domain.')
      }
      const wanted = domain?.trim().toLowerCase() ?? ''
      let found: Awaited<ReturnType<typeof gameByDomain>> = null
      if (wanted) {
        // The network check comes first, outside the settings lock.
        found = /^[a-z0-9_-]{1,64}$/.test(wanted) ? await gameByDomain(nexusClient, wanted) : null
        if (!found) throw new Error(`Nexus Mods has no game "${wanted}".`)
      }
      await updateSettings(paths, async (settings) => {
        const overrides = { ...settings.nexusDomainOverrides }
        if (found) {
          overrides[game] = found.domain
          await nexus.rememberDomain(game, found.domain, found.id)
        } else {
          delete overrides[game]
          await nexus.forgetDomain(game)
        }
        return { ...settings, nexusDomainOverrides: overrides }
      })
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
    async createProfile(game, name) {
      const profile = await createProfile(paths, game, name)
      // Only custom games are looked up, so creating a catalog game's profile fetches nothing.
      const stored = await customGames.get(game)
      if (stored && customLoaderSpec(customGameDef(stored))) {
        try {
          await customApi.installLoader(game, profile.id)
          // Return the manifest with the loader in it, so the renderer shows it straight away.
          return await getProfile(paths, game, profile.id)
        } catch (e) {
          // The profile stays; its launch warnings offer the install again.
          deps.emit({
            type: 'progress',
            message: `Couldn't install BepInEx: ${errMsg(e)}`,
            done: 1,
            total: 1
          })
        }
      }
      return profile
    },
    renameProfile: (game, id, name) =>
      serialize(game, id, () => renameProfile(paths, game, id, name)),
    // Serialized on the source, so an install in progress doesn't land half copied.
    duplicateProfile: (game, id, name) =>
      serialize(game, id, () => duplicateProfile(paths, game, id, name)),
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

    setModEnabled: setModEnabledService,

    async readModLog(game, profileId, from) {
      const file = await modLogFile(game, profileId)
      if (!file) return { file: null, size: 0, next: 0, text: '', reset: true }
      return { file, ...(await readLogFrom(file, from)) }
    },
    async openModLog(game, profileId) {
      const file = await modLogFile(game, profileId)
      if (!file) throw new Error("HML doesn't know where this game's mod loader writes its log.")
      const error = await deps.shell.openPath(file)
      if (error) throw new Error(`Could not open the log: ${error}`)
    },

    async listConfigs(game, profileId) {
      await getProfile(paths, game, profileId)
      return listConfigFiles(paths.profileDir(game, profileId))
    },
    async readConfig(game, profileId, file) {
      await getProfile(paths, game, profileId)
      return readConfigFile(paths.profileDir(game, profileId), file)
    },
    async writeConfig(game, profileId, file, text) {
      await getProfile(paths, game, profileId)
      return serialize(game, profileId, () =>
        writeConfigFile(paths.profileDir(game, profileId), file, text)
      )
    },

    async setModHeld(game, profileId, modId, held) {
      await requireGame(game)
      return serialize(game, profileId, async () => {
        const profile = await getProfile(paths, game, profileId)
        const mod = profile.mods.find((m) => m.id === modId)
        if (!mod) throw new Error(`${modId} isn't installed in this profile.`)
        if (mod.source.kind === 'github')
          throw new Error('GitHub mods are held with their update setting.')
        const rest = { ...mod }
        delete rest.held
        await saveProfile(paths, {
          ...profile,
          mods: profile.mods.map((m) =>
            m.id === modId ? (held ? { ...rest, held: true } : rest) : m
          )
        })
      })
    },

    async uninstallMod(game, profileId, modId): Promise<void> {
      const def = await requireGame(game)
      await assertGameClosed(def)
      return serialize(game, profileId, () => uninstallMod(paths, def, profileId, modId))
    },

    async deployProfile(game, profileId) {
      const { def, gameDir } = await requireDeploy(game)
      if (profileId === DEPLOY_KEY) throw new Error(`Profile not found: ${game}/${profileId}`)
      // Fail before removing the current deployment; deploy.ts repeats these checks under the locks.
      await getProfile(paths, game, profileId)
      if (!(await isDirectory(gameDir))) {
        throw new Error(`The game folder ${path.resolve(gameDir)} doesn't exist.`)
      }
      await assertGameClosed(def)
      for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
        // Removing another profile's deployment copies files back into that profile, so it runs
        // under that profile's lock as its own step. Two profile locks are never held at once.
        const current = await lockableDeployedProfile(def)
        if (current !== null && current !== profileId) await removeDeploymentLocked(def)
        // The profile key is the outer lock and the deploy key the inner one.
        const status = await serialize(game, profileId, () =>
          serialize(game, DEPLOY_KEY, async () => {
            const now = await lockableDeployedProfile(def)
            if (now !== null && now !== profileId) return null
            await assertNoOtherDeployment(def, gameDir)
            return deployProfile(paths, def, profileId, gameDir)
          })
        )
        if (status) return status
      }
      throw new Error(LOCK_BUSY)
    },

    // Remove and status work from the deployment manifest, which records the folder deployed
    // to, so they don't need the folder setting (it may have been cleared since).
    async removeDeployment(game) {
      const def = await requireDeployGame(game)
      await assertGameClosed(def)
      await removeDeploymentLocked(def)
    },

    async getDeployment(game) {
      return deploymentStatus(paths, await requireDeployGame(game))
    },

    async getLaunchWarnings(game: string, profileId: string): Promise<LaunchWarning[]> {
      const def = await requireGame(game)
      const { mods } = await getProfile(paths, game, profileId)
      const mismatch = loaderMismatch(def, mods)
      if (isFolderGame(def)) {
        return launchWarnings({
          platform,
          game: def,
          gameDir: await deployFolder(def, await loadSettings(paths)),
          profileDir: paths.profileDir(game, profileId),
          steamRoot: '',
          direct: { runner: def.custom?.runner ?? null },
          loaderMismatch: mismatch
        })
      }
      if (def.loader === 'deploy') {
        const dir = await deployFolder(def, await loadSettings(paths))
        return launchWarnings({
          platform,
          game: def,
          gameDir: dir,
          profileDir: paths.profileDir(game, profileId),
          steamRoot: ''
        })
      }
      const steamRoot = await getSteamRoot()
      if (!steamRoot) return ['steam-not-found']
      const gameDir = await resolveGameDir(def, await loadSettings(paths), steamRoot)
      return launchWarnings({
        platform,
        game: def,
        gameDir,
        profileDir: paths.profileDir(game, profileId),
        steamRoot,
        flatpakAccessGranted:
          platform === 'linux' && isFlatpakSteam(steamRoot) ? await flatpakAccess() : false,
        loaderMismatch: mismatch
      })
    },

    async launch(game: string, profileId: string | null, mode: LaunchMode): Promise<void> {
      if (mode !== 'modded' && mode !== 'vanilla') {
        throw new Error(`Unknown launch mode: ${String(mode)}`)
      }
      const def = await requireGame(game)
      directExits.delete(def.label)
      if (isFolderGame(def)) return launchFolderGame(def, profileId, mode)
      if (def.loader === 'deploy' && def.custom?.source === 'steam' && def.steamAppId) {
        return launchSteamPlain({ ...def, steamAppId: def.steamAppId })
      }
      if (def.loader === 'deploy') {
        throw new Error(
          `HML doesn't launch ${def.displayName}. Deploy mods, then start the game as usual.`
        )
      }
      if (mode === 'modded' && !profileId) {
        throw new Error('Select a profile to launch with mods.')
      }
      if (!def.steamAppId)
        throw new Error(`${def.displayName} has no Steam app id, so HML cannot launch it.`)
      const steamRoot = await getSteamRoot()
      if (!steamRoot) throw new Error('Steam was not found. Set the Steam folder in settings.')
      const gameDir = await resolveGameDir(def, await loadSettings(paths), steamRoot)
      if (!gameDir) {
        throw new Error(`${def.displayName} was not found. Choose its install folder first.`)
      }
      if (def.loader !== 'bepinex' && def.loader !== 'shimloader') {
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
      if (def.loader === 'shimloader') {
        return launchShimloader({ ...def, steamAppId: def.steamAppId }, mode, {
          steamRoot,
          gameDir,
          profileDir,
          proton
        })
      }
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
      if (modded && proton) await prepareProtonPrefix(def, steamRoot, def.steamAppId)
      await launch(plan, profileDir, gameDir, deps.spawn)
    },

    async waitForGame(game: string): Promise<LaunchWatchResult> {
      // A new wait for the same game replaces the old one.
      launchWatches.get(game)?.abort()
      const watch = new AbortController()
      launchWatches.set(game, watch)
      const exited = directExits.get(game)
      try {
        const def = await requireGame(game)
        return await waitForGameStart({
          check: () =>
            isGameProcessRunning(deps.platform, deps.execFile, def.exeNames, deps.procFs),
          signal: watch.signal,
          exited,
          ...deps.launchWatch
        })
      } finally {
        if (launchWatches.get(game) === watch) launchWatches.delete(game)
        if (exited && directExits.get(game) === exited) directExits.delete(game)
      }
    },

    async cancelWaitForGame(game: string): Promise<void> {
      launchWatches.get(game)?.abort()
    },

    async openProfileFolder(game: string, profileId: string): Promise<void> {
      await getProfile(paths, game, profileId)
      const error = await deps.shell.openPath(paths.profileDir(game, profileId))
      if (error) throw new Error(`Could not open the profile folder: ${error}`)
    },

    async openExternal(url: string): Promise<void> {
      const u = parseAllowedExternalUrl(url)
      if (!u) throw new Error('HML only opens Thunderstore, GitHub and Nexus Mods links.')
      await deps.shell.openExternal(u.href)
    },

    getSettings: () => loadSettings(paths),

    async saveSettings(s: Settings): Promise<void> {
      const override = typeof s.steamRootOverride === 'string' ? s.steamRootOverride : null
      if (override !== null && override !== (await loadSettings(paths)).steamRootOverride) {
        const looksLikeSteam = await fs
          .access(path.join(override, 'steamapps', 'libraryfolders.vdf'))
          .then(
            () => true,
            () => false
          )
        if (!looksLikeSteam) {
          throw new Error(
            "That folder doesn't look like Steam: it has no steamapps/libraryfolders.vdf."
          )
        }
      }
      // Only the renderer-owned keys; the path and domain overrides have their own methods.
      await updateSettings(paths, (cur) => ({
        ...cur,
        steamRootOverride: s.steamRootOverride,
        lastGame: s.lastGame,
        lastProfile: s.lastProfile
      }))
      invalidateSteamRoot()
    },

    getGamesDataDir: async () => paths.gamesDir
  }
}
