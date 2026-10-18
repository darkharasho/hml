import { create } from 'zustand'
import type { GameSummary } from '../../shared/ipc'
import type {
  DeploymentStatus,
  GhInstallRequest,
  GhInstallResult,
  GhUpdate,
  GhUpdateMode,
  HmlEvent,
  AddCustomGameInput,
  CustomGameUpdate,
  InstalledMod,
  LaunchMode,
  LaunchWarning,
  ModUpdate,
  NxInstallResult,
  NxUpdate,
  ProfileManifest,
  Settings
} from '../../shared/types'
import { api, errorMessage } from './api'
import { isGhAccessError } from '../../shared/messages'
import { disabledDependencies, type ModDeps } from '../../shared/modDeps'
import { ghInstallToast, ghUpdatedToast } from './ghView'
import { NX_MAX_UPDATE_TABS, NX_MORE_UPDATES, NX_NO_KEY, openWebsiteToast } from './nxView'
import { displayName, installToast, progressLabel } from './tsView'

export type ToastKind = 'error' | 'success' | 'info'
export interface ToastAction {
  label: string
  run(): void
}
export interface Toast {
  id: number
  kind: ToastKind
  message: string
  action?: ToastAction
}
/** Which catalogue the Online tab browses. */
export type OnlineSource = 'thunderstore' | 'nexus'

interface State {
  ready: boolean
  settings: Settings | null
  currentGame: GameSummary | null
  profiles: ProfileManifest[]
  currentProfile: string | null
  warnings: LaunchWarning[]
  /** Number of running mutations; `busy` is `busyCount > 0` so overlapping runs don't clear it. */
  busyCount: number
  busy: boolean
  /** Thunderstore updates for the current profile, from tsCheckUpdates. */
  updates: ModUpdate[]
  /** fullNames of Thunderstore packages being installed or updated. */
  tsInstalling: string[]
  /** GitHub updates for the current profile, from ghCheckUpdates. */
  ghUpdates: GhUpdate[]
  /** Ids of GitHub mods being updated. */
  ghUpdating: string[]
  /** Number of running GitHub installs (the Add from GitHub dialog). */
  ghInstalling: number
  /** GitHub account of a token saved in this session; null when unknown or removed. */
  ghLogin: string | null
  /** Nexus mod ids being installed or updated. */
  nxInstalling: number[]
  /** Nexus updates for the current profile, from nxCheckUpdates. */
  nxUpdates: NxUpdate[]
  /** Bumped when a game's Nexus domain changes, so views that looked it up look again. */
  nxDomainVersion: number
  /** What is deployed into the current deploy game's folder; null when nothing is. */
  deployment: DeploymentStatus | null
  /** The Online tab's last source per game label. */
  onlineSource: Record<string, OnlineSource>
  /** Latest progress line from the main process while a Thunderstore or GitHub install runs. */
  progress: string | null
  toasts: Toast[]
  settingsOpen: boolean
  /** A hand-installed BepInEx found in the selected game's folder, awaiting Remove or Keep. */
  manualLoader: { game: string; entries: string[] } | null
  /** The current game's Nexus domain; null when it has none or the lookup failed. */
  currentDomain: string | null
  /** Games (by label) being started, with the mode, until their process is seen or HML gives up. */
  launching: Record<string, LaunchMode>
  /** The profile sidebar's new-profile name field is open (also opened from the titlebar). */
  creatingProfile: boolean

  init(): Promise<void>
  selectGame(game: GameSummary): Promise<void>
  leaveGame(): void
  addCustomGame(input: AddCustomGameInput): Promise<void>
  resolveManualLoader(action: 'remove' | 'keep'): Promise<void>
  /** Installs (or switches to) the game's chosen BepInEx in the current profile. */
  installLoader(): Promise<void>
  updateCustomGame(patch: CustomGameUpdate): Promise<void>
  /** Forgets the current custom game and returns to the picker; its profiles stay on disk. */
  removeCustomGame(): Promise<void>
  selectProfile(id: string): Promise<void>
  createProfile(name: string): Promise<void>
  renameProfile(id: string, name: string): Promise<void>
  duplicateProfile(id: string): Promise<void>
  deleteProfile(id: string): Promise<void>
  /** Switches to a game's profile (after an import) and reloads its list. */
  openImportedProfile(game: string, profileId: string): Promise<void>
  openProfileFolder(): Promise<void>
  installFromFile(): Promise<void>
  installFromPaths(paths: string[]): Promise<void>
  /** The current profile's dependency graph; null when it can't be read. */
  loadModDeps(): Promise<ModDeps | null>
  /**
   * Turns a mod on or off, with `also` alongside it. Turning one on also turns on the disabled
   * mods it needs.
   */
  setModEnabled(modId: string, enabled: boolean, also?: string[]): Promise<void>
  /** Uninstalls a mod, then each of `also` (dependencies only it needed). */
  uninstallMod(mod: InstalledMod, also?: InstalledMod[]): Promise<void>
  tsInstall(pkg: { fullName: string; name: string }, version?: string): Promise<void>
  tsUpdate(updates: ModUpdate[]): Promise<void>
  /** Throws on failure so the GitHub dialog can show the error inline. */
  ghInstall(url: string, asset?: string, opts?: GhInstallRequest): Promise<GhInstallResult>
  ghUpdate(updates: GhUpdate[]): Promise<void>
  ghSetUpdateMode(modId: string, mode: GhUpdateMode): Promise<void>
  /** Saves a GitHub mod's pre-release setting; an update it reveals is applied per update mode. */
  ghSetPrereleases(modId: string, on: boolean): Promise<void>
  /** Saves a token, or removes it with null. Resolves false when that failed. */
  ghSetToken(token: string | null): Promise<boolean>
  /**
   * Installs a Nexus mod's newest main file, or the given file. Resolves 'needs-key' when it
   * failed for want of an API key, so a dialog (above the toasts) can offer Settings itself.
   */
  nxInstall(
    mod: { modId: number; name: string },
    fileId?: number,
    /** The caller shows the missing-key notice itself, so no toast for it. */
    opts?: { inlineNoKey?: boolean }
  ): Promise<'needs-key' | 'done'>
  /** Saves a Nexus Mods API key, or removes it with null. Resolves false when that failed. */
  nxSetKey(key: string | null): Promise<boolean>
  /** Updates Nexus mods: in place for Premium, by opening each file page for free accounts. */
  nxUpdate(updates: NxUpdate[]): Promise<void>
  /** Sets, or clears with null, the current game's Nexus domain. Throws so the dialog can show why. */
  nxSetDomain(domain: string | null): Promise<void>
  /** Copies the current profile's mods into a deploy game's folder. */
  deploy(): Promise<void>
  /** Restores a deploy game's folder to how it was before deploying. */
  removeDeployment(): Promise<void>
  setOnlineSource(game: string, source: OnlineSource): void
  /** Runs every Thunderstore, GitHub and Nexus update for the current profile. */
  updateAll(): Promise<void>
  checkUpdates(): Promise<void>
  handleEvent(e: HmlEvent): void
  /** Starts the current game; resolves once it's seen running, HML gives up, or it failed. */
  launch(mode: LaunchMode): Promise<void>
  /** Stops waiting for a game to start (the game itself is left alone) and frees its buttons. */
  cancelLaunch(game: string): void
  saveSteamPath(dir: string | null): Promise<void>
  setGamePath(dir: string | null): Promise<void>
  pickGamePath(label: string): Promise<string | null>
  setSettingsOpen(open: boolean): void
  setGameColors(on: boolean): Promise<void>
  setCreatingProfile(open: boolean): void
  toast(kind: ToastKind, message: string, action?: ToastAction): void
  dismissToast(id: number): void
}

let toastSeq = 0
/** The latest launch per game label, so a cancelled launch that ends late changes nothing. */
const launchSeq = new Map<string, number>()
let launchCounter = 0
let updatesSeq = 0
/** The last GitHub rate-limit or rejected-token message shown, so it shows once per session. */
let lastGhNotice: string | null = null

export const useStore = create<State>()((set, get) => {
  const fail = (e: unknown): void => get().toast('error', errorMessage(e))

  /** Runs a mutation with the busy flag set; errors propagate. */
  async function tracked<T>(fn: () => Promise<T>): Promise<T> {
    set((s) => ({ busyCount: s.busyCount + 1, busy: true }))
    try {
      return await fn()
    } finally {
      set((s) => ({ busyCount: s.busyCount - 1, busy: s.busyCount - 1 > 0 }))
    }
  }

  /** Runs a mutation with the busy flag set; errors become toasts and yield `failed`. */
  const failed = Symbol('failed')
  async function busy<T>(fn: () => Promise<T>): Promise<T | typeof failed> {
    try {
      return await tracked(fn)
    } catch (e) {
      fail(e)
      return failed
    }
  }

  /** Frees a game's start buttons; a launch still running for it then ends without effect. */
  function clearLaunching(game: string): void {
    launchSeq.delete(game)
    set((s) => {
      const rest = { ...s.launching }
      delete rest[game]
      return { launching: rest }
    })
  }

  /** The progress line is kept only while some install or update is running. */
  const progressIdle = (s: State): boolean =>
    s.tsInstalling.length === 0 && s.ghUpdating.length === 0 && s.ghInstalling === 0

  async function persist(patch: (s: Settings) => Settings): Promise<void> {
    // Read fresh settings so main-process changes (game path overrides) are never clobbered.
    const next = patch(await api.getSettings())
    await api.saveSettings(next)
    set({ settings: next })
  }

  // Concurrent callers (StrictMode double effects, fast clicks) share one in-flight load,
  // so an empty game never gets two auto-created Default profiles.
  const profileLoads = new Map<string, Promise<ProfileManifest[]>>()
  function loadProfilesEnsuringOne(game: string): Promise<ProfileManifest[]> {
    let load = profileLoads.get(game)
    if (!load) {
      load = (async () => {
        const profiles = await api.listProfiles(game)
        return profiles.length > 0 ? profiles : [await api.createProfile(game, 'Default')]
      })().finally(() => profileLoads.delete(game))
      profileLoads.set(game, load)
    }
    return load
  }

  let initPromise: Promise<void> | null = null
  async function runInit(): Promise<void> {
    try {
      const settings = await api.getSettings()
      // The app always opens on the game picker; lastGame only powers its Back button.
      set({ settings })
    } catch (e) {
      fail(e)
    } finally {
      set({ ready: true })
    }
  }

  async function refreshWarnings(): Promise<void> {
    const { currentGame, currentProfile } = get()
    if (!currentGame || !currentProfile) return set({ warnings: [] })
    try {
      const warnings = await api.getLaunchWarnings(currentGame.label, currentProfile)
      if (get().currentGame?.label === currentGame.label && get().currentProfile === currentProfile)
        set({ warnings })
    } catch (e) {
      fail(e)
    }
  }

  async function reloadProfiles(): Promise<void> {
    const game = get().currentGame
    if (!game) return
    const profiles = await api.listProfiles(game.label)
    if (get().currentGame?.label === game.label) set({ profiles })
  }

  /** Re-reads the current game's install dir and settings after a path change. */
  async function refreshGame(): Promise<void> {
    const game = get().currentGame
    const settings = await api.getSettings()
    set({ settings })
    if (!game) return
    const match = await api.getGame(game.label)
    if (match && get().currentGame?.label === game.label) set({ currentGame: match })
    await Promise.all([refreshWarnings(), refreshDeployment()])
  }

  async function install(run: () => Promise<InstalledMod[]>): Promise<void> {
    const result = await busy(async () => {
      try {
        return await run()
      } finally {
        // Earlier zips in a batch may have installed before a failure.
        await reloadProfiles()
      }
    })
    const mods = result === failed ? [] : result
    if (mods.length === 1) get().toast('success', `Installed ${mods[0].name} ${mods[0].version}`)
    else if (mods.length > 1) get().toast('success', `Installed ${mods.length} mods`)
    await refreshWarnings()
    if (mods.length > 0) await get().checkUpdates()
  }

  /**
   * Runs a Thunderstore install/update (fullNames in `tsInstalling`) or a GitHub update (mod ids
   * in `ghUpdating`) with those entries marked as running.
   */
  async function markedRun<T>(
    list: 'tsInstalling' | 'ghUpdating',
    keys: string[],
    run: () => Promise<T>
  ): Promise<T | typeof failed> {
    set((s) => ({ [list]: [...s[list], ...keys] }))
    try {
      return await busy(async () => {
        try {
          return await run()
        } finally {
          // Mods installed before a failure are recorded, so always reload.
          await reloadProfiles()
        }
      })
    } finally {
      set((s) => {
        const running = [...s[list]]
        for (const k of keys) {
          const at = running.indexOf(k)
          if (at !== -1) running.splice(at, 1)
        }
        const next = { ...s, [list]: running }
        return { [list]: running, progress: progressIdle(next) ? null : s.progress }
      })
      await refreshWarnings()
      await get().checkUpdates()
    }
  }

  async function onGithubUpdated(e: Extract<HmlEvent, { type: 'github-updated' }>): Promise<void> {
    get().toast('success', ghUpdatedToast(e.mods))
    const { currentGame, currentProfile } = get()
    if (currentGame?.label !== e.game || currentProfile !== e.profileId) return
    await reloadProfiles().catch(fail)
    await refreshWarnings()
    await get().checkUpdates()
  }

  async function onGithubUpdatesAvailable(
    e: Extract<HmlEvent, { type: 'github-updates-available' }>
  ): Promise<void> {
    const { currentGame, currentProfile } = get()
    if (currentGame?.label !== e.game || currentProfile !== e.profileId) return
    await get().checkUpdates()
    const mods = e.count === 1 ? 'mod has' : 'mods have'
    get().toast('info', `${e.count} GitHub ${mods} an update. Use Update to install it.`)
  }

  /** Offers to remove a hand-installed BepInEx from the game folder, unless the user already kept it. */
  async function checkManualLoader(game: GameSummary): Promise<void> {
    if (game.loader !== 'bepinex') return
    const found = await api.getManualLoader(game.label).catch(() => null)
    if (found && !found.kept && get().currentGame?.label === game.label)
      set({ manualLoader: { game: game.label, entries: found.entries } })
  }

  /** Loads the game's Nexus domain; a failed lookup counts as no domain. */
  async function loadDomain(game: GameSummary): Promise<void> {
    let domain: string | null = null
    try {
      domain = await api.nxGetDomain(game.label)
    } catch {
      // No domain: the Online tab simply offers fewer sources.
    }
    if (get().currentGame?.label === game.label) set({ currentDomain: domain })
  }

  /** Re-reads what is deployed for the current game; only deploy games have deployments. */
  async function refreshDeployment(): Promise<void> {
    const game = get().currentGame
    if (game?.loader !== 'deploy') return set({ deployment: null })
    // Asked even without a game folder: a deployment made before the folder was cleared is
    // still there and can still be removed.
    const deployment = await api.getDeployment(game.label).catch(() => null)
    if (get().currentGame?.label === game.label) set({ deployment })
  }

  async function onNexusInstalled(
    e: Extract<HmlEvent, { type: 'nexus-installed' }>
  ): Promise<void> {
    const { currentGame, currentProfile } = get()
    if (currentGame?.label === e.game && currentProfile === e.profileId) {
      await reloadProfiles().catch(fail)
      await refreshWarnings()
      await get().checkUpdates()
    }
    get().toast('success', `Installed ${e.mod.name} ${e.mod.version} from Nexus Mods`)
  }

  /** Toasts a Nexus error, with a Settings action when the API key is missing. */
  function nexusFail(e: unknown, inlineNoKey = false): 'needs-key' | 'done' {
    const message = errorMessage(e)
    const noKey = message === NX_NO_KEY
    if (!(noKey && inlineNoKey))
      get().toast(
        'error',
        message,
        noKey ? { label: 'Settings', run: () => get().setSettingsOpen(true) } : undefined
      )
    return noKey ? 'needs-key' : 'done'
  }

  /** Opens a free account's file pages; the nxm:// links bring the downloads back. */
  async function openNexusPages(urls: string[]): Promise<void> {
    try {
      for (const url of urls.slice(0, NX_MAX_UPDATE_TABS)) await api.openExternal(url)
    } catch (e) {
      return fail(e)
    }
    const handler = await api.nxStatus().then(
      (s) => s.handler,
      () => 'not-registered' as const
    )
    get().toast('info', openWebsiteToast(handler))
    if (urls.length > NX_MAX_UPDATE_TABS) get().toast('info', NX_MORE_UPDATES)
  }

  return {
    ready: false,
    settings: null,
    currentGame: null,
    profiles: [],
    currentProfile: null,
    warnings: [],
    busyCount: 0,
    busy: false,
    updates: [],
    tsInstalling: [],
    ghUpdates: [],
    ghUpdating: [],
    ghInstalling: 0,
    ghLogin: null,
    nxInstalling: [],
    nxUpdates: [],
    nxDomainVersion: 0,
    deployment: null,
    onlineSource: {},
    progress: null,
    toasts: [],
    settingsOpen: false,
    manualLoader: null,
    currentDomain: null,
    launching: {},
    creatingProfile: false,

    init() {
      initPromise ??= runInit()
      return initPromise
    },
    async selectGame(game) {
      set({
        currentGame: game,
        profiles: [],
        currentProfile: null,
        warnings: [],
        updates: [],
        ghUpdates: [],
        nxUpdates: [],
        deployment: null,
        manualLoader: null,
        currentDomain: null,
        creatingProfile: false
      })
      void loadDomain(game)
      try {
        const profiles = await loadProfilesEnsuringOne(game.label)
        if (get().currentGame?.label !== game.label) return
        set({ profiles })
        const remembered = get().settings?.lastProfile[game.label]
        const profile = profiles.find((p) => p.id === remembered) ?? profiles[0]
        await persist((s) => ({ ...s, lastGame: game.label }))
        // The user may have picked another game while settings were saving.
        if (get().currentGame?.label !== game.label) return
        await get().selectProfile(profile.id)
        await checkManualLoader(game)
      } catch (e) {
        fail(e)
      }
    },

    async addCustomGame(input) {
      const added = await api.addCustomGame(input)
      await get().selectGame(added)
    },

    async resolveManualLoader(action) {
      const prompt = get().manualLoader
      if (!prompt) return
      try {
        if (action === 'keep') await api.keepManualLoader(prompt.game)
        else {
          const backup = await api.removeManualLoader(prompt.game)
          get().toast('success', `Moved the manual BepInEx install to ${backup}`)
        }
        set({ manualLoader: null })
      } catch (e) {
        fail(e)
      }
    },

    leaveGame() {
      set({
        currentGame: null,
        profiles: [],
        currentProfile: null,
        warnings: [],
        updates: [],
        ghUpdates: [],
        nxUpdates: [],
        deployment: null,
        manualLoader: null,
        currentDomain: null,
        creatingProfile: false
      })
    },

    async installLoader() {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile) return
      const mod = await busy(() => api.installLoader(currentGame.label, currentProfile))
      if (mod === failed) return
      if (get().currentGame?.label === currentGame.label) {
        await reloadProfiles().catch(fail)
        await refreshWarnings()
      }
      get().toast('success', `Installed ${mod.name} ${mod.version}`)
    },

    async updateCustomGame(patch) {
      const game = get().currentGame
      if (!game) return
      // Throws so the edit dialog can show the reason inline.
      const updated = await tracked(() => api.updateCustomGame(game.label, patch))
      if (get().currentGame?.label === game.label) {
        set({ currentGame: updated })
        await refreshWarnings()
      }
    },

    async removeCustomGame() {
      const game = get().currentGame
      if (!game) return
      const ok = await busy(() => api.removeCustomGame(game.label))
      if (ok === failed) return
      get().leaveGame()
      get().toast('success', `Removed ${game.displayName} from HML. Its profiles are kept.`)
    },

    async selectProfile(id) {
      const game = get().currentGame
      if (!game) return
      set({ currentProfile: id, warnings: [], updates: [], ghUpdates: [], nxUpdates: [] })
      try {
        await persist((s) => ({ ...s, lastProfile: { ...s.lastProfile, [game.label]: id } }))
      } catch (e) {
        fail(e)
      }
      await Promise.all([refreshWarnings(), get().checkUpdates(), refreshDeployment()])
    },

    async createProfile(name) {
      const game = get().currentGame
      if (!game) return
      const created = await busy(async () => {
        const profile = await api.createProfile(game.label, name)
        await reloadProfiles()
        return profile
      })
      if (created !== failed) {
        get().toast('success', `Created profile ${created.name}`)
        await get().selectProfile(created.id)
      }
    },

    async renameProfile(id, name) {
      const game = get().currentGame
      if (!game) return
      await busy(async () => {
        await api.renameProfile(game.label, id, name)
        await reloadProfiles()
      })
    },

    async duplicateProfile(id) {
      const game = get().currentGame
      const source = get().profiles.find((p) => p.id === id)
      if (!game || !source) return
      const created = await busy(async () => {
        const profile = await api.duplicateProfile(game.label, id, `${source.name} (copy)`)
        await reloadProfiles()
        return profile
      })
      if (created !== failed) {
        get().toast('success', `Created ${created.name}`)
        await get().selectProfile(created.id)
      }
    },

    async deleteProfile(id) {
      const game = get().currentGame
      if (!game) return
      const ok = await busy(async () => {
        await api.deleteProfile(game.label, id)
        const profiles = await loadProfilesEnsuringOne(game.label)
        if (get().currentGame?.label === game.label) set({ profiles })
      })
      if (ok !== failed && get().currentGame?.label === game.label && get().currentProfile === id)
        await get().selectProfile(get().profiles[0].id)
    },

    async openImportedProfile(game, profileId) {
      try {
        // Remembered first, so selectGame lands on this profile instead of the last one used.
        await persist((s) => ({ ...s, lastProfile: { ...s.lastProfile, [game]: profileId } }))
        if (get().currentGame?.label === game) {
          await reloadProfiles()
          return await get().selectProfile(profileId)
        }
        const match = await api.getGame(game)
        if (!match) throw new Error(`HML couldn't find the game ${game}.`)
        await get().selectGame(match)
      } catch (e) {
        fail(e)
      }
    },

    async openProfileFolder() {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile) return
      await api.openProfileFolder(currentGame.label, currentProfile).catch(fail)
    },

    async installFromFile() {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile) return
      await install(() => api.installFromFile(currentGame.label, currentProfile))
    },

    async installFromPaths(paths) {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile || paths.length === 0) return
      await install(() => api.installFromPaths(currentGame.label, currentProfile, paths))
    },

    async loadModDeps() {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile) return null
      try {
        return await api.getModDeps(currentGame.label, currentProfile)
      } catch {
        return null
      }
    },

    async setModEnabled(modId, enabled, also = []) {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile) return
      const mods = get().profiles.find((p) => p.id === currentProfile)?.mods ?? []
      const flip = (ids: string[]): void =>
        set({
          profiles: get().profiles.map((p) =>
            p.id !== currentProfile
              ? p
              : { ...p, mods: p.mods.map((m) => (ids.includes(m.id) ? { ...m, enabled } : m)) }
          )
        })
      // Optimistic flip so the toggle responds immediately; reload reconciles either way.
      flip([modId, ...also])
      let needed: string[] = []
      if (enabled) {
        const graph = await get().loadModDeps()
        needed = graph
          ? disabledDependencies(graph, mods, modId).filter((id) => !also.includes(id))
          : []
        flip(needed)
      }
      const done: string[] = []
      try {
        for (const id of [modId, ...also, ...needed]) {
          await api.setModEnabled(currentGame.label, currentProfile, id, enabled)
          done.push(id)
        }
      } catch (e) {
        fail(e)
      }
      const turnedOn = needed.filter((id) => done.includes(id))
      if (turnedOn.length > 0) {
        const names = turnedOn.map((id) => displayName(mods.find((m) => m.id === id)?.name ?? id))
        get().toast('info', `Also turned on ${names.join(', ')}, which it needs.`)
      }
      await reloadProfiles().catch(fail)
      await refreshWarnings()
    },

    async uninstallMod(mod, also = []) {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile) return
      const ok = await busy(async () => {
        try {
          for (const m of [mod, ...also])
            await api.uninstallMod(currentGame.label, currentProfile, m.id)
        } finally {
          await reloadProfiles()
        }
      })
      if (ok !== failed)
        get().toast(
          'success',
          also.length > 0
            ? `Uninstalled ${mod.name} and ${also.length} ${also.length === 1 ? 'dependency' : 'dependencies'}`
            : `Uninstalled ${mod.name}`
        )
      await refreshWarnings()
      await get().checkUpdates()
    },

    async tsInstall(pkg, version) {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile || get().tsInstalling.includes(pkg.fullName)) return
      const result = await markedRun('tsInstalling', [pkg.fullName], () =>
        api.tsInstall(currentGame.label, currentProfile, pkg.fullName, version)
      )
      if (result === failed) return
      const name = displayName(pkg.name)
      const t = installToast(`Installed ${name}`, result, name)
      get().toast(t.kind, t.message)
    },

    async tsUpdate(updates) {
      const { currentGame, currentProfile, tsInstalling } = get()
      const todo = updates.filter((u) => !tsInstalling.includes(u.fullName))
      if (!currentGame || !currentProfile || todo.length === 0) return
      const result = await markedRun(
        'tsInstalling',
        todo.map((u) => u.fullName),
        () =>
          api.tsUpdate(
            currentGame.label,
            currentProfile,
            todo.map((u) => u.modId)
          )
      )
      if (result === failed) return
      const first = get()
        .profiles.find((p) => p.id === currentProfile)
        ?.mods.find((m) => m.id === todo[0].modId)
      const what =
        todo.length === 1
          ? `${first ? displayName(first.name) : todo[0].fullName} to ${todo[0].latest}`
          : `${todo.length} mods`
      const t = installToast(`Updated ${what}`, result)
      get().toast(t.kind, t.message)
    },

    async ghInstall(url, asset, opts) {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile) throw new Error('Pick a profile first.')
      set((s) => ({ ghInstalling: s.ghInstalling + 1 }))
      let result: GhInstallResult
      try {
        result = await tracked(async () => {
          try {
            return await api.ghInstall(currentGame.label, currentProfile, url, asset, opts)
          } finally {
            await reloadProfiles()
          }
        })
      } finally {
        set((s) => {
          const ghInstalling = s.ghInstalling - 1
          return {
            ghInstalling,
            progress: progressIdle({ ...s, ghInstalling }) ? null : s.progress
          }
        })
      }
      if (result.kind === 'installed') {
        get().toast('success', ghInstallToast(result.mod, result.replaced))
        await refreshWarnings()
        await get().checkUpdates()
      }
      return result
    },

    async ghUpdate(updates) {
      const { currentGame, currentProfile, ghUpdating } = get()
      const todo = updates.filter((u) => !ghUpdating.includes(u.modId))
      if (!currentGame || !currentProfile || todo.length === 0) return
      const ids = todo.map((u) => u.modId)
      const result = await markedRun('ghUpdating', ids, () =>
        api.ghUpdate(currentGame.label, currentProfile, ids)
      )
      if (result === failed) return
      if (result.length === 0) {
        const what = todo.length === 1 ? `${todo[0].owner}/${todo[0].repo} is` : 'GitHub mods are'
        return get().toast('info', `${what} already up to date`)
      }
      const done = result.map((m) => ({
        name: m.name,
        tag: m.source.kind === 'github' ? m.source.tag : m.version
      }))
      get().toast('success', ghUpdatedToast(done))
    },

    async ghSetUpdateMode(modId, mode) {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile) return
      const ok = await busy(async () => {
        await api.ghSetUpdateMode(currentGame.label, currentProfile, modId, mode)
        await reloadProfiles()
      })
      if (ok !== failed) await get().checkUpdates()
    },

    async ghSetPrereleases(modId, on) {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile) return
      const result = await busy(async () => {
        const r = await api.ghSetPrereleases(currentGame.label, currentProfile, modId, on)
        await reloadProfiles()
        return r
      })
      if (result === failed) return
      const found = result.update
      // An auto-mode update installs now (ghUpdate checks again when it is done); notify mode
      // announces it the way the background check does.
      if (found?.mode === 'auto') return get().ghUpdate([found])
      await get().checkUpdates()
      if (found) {
        get().toast(
          'info',
          `${found.owner}/${found.repo} has an update to ${found.latest}. Use Update to install it.`
        )
      } else if (result.prereleaseOnly) {
        const source = get()
          .profiles.find((p) => p.id === currentProfile)
          ?.mods.find((m) => m.id === modId)?.source
        const name = source?.kind === 'github' ? `${source.owner}/${source.repo}` : modId
        get().toast(
          'info',
          `${name} only publishes pre-releases, so it won't update until it publishes a stable release.`
        )
      }
    },

    async ghSetToken(token) {
      const result = await busy(() => api.ghSetToken(token))
      if (result === failed) return false
      set({ ghLogin: token ? result.login : null })
      get().toast(
        'success',
        !token
          ? 'Removed GitHub token'
          : result.login
            ? `Saved GitHub token for ${result.login}`
            : 'Saved GitHub token'
      )
      // A token can reveal updates for private repos or lift a rate limit.
      await get().checkUpdates()
      return true
    },

    async nxInstall(mod, fileId, opts) {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile || get().nxInstalling.includes(mod.modId)) return 'done'
      set((s) => ({ nxInstalling: [...s.nxInstalling, mod.modId] }))
      let result: NxInstallResult
      try {
        result = await tracked(async () => {
          try {
            return await api.nxInstall(currentGame.label, currentProfile, mod.modId, fileId)
          } finally {
            await reloadProfiles()
          }
        })
      } catch (e) {
        return nexusFail(e, opts?.inlineNoKey)
      } finally {
        set((s) => ({ nxInstalling: s.nxInstalling.filter((id) => id !== mod.modId) }))
      }
      if (result.kind === 'installed') {
        get().toast('success', `Installed ${result.mod.name} ${result.mod.version}`)
        await refreshWarnings()
        await get().checkUpdates()
        return 'done'
      }
      // Free accounts finish on the file page; the nxm:// link brings the download back.
      await openNexusPages([result.url])
      return 'done'
    },

    async nxSetKey(key) {
      const result = await busy(() => api.nxSetKey(key))
      if (result === failed) return false
      get().toast(
        'success',
        !key
          ? 'Removed Nexus Mods API key'
          : result
            ? `Saved Nexus Mods API key for ${result.name}`
            : 'Saved Nexus Mods API key'
      )
      return true
    },

    async nxUpdate(updates) {
      const { currentGame, currentProfile, nxInstalling } = get()
      const todo = updates.filter((u) => !nxInstalling.includes(u.nexusModId))
      if (!currentGame || !currentProfile || todo.length === 0) return
      const ids = todo.map((u) => u.nexusModId)
      set((s) => ({ nxInstalling: [...s.nxInstalling, ...ids] }))
      let results: NxInstallResult[]
      try {
        results = await tracked(async () => {
          try {
            return await api.nxUpdate(
              currentGame.label,
              currentProfile,
              todo.map((u) => u.modId)
            )
          } finally {
            // Mods updated before a failure are recorded, so always reload.
            await reloadProfiles()
          }
        })
      } catch (e) {
        nexusFail(e)
        return
      } finally {
        set((s) => ({ nxInstalling: s.nxInstalling.filter((id) => !ids.includes(id)) }))
        await refreshWarnings()
        await get().checkUpdates()
      }
      const installed = results.flatMap((r) => (r.kind === 'installed' ? [r.mod] : []))
      if (installed.length === 1) {
        get().toast('success', `Updated ${installed[0].name} to ${installed[0].version}`)
      } else if (installed.length > 1) {
        get().toast('success', `Updated ${installed.length} Nexus mods`)
      }
      const urls = results.flatMap((r) => (r.kind === 'open-website' ? [r.url] : []))
      if (urls.length > 0) await openNexusPages(urls)
      if (results.length === 0) get().toast('info', 'Nexus mods are already up to date')
    },

    async nxSetDomain(domain) {
      const game = get().currentGame
      if (!game) return
      await tracked(() => api.nxSetDomain(game.label, domain))
      set((s) => ({ nxDomainVersion: s.nxDomainVersion + 1 }))
      await loadDomain(game)
      get().toast(
        'success',
        domain ? `Using nexusmods.com/${domain}` : 'Cleared the Nexus Mods page'
      )
      await get().checkUpdates()
    },

    async deploy() {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile) return
      const result = await busy(() => api.deployProfile(currentGame.label, currentProfile))
      if (result !== failed) {
        if (get().currentGame?.label === currentGame.label) set({ deployment: result })
        get().toast('success', `Deployed mods to ${currentGame.displayName}`)
      }
      await refreshDeployment()
    },

    async removeDeployment() {
      const game = get().currentGame
      if (!game) return
      const ok = await busy(() => api.removeDeployment(game.label))
      if (ok !== failed) get().toast('success', `Removed mods from ${game.displayName}`)
      // A remove copies changed files back into their mods, so the profile may have changed.
      await reloadProfiles().catch(fail)
      await refreshDeployment()
    },

    setOnlineSource(game, source) {
      set((s) => ({ onlineSource: { ...s.onlineSource, [game]: source } }))
    },

    async updateAll() {
      const { updates, ghUpdates, nxUpdates } = get()
      await Promise.all([
        get().tsUpdate(updates),
        get().ghUpdate(ghUpdates),
        get().nxUpdate(nxUpdates)
      ])
    },

    async checkUpdates() {
      const { currentGame, currentProfile } = get()
      const seq = ++updatesSeq
      if (!currentGame || !currentProfile) return set({ updates: [], ghUpdates: [], nxUpdates: [] })
      // Only the newest check for the still-selected profile may write.
      const current = (): boolean => {
        const { currentGame: g, currentProfile: p } = get()
        return seq === updatesSeq && g?.label === currentGame.label && p === currentProfile
      }
      // A failed check keeps the last list, minus mods that were uninstalled since.
      const pruneOnFail = (e: unknown, key: 'updates' | 'ghUpdates' | 'nxUpdates'): never => {
        if (current()) {
          const installed = get().profiles.find((p) => p.id === currentProfile)?.mods ?? []
          const still = (u: { modId: string }): boolean => installed.some((m) => m.id === u.modId)
          if (key === 'updates') set((s) => ({ updates: s.updates.filter(still) }))
          else if (key === 'ghUpdates') set((s) => ({ ghUpdates: s.ghUpdates.filter(still) }))
          else set((s) => ({ nxUpdates: s.nxUpdates.filter(still) }))
        }
        throw e
      }
      if (!currentGame.packageIndex) set({ updates: [] })
      const ts = currentGame.packageIndex
        ? api
            .tsCheckUpdates(currentGame.label, currentProfile)
            .then((updates) => {
              if (current()) set({ updates })
            })
            .catch((e) => pruneOnFail(e, 'updates'))
        : null
      const gh = api
        .ghCheckUpdates(currentGame.label, currentProfile)
        .then((ghUpdates) => {
          if (current()) set({ ghUpdates })
        })
        .catch((e) => pruneOnFail(e, 'ghUpdates'))
      // Nexus checks need the game's domain; a game that isn't on Nexus Mods has no updates there.
      const hasNexusMods = get()
        .profiles.find((p) => p.id === currentProfile)
        ?.mods.some((m) => m.source.kind === 'nexus')
      const nx = hasNexusMods
        ? api
            .nxGetDomain(currentGame.label)
            .then(async (domain) => {
              const nxUpdates = domain
                ? await api.nxCheckUpdates(currentGame.label, currentProfile)
                : []
              if (current()) set({ nxUpdates })
            })
            .catch((e) => pruneOnFail(e, 'nxUpdates'))
        : null
      if (!nx) set({ nxUpdates: [] })
      // Update checks are background work. With Thunderstore unreachable and no cached list there
      // is nothing to compare against, and the Online tab already reports the error; a failing
      // GitHub lookup only skips that mod, and a manual update surfaces the error. A GitHub rate
      // limit or rejected token that stopped every lookup is shown once, as info.
      const ghFailed = (e: unknown): void => {
        const message = errorMessage(e)
        if (!isGhAccessError(message) || message === lastGhNotice) return
        lastGhNotice = message
        get().toast('info', message)
      }
      await Promise.all([ts?.catch(() => {}), gh.catch(ghFailed), nx?.catch(() => {})])
    },

    handleEvent(e) {
      if (e.type === 'github-updated') return void onGithubUpdated(e)
      if (e.type === 'github-updates-available') return void onGithubUpdatesAvailable(e)
      if (e.type === 'nexus-installed') return void onNexusInstalled(e)
      if (e.type === 'nexus-failed') return get().toast('error', e.message)
      if (progressIdle(get())) return
      set({ progress: progressLabel(e) })
    },

    async launch(mode) {
      const { currentGame, currentProfile } = get()
      // HML does not start catalog deploy games (the launch bar deploys instead); custom ones can Play.
      if (!currentGame || (currentGame.loader === 'deploy' && !currentGame.custom)) return
      const label = currentGame.label
      // A second press while the game is starting does nothing.
      if (get().launching[label]) return
      const seq = ++launchCounter
      launchSeq.set(label, seq)
      const current = (): boolean => launchSeq.get(label) === seq
      set((s) => ({ launching: { ...s.launching, [label]: mode } }))
      const name = currentGame.displayName
      try {
        const ok = await busy(() =>
          api.launch(label, mode === 'modded' ? currentProfile : null, mode)
        )
        if (ok === failed || !current()) return
        const result = await api.waitForGame(label).catch(() => 'unknown' as const)
        if (!current()) return
        if (result === 'timeout')
          get().toast('info', `Couldn't confirm ${name} started — it may still be loading`)
        else if (result === 'exited')
          get().toast('error', `${name} closed before it finished starting.`)
        else if (result === 'unknown') get().toast('info', `Starting ${name} ${mode}`)
      } finally {
        if (current()) clearLaunching(label)
      }
    },

    cancelLaunch(game) {
      if (!get().launching[game]) return
      clearLaunching(game)
      void api.cancelWaitForGame(game).catch(() => undefined)
    },

    async saveSteamPath(dir) {
      const ok = await busy(async () => {
        await persist((s) => ({ ...s, steamRootOverride: dir }))
        await refreshGame()
      })
      if (ok !== failed) get().toast('success', dir ? 'Saved Steam folder' : 'Cleared Steam folder')
    },

    async setGamePath(dir) {
      const game = get().currentGame
      if (!game) return
      const ok = await busy(async () => {
        await api.setGamePath(game.label, dir)
        await refreshGame()
      })
      if (ok !== failed) get().toast('success', dir ? 'Saved game folder' : 'Cleared game folder')
    },

    async pickGamePath(label) {
      try {
        const dir = await api.pickGamePath(label)
        if (dir) {
          if (get().currentGame?.label === label) await refreshGame()
          else set({ settings: await api.getSettings() })
          get().toast('success', 'Saved game folder')
        }
        return dir
      } catch (e) {
        fail(e)
        return null
      }
    },

    setSettingsOpen(open) {
      set({ settingsOpen: open })
    },

    async setGameColors(on) {
      await persist((s) => ({ ...s, gameColors: on })).catch(fail)
    },

    setCreatingProfile(open) {
      set({ creatingProfile: open })
    },

    toast(kind, message, action) {
      const id = ++toastSeq
      set({ toasts: [...get().toasts, { id, kind, message, action }] })
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000)
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) })
    }
  }
})

/** The selected profile's manifest, or null. */
export function useCurrentProfile(): ProfileManifest | null {
  return useStore((s) => s.profiles.find((p) => p.id === s.currentProfile) ?? null)
}
