export interface InstallRule {
  route: string
  defaultFileExtensions: string[]
  trackingMethod: 'subdir' | 'none' | 'state' | 'package-zip' | string
  subRoutes: InstallRule[]
  isDefaultLocation: boolean
}

export interface GameDef {
  label: string
  displayName: string
  steamAppId: string | null
  steamFolderName: string
  exeNames: string[]
  dataFolderName: string
  loader: string
  installRules: InstallRule[]
  packageIndex: string | null
  searchStrings: string[]
  iconUrl: string | null
  supported: boolean
}

export interface ModloaderPackage {
  packageId: string
  rootFolder: string
  loader: string
}

export interface Catalog {
  games: GameDef[]
  modloaderPackages: ModloaderPackage[]
  fetchedAt: string
}

export interface Settings {
  gamePathOverrides: Record<string, string>
  steamRootOverride: string | null
  lastGame: string | null
  lastProfile: Record<string, string>
}

export type ModSource =
  | { kind: 'thunderstore'; fullName: string }
  | { kind: 'github'; owner: string; repo: string; tag: string; asset: string; sha256: string }
  | { kind: 'nexus'; domain: string; modId: number; fileId: number }
  | { kind: 'local'; fileName: string; sha256: string }

export interface InstalledMod {
  id: string
  name: string
  version: string
  source: ModSource
  enabled: boolean
  /** Paths relative to the profile dir, posix separators. */
  files: string[]
  disableable: string[]
  installedAt: string
}

export interface ProfileManifest {
  formatVersion: 1
  id: string
  name: string
  game: string
  createdAt: string
  mods: InstalledMod[]
}

export type LaunchMode = 'modded' | 'vanilla'
export type DoorstopVersion = 3 | 4
