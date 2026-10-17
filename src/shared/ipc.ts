import type {
  AddCustomGameInput,
  CustomGameUpdate,
  GameDef,
  GameDetection,
  GhInstallRequest,
  GhInstallResult,
  GhPrereleaseResult,
  GhUpdate,
  GhUpdateMode,
  DeploymentStatus,
  ImportResult,
  InstalledMod,
  LaunchMode,
  LaunchWarning,
  LaunchWatchResult,
  ModUpdate,
  NxInstallResult,
  NxModDetail,
  NxQuery,
  NxSearchResult,
  NxStatus,
  NxUpdate,
  NxUser,
  ProfileManifest,
  ProtonOptionsResult,
  Runner,
  Settings,
  SharePreview,
  TsInstallResult,
  TsDocKind,
  TsPackage,
  TsQuery,
  TsSearchResult
} from './types'

export interface GameSummary extends GameDef {
  installDir: string | null
  /** Catalog ids of this game's loader packages, e.g. "BepInEx-BepInExPack". */
  loaderPackageIds: string[]
}

export interface HmlApi {
  /** Installed games are listed before games that are not installed. */
  searchGames(query: string): Promise<GameSummary[]>
  /** One game by label, without searching Nexus Mods; null for an unknown label. */
  getGame(label: string): Promise<GameSummary | null>
  refreshCatalog(): Promise<void>
  setGamePath(label: string, dir: string | null): Promise<void>
  /** Folder dialog, then setGamePath. Null when cancelled. */
  pickGamePath(label: string): Promise<string | null>
  listProfiles(game: string): Promise<ProfileManifest[]>
  createProfile(game: string, name: string): Promise<ProfileManifest>
  renameProfile(game: string, id: string, name: string): Promise<void>
  deleteProfile(game: string, id: string): Promise<void>
  /** Multi-select .zip dialog; installs with source kind 'local'. Cancel returns []. */
  installFromFile(game: string, profileId: string): Promise<InstalledMod[]>
  /** Installs dropped .zip files (absolute paths) with source kind 'local'. */
  installFromPaths(game: string, profileId: string, paths: string[]): Promise<InstalledMod[]>
  setModEnabled(game: string, profileId: string, modId: string, enabled: boolean): Promise<void>
  uninstallMod(game: string, profileId: string, modId: string): Promise<void>
  getLaunchWarnings(game: string, profileId: string): Promise<LaunchWarning[]>
  launch(game: string, profileId: string | null, mode: LaunchMode): Promise<void>
  /**
   * Linux: adds `WINEDLLOVERRIDES="winhttp=n,b"` to the game's Steam launch options, merged with
   * the user's. Answers `steam-running` (writing nothing) while Steam is open.
   */
  setProtonLaunchOptions(game: string): Promise<ProtonOptionsResult>
  /** Linux: asks Steam to shut down, waits for it to exit (about 30 s), then sets them. */
  closeSteamAndSet(game: string): Promise<ProtonOptionsResult>
  /**
   * After a launch, polls (about every second, for up to two minutes) until one of the game's
   * exes is running. 'unknown' when HML can't detect the game's process.
   */
  waitForGame(game: string): Promise<LaunchWatchResult>
  /** Ends the game's running waitForGame with 'cancelled' (the game itself is left alone). */
  cancelWaitForGame(game: string): Promise<void>
  openProfileFolder(game: string, profileId: string): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<void>
  /** Absolute path of HML's per-game data dir (`<userData>/games`), for the Flatpak override. */
  getGamesDataDir(): Promise<string>
  tsSearch(game: string, q: TsQuery): Promise<TsSearchResult>
  tsRefresh(game: string): Promise<{ count: number; fetchedAt: string; stale: boolean }>
  tsGetPackage(game: string, fullName: string): Promise<TsPackage | null>
  /** A package version's README or CHANGELOG markdown from Thunderstore, or null if it has none. */
  tsGetDoc(fullName: string, version: string, kind: TsDocKind): Promise<string | null>
  tsInstall(
    game: string,
    profileId: string,
    fullName: string,
    version?: string
  ): Promise<TsInstallResult>
  tsCheckUpdates(game: string, profileId: string): Promise<ModUpdate[]>
  tsUpdate(game: string, profileId: string, modIds: string[]): Promise<TsInstallResult>
  /** Installs the latest (or the linked) release of a GitHub repo; may ask which file to use. */
  ghInstall(
    game: string,
    profileId: string,
    url: string,
    asset?: string,
    opts?: GhInstallRequest
  ): Promise<GhInstallResult>
  ghCheckUpdates(game: string, profileId: string): Promise<GhUpdate[]>
  ghUpdate(game: string, profileId: string, modIds: string[]): Promise<InstalledMod[]>
  ghSetUpdateMode(game: string, profileId: string, modId: string, mode: GhUpdateMode): Promise<void>
  /** Saves the mod's pre-release setting and checks the mod (pinned mods aren't checked). */
  ghSetPrereleases(
    game: string,
    profileId: string,
    modId: string,
    on: boolean
  ): Promise<GhPrereleaseResult>
  /** Saves (after verifying) or, with null/empty, removes the GitHub token. Never returns it. */
  ghSetToken(token: string | null): Promise<{ login: string | null }>
  ghTokenStatus(): Promise<{ set: boolean; encryptionAvailable: boolean }>
  /** Persists a Nexus-only game (validated against Nexus Mods) so it can be opened like any game. */
  addNexusGame(domain: string): Promise<GameSummary>
  /** The game's Nexus domain (override, cache, or live lookup); null when not on Nexus Mods. */
  nxGetDomain(game: string): Promise<string | null>
  /** Sets (after validating) or, with null, clears the Nexus domain override for a game. */
  nxSetDomain(game: string, domain: string | null): Promise<void>
  /** Saves (after verifying) or, with null/empty, removes the Nexus Mods API key. Never returns it. */
  nxSetKey(key: string | null): Promise<NxUser | null>
  nxStatus(): Promise<NxStatus>
  /** Makes HML the operating system's handler for `nxm://` links (only on the user's request). */
  nxRegisterHandler(): Promise<void>
  nxSearch(game: string, q: NxQuery): Promise<NxSearchResult>
  nxGetMod(game: string, modId: number): Promise<NxModDetail>
  nxInstall(
    game: string,
    profileId: string,
    modId: number,
    fileId?: number
  ): Promise<NxInstallResult>
  nxCheckUpdates(game: string, profileId: string): Promise<NxUpdate[]>
  nxUpdate(game: string, profileId: string, modIds: string[]): Promise<NxInstallResult[]>
  /** Saves the profile as a `<name>.hml` file chosen in a save dialog; null when cancelled. */
  exportProfileFile(game: string, profileId: string): Promise<string | null>
  /** Uploads the profile and returns its share code plus how many local mods won't resolve for others. */
  shareProfile(game: string, profileId: string): Promise<{ code: string; localMods: number }>
  /** Reads a share code or a picked `.hml` file and holds it for importShare; null when the file dialog is cancelled. */
  previewShare(input: { code: string } | { file: true }): Promise<SharePreview | null>
  /** Rebuilds the previewed profile as a new profile; a blank name uses the shared profile's name. */
  importShare(token: string, name: string, folder?: string): Promise<ImportResult>
  /** Copies the profile's enabled mods into the game folder (deploy games), replacing any current deployment. */
  deployProfile(game: string, profileId: string): Promise<DeploymentStatus>
  /** Restores the game folder to how it was before the deployment. */
  removeDeployment(game: string): Promise<void>
  getDeployment(game: string): Promise<DeploymentStatus | null>
  /** Opens an https Thunderstore or GitHub link in the system browser; anything else throws. */
  openExternal(url: string): Promise<void>
  /** Detection for an installed Steam game (by `steam-<appid>` label) or an added custom game. */
  detectCustomGame(
    label: string
  ): Promise<{ displayName: string; folder: string; detection: GameDetection }>
  /** Folder dialog, then detection; null when cancelled. */
  pickCustomGameFolder(): Promise<{
    folder: string
    displayName: string
    detection: GameDetection
  } | null>
  /** Adds an installed Steam game or a game folder as a custom game. */
  addCustomGame(input: AddCustomGameInput): Promise<GameSummary>
  /** Renames a custom game, changes the loader new profiles get, or its runner. */
  updateCustomGame(label: string, patch: CustomGameUpdate): Promise<GameSummary>
  /** Forgets a custom game; its profiles stay on disk. Refused while mods are deployed. */
  removeCustomGame(label: string): Promise<void>
  /** Proton builds and Wine that can start a Windows game on Linux; empty on Windows. */
  listRunners(): Promise<Runner[]>
  /** Installs (or switches to) the game's chosen BepInEx in the profile from BepInEx's GitHub releases. */
  installLoader(game: string, profileId: string): Promise<InstalledMod>
  /** A hand-installed BepInEx in the game folder; null when there is none. */
  getManualLoader(game: string): Promise<{ entries: string[]; kept: boolean } | null>
  /** Moves it to HML's backup folder; returns that folder. */
  removeManualLoader(game: string): Promise<string>
  /** Remembers "Keep" for this game. */
  keepManualLoader(game: string): Promise<void>
  /**
   * Image dialog for a custom game's cover; null when cancelled. The token goes to addCustomGame
   * or updateCustomGame as `image`; the preview is a data: URL of the image.
   */
  pickCustomGameImage(): Promise<{ token: string; preview: string } | null>
  /** Icon URLs to try in order for each installed mod (by id); a mod without any is left out. */
  getModIcons(game: string, profileId: string): Promise<Record<string, string[]>>
}

// `satisfies` makes the compiler reject a missing or unknown method name.
const METHOD_TABLE = {
  searchGames: true,
  getGame: true,
  refreshCatalog: true,
  setGamePath: true,
  pickGamePath: true,
  listProfiles: true,
  createProfile: true,
  renameProfile: true,
  deleteProfile: true,
  installFromFile: true,
  installFromPaths: true,
  setModEnabled: true,
  uninstallMod: true,
  getLaunchWarnings: true,
  launch: true,
  setProtonLaunchOptions: true,
  closeSteamAndSet: true,
  waitForGame: true,
  cancelWaitForGame: true,
  openProfileFolder: true,
  getSettings: true,
  saveSettings: true,
  getGamesDataDir: true,
  tsSearch: true,
  tsRefresh: true,
  tsGetPackage: true,
  tsGetDoc: true,
  tsInstall: true,
  tsCheckUpdates: true,
  tsUpdate: true,
  ghInstall: true,
  ghCheckUpdates: true,
  ghUpdate: true,
  ghSetUpdateMode: true,
  ghSetPrereleases: true,
  ghSetToken: true,
  ghTokenStatus: true,
  addNexusGame: true,
  nxGetDomain: true,
  nxSetDomain: true,
  nxSetKey: true,
  nxStatus: true,
  nxRegisterHandler: true,
  nxSearch: true,
  nxGetMod: true,
  nxInstall: true,
  nxCheckUpdates: true,
  nxUpdate: true,
  exportProfileFile: true,
  shareProfile: true,
  previewShare: true,
  importShare: true,
  deployProfile: true,
  removeDeployment: true,
  getDeployment: true,
  openExternal: true,
  detectCustomGame: true,
  pickCustomGameFolder: true,
  addCustomGame: true,
  updateCustomGame: true,
  removeCustomGame: true,
  listRunners: true,
  installLoader: true,
  getManualLoader: true,
  removeManualLoader: true,
  keepManualLoader: true,
  pickCustomGameImage: true,
  getModIcons: true
} satisfies Record<keyof HmlApi, true>

export const HML_METHODS = Object.keys(METHOD_TABLE) as (keyof HmlApi)[]

export function channel(method: keyof HmlApi): string {
  return `hml:${method}`
}

/** The window's own controls, for the titlebar HML draws in place of the system frame. */
export interface WindowApi {
  minimize(): Promise<void>
  /** Maximizes, or restores a maximized window. */
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
}

const WINDOW_METHOD_TABLE = {
  minimize: true,
  toggleMaximize: true,
  close: true,
  isMaximized: true
} satisfies Record<keyof WindowApi, true>

export const WINDOW_METHODS = Object.keys(WINDOW_METHOD_TABLE) as (keyof WindowApi)[]

export function windowChannel(method: keyof WindowApi): string {
  return `hml:window:${method}`
}

/** Main sends this with a boolean whenever the window is maximized or restored. */
export const WINDOW_MAXIMIZED_EVENT = 'hml:window-maximized'

/** Where HML's own auto-update (electron-updater) is; main pushes it on every change. */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'none' }
  | { status: 'downloading'; version: string; percent: number | null }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string }

export type UpdateCheckResult = { ok: true } | { ok: false; error: string }

/** HML's own updates, separate from mod updates. */
export interface UpdateApi {
  /** HML's version (app.getVersion()). */
  getVersion(): Promise<string>
  getState(): Promise<UpdateState>
  /** A manual check; in a dev build it answers without checking. */
  check(): Promise<UpdateCheckResult>
  /** Quits and installs a downloaded update; does nothing before one is downloaded. */
  restart(): Promise<void>
}

const UPDATE_METHOD_TABLE = {
  getVersion: true,
  getState: true,
  check: true,
  restart: true
} satisfies Record<keyof UpdateApi, true>

export const UPDATE_METHODS = Object.keys(UPDATE_METHOD_TABLE) as (keyof UpdateApi)[]

export function updateChannel(method: keyof UpdateApi): string {
  return `hml:update:${method}`
}

/** Main sends this with the UpdateState whenever it changes. */
export const UPDATE_STATE_EVENT = 'hml:update-state'

/** Electron wraps handler errors as "Error invoking remote method 'ch': Error: msg". */
export function stripIpcErrorPrefix(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}
