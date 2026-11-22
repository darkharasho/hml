// One GitHub GraphQL search page -> CrawledRepo[]. No node:* or Electron imports (bundled into the Worker).
import { MANIFEST_MAX_BYTES } from '../../../src/shared/hmlManifest'
import type { CrawledRelease, CrawledRepo } from './listing'

export const SEARCH_QUERY = `query($cursor: String, $first: Int!) {
  search(query: "topic:hml-mod archived:false fork:true", type: REPOSITORY, first: $first, after: $cursor) {
    repositoryCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Repository {
        databaseId
        name
        stargazerCount
        createdAt
        isArchived
        owner { id login avatarUrl }
        defaultBranchRef { name }
        object(expression: "HEAD:hml.json") { ... on Blob { text byteSize } }
        releases(first: 20, orderBy: {field: CREATED_AT, direction: DESC}) {
          nodes {
            tagName
            isDraft
            isPrerelease
            publishedAt
            releaseAssets(first: 15) { nodes { name size downloadCount } }
          }
        }
      }
    }
  }
}`

export const DEFAULT_PAGE_SIZE = 30

export class GhGraphqlError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'GhGraphqlError'
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const list = (v: unknown): unknown[] => (isObj(v) && Array.isArray(v.nodes) ? v.nodes : [])

function mapRelease(n: unknown): CrawledRelease | null {
  if (!isObj(n)) return null
  const tag = str(n.tagName)
  if (!tag) return null
  const assets: CrawledRelease['assets'] = []
  for (const a of list(n.releaseAssets)) {
    if (!isObj(a)) continue
    const name = str(a.name)
    if (name === undefined) continue
    assets.push({ name, size: num(a.size) ?? 0, downloads: num(a.downloadCount) ?? 0 })
  }
  return {
    tag,
    draft: n.isDraft === true,
    prerelease: n.isPrerelease === true,
    publishedAt: str(n.publishedAt) ?? '',
    assets
  }
}

function mapRepo(n: unknown): CrawledRepo | null {
  if (!isObj(n) || n.__typename !== 'Repository') return null
  const dbId = num(n.databaseId)
  const repo = str(n.name)
  const owner = n.owner
  if (dbId === undefined || !repo || !isObj(owner)) return null
  const login = str(owner.login)
  const ownerId = str(owner.id)
  if (!login || !ownerId) return null
  let manifest: string | null = null
  let tooLarge = false
  if (isObj(n.object)) {
    const size = num(n.object.byteSize)
    if (size !== undefined && size > MANIFEST_MAX_BYTES) tooLarge = true
    else manifest = str(n.object.text) ?? null
  }
  const releases: CrawledRelease[] = []
  for (const r of list(n.releases)) {
    const m = mapRelease(r)
    if (m) releases.push(m)
  }
  const out: CrawledRepo = {
    id: String(dbId),
    ownerId,
    owner: login,
    repo,
    stars: num(n.stargazerCount) ?? 0,
    createdAt: str(n.createdAt) ?? '',
    ownerAvatar: str(owner.avatarUrl) ?? '',
    defaultBranch: isObj(n.defaultBranchRef) ? (str(n.defaultBranchRef.name) ?? 'main') : 'main',
    manifest,
    releases,
    archived: n.isArchived === true
  }
  if (tooLarge) out.manifestTooLarge = true
  return out
}

export async function fetchSearchPage(
  fetchFn: typeof fetch,
  token: string,
  cursor: string | null,
  pageSize = DEFAULT_PAGE_SIZE
): Promise<{ repos: CrawledRepo[]; nextCursor: string | null; total: number }> {
  const res = await fetchFn('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'user-agent': 'hml-catalog',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ query: SEARCH_QUERY, variables: { cursor, first: pageSize } })
  })
  if (!res.ok) throw new GhGraphqlError(`GitHub GraphQL HTTP ${res.status}`, res.status)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new GhGraphqlError('GitHub GraphQL returned invalid JSON', res.status)
  }
  const search = isObj(body) && isObj(body.data) ? body.data.search : undefined
  if (!isObj(search)) {
    const errs = isObj(body) && Array.isArray(body.errors) ? body.errors : []
    const msg = errs
      .map((e) => (isObj(e) ? str(e.message) : undefined))
      .filter(Boolean)
      .join('; ')
    throw new GhGraphqlError(`GitHub GraphQL error: ${msg || 'no data'}`, res.status)
  }
  const repos: CrawledRepo[] = []
  for (const n of list(search)) {
    const r = mapRepo(n)
    if (r) repos.push(r)
  }
  const pi = isObj(search.pageInfo) ? search.pageInfo : {}
  const end = str(pi.endCursor)
  return {
    repos,
    nextCursor: pi.hasNextPage === true && end ? end : null,
    total: num(search.repositoryCount) ?? repos.length
  }
}
