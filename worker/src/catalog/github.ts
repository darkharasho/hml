// One GitHub GraphQL search page -> CrawledRepo[]. No node:* or Electron imports (bundled into the Worker).
import { MANIFEST_MAX_BYTES } from '../../../src/shared/hmlManifest'
import type { CrawledRelease, CrawledRepo } from './listing'

const RELEASE_FIELDS = `fragment Rel on Release {
  tagName
  isDraft
  isPrerelease
  publishedAt
  releaseAssets(first: 15) { nodes { name size downloadCount } }
}`

export const SEARCH_QUERY = `query($cursor: String, $first: Int!) {
  search(query: "topic:hml-mod archived:false fork:true sort:created-asc", type: REPOSITORY, first: $first, after: $cursor) {
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
          pageInfo { hasNextPage endCursor }
          nodes { ...Rel }
        }
      }
    }
  }
}
${RELEASE_FIELDS}`

/** Releases per follow-up page of one repo (a monorepo whose mod is past the first 20). */
export const RELEASES_PAGE_SIZE = 50

export const RELEASES_QUERY = `query($owner: String!, $name: String!, $after: String, $first: Int!) {
  repository(owner: $owner, name: $name) {
    releases(first: $first, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ...Rel }
    }
  }
}
${RELEASE_FIELDS}`

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
  const releases = mapReleases(n.releases)
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
  const more = nextCursor(n.releases)
  if (more) out.releasesCursor = more
  return out
}

function mapReleases(conn: unknown): CrawledRelease[] {
  const out: CrawledRelease[] = []
  for (const r of list(conn)) {
    const m = mapRelease(r)
    if (m) out.push(m)
  }
  return out
}

/** A connection's end cursor when it has a next page, else null. */
function nextCursor(conn: unknown): string | null {
  const pi = isObj(conn) && isObj(conn.pageInfo) ? conn.pageInfo : {}
  const end = str(pi.endCursor)
  return pi.hasNextPage === true && end ? end : null
}

async function graphql(
  fetchFn: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<{ body: unknown; status: number }> {
  const res = await fetchFn('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'user-agent': 'hml-catalog',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  })
  if (!res.ok) throw new GhGraphqlError(`GitHub GraphQL HTTP ${res.status}`, res.status)
  try {
    return { body: await res.json(), status: res.status }
  } catch {
    throw new GhGraphqlError('GitHub GraphQL returned invalid JSON', res.status)
  }
}

function graphqlError(body: unknown, status: number): GhGraphqlError {
  const errs = isObj(body) && Array.isArray(body.errors) ? body.errors : []
  const msg = errs
    .map((e) => (isObj(e) ? str(e.message) : undefined))
    .filter(Boolean)
    .join('; ')
  return new GhGraphqlError(`GitHub GraphQL error: ${msg || 'no data'}`, status)
}

export async function fetchSearchPage(
  fetchFn: typeof fetch,
  token: string,
  cursor: string | null,
  pageSize = DEFAULT_PAGE_SIZE
): Promise<{ repos: CrawledRepo[]; nextCursor: string | null; total: number }> {
  const { body, status } = await graphql(fetchFn, token, SEARCH_QUERY, {
    cursor,
    first: pageSize
  })
  const search = isObj(body) && isObj(body.data) ? body.data.search : undefined
  if (!isObj(search)) throw graphqlError(body, status)
  const repos: CrawledRepo[] = []
  for (const n of list(search)) {
    const r = mapRepo(n)
    if (r) repos.push(r)
  }
  return {
    repos,
    nextCursor: nextCursor(search),
    total: num(search.repositoryCount) ?? repos.length
  }
}

/** The next page of one repo's releases, newest first, after `after`. */
export async function fetchMoreReleases(
  fetchFn: typeof fetch,
  token: string,
  owner: string,
  name: string,
  after: string
): Promise<{ releases: CrawledRelease[]; nextCursor: string | null }> {
  const { body, status } = await graphql(fetchFn, token, RELEASES_QUERY, {
    owner,
    name,
    after,
    first: RELEASES_PAGE_SIZE
  })
  const repo = isObj(body) && isObj(body.data) ? body.data.repository : undefined
  if (!isObj(repo) || !isObj(repo.releases)) throw graphqlError(body, status)
  return { releases: mapReleases(repo.releases), nextCursor: nextCursor(repo.releases) }
}
