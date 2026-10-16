import { create } from 'zustand'
import type { GameSummary } from '../../shared/ipc'
import type {
  HmlEvent,
  InstalledMod,
  LaunchMode,
  LaunchWarning,
  ModUpdate,
  ProfileManifest,
  Settings,
  TsInstallResult
} from '../../shared/types'
import { api, errorMessage } from './api'
import { displayName, installToast, progressLabel } from './tsView'

export type ToastKind = 'error' | 'success' | 'info'
export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

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
  /** Latest progress line from the main process while a Thunderstore install runs. */
  tsProgress: string | null
  toasts: Toast[]
  settingsOpen: boolean

  init(): Promise<void>
  selectGame(game: GameSummary): Promise<void>
  leaveGame(): void
  selectProfile(id: string): Promise<void>
  createProfile(name: string): Promise<void>
  renameProfile(id: string, name: string): Promise<void>
  deleteProfile(id: string): Promise<void>
  openProfileFolder(): Promise<void>
  installFromFile(): Promise<void>
  installFromPaths(paths: string[]): Promise<void>
  setModEnabled(modId: string, enabled: boolean): Promise<void>
  uninstallMod(mod: InstalledMod): Promise<void>
  tsInstall(pkg: { fullName: string; name: string }, version?: string): Promise<void>
  tsUpdate(updates: ModUpdate[]): Promise<void>
  checkUpdates(): Promise<void>
  handleEvent(e: HmlEvent): void
  launch(mode: LaunchMode): Promise<void>
  saveSteamPath(dir: string | null): Promise<void>
  setGamePath(dir: string | null): Promise<void>
  pickGamePath(label: string): Promise<string | null>
  setSettingsOpen(open: boolean): void
  toast(kind: ToastKind, message: string): void
  dismissToast(id: number): void
}

let toastSeq = 0
let updatesSeq = 0

export const useStore = create<State>()((set, get) => {
  const fail = (e: unknown): void => get().toast('error', errorMessage(e))

  /** Runs a mutation with the busy flag set; errors become toasts and yield `failed`. */
  const failed = Symbol('failed')
  async function busy<T>(fn: () => Promise<T>): Promise<T | typeof failed> {
    set((s) => ({ busyCount: s.busyCount + 1, busy: true }))
    try {
      return await fn()
    } catch (e) {
      fail(e)
      return failed
    } finally {
      set((s) => ({ busyCount: s.busyCount - 1, busy: s.busyCount - 1 > 0 }))
    }
  }

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
      set({ settings })
      if (settings.lastGame) {
        const games = await api.searchGames(settings.lastGame)
        const game = games.find((g) => g.label === settings.lastGame)
        if (game) await get().selectGame(game)
      }
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
    const match = (await api.searchGames(game.label)).find((g) => g.label === game.label)
    if (match && get().currentGame?.label === game.label) set({ currentGame: match })
    await refreshWarnings()
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

  /** Runs a Thunderstore install or update with the packages marked as installing. */
  async function tsRun(
    fullNames: string[],
    run: () => Promise<TsInstallResult>
  ): Promise<TsInstallResult | typeof failed> {
    set((s) => ({ tsInstalling: [...s.tsInstalling, ...fullNames] }))
    try {
      return await busy(async () => {
        try {
          return await run()
        } finally {
          // Packages installed before a failure are recorded, so always reload.
          await reloadProfiles()
        }
      })
    } finally {
      set((s) => {
        const tsInstalling = [...s.tsInstalling]
        for (const n of fullNames) tsInstalling.splice(tsInstalling.indexOf(n), 1)
        return { tsInstalling, tsProgress: tsInstalling.length > 0 ? s.tsProgress : null }
      })
      await refreshWarnings()
      await get().checkUpdates()
    }
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
    tsProgress: null,
    toasts: [],
    settingsOpen: false,

    init() {
      initPromise ??= runInit()
      return initPromise
    },
    async selectGame(game) {
      set({ currentGame: game, profiles: [], currentProfile: null, warnings: [], updates: [] })
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
      } catch (e) {
        fail(e)
      }
    },

    leaveGame() {
      set({ currentGame: null, profiles: [], currentProfile: null, warnings: [], updates: [] })
    },

    async selectProfile(id) {
      const game = get().currentGame
      if (!game) return
      set({ currentProfile: id, warnings: [], updates: [] })
      try {
        await persist((s) => ({ ...s, lastProfile: { ...s.lastProfile, [game.label]: id } }))
      } catch (e) {
        fail(e)
      }
      await Promise.all([refreshWarnings(), get().checkUpdates()])
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

    async setModEnabled(modId, enabled) {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile) return
      // Optimistic flip so the toggle responds immediately; reload reconciles either way.
      set({
        profiles: get().profiles.map((p) =>
          p.id !== currentProfile
            ? p
            : { ...p, mods: p.mods.map((m) => (m.id === modId ? { ...m, enabled } : m)) }
        )
      })
      try {
        await api.setModEnabled(currentGame.label, currentProfile, modId, enabled)
      } catch (e) {
        fail(e)
      }
      await reloadProfiles().catch(fail)
      await refreshWarnings()
    },

    async uninstallMod(mod) {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile) return
      const ok = await busy(async () => {
        await api.uninstallMod(currentGame.label, currentProfile, mod.id)
        await reloadProfiles()
      })
      if (ok !== failed) get().toast('success', `Uninstalled ${mod.name}`)
      await refreshWarnings()
      await get().checkUpdates()
    },

    async tsInstall(pkg, version) {
      const { currentGame, currentProfile } = get()
      if (!currentGame || !currentProfile || get().tsInstalling.includes(pkg.fullName)) return
      const result = await tsRun([pkg.fullName], () =>
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
      const result = await tsRun(
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

    async checkUpdates() {
      const { currentGame, currentProfile } = get()
      const seq = ++updatesSeq
      if (!currentGame?.packageIndex || !currentProfile) return set({ updates: [] })
      try {
        const updates = await api.tsCheckUpdates(currentGame.label, currentProfile)
        // Only the newest check for the still-selected profile may write.
        const { currentGame: g, currentProfile: p } = get()
        if (seq === updatesSeq && g?.label === currentGame.label && p === currentProfile)
          set({ updates })
      } catch {
        // Update checks are background work: with Thunderstore unreachable and no cached list
        // there is nothing to compare against, and the Online tab already reports the error.
      }
    },

    handleEvent(e) {
      if (e.type !== 'progress' || get().tsInstalling.length === 0) return
      set({ tsProgress: progressLabel(e) })
    },

    async launch(mode) {
      const { currentGame, currentProfile } = get()
      if (!currentGame) return
      const ok = await busy(() =>
        api.launch(currentGame.label, mode === 'modded' ? currentProfile : null, mode)
      )
      if (ok !== failed) get().toast('info', `Starting ${currentGame.displayName} ${mode}`)
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

    toast(kind, message) {
      const id = ++toastSeq
      set({ toasts: [...get().toasts, { id, kind, message }] })
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
