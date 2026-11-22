// Types and helpers shared by the Worker, the Electron main process and the CLI.
// Must not import node:* modules or Electron.

export const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
export const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const ID_RE = /^[a-z0-9-]{1,64}$/

export type Dependency =
  | { kind: 'thunderstore'; fullName: string }
  | { kind: 'github'; owner: string; repo: string; id?: string }

export function parseDependency(s: string): Dependency | null {
  if (s.startsWith('github:')) {
    const [owner, repo, id, ...extra] = s.slice('github:'.length).split('/')
    if (extra.length > 0 || !owner || !repo) return null
    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null
    if (id === undefined) return { kind: 'github', owner, repo }
    if (!ID_RE.test(id)) return null
    return { kind: 'github', owner, repo, id }
  }
  return /^[^\s:/]+-[^\s:/]+-\d+\.\d+\.\d+$/.test(s) ? { kind: 'thunderstore', fullName: s } : null
}

export interface CatalogEntry {
  key: string // owner/repo/id
  owner: string
  repo: string
  id: string
  name: string
  description: string
  icon?: string
  readme?: string
  categories: string[]
  tagPrefix?: string
  assetPattern?: string
  dependencies: string[]
  nsfw: boolean
  stars: number
  repoCreatedAt: string
  ownerAvatar: string
  latest: {
    tag: string
    version: string
    publishedAt: string
    prerelease: boolean
    assetName: string
    size: number
  }
  downloads: number
  updatedAt: string
  games: string[]
}

export interface CatalogIndex {
  game: string
  builtAt: string
  mods: CatalogEntry[]
}

export type RepoStatus = {
  owner: string
  repo: string
  crawledAt: string
  listed: CatalogEntry[]
  warnings: string[]
  rejected?: string
}

export interface BlockEntry {
  target: string // "owner" | "owner/repo"
  reason: string
  at: string
}

export interface ServedBlocklist {
  /** names are lowercase `owner` or `owner/repo`, including aliases */
  entries: { names: string[]; reason: string }[]
}

/** What the app's catalog list returns: the index, when it was fetched, and whether the Worker was unreachable. */
export interface CatListResult {
  mods: CatalogEntry[]
  fetchedAt: string | null
  offline: boolean
}
