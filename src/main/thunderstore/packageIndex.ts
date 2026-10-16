import { gunzipSync } from 'node:zlib'
import type { TsPackage, TsVersion } from '../../shared/types'
import type { AppPaths } from '../store/paths'
import { readJson, writeJsonAtomic } from '../store/json'

export interface TsIndex {
  packages: TsPackage[]
  chunkUrls: string[]
  fetchedAt: string
}

const UNREACHABLE = "Couldn't reach Thunderstore. Check your connection and try again."
const MAX_IN_FLIGHT = 3

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function slimVersion(v: Record<string, unknown>): TsVersion {
  return {
    version: str(v.version_number),
    dependencies: Array.isArray(v.dependencies)
      ? v.dependencies.filter((d): d is string => typeof d === 'string')
      : [],
    downloadUrl: str(v.download_url),
    downloads: num(v.downloads),
    fileSize: num(v.file_size),
    dateCreated: str(v.date_created)
  }
}

export function slimPackage(raw: unknown): TsPackage | null {
  if (!isObj(raw)) return null
  const fullName = str(raw.full_name)
  if (!fullName || !Array.isArray(raw.versions)) return null
  const active = raw.versions.filter(
    (v): v is Record<string, unknown> =>
      isObj(v) && v.is_active !== false && !!str(v.version_number)
  )
  if (active.length === 0) return null
  const newest = active[0]
  const versions = active.map(slimVersion)
  return {
    fullName,
    owner: str(raw.owner),
    name: str(raw.name),
    description: str(newest.description),
    iconUrl: str(newest.icon),
    websiteUrl: str(newest.website_url),
    packageUrl: str(raw.package_url),
    categories: Array.isArray(raw.categories)
      ? raw.categories.filter((c): c is string => typeof c === 'string')
      : [],
    rating: num(raw.rating_score),
    totalDownloads: versions.reduce((n, v) => n + v.downloads, 0),
    dateUpdated: str(raw.date_updated),
    isPinned: raw.is_pinned === true,
    isDeprecated: raw.is_deprecated === true,
    nsfw: raw.has_nsfw_content === true,
    versions
  }
}

export function decodeMaybeGzip(buf: Uint8Array): unknown {
  const body = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf
  return JSON.parse(Buffer.from(body).toString('utf8'))
}

async function readCache(paths: AppPaths, label: string): Promise<TsIndex | null> {
  let c: TsIndex | null
  try {
    c = await readJson<TsIndex>(paths.tsIndexCache(label))
  } catch {
    return null
  }
  if (!c || typeof c !== 'object') return null
  if (!Array.isArray(c.packages) || !Array.isArray(c.chunkUrls) || typeof c.fetchedAt !== 'string')
    return null
  if (Number.isNaN(Date.parse(c.fetchedAt))) return null
  return c
}

async function get(fetchFn: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return decodeMaybeGzip(new Uint8Array(await res.arrayBuffer()))
}

async function fetchChunks(fetchFn: typeof fetch, urls: string[]): Promise<TsPackage[]> {
  const results: unknown[][] = new Array(urls.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      const i = next++
      const data = await get(fetchFn, urls[i])
      if (!Array.isArray(data)) throw new Error(`Chunk is not an array: ${urls[i]}`)
      results[i] = data
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, urls.length) }, worker))
  const packages: TsPackage[] = []
  for (const chunk of results) {
    for (const raw of chunk) {
      const p = slimPackage(raw)
      if (p) packages.push(p)
    }
  }
  return packages
}

export async function loadPackageIndex(opts: {
  paths: AppPaths
  label: string
  indexUrl: string
  fetch: typeof fetch
  now?: () => number
  maxAgeMs?: number
  force?: boolean
}): Promise<TsIndex & { stale: boolean }> {
  const { paths, label, indexUrl, fetch: fetchFn, force = false } = opts
  const now = opts.now ?? Date.now
  const maxAgeMs = opts.maxAgeMs ?? 3_600_000
  const cached = await readCache(paths, label)
  if (cached && !force) {
    const age = now() - Date.parse(cached.fetchedAt)
    if (age >= 0 && age < maxAgeMs) return { ...cached, stale: false }
  }

  try {
    const urls = await get(fetchFn, indexUrl)
    if (!Array.isArray(urls) || !urls.every((u) => typeof u === 'string'))
      throw new Error('Package index is not a list of URLs')
    const chunkUrls = urls as string[]
    const unchanged =
      cached !== null &&
      cached.chunkUrls.length === chunkUrls.length &&
      cached.chunkUrls.every((u, i) => u === chunkUrls[i])
    const packages = unchanged ? cached.packages : await fetchChunks(fetchFn, chunkUrls)
    const index: TsIndex = { packages, chunkUrls, fetchedAt: new Date(now()).toISOString() }
    try {
      await writeJsonAtomic(paths.tsIndexCache(label), index)
    } catch (e) {
      console.warn(`Thunderstore index cache write failed: ${msg(e)}`)
    }
    return { ...index, stale: false }
  } catch (e) {
    console.warn(`Thunderstore index fetch failed: ${msg(e)}`)
    if (cached) return { ...cached, stale: true }
    throw new Error(UNREACHABLE, { cause: e })
  }
}
