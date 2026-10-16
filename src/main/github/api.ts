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
const TIMEOUT_ERROR = 'GitHub took too long to respond. Try again later.'
const API_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 120_000
/** Largest release asset HML downloads (it is held in memory). */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

const isTimeout = (e: unknown): boolean => e instanceof Error && e.name === 'TimeoutError'

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
    return await f(url, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) })
  } catch (e) {
    throw new Error(isTimeout(e) ? TIMEOUT_ERROR : CONNECTION_ERROR, { cause: e })
  }
}

/** Throws the shared message for rate limits and rejected tokens; returns for anything else. */
function throwCommonError(res: Response, nowMs: number): void {
  const retryAfter = res.headers.get('retry-after')
  if (
    (res.status === 403 || res.status === 429) &&
    (res.headers.get('x-ratelimit-remaining') === '0' || retryAfter !== null)
  ) {
    const reset = res.headers.get('x-ratelimit-reset')
    let resetMs = NaN
    if (reset !== null && reset.trim() !== '' && Number.isFinite(Number(reset))) {
      resetMs = Number(reset) * 1000
    } else if (
      retryAfter !== null &&
      retryAfter.trim() !== '' &&
      Number.isFinite(Number(retryAfter))
    ) {
      resetMs = nowMs + Number(retryAfter) * 1000
    }
    const when = Number.isFinite(resetMs)
      ? `after ${new Date(resetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'later'
    throw new Error(
      `GitHub's rate limit was reached. Try again ${when}, or add a GitHub token in Settings.`
    )
  }
  if (res.status === 401) {
    throw new Error('GitHub rejected the saved token. Update or remove it in Settings.')
  }
}

const cacheQueues = new Map<string, Promise<unknown>>()

/** Serializes read-modify-write of one cache file so concurrent writers merge. */
function updateCache(file: string, mutate: (cache: Cache) => void): Promise<void> {
  const run = async (): Promise<void> => {
    const cache = await readCache(file)
    mutate(cache)
    await writeJsonAtomic(file, cache, { pretty: false })
  }
  const prev = cacheQueues.get(file) ?? Promise.resolve()
  const next = prev.then(run, run)
  const tail = next.catch(() => undefined)
  cacheQueues.set(file, tail)
  void tail.then(() => {
    if (cacheQueues.get(file) === tail) cacheQueues.delete(file)
  })
  return next
}

async function readCache(file: string): Promise<Cache> {
  const raw = await readJson<Cache>(file)
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
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
  const cache = await readCache(opts.cacheFile)

  const get = async (url: string): Promise<Fetched> => {
    const key = opts.token ? `${url}#auth` : url
    const cached = cache[key]
    if (cached && maxAgeMs !== undefined && now() - cached.fetchedAt < maxAgeMs) {
      return { status: 'ok', body: cached.body }
    }
    const headers = apiHeaders(opts.token)
    if (cached?.etag) headers['If-None-Match'] = cached.etag
    const res = await send(opts.fetch, url, headers)
    if (res.status === 304 && cached) {
      await updateCache(opts.cacheFile, (c) => {
        c[key] = { ...cached, fetchedAt: now() }
      })
      return { status: 'ok', body: cached.body }
    }
    if (res.status === 404) return { status: 'notfound' }
    throwCommonError(res, now())
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for ${slug}.`)
    const body = await res.json()
    await updateCache(opts.cacheFile, (c) => {
      c[key] = { etag: res.headers.get('etag') ?? '', body, fetchedAt: now() }
    })
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
  const { asset } = opts
  const token = opts.token && asset.apiUrl.startsWith(`${API_ROOT}/`) ? opts.token : null
  const fail = (why: string): Error => new Error(`Download of ${asset.name} failed: ${why}`)
  const tooBig = (bytes: number): Error =>
    fail(
      `it is ${Math.ceil(bytes / 1048576)} MB, over HML's ${MAX_DOWNLOAD_BYTES / 1048576} MB limit`
    )
  if (asset.size > MAX_DOWNLOAD_BYTES) throw tooBig(asset.size)
  const headers: Record<string, string> = token
    ? { Accept: 'application/octet-stream', 'User-Agent': 'HML', Authorization: `Bearer ${token}` }
    : { 'User-Agent': 'HML' }
  const why = (e: unknown): string =>
    isTimeout(e) ? 'it took too long' : e instanceof Error ? e.message : String(e)
  let res: Response
  try {
    res = await opts.fetch(token ? asset.apiUrl : asset.downloadUrl, {
      headers,
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    })
  } catch (e) {
    throw fail(why(e))
  }
  if (!res.ok) throw fail(`HTTP ${res.status}`)
  const length = Number(res.headers.get('content-length') ?? '')
  if (length > MAX_DOWNLOAD_BYTES) {
    void res.body?.cancel().catch(() => undefined)
    throw tooBig(length)
  }
  let data: Uint8Array
  try {
    data = new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    throw fail(why(e))
  }
  if (data.byteLength > MAX_DOWNLOAD_BYTES) throw tooBig(data.byteLength)
  const sha256 = createHash('sha256').update(data).digest('hex')
  const m = /^sha256:([0-9a-f]+)$/i.exec(asset.digest ?? '')
  if (m && m[1].toLowerCase() !== sha256) throw fail('checksum mismatch')
  return { data, sha256 }
}

export async function fetchLogin(opts: { fetch: typeof fetch; token: string }): Promise<string> {
  const res = await send(opts.fetch, `${API_ROOT}/user`, apiHeaders(opts.token))
  if (res.status === 401) throw new Error("GitHub didn't accept that token.")
  throwCommonError(res, Date.now())
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
