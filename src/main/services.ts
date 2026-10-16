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
  Settings,
  TsPackage
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
import { loadPackageIndex, type TsIndex } from './thunderstore/packageIndex'
import { allCategories, searchPackages } from './thunderstore/search'
import {
  findUpdates,
  installedVersions,
  mergePlans,
  resolveInstall,
  type PlannedPackage
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
import { createNexusServices } from './nexus/service'
import { createShareServices } from './share/service'
import { gameByDomain } from './nexus/api'
import { parseNxm, type HandlerPort } from './nexus/nxm'
import { findInstalledMod } from '../shared/modIdentity'

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
  /** HML's version, sent to Nexus Mods in request headers. */
  appVersion: string
  /** OS details for the Nexus User-Agent. */
  os: { type: string; release: string; arch: string }
  /** Registers and reports HML as the operating system's `nxm://` handler. */
  nxmHandler: HandlerPort
  /** Base URL of the share-code Worker. */
  shareBaseUrl: string
}

interface LoadedIndex extends TsIndex {
  stale: boolean
  byName: Map<string, TsPackage>
  categories: string[]
  /** When this process loaded it (ms), for retrying a stale index. */
  loadedAt: number
}
interface IndexSlot {
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

export function createServices(
  deps: ServiceDeps
): HmlApi & { ghAutoUpdateAll(): Promise<void>; handleNxm(raw: string): Promise<void> } {
  const { paths } = deps
  const platform: 'win32' | 'linux' = deps.platform === 'win32' ? 'win32' : 'linux'
  const now = deps.now ?? Date.now

  const nexusClient = { fetch: deps.fetch, appVersion: deps.appVersion, os: deps.os }
  const nexus = createNexusGames({ paths, client: nexusClient, now })

  let catalogPromise: Promise<Catalog> | null = null
  const getBaseCatalog = (): Promise<Catalog> => {
    catalogPromise ??= loadCatalog(paths, deps.fetch, deps.snapshotPath).catch((e) => {
      catalogPromise = null
      throw e
    })
    return catalogPromise
  }
  /** The ecosystem catalog plus the user's added Nexus-only games. */
  const getCatalog = async (): Promise<Catalog> => {
    const base = await getBaseCatalog()
    const have = new Set(base.games.map((g) => g.label))
    const added = (await nexus.addedGames()).filter((g) => !have.has(g.label))
    return added.length ? { ...base, games: [...base.games, ...added] } : base
  }

  const summarize = (
    g: GameDef,
    catalog: Catalog,
    settings: Settings,
    steamRoot: string | null
  ): Promise<GameSummary> =>
    g.loader === 'deploy'
      ? Promise.resolve({
          ...g,
          loaderPackageIds: [],
          installDir: settings.gamePathOverrides[g.label] ?? null
        })
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
    const gameDir = (await loadSettings(paths)).gamePathOverrides[def.label]
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

  // In-memory index per game label, least recently used evicted beyond INDEX_LRU.
  const indexes = new Map<string, IndexSlot>()
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
    const slot = startIndexLoad(def, indexUrl, force)
    // A failed load must not poison the slot: restore the previous index, if any.
    slot.promise = slot.promise.catch((e) => {
      if (indexes.get(def.label) === slot) {
        indexes.delete(def.label)
        if (hit) touchIndex(def.label, hit)
      }
      throw e
    })
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
   * mod whose id is a planned package's manifest name is replaced by the Thunderstore copy.
   */
  async function installPlan(
    def: GameDef,
    profileId: string,
    plan: PlannedPackage[]
  ): Promise<{ installed: InstalledMod[]; replaced: string[] }> {
    const catalog = await getCatalog()
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
        const local = mods.some((m) => m.source.kind === 'local' && m.id === pkg.name)
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
              replaces: local ? [pkg.name] : []
            }
          )
        )
        if (local) replaced.push(pkg.name)
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

  async function loaderIds(def: GameDef): Promise<string[]> {
    return (await getCatalog()).modloaderPackages
      .filter((m) => m.loader === def.loader)
      .map((m) => m.packageId)
  }

  const tsServices: Pick<
    HmlApi,
    'tsSearch' | 'tsRefresh' | 'tsGetPackage' | 'tsInstall' | 'tsCheckUpdates' | 'tsUpdate'
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

    async tsInstall(game, profileId, fullName, version) {
      const def = await requireGame(game)
      requireInstallable(def)
      const idx = await loadIndex(def, false)
      const loaders = await loaderIds(def)
      return serialize(game, profileId, async () => {
        const profile = await getProfile(paths, game, profileId)
        const { plan, skipped, missing } = resolveInstall(
          idx.byName,
          { fullName, version },
          installedVersions(profile.mods, loaders)
        )
        const satisfied = skipped.filter((s) => s !== fullName)
        const enabled = await enableSatisfied(def, profileId, satisfied, loaders)
        const { installed, replaced } = await installPlan(def, profileId, plan)
        return { installed, skipped, missing, replaced, enabled }
      })
    },

    async tsCheckUpdates(game, profileId) {
      const def = await requireGame(game)
      requireListing(def)
      const idx = await loadIndex(def, false)
      const profile = await getProfile(paths, game, profileId)
      return findUpdates(profile.mods, idx.byName)
    },

    async tsUpdate(game, profileId, modIds) {
      const def = await requireGame(game)
      requireInstallable(def)
      const idx = await loadIndex(def, false)
      const loaders = await loaderIds(def)
      return serialize(game, profileId, async () => {
        const profile = await getProfile(paths, game, profileId)
        const wanted = new Set(modIds)
        const targets = findUpdates(profile.mods, idx.byName).filter((u) => wanted.has(u.modId))
        const installedNow = installedVersions(profile.mods, loaders)
        const plans: PlannedPackage[][] = []
        const skipped = new Set<string>()
        const missing = new Set<string>()
        for (const t of targets) {
          const r = resolveInstall(idx.byName, { fullName: t.fullName }, installedNow)
          plans.push(r.plan)
          r.skipped.forEach((s) => skipped.add(s))
          r.missing.forEach((m) => missing.add(m))
        }
        const plan = mergePlans(plans, idx.byName)
        const planned = new Set(plan.map((p) => p.fullName))
        const satisfied = [...skipped].filter((s) => !planned.has(s))
        const enabled = await enableSatisfied(def, profileId, satisfied, loaders)
        const { installed, replaced } = await installPlan(def, profileId, plan)
        return { installed, skipped: satisfied, missing: [...missing], replaced, enabled }
      })
    }
  }

  const ghServices = createGithubServices({
    deps,
    getCatalog,
    requireGame,
    serialize,
    // HML launches through Steam (`steam -applaunch`), which hands off to the running Steam client
    // and exits, so HML never holds the game's process and can't tell whether it's running.
    isGameRunning: () => false
  })

  const { installFromNxm, loggedInUserId, ...nexusApi } = createNexusServices({
    deps,
    client: nexusClient,
    games: nexus,
    getCatalog,
    requireGame,
    serialize
  })

  async function setModEnabledService(
    game: string,
    profileId: string,
    modId: string,
    enabled: boolean
  ): Promise<void> {
    const def = await requireGame(game)
    return serialize(game, profileId, () => setModEnabled(paths, def, profileId, modId, enabled))
  }

  async function addNexusGame(domain: string): Promise<GameSummary> {
    const def = await nexus.addGame(domain)
    const catalog = await getCatalog()
    return summarize(def, catalog, await loadSettings(paths), null)
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

  const shareApi = createShareServices({
    deps,
    getCatalog,
    requireGame,
    serialize,
    installers: {
      tsGetPackage: tsServices.tsGetPackage,
      tsRefresh: tsServices.tsRefresh,
      tsInstall: tsServices.tsInstall,
      ghInstall: ghServices.ghInstall,
      nxInstall: nexusApi.nxInstall,
      nxGetDomain,
      setModEnabled: setModEnabledService,
      createProfile: (game, name) => createProfile(paths, game, name),
      addNexusGame
    }
  })

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
    handleNxm,
    nxRegisterHandler: () => deps.nxmHandler.register(),
    async searchGames(query: string): Promise<GameSummary[]> {
      const catalog = await getCatalog()
      const ranked = searchGames(catalog.games, query)
      const settings = await loadSettings(paths)
      const steamRoot = await getSteamRoot()
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
      return [...sorted, ...extras]
    },

    addNexusGame,
    nxGetDomain,

    async nxSetDomain(game: string, domain: string | null): Promise<void> {
      await requireGame(game)
      const settings = await loadSettings(paths)
      const overrides = { ...settings.nexusDomainOverrides }
      const wanted = domain?.trim().toLowerCase() ?? ''
      if (wanted) {
        const found = /^[a-z0-9_-]{1,64}$/.test(wanted)
          ? await gameByDomain(nexusClient, wanted)
          : null
        if (!found) throw new Error(`Nexus Mods has no game "${wanted}".`)
        overrides[game] = found.domain
        await nexus.rememberDomain(game, found.domain, found.id)
      } else {
        delete overrides[game]
        await nexus.forgetDomain(game)
      }
      await saveSettings(paths, { ...settings, nexusDomainOverrides: overrides })
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

    setModEnabled: setModEnabledService,

    async uninstallMod(game, profileId, modId): Promise<void> {
      const def = await requireGame(game)
      return serialize(game, profileId, () => uninstallMod(paths, def, profileId, modId))
    },

    async deployProfile(game, profileId) {
      const { def, gameDir } = await requireDeploy(game)
      if (profileId === DEPLOY_KEY) throw new Error(`Profile not found: ${game}/${profileId}`)
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
      await removeDeploymentLocked(await requireDeployGame(game))
    },

    async getDeployment(game) {
      return deploymentStatus(paths, await requireDeployGame(game))
    },

    async getLaunchWarnings(game: string, profileId: string): Promise<LaunchWarning[]> {
      const def = await requireGame(game)
      await getProfile(paths, game, profileId)
      if (def.loader === 'deploy') {
        const dir = (await loadSettings(paths)).gamePathOverrides[def.label] ?? null
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
        steamRoot
      })
    },

    async launch(game: string, profileId: string | null, mode: LaunchMode): Promise<void> {
      if (mode !== 'modded' && mode !== 'vanilla') {
        throw new Error(`Unknown launch mode: ${String(mode)}`)
      }
      const def = await requireGame(game)
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

    async openExternal(url: string): Promise<void> {
      const u = parseAllowedExternalUrl(url)
      if (!u) throw new Error('HML only opens Thunderstore, GitHub and Nexus Mods links.')
      await deps.shell.openExternal(u.href)
    },

    getSettings: () => loadSettings(paths),

    async saveSettings(s: Settings): Promise<void> {
      await saveSettings(paths, s)
      invalidateSteamRoot()
    },

    getGamesDataDir: async () => paths.gamesDir
  }
}
