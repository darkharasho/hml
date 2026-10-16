import type {
  GameDef,
  InstalledMod,
  LaunchMode,
  LaunchWarning,
  ProfileManifest,
  Settings
} from './types'

export interface GameSummary extends GameDef {
  installDir: string | null
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
  getGamesDataDir: true
} satisfies Record<keyof HmlApi, true>

export const HML_METHODS = Object.keys(METHOD_TABLE) as (keyof HmlApi)[]

export function channel(method: keyof HmlApi): string {
  return `hml:${method}`
}

/** Electron wraps handler errors as "Error invoking remote method 'ch': Error: msg". */
export function stripIpcErrorPrefix(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}
