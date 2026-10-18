export interface InstallRule {
  route: string
  defaultFileExtensions: string[]
  trackingMethod: 'subdir' | 'none' | 'state' | 'package-zip' | string
  subRoutes: InstallRule[]
  isDefaultLocation: boolean
}

export type LoaderChoice = 'bepinex5' | 'bepinex6-mono' | 'bepinex6-il2cpp' | 'none'
export type Runner = { kind: 'proton'; name: string; path: string } | { kind: 'wine' }
export interface CustomGameInfo {
  source: 'steam' | 'folder'
  loaderChoice: LoaderChoice
  /** Folder games on Linux: how HML starts the exe. null = none chosen/found. */
  runner?: Runner | null
  /** False only for an installed Steam game shown in search that isn't added yet. */
  added: boolean
  /** The user chose a cover image for the game (it is the game's iconUrl). */
  image?: boolean
}
export interface GameDetection {
  exeName: string | null
  dataFolderName: string
  engine: 'unity-mono' | 'unity-il2cpp' | 'unknown'
  /** No Windows .exe in the folder (a native Linux build). */
  nativeLinux: boolean
  suggested: LoaderChoice
}
export type AddCustomGameInput =
  | {
      source: 'steam'
      steamAppId: string
      loaderChoice: LoaderChoice
      displayName?: string
      /** A pickCustomGameImage token: the image becomes the game's cover. */
      image?: string
    }
  | {
      source: 'folder'
      folder: string
      displayName: string
      loaderChoice: LoaderChoice
      runner?: Runner | null
      image?: string
    }
export interface CustomGameUpdate {
  displayName?: string
  loaderChoice?: LoaderChoice
  runner?: Runner | null
  /** A pickCustomGameImage token sets the cover image; null removes it. */
  image?: string | null
}
export interface GhTrack {
  major: number
  prerelease: boolean
}
export interface HmlCustomGame {
  source: 'steam' | 'folder'
  displayName: string
  steamAppId: string | null
  loaderChoice: LoaderChoice
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
  /** More cover URLs to try, in order, when iconUrl fails to load. */
  iconFallbacks?: string[]
  /** Wide banner art URLs to try in order (Steam games), shown behind the launch bar. */
  heroUrls?: string[]
  supported: boolean
  /** Nexus-only search results: the game's mod count on Nexus Mods. */
  nexusModCount?: number
  /** Deploy games: the game-relative folder mods deploy into (e.g. `Data`). Unset is the game folder. */
  deployRoot?: string
  custom?: CustomGameInfo
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
  nexusDomainOverrides: Record<string, string>
  /** Game labels whose manual loader install the user chose to keep. */
  manualLoaderKept: string[]
  /** Tint the app with each game's colour and show its banner art. */
  gameColors: boolean
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
  /**
   * Thunderstore packages (fullNames) this mod stands in for: a GitHub install that replaced a
   * Thunderstore copy, or a raw loader release. Dependencies on them count as satisfied.
   */
  provides?: string[]
  /**
   * Kept at this version: update checks skip it. Thunderstore and Nexus mods; GitHub mods use
   * their update mode ('pinned') instead.
   */
  held?: true
}

/** A mod's settings file in a profile. */
export interface ConfigFile {
  /** Relative to the profile folder, posix separators. */
  path: string
  size: number
  modifiedAt: string
}

export interface ProfileManifest {
  formatVersion: 1
  id: string
  name: string
  game: string
  createdAt: string
  mods: InstalledMod[]
}

export interface HmlExportMod {
  source: ModSource
  version: string
  enabled: boolean
  /** Display name only; optional when reading. */
  name?: string
  /** Thunderstore packages the mod stands in for (InstalledMod.provides); optional when reading. */
  provides?: string[]
  /** A GitHub mod that follows pre-releases; written only when true, absent is off. */
  prereleases?: boolean
}

/** The export.json inside a .hml profile file. */
export interface HmlExport {
  formatVersion: 1
  game: string
  profileName: string
  mods: HmlExportMod[]
  customGame?: HmlCustomGame
}

export interface SharePreview {
  token: string
  game: string
  gameName: string
  profileName: string
  mods: { name: string; version: string; kind: ModSource['kind'] }[]
  configFiles: number
  needsFolder?: boolean
  /** Set for an r2modman code or file, which doesn't say its game: it imports into `game`. */
  fromR2modman?: true
}

export interface UnresolvedMod {
  name: string
  version: string
  kind: ModSource['kind']
  reason: string
  url?: string
}

export interface ImportResult {
  game: string
  profile: ProfileManifest
  installed: number
  unresolved: UnresolvedMod[]
  warnings: string[]
}

export type LaunchMode = 'modded' | 'vanilla'

/**
 * How waiting for a launched game ended: seen running, not seen in time, not detectable,
 * stopped by the user (or a new wait), or the program HML started exited first.
 */
export type LaunchWatchResult = 'running' | 'timeout' | 'unknown' | 'cancelled' | 'exited'

/** Codes returned by getLaunchWarnings. Blockers stop a modded launch; the rest are advice. */
export type LaunchWarning =
  | 'game-not-found'
  | 'loader-unsupported'
  | 'no-bepinex'
  | 'no-shimloader'
  | 'proton-first-run'
  | 'steam-not-found'
  | 'flatpak-filesystem'
  | 'native-linux-unsupported'
  | 'loader-mismatch'
  | 'no-runner'
export type DoorstopVersion = 3 | 4

export interface TsVersion {
  version: string // version_number
  dependencies: string[] // "Owner-Name-x.y.z"
  downloadUrl: string
  downloads: number
  fileSize: number
  dateCreated: string
}
/** A Thunderstore package version's document: its README or CHANGELOG. */
export type TsDocKind = 'readme' | 'changelog'

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
  replaced?: string[] // ids of local or GitHub mods superseded by the Thunderstore copy
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
  track?: GhTrack
  /** Follow pre-releases too (absent is off). Not used with a track. */
  prereleases?: boolean
  /** True when the installed release is a GitHub pre-release; absent otherwise and on old installs. */
  installedPrerelease?: boolean
  /** The installed pre-release's publish date, set with installedPrerelease. */
  installedPublishedAt?: string
}
/** What turning a GitHub mod's pre-releases on or off found. */
export interface GhPrereleaseResult {
  /** The update turning it on revealed (not installed yet); null when none or when off. */
  update: GhUpdate | null
  /** Off, and the repo only publishes pre-releases: the mod won't update until a stable one. */
  prereleaseOnly?: true
}
/** Options of an Add from GitHub install. */
export interface GhInstallRequest {
  /** Install and follow the newest release even when it is a pre-release. */
  prereleases?: boolean
}
/** A release offered by a GitHub mod's Change version dialog. */
export interface GhReleaseChoice {
  tag: string
  name: string
  prerelease: boolean
  publishedAt: string
  /** The release the mod has installed now. */
  installed: boolean
  /** The release has a file matching the one the mod uses. */
  hasAsset: boolean
}
export interface GhAsset {
  name: string
  size: number
}
export type GhInstallResult =
  | { kind: 'installed'; mod: InstalledMod; replaced: string[] }
  | { kind: 'choose-asset'; owner: string; repo: string; tag: string; assets: GhAsset[] }
  /** Pre-releases were off and the repo publishes nothing else; nothing was installed. */
  | { kind: 'prerelease-only'; owner: string; repo: string }
export interface GhUpdate {
  modId: string
  owner: string
  repo: string
  current: string // installed tag
  latest: string // latest tag
  mode: GhUpdateMode
}
export type NxSort = 'relevance' | 'downloads' | 'endorsements' | 'updated' | 'name'
export interface NxQuery {
  text: string
  sort: NxSort
  includeAdult: boolean
  offset: number
  limit: number // clamped 1..50
}
export interface NxMod {
  modId: number
  name: string
  summary: string
  author: string
  version: string
  pictureUrl: string | null
  thumbnailUrl: string | null
  downloads: number
  endorsements: number
  updatedAt: string
  adultContent: boolean
}
export interface NxSearchResult {
  items: NxMod[]
  total: number
}
export type NxFileCategory =
  'MAIN' | 'UPDATE' | 'OPTIONAL' | 'OLD_VERSION' | 'MISCELLANEOUS' | 'REMOVED' | 'ARCHIVED'
export interface NxFile {
  fileId: number
  name: string
  version: string
  category: NxFileCategory
  sizeBytes: number // falls back to size*1024
  date: number
}
export interface NxModDetail {
  domain: string
  mod: NxMod
  files: NxFile[] // MAIN/UPDATE/OPTIONAL/MISCELLANEOUS, newest first
}
export interface NxUser {
  name: string
  isPremium: boolean
}
export interface NxStatus {
  set: boolean
  encryptionAvailable: boolean
  user: NxUser | null
  handler: 'registered' | 'not-registered' | 'unavailable'
}
export type NxInstallResult =
  | { kind: 'installed'; mod: InstalledMod; replaced: string[] }
  | { kind: 'open-website'; url: string }
export interface NxUpdate {
  modId: string
  domain: string
  nexusModId: number
  current: string
  latest: string
  latestFileId: number
}
export interface DeploymentStatus {
  profileId: string
  profileName: string | null
  files: number
  deployedAt: string
}
export type HmlEvent =
  | { type: 'progress'; message: string; done: number; total: number }
  | {
      type: 'github-updated'
      game: string
      profileId: string
      mods: { name: string; tag: string }[]
    }
  | {
      type: 'nexus-installed'
      game: string
      profileId: string
      mod: { name: string; version: string }
    }
  | { type: 'nexus-failed'; message: string }
  /** Notify-mode GitHub mods with a release not announced before this session. */
  | { type: 'github-updates-available'; game: string; profileId: string; count: number }
