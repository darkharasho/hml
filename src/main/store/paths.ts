import path from 'node:path'

export interface AppPaths {
  root: string
  settings: string
  schemaCache: string
  downloads: string
  ghCache: string
  ghToken: string
  nxKey: string
  nxGames: string
  /** Owner key of a sync code, encrypted. */
  syncKey(code: string): string
  nxAddedGames: string
  customGames: string
  /** Steam store cover URLs by app id. */
  steamArtCache: string
  /** Thunderstore package icon URLs by fullName, for games without a package index. */
  tsIconCache: string
  tsIndexCache(label: string): string
  /** Parent of every per-game dir. */
  gamesDir: string
  gameDir(label: string): string
  profilesDir(label: string): string
  profileDir(label: string, id: string): string
  deployment(label: string): string
  deployBackup(label: string): string
  winePrefix(label: string): string
  loaderBackup(label: string, stamp: string): string
}

export function makePaths(root: string): AppPaths {
  const gamesDir = path.join(root, 'games')
  const gameDir = (label: string): string => path.join(gamesDir, label)
  const profilesDir = (label: string): string => path.join(gameDir(label), 'profiles')
  return {
    root,
    settings: path.join(root, 'settings.json'),
    schemaCache: path.join(root, 'cache', 'ecosystem.json'),
    downloads: path.join(root, 'cache', 'downloads'),
    ghCache: path.join(root, 'cache', 'github.json'),
    ghToken: path.join(root, 'secrets', 'github-token.bin'),
    nxKey: path.join(root, 'secrets', 'nexus-key.bin'),
    syncKey: (code) => path.join(root, 'secrets', `sync-${code}.bin`),
    nxGames: path.join(root, 'cache', 'nexus-games.json'),
    nxAddedGames: path.join(root, 'nexus-added-games.json'),
    customGames: path.join(root, 'custom-games.json'),
    steamArtCache: path.join(root, 'cache', 'steam-art.json'),
    tsIconCache: path.join(root, 'cache', 'thunderstore-icons.json'),
    tsIndexCache: (label) => path.join(root, 'cache', 'thunderstore', `${label}.json`),
    gamesDir,
    gameDir,
    profilesDir,
    profileDir: (label, id) => path.join(profilesDir(label), id),
    deployment: (label) => path.join(gameDir(label), 'deployment.json'),
    deployBackup: (label) => path.join(gameDir(label), 'deploy-backup'),
    winePrefix: (label) => path.join(root, 'prefixes', label),
    loaderBackup: (label, stamp) => path.join(root, 'backups', label, stamp)
  }
}
