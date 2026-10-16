import { createHash } from 'node:crypto'
import { compareVersions } from '../../shared/version'
import { readJson, writeJsonAtomic } from '../store/json'
import type { GhReleaseAsset } from './assets'

export interface GhRelease {
  tag: string
  name: string
  prerelease: boolean
  publishedAt: string
  htmlUrl: string
  assets: GhReleaseAsset[]
}

export interface GhClientOpts {
  fetch: typeof fetch
  token: string | null
  cacheFile: string
  now?: () => number
}

export const GH_RELEASE_MEMO_MS = 600_000

const API_ROOT = 'https://api.github.com'
const CONNECTION_ERROR = "Couldn't reach GitHub. Check your connection and try again."

interface CacheEntry {
  etag: string
  body: unknown
  fetchedAt: number
}
type Cache = Record<string, CacheEntry>

function apiHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'HML'
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function send(
  f: typeof fetch,
  url: string,
  headers: Record<string, string>
): Promise<Response> {
  try {
    return await f(url, { headers })
  } catch {
    throw new Error(CONNECTION_ERROR)
  }
}

/** Throws the shared message for rate limits and rejected tokens; returns for anything else. */
function throwCommonError(res: Response): void {
  if (
    (res.status === 403 || res.status === 429) &&
    res.headers.get('x-ratelimit-remaining') === '0'
  ) {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    const time = new Date(reset * 1000).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    })
    throw new Error(
      `GitHub's rate limit was reached. Try again after ${time}, or add a GitHub token in Settings.`
    )
  }
  if (res.status === 401) {
    throw new Error('GitHub rejected the saved token. Update or remove it in Settings.')
  }
}

function normalizeAsset(a: Record<string, unknown>): GhReleaseAsset | null {
  const downloadUrl = String(a.browser_download_url ?? '')
  const apiUrl = String(a.url ?? '')
  if (!downloadUrl.startsWith('https://github.com/')) return null
  if (!apiUrl.startsWith('https://api.github.com/')) return null
  return {
    id: Number(a.id),
    name: String(a.name),
    size: Number(a.size),
    downloadUrl,
    apiUrl,
    digest: typeof a.digest === 'string' ? a.digest : null
  }
}

function normalizeRelease(r: Record<string, unknown>): GhRelease {
  const assets = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : []
  return {
    tag: String(r.tag_name),
    name: String(r.name ?? ''),
    prerelease: r.prerelease === true,
    publishedAt: String(r.published_at ?? ''),
    htmlUrl: String(r.html_url ?? ''),
    assets: assets.map(normalizeAsset).filter((a): a is GhReleaseAsset => a !== null)
  }
}

type Fetched = { status: 'ok'; body: unknown } | { status: 'notfound' }

export async function fetchRelease(
  opts: GhClientOpts & { owner: string; repo: string; tag?: string; maxAgeMs?: number }
): Promise<GhRelease> {
  const { owner, repo, tag, maxAgeMs } = opts
  const now = opts.now ?? Date.now
  const slug = `${owner}/${repo}`
  const base = `${API_ROOT}/repos/${owner}/${repo}`
  const cacheRead = await readJson<Cache>(opts.cacheFile)
  const cache: Cache =
    cacheRead && typeof cacheRead === 'object' && !Array.isArray(cacheRead) ? cacheRead : {}

  const get = async (url: string): Promise<Fetched> => {
    const cached = cache[url]
    if (cached && maxAgeMs !== undefined && now() - cached.fetchedAt < maxAgeMs) {
      return { status: 'ok', body: cached.body }
    }
    const headers = apiHeaders(opts.token)
    if (cached) headers['If-None-Match'] = cached.etag
    const res = await send(opts.fetch, url, headers)
    if (res.status === 304 && cached) {
      cache[url] = { ...cached, fetchedAt: now() }
      await writeJsonAtomic(opts.cacheFile, cache, { pretty: false })
      return { status: 'ok', body: cached.body }
    }
    if (res.status === 404) return { status: 'notfound' }
    throwCommonError(res)
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for ${slug}.`)
    const body = await res.json()
    cache[url] = { etag: res.headers.get('etag') ?? '', body, fetchedAt: now() }
    await writeJsonAtomic(opts.cacheFile, cache, { pretty: false })
    return { status: 'ok', body }
  }

  if (tag !== undefined) {
    const got = await get(`${base}/releases/tags/${encodeURIComponent(tag)}`)
    if (got.status === 'notfound') throw new Error(`${slug} has no release ${tag}.`)
    return normalizeRelease(got.body as Record<string, unknown>)
  }

  const latest = await get(`${base}/releases/latest`)
  if (latest.status === 'ok') return normalizeRelease(latest.body as Record<string, unknown>)

  const list = await get(`${base}/releases?per_page=10`)
  if (list.status === 'notfound') {
    throw new Error(
      `Couldn't find github.com/${slug}. Check the URL; private repositories need a GitHub token in Settings.`
    )
  }
  const first = (Array.isArray(list.body) ? (list.body as Record<string, unknown>[]) : []).find(
    (r) => r.draft !== true
  )
  if (!first) throw new Error(`${slug} has no releases yet.`)
  return normalizeRelease(first)
}

export async function downloadAsset(opts: {
  fetch: typeof fetch
  token: string | null
  asset: GhReleaseAsset
}): Promise<{ data: Uint8Array; sha256: string }> {
  const { asset, token } = opts
  const fail = (why: string): Error => new Error(`Download of ${asset.name} failed: ${why}`)
  const headers: Record<string, string> = token
    ? { Accept: 'application/octet-stream', 'User-Agent': 'HML', Authorization: `Bearer ${token}` }
    : { 'User-Agent': 'HML' }
  let data: Uint8Array
  try {
    const res = await opts.fetch(token ? asset.apiUrl : asset.downloadUrl, { headers })
    if (!res.ok) throw fail(`HTTP ${res.status}`)
    data = new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    if (e instanceof Error && e.message.startsWith(`Download of ${asset.name} failed:`)) throw e
    throw fail(e instanceof Error ? e.message : String(e))
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  const m = /^sha256:([0-9a-f]+)$/i.exec(asset.digest ?? '')
  if (m && m[1].toLowerCase() !== sha256) throw fail('checksum mismatch')
  return { data, sha256 }
}

export async function fetchLogin(opts: { fetch: typeof fetch; token: string }): Promise<string> {
  const res = await send(opts.fetch, `${API_ROOT}/user`, apiHeaders(opts.token))
  if (res.status === 401) throw new Error("GitHub didn't accept that token.")
  throwCommonError(res)
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for your account.`)
  return String(((await res.json()) as { login: unknown }).login)
}

const VERSION_LIKE = /^v?\d+(\.\d+)*$/i

export function isNewerTag(latest: string, current: string): boolean {
  if (VERSION_LIKE.test(latest) && VERSION_LIKE.test(current)) {
    const strip = (t: string): string => t.replace(/^v/i, '')
    return compareVersions(strip(latest), strip(current)) > 0
  }
  return latest !== current
}
