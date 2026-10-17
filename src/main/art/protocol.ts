import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * The privileged scheme the renderer loads local art through. A URL names what it wants (a Steam
 * app, a custom game, an installed mod), never a path; main looks the file up itself.
 */
export const ART_SCHEME = 'hml-art'

export type ArtTarget =
  | { kind: 'steam'; appId: string }
  | { kind: 'custom'; label: string }
  | { kind: 'mod'; game: string; profileId: string; modId: string }

export const steamArtUrl = (appId: string): string => `${ART_SCHEME}://steam/${appId}`
/** `v` changes when the image does, so the renderer doesn't show a cached old one. */
export const customArtUrl = (label: string, v: number | string): string =>
  `${ART_SCHEME}://custom/${encodeURIComponent(label)}?v=${encodeURIComponent(String(v))}`
export const modArtUrl = (game: string, profileId: string, modId: string, v: string): string =>
  `${ART_SCHEME}://mod/${[game, profileId, modId].map(encodeURIComponent).join('/')}?v=${encodeURIComponent(v)}`

/** What an art URL asks for, or null for anything malformed. Ids are checked again on lookup. */
export function parseArtUrl(raw: string): ArtTarget | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== `${ART_SCHEME}:`) return null
  let segs: string[]
  try {
    segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
  if (segs.some((s) => s === '' || s === '.' || s === '..' || /[/\\\0]/.test(s))) return null
  if (u.hostname === 'steam' && segs.length === 1 && /^\d{1,10}$/.test(segs[0])) {
    return { kind: 'steam', appId: segs[0] }
  }
  if (u.hostname === 'custom' && segs.length === 1) return { kind: 'custom', label: segs[0] }
  if (u.hostname === 'mod' && segs.length === 3) {
    return { kind: 'mod', game: segs[0], profileId: segs[1], modId: segs[2] }
  }
  return null
}

/** Finds the file for each kind of art; null when there is none or the request is invalid. */
export interface ArtSources {
  steamCover(appId: string): Promise<string | null>
  customCover(label: string): Promise<string | null>
  modIcon(game: string, profileId: string, modId: string): Promise<string | null>
}

export async function resolveArt(raw: string, sources: ArtSources): Promise<string | null> {
  const t = parseArtUrl(raw)
  if (!t) return null
  try {
    switch (t.kind) {
      case 'steam':
        return await sources.steamCover(t.appId)
      case 'custom':
        return await sources.customCover(t.label)
      case 'mod':
        return await sources.modIcon(t.game, t.profileId, t.modId)
    }
  } catch {
    return null
  }
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

/** The protocol handler's response: the image, or 404 for anything it can't serve. */
export async function serveArt(raw: string, sources: ArtSources): Promise<Response> {
  const file = await resolveArt(raw, sources)
  // A disabled mod's icon carries `.old`; its type is the name's before that.
  const type = file ? MIME[path.extname(file.replace(/\.old$/i, '')).toLowerCase()] : undefined
  const data = file && type ? await fs.readFile(file).catch(() => null) : null
  if (!data || !type) return new Response(null, { status: 404 })
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: { 'content-type': type, 'cache-control': 'no-cache' }
  })
}
