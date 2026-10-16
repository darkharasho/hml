import path from 'node:path'

export interface AppPaths {
  root: string
  settings: string
  schemaCache: string
  downloads: string
  /** Parent of every per-game dir. */
  gamesDir: string
  gameDir(label: string): string
  profilesDir(label: string): string
  profileDir(label: string, id: string): string
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
    gamesDir,
    gameDir,
    profilesDir,
    profileDir: (label, id) => path.join(profilesDir(label), id)
  }
}
