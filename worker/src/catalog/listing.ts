// Pure: decides what one crawled repo lists. No node:* or Electron imports (bundled into the Worker).
import type { CatalogEntry, RepoStatus } from '../../../src/shared/ghCatalog'
import {
  assetMatcher,
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
  /** Set when the repo has more releases than were crawled: the cursor of the next page. */
  releasesCursor?: string
  archived: boolean
}

const MAX_WARNINGS = 20

/**
 * assetPattern match units one repo may spend, across all its mods and its release follow-ups.
 * A match costs one unit per 25 characters of the name (matchUnits), and each distinct name and
 * pattern is matched once. 300 units cover a full first page (20 releases × 15 assets) of names
 * up to 25 characters, or 75 names of 100. Worst case for 300 units in node: about 1 ms (patterns
 * with text between their tokens, names up to 100 characters). Mods left when it runs out are
 * rejected with no-matching-asset.
 */
export const MAX_ASSET_MATCHES_PER_REPO = 300

/** Budget units one match of a name costs: matching time grows faster than the name's length. */
export const matchUnits = (len: number): number => Math.max(1, Math.ceil(len / 25))

/** A repo's assetPattern match budget, with the results so far (re-matching a name is free). */
export interface MatchBudget {
  left: number
  seen: Map<string, boolean>
}

export const newMatchBudget = (): MatchBudget => ({
  left: MAX_ASSET_MATCHES_PER_REPO,
  seen: new Map()
})

/** Thrown when a repo's match budget runs out mid-mod. */
const SPENT = Symbol('match budget spent')

function budgetedMatcher(pattern: string, budget: MatchBudget): (name: string) => boolean {
  const match = assetMatcher(pattern)
  return (name) => {
    const key = `${pattern}\0${name}`
    const known = budget.seen.get(key)
    if (known !== undefined) return known
    const cost = matchUnits(name.length)
    if (budget.left < cost) throw SPENT
    budget.left -= cost
    const hit = match(name)
    budget.seen.set(key, hit)
    return hit
  }
}

function rawUrl(r: CrawledRepo, path: string): string {
  const segs = path.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/${encodeURIComponent(r.defaultBranch)}/${segs}`
}

function resolveRepoUrl(r: CrawledRepo, v: string): string {
  return v.startsWith('https://') ? v : rawUrl(r, v)
}

const isZip = (name: string): boolean => /\.zip$/i.test(name)

const newestFirst = (a: CrawledRelease, b: CrawledRelease): number =>
  Date.parse(b.publishedAt) - Date.parse(a.publishedAt)

function listMod(
  r: CrawledRepo,
  mod: ManifestMod,
  single: boolean,
  budget: MatchBudget
): CatalogEntry | { reason: string } {
  const mine = r.releases
    .filter((rel) => !rel.draft)
    .filter((rel) =>
      mod.tagPrefix ? samePrefix(tagPrefix(rel.tag), normPrefix(mod.tagPrefix)) : single
    )
  if (mine.length === 0) return { reason: 'no-releases' }
  // Only patterns are budgeted: isZip is linear in the name's length.
  const fits = mod.assetPattern ? budgetedMatcher(mod.assetPattern, budget) : isZip
  const installable = (rel: CrawledRelease): CrawledRelease['assets'][number] | undefined =>
    rel.assets.find((a) => fits(a.name))
  const usable = mine.filter((rel) => installable(rel)).sort(newestFirst)
  if (usable.length === 0) return { reason: 'no-matching-asset' }
  const latest = usable.find((rel) => !rel.prerelease) ?? usable[0]
  const asset = installable(latest)!
  let downloads = 0
  for (const rel of usable) for (const a of rel.assets) if (fits(a.name)) downloads += a.downloads
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
  return listRepo(r, isKnownGame, now).status
}

/**
 * The repo's status, and whether a mod with a tagPrefix found no release of its own: in a
 * monorepo with more releases than were crawled, older pages may hold that mod's releases.
 */
export function listRepo(
  r: CrawledRepo,
  isKnownGame: (l: string) => boolean,
  now: string,
  budget: MatchBudget = newMatchBudget()
): { status: RepoStatus; moreReleases: boolean } {
  const base = { owner: r.owner, repo: r.repo, crawledAt: now }
  const done = (status: RepoStatus): { status: RepoStatus; moreReleases: boolean } => ({
    status,
    moreReleases: false
  })
  if (r.manifestTooLarge)
    return done({
      ...base,
      listed: [],
      warnings: [],
      rejected: 'invalid-manifest: (root): too large'
    })
  const m = validateManifest(r.manifest, isKnownGame)
  if (!m.ok)
    return done({
      ...base,
      listed: [],
      warnings: (m.warnings ?? []).slice(0, MAX_WARNINGS),
      rejected: m.error
    })
  const warnings = [...m.warnings]
  const listed: CatalogEntry[] = []
  let firstReason: string | undefined
  let moreReleases = false
  let spent = false
  const single = m.mods.length === 1
  for (const mod of m.mods) {
    let res: CatalogEntry | { reason: string }
    try {
      res = listMod(r, mod, single, budget)
    } catch (e) {
      if (e !== SPENT) throw e
      if (!spent)
        warnings.push(
          `asset matching stopped after ${MAX_ASSET_MATCHES_PER_REPO} units (25 name characters each)`
        )
      spent = true
      res = { reason: 'no-matching-asset' }
    }
    if ('reason' in res) {
      firstReason ??= res.reason
      warnings.push(`${mod.id}: not listed (${res.reason})`)
      if (res.reason === 'no-releases' && mod.tagPrefix) moreReleases = true
    } else listed.push(res)
  }
  const status: RepoStatus =
    listed.length === 0
      ? { ...base, listed, warnings: warnings.slice(0, MAX_WARNINGS), rejected: firstReason }
      : { ...base, listed, warnings: warnings.slice(0, MAX_WARNINGS) }
  return { status, moreReleases }
}
