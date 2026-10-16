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
  /** Set only on github-source mods. */
  github?: GhModConfig
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

/** Codes returned by getLaunchWarnings. Blockers stop a modded launch; the rest are advice. */
export type LaunchWarning =
  | 'game-not-found'
  | 'loader-unsupported'
  | 'no-bepinex'
  | 'proton-launch-options'
  | 'steam-not-found'
  | 'flatpak-filesystem'
  | 'native-linux-unsupported'
export type DoorstopVersion = 3 | 4

export interface TsVersion {
  version: string // version_number
  dependencies: string[] // "Owner-Name-x.y.z"
  downloadUrl: string
  downloads: number
  fileSize: number
  dateCreated: string
}
export interface TsPackage {
  fullName: string // "Owner-Name"
  owner: string
  name: string
  description: string // from newest version
  iconUrl: string // from newest version
  websiteUrl: string // from newest version, '' if none
  packageUrl: string
  categories: string[]
  rating: number
  totalDownloads: number // sum over kept versions
  dateUpdated: string
  isPinned: boolean
  isDeprecated: boolean
  nsfw: boolean
  versions: TsVersion[] // newest first, only is_active versions
}
export type TsSort = 'top' | 'downloads' | 'updated' | 'name'
export interface TsQuery {
  text: string
  categories: string[] // package must have every listed category
  sort: TsSort
  includeDeprecated: boolean
  includeNsfw: boolean
  offset: number
  limit: number // clamped to 1..100
}
export interface TsSearchResult {
  items: TsPackage[]
  total: number
  categories: string[] // all categories in the community, sorted
  fetchedAt: string
  stale: boolean // true when the refresh failed and cached data is shown
}
export interface TsInstallResult {
  installed: InstalledMod[]
  skipped: string[] // fullNames already satisfied
  missing: string[] // dependency strings not found in the index
  replaced?: string[] // ids of local mods superseded by the Thunderstore copy
  enabled?: string[] // fullNames of disabled dependencies that were turned back on
}
export interface ModUpdate {
  modId: string
  fullName: string
  current: string
  latest: string
}
export type GhUpdateMode = 'auto' | 'notify' | 'pinned'
export interface GhModConfig {
  updateMode: GhUpdateMode
  /** Saved when the user picked the asset; `{version}` stands for version-like parts. */
  assetPattern: string | null
}
export interface GhAsset {
  name: string
  size: number
}
export type GhInstallResult =
  | { kind: 'installed'; mod: InstalledMod; replaced: string[] }
  | { kind: 'choose-asset'; owner: string; repo: string; tag: string; assets: GhAsset[] }
export interface GhUpdate {
  modId: string
  owner: string
  repo: string
  current: string // installed tag
  latest: string // latest tag
  mode: GhUpdateMode
}
export type HmlEvent =
  | { type: 'progress'; message: string; done: number; total: number }
  | {
      type: 'github-updated'
      game: string
      profileId: string
      mods: { name: string; tag: string }[]
    }
