import type { TsDocKind } from '../../shared/types'

const TS_PACKAGE_API = 'https://thunderstore.io/api/experimental/package/'
const FULL_NAME = /^([A-Za-z0-9_]+)-([A-Za-z0-9_]+)$/
const VERSION = /^\d+\.\d+\.\d+$/
/** Documents kept in memory; a version's README never changes once published. */
const CACHE_LIMIT = 100

/** The markdown of Thunderstore's readme/changelog response, or null when there is none. */
export function parseTsDoc(json: unknown): string | null {
  const md = (json as { markdown?: unknown } | null)?.markdown
  return typeof md === 'string' && md.trim() !== '' ? md : null
}

export function tsDocUrl(fullName: string, version: string, kind: TsDocKind): string {
  const m = FULL_NAME.exec(fullName)
  if (!m || !VERSION.test(version)) throw new Error('Invalid Thunderstore package.')
  return `${TS_PACKAGE_API}${m[1]}/${m[2]}/${version}/${kind}/`
}

export interface TsDocs {
  /** A package version's README or CHANGELOG markdown, or null if it has none. */
  get(fullName: string, version: string, kind: TsDocKind): Promise<string | null>
}

export function createTsDocs(opts: { fetch: typeof fetch }): TsDocs {
  const cache = new Map<string, Promise<string | null>>()
  async function load(url: string): Promise<string | null> {
    const res = await opts.fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Thunderstore returned HTTP ${res.status}.`)
    return parseTsDoc(await res.json())
  }
  return {
    get(fullName, version, kind) {
      const url = tsDocUrl(fullName, version, kind)
      let p = cache.get(url)
      if (!p) {
        p = load(url)
        // A failure (offline) isn't remembered, so opening the package again retries.
        p.catch(() => cache.delete(url))
        cache.set(url, p)
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      }
      return p
    }
  }
}
