import { detectPackageMeta, readZipEntries } from '../install/installer'

export interface GhReleaseAsset {
  id: number
  name: string
  size: number
  downloadUrl: string
  apiUrl: string
  digest: string | null
}

const MAX_PROBES = 5
const MAX_PROBE_SIZE = 104_857_600

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function assetPattern(name: string, tag: string): string {
  let out = name
  const replaceLiteral = (lit: string): void => {
    if (lit.length >= 2) out = out.replace(new RegExp(escapeRegExp(lit), 'gi'), '{version}')
  }
  replaceLiteral(tag)
  replaceLiteral(tag.replace(/^v/i, ''))
  return out.replace(/(?<![A-Za-z0-9])v?\d+(?:\.\d+)+(?![A-Za-z0-9])/gi, '{version}')
}

export function matchesAssetPattern(pattern: string, name: string): boolean {
  const src = pattern.split('{version}').map(escapeRegExp).join('.+')
  return new RegExp(`^${src}$`, 'i').test(name)
}

type Chosen = { asset: GhReleaseAsset; data: Uint8Array }

export async function chooseAsset(
  assets: GhReleaseAsset[],
  pattern: string | null,
  download: (a: GhReleaseAsset) => Promise<Uint8Array>
): Promise<Chosen | { ask: GhReleaseAsset[] }> {
  const candidates = assets.filter(
    (a) => !/\.(tar\.gz|tgz)$/i.test(a.name) && !/(^|[-_. ])(source|src)([-_. ]|$)/i.test(a.name)
  )
  const pick = async (asset: GhReleaseAsset, data?: Uint8Array): Promise<Chosen> => ({
    asset,
    data: data ?? (await download(asset))
  })

  const zips = candidates.filter((a) => /\.zip$/i.test(a.name))
  const dlls = candidates.filter((a) => /\.dll$/i.test(a.name))

  if (pattern) {
    const hits = [...zips, ...dlls].filter((a) => matchesAssetPattern(pattern, a.name))
    if (hits.length === 1) return pick(hits[0])
  }

  if (zips.length === 1) return pick(zips[0])
  if (zips.length > 1) {
    const probed: Chosen[] = []
    for (const a of zips.filter((z) => z.size <= MAX_PROBE_SIZE).slice(0, MAX_PROBES)) {
      const data = await download(a)
      try {
        if (detectPackageMeta(readZipEntries(data), '') !== null) probed.push({ asset: a, data })
      } catch {
        // not a readable zip: treat as having no manifest
      }
    }
    if (probed.length === 1) return probed[0]
  } else if (dlls.length === 1) {
    return pick(dlls[0])
  }

  const ask = [...zips, ...dlls]
  if (ask.length === 0) throw new Error('This release has no .zip or .dll file to install.')
  return { ask }
}
