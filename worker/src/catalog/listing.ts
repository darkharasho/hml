// Pure: decides what one crawled repo lists. No node:* or Electron imports (bundled into the Worker).
import type { CatalogEntry, RepoStatus } from '../../../src/shared/ghCatalog'
import {
  matchesAssetPattern,
  normPrefix,
  samePrefix,
  tagPrefix,
  tagVersion
} from '../../../src/shared/ghTag'
import { validateManifest, type ManifestMod } from '../../../src/shared/hmlManifest'

export interface CrawledRelease {
  tag: string
  draft: boolean
  prerelease: boolean
  publishedAt: string
  assets: { name: string; size: number; downloads: number }[]
}

export interface CrawledRepo {
  id: string
  ownerId: string
  owner: string
  repo: string
  stars: number
  createdAt: string
  ownerAvatar: string
  defaultBranch: string
  manifest: string | null
  manifestTooLarge?: true
  releases: CrawledRelease[]
  archived: boolean
}

const MAX_WARNINGS = 20

function rawUrl(r: CrawledRepo, path: string): string {
  const segs = path.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/${encodeURIComponent(r.defaultBranch)}/${segs}`
}

function resolveRepoUrl(r: CrawledRepo, v: string): string {
  return v.startsWith('https://') ? v : rawUrl(r, v)
}

function installable(
  mod: ManifestMod,
  rel: CrawledRelease
): CrawledRelease['assets'][number] | undefined {
  return rel.assets.find((a) =>
    mod.assetPattern ? matchesAssetPattern(mod.assetPattern, a.name) : /\.zip$/i.test(a.name)
  )
}

const newestFirst = (a: CrawledRelease, b: CrawledRelease): number =>
  Date.parse(b.publishedAt) - Date.parse(a.publishedAt)

function listMod(
  r: CrawledRepo,
  mod: ManifestMod,
  single: boolean
): CatalogEntry | { reason: string } {
  const mine = r.releases
    .filter((rel) => !rel.draft)
    .filter((rel) =>
      mod.tagPrefix ? samePrefix(tagPrefix(rel.tag), normPrefix(mod.tagPrefix)) : single
    )
  if (mine.length === 0) return { reason: 'no-releases' }
  const usable = mine.filter((rel) => installable(mod, rel)).sort(newestFirst)
  if (usable.length === 0) return { reason: 'no-matching-asset' }
  const latest = usable.find((rel) => !rel.prerelease) ?? usable[0]
  const asset = installable(mod, latest)!
  let downloads = 0
  for (const rel of usable)
    for (const a of rel.assets)
      if (mod.assetPattern ? matchesAssetPattern(mod.assetPattern, a.name) : /\.zip$/i.test(a.name))
        downloads += a.downloads
  return {
    key: `${r.owner}/${r.repo}/${mod.id}`,
    owner: r.owner,
    repo: r.repo,
    id: mod.id,
    name: mod.name,
    description: mod.description,
    icon: mod.icon ? resolveRepoUrl(r, mod.icon) : r.ownerAvatar,
    readme: resolveRepoUrl(r, mod.readme ?? 'README.md'),
    categories: mod.categories,
    tagPrefix: mod.tagPrefix,
    assetPattern: mod.assetPattern,
    dependencies: mod.dependencies,
    nsfw: mod.nsfw,
    stars: r.stars,
    repoCreatedAt: r.createdAt,
    ownerAvatar: r.ownerAvatar,
    latest: {
      tag: latest.tag,
      version: tagVersion(latest.tag),
      publishedAt: latest.publishedAt,
      prerelease: latest.prerelease,
      assetName: asset.name,
      size: asset.size
    },
    downloads,
    updatedAt: latest.publishedAt,
    games: mod.games
  }
}

export function buildStatus(
  r: CrawledRepo,
  isKnownGame: (l: string) => boolean,
  now: string
): RepoStatus {
  const base = { owner: r.owner, repo: r.repo, crawledAt: now }
  if (r.manifestTooLarge)
    return { ...base, listed: [], warnings: [], rejected: 'invalid-manifest: (root): too large' }
  const m = validateManifest(r.manifest, isKnownGame)
  if (!m.ok) return { ...base, listed: [], warnings: [], rejected: m.error }
  const warnings = [...m.warnings]
  const listed: CatalogEntry[] = []
  let firstReason: string | undefined
  const single = m.mods.length === 1
  for (const mod of m.mods) {
    const res = listMod(r, mod, single)
    if ('reason' in res) {
      firstReason ??= res.reason
      warnings.push(`${mod.id}: not listed (${res.reason})`)
    } else listed.push(res)
  }
  if (listed.length === 0) return { ...base, listed, warnings: [], rejected: firstReason }
  return { ...base, listed, warnings: warnings.slice(0, MAX_WARNINGS) }
}
