import type {
  GameDef,
  GhInstallResult,
  GhUpdate,
  GhUpdateMode,
  InstalledMod,
  LaunchMode,
  LaunchWarning,
  ModUpdate,
  ProfileManifest,
  Settings,
  TsInstallResult,
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
  openProfileFolder(game: string, profileId: string): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<void>
  /** Absolute path of HML's per-game data dir (`<userData>/games`), for the Flatpak override. */
  getGamesDataDir(): Promise<string>
  tsSearch(game: string, q: TsQuery): Promise<TsSearchResult>
  tsRefresh(game: string): Promise<{ count: number; fetchedAt: string; stale: boolean }>
  tsGetPackage(game: string, fullName: string): Promise<TsPackage | null>
  tsInstall(
    game: string,
    profileId: string,
    fullName: string,
    version?: string
  ): Promise<TsInstallResult>
  tsCheckUpdates(game: string, profileId: string): Promise<ModUpdate[]>
  tsUpdate(game: string, profileId: string, modIds: string[]): Promise<TsInstallResult>
  /** Installs the latest (or the linked) release of a GitHub repo; may ask which file to use. */
  ghInstall(game: string, profileId: string, url: string, asset?: string): Promise<GhInstallResult>
  ghCheckUpdates(game: string, profileId: string): Promise<GhUpdate[]>
  ghUpdate(game: string, profileId: string, modIds: string[]): Promise<InstalledMod[]>
  ghSetUpdateMode(game: string, profileId: string, modId: string, mode: GhUpdateMode): Promise<void>
  /** Saves (after verifying) or, with null/empty, removes the GitHub token. Never returns it. */
  ghSetToken(token: string | null): Promise<{ login: string | null }>
  ghTokenStatus(): Promise<{ set: boolean; encryptionAvailable: boolean }>
  /** Opens an https Thunderstore or GitHub link in the system browser; anything else throws. */
  openExternal(url: string): Promise<void>
}

// `satisfies` makes the compiler reject a missing or unknown method name.
const METHOD_TABLE = {
  searchGames: true,
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
  openProfileFolder: true,
  getSettings: true,
  saveSettings: true,
  getGamesDataDir: true,
  tsSearch: true,
  tsRefresh: true,
  tsGetPackage: true,
  tsInstall: true,
  tsCheckUpdates: true,
  tsUpdate: true,
  ghInstall: true,
  ghCheckUpdates: true,
  ghUpdate: true,
  ghSetUpdateMode: true,
  ghSetToken: true,
  ghTokenStatus: true,
  openExternal: true
} satisfies Record<keyof HmlApi, true>

export const HML_METHODS = Object.keys(METHOD_TABLE) as (keyof HmlApi)[]

export function channel(method: keyof HmlApi): string {
  return `hml:${method}`
}

/** Electron wraps handler errors as "Error invoking remote method 'ch': Error: msg". */
export function stripIpcErrorPrefix(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}
