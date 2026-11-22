// KV helpers for catalog values: JSON with a SHA-256 of the content in the KV metadata, so
// unchanged values are never rewritten. No node:* or Electron imports (bundled into the Worker).
import type { BlockEntry } from '../../../src/shared/ghCatalog'
import type { KvLike } from '../index'

/** A value whose only change is star/download counts is rewritten at most this often. */
export const COUNTS_REFRESH_MS = 6 * 3_600_000

export const KEY_STATE = 'catalog:state'
export const KEY_STATUS = 'catalog:status'
export const KEY_BLOCKLIST = 'catalog:blocklist'
/** The crawl's BlockState (GitHub ids of blocked names), written only when it changes. */
export const KEY_BLOCKS = 'catalog:blocks'
export const KEY_GAMES = 'catalog:games'
export const indexKey = (game: string): string => `catalog:index:${game}`

/** KV metadata on catalog values. `hash` covers the content (ETag); `stableHash` leaves out counts. */
export interface CatalogMeta {
  hash: string
  stableHash?: string
  /** ISO time of the write. */
  at?: string
}

export interface Stored<T> {
  value: T | null
  hash: string | null
  meta: Partial<CatalogMeta>
}

type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function parseMeta(metadata: unknown): Partial<CatalogMeta> {
  const meta: Partial<CatalogMeta> = {}
  if (isObj(metadata))
    for (const k of ['hash', 'stableHash', 'at'] as const)
      if (typeof metadata[k] === 'string') meta[k] = metadata[k] as string
  return meta
}

/** Reads a JSON value and the hash stored in its metadata. Unparseable values read as null. */
export async function readStored<T>(kv: KvLike, key: string): Promise<Stored<T>> {
  const { value, metadata } = await kv.getWithMetadata<Record<string, unknown>>(key, 'text')
  const meta = parseMeta(metadata)
  const hash = meta.hash ?? null
  if (value === null) return { value: null, hash, meta }
  try {
    return { value: JSON.parse(value) as T, hash, meta }
  } catch {
    return { value: null, hash, meta }
  }
}

/** Reads only a value's metadata; the body is streamed and cancelled unread (saves CPU). */
async function readMeta(kv: KvLike, key: string): Promise<Partial<CatalogMeta>> {
  const { value, metadata } = await kv.getWithMetadata<Record<string, unknown>>(key, 'stream')
  await value?.cancel()
  return parseMeta(metadata)
}

/** Writes `value` (whole-value hash) unless the stored hash matches; gives the value's hash. */
export async function writeIfChanged(
  kv: KvLike,
  key: string,
  value: unknown,
  known?: string | null
): Promise<{ written: boolean; hash: string }> {
  const json = JSON.stringify(value)
  const hash = await sha256Hex(json)
  const prev = known !== undefined ? known : ((await readMeta(kv, key)).hash ?? null)
  if (prev === hash) return { written: false, hash }
  await kv.put(key, json, { metadata: { hash } })
  return { written: true, hash }
}

/** Writes `value` (whole-value hash) unless the stored hash matches. */
export async function putIfChanged(
  kv: KvLike,
  key: string,
  value: unknown,
  known?: string | null
): Promise<boolean> {
  return (await writeIfChanged(kv, key, value, known)).written
}

/**
 * For indexes and the status map. `content` leaves out builtAt/crawledAt; `stable` also leaves
 * out stars and downloads. Writes when `stable` changed, or when only counts changed and the
 * stored value is over COUNTS_REFRESH_MS old.
 */
export async function putCatalogValue(
  kv: KvLike,
  key: string,
  value: unknown,
  content: unknown,
  stable: unknown,
  now: number
): Promise<boolean> {
  const [hash, stableHash] = await Promise.all([
    sha256Hex(JSON.stringify(content)),
    sha256Hex(JSON.stringify(stable))
  ])
  const prev = await readMeta(kv, key)
  if (prev.stableHash === stableHash) {
    if (prev.hash === hash) return false
    const at = prev.at ? Date.parse(prev.at) : NaN
    if (now - at < COUNTS_REFRESH_MS) return false
  }
  const meta: CatalogMeta = { hash, stableHash, at: new Date(now).toISOString() }
  await kv.put(key, JSON.stringify(value), { metadata: meta })
  return true
}

export async function readBlocklist(kv: KvLike): Promise<BlockEntry[]> {
  const { value } = await readStored<unknown>(kv, KEY_BLOCKLIST)
  if (!Array.isArray(value)) return []
  return value.filter(
    (e): e is BlockEntry =>
      isObj(e) && typeof e.target === 'string' && e.target !== '' && typeof e.reason === 'string'
  )
}
