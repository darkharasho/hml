import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { InstalledMod } from '../../shared/types'
import { readJson, writeJsonAtomic } from '../store/json'
import { modArtUrl } from './protocol'

/** The shallowest `icon.png` among a mod's files (profile-relative posix paths), if any. */
export function modIconFile(mod: Pick<InstalledMod, 'files'>): string | null {
  let best: { file: string; depth: number } | null = null
  for (const file of mod.files) {
    const segs = file.split('/')
    if (segs[segs.length - 1].toLowerCase() !== 'icon.png') continue
    if (!best || segs.length < best.depth) best = { file, depth: segs.length }
  }
  return best?.file ?? null
}

async function isFile(p: string): Promise<boolean> {
  return fs.stat(p).then(
    (s) => s.isFile(),
    () => false
  )
}

/**
 * The icon file on disk for a mod in a profile: its `icon.png`, or that file with `.old` while
 * the mod is disabled. Null when it has none or the recorded path would leave the profile.
 */
export async function modIconPath(
  profileDir: string,
  mod: Pick<InstalledMod, 'files'>
): Promise<string | null> {
  const rel = modIconFile(mod)
  if (!rel) return null
  const root = path.resolve(profileDir)
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(root + path.sep)) return null
  if (await isFile(abs)) return abs
  return (await isFile(`${abs}.old`)) ? `${abs}.old` : null
}

/**
 * Icon URLs to try in order for an installed mod: its own icon.png, then the Thunderstore icon of
 * its package or of the packages it stands in for (`tsIcon` looks them up). Nexus mods carry no
 * picture in their record, so they get no remote icon. The renderer ends with a letter tile.
 */
export function modIconCandidates(
  game: string,
  profileId: string,
  mod: InstalledMod,
  tsIcon: (fullName: string) => string | null | undefined
): string[] {
  const out: string[] = []
  if (modIconFile(mod)) out.push(modArtUrl(game, profileId, mod.id, mod.version))
  const packages = mod.source.kind === 'thunderstore' ? [mod.source.fullName] : (mod.provides ?? [])
  for (const fullName of packages) {
    const url = tsIcon(fullName)
    if (url) out.push(url)
  }
  return [...new Set(out)]
}

const TS_PACKAGE_API = 'https://thunderstore.io/api/experimental/package/'
const ICON_MAX_AGE_MS = 7 * 86_400_000
const FAILED_RETRY_MS = 60_000
const FULL_NAME = /^([A-Za-z0-9_]+)-([A-Za-z0-9_]+)$/

/** A package's icon from Thunderstore's package API, or null for anything unexpected. */
export function parseTsPackageIcon(json: unknown): string | null {
  const icon = (json as { latest?: { icon?: unknown } } | null)?.latest?.icon
  return typeof icon === 'string' && /^https:\/\//.test(icon) ? icon : null
}

export interface TsIcons {
  /**
   * Thunderstore icons of packages by fullName ("Owner-Name"), for games without a package index
   * (a custom game's BepInEx stands in for BepInEx-BepInExPack). Cached; never throws.
   */
  icons(fullNames: string[]): Promise<Map<string, string>>
}

export function createTsIcons(opts: {
  fetch: typeof fetch
  cacheFile: string
  now?: () => number
}): TsIcons {
  const now = opts.now ?? Date.now
  let loaded: Promise<Map<string, { url: string | null; at: number }>> | null = null
  const inFlight = new Map<string, Promise<void>>()
  let failedAt = -Infinity
  const load = (): NonNullable<typeof loaded> => {
    loaded ??= readJson<Record<string, { url: string | null; at: number }>>(opts.cacheFile)
      .catch(() => null)
      .then((j) => {
        const m = new Map<string, { url: string | null; at: number }>()
        for (const [k, v] of Object.entries(j ?? {})) {
          if (FULL_NAME.test(k) && v && typeof v.at === 'number') {
            m.set(k, { url: typeof v.url === 'string' ? v.url : null, at: v.at })
          }
        }
        return m
      })
    return loaded
  }
  async function fetchOne(
    fullName: string,
    cache: Map<string, { url: string | null; at: number }>
  ): Promise<void> {
    const [, owner, name] = FULL_NAME.exec(fullName)!
    try {
      const res = await opts.fetch(`${TS_PACKAGE_API}${owner}/${name}/`, {
        signal: AbortSignal.timeout(5_000)
      })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
      cache.set(fullName, { url: res.ok ? parseTsPackageIcon(await res.json()) : null, at: now() })
      await writeJsonAtomic(opts.cacheFile, Object.fromEntries(cache), { pretty: false }).catch(
        () => undefined
      )
    } catch {
      failedAt = now()
    }
  }
  return {
    async icons(fullNames) {
      const cache = await load()
      const wanted = [...new Set(fullNames.filter((n) => FULL_NAME.test(n)))]
      await Promise.all(
        wanted.map((n) => {
          const pending = inFlight.get(n)
          if (pending) return pending
          const hit = cache.get(n)
          if (hit && now() - hit.at < ICON_MAX_AGE_MS) return undefined
          if (now() - failedAt < FAILED_RETRY_MS) return undefined
          const p = fetchOne(n, cache).finally(() => inFlight.delete(n))
          inFlight.set(n, p)
          return p
        })
      )
      const out = new Map<string, string>()
      for (const n of wanted) {
        const url = cache.get(n)?.url
        if (url) out.set(n, url)
      }
      return out
    }
  }
}
