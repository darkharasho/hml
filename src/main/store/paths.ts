import path from 'node:path'

export interface AppPaths {
  root: string
  settings: string
  schemaCache: string
  downloads: string
  gameDir(label: string): string
  profilesDir(label: string): string
  profileDir(label: string, id: string): string
}

export function makePaths(root: string): AppPaths {
  const gameDir = (label: string): string => path.join(root, 'games', label)
  const profilesDir = (label: string): string => path.join(gameDir(label), 'profiles')
  return {
    root,
    settings: path.join(root, 'settings.json'),
    schemaCache: path.join(root, 'cache', 'ecosystem.json'),
    downloads: path.join(root, 'cache', 'downloads'),
    gameDir,
    profilesDir,
    profileDir: (label, id) => path.join(profilesDir(label), id)
  }
}
