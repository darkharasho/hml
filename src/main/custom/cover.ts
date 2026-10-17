import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AppPaths } from '../store/paths'

export const COVER_EXTS = ['png', 'jpg', 'jpeg', 'webp'] as const
export type CoverExt = (typeof COVER_EXTS)[number]
/** A custom game's chosen image: `games/<label>/cover.<ext>`, replaced at `at` (ms). */
export interface CoverRef {
  ext: CoverExt
  at: number
}
/** Larger files are refused; a cover is shown at a few hundred pixels. */
export const MAX_COVER_BYTES = 20 * 1024 * 1024

export function coverExt(file: string): CoverExt | null {
  const ext = path.extname(file).slice(1).toLowerCase()
  return (COVER_EXTS as readonly string[]).includes(ext) ? (ext as CoverExt) : null
}

export function isCoverRef(v: unknown): v is CoverRef {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.ext === 'string' && coverExt(`x.${o.ext}`) === o.ext && typeof o.at === 'number'
}

export const coverPath = (paths: AppPaths, label: string, cover: CoverRef): string =>
  path.join(paths.gameDir(label), `cover.${cover.ext}`)

/** Deletes every `cover.<ext>` the game has. */
export async function removeCovers(paths: AppPaths, label: string): Promise<void> {
  for (const ext of COVER_EXTS) {
    await fs.rm(path.join(paths.gameDir(label), `cover.${ext}`), { force: true })
  }
}

/** Copies `src` in as the game's cover, replacing any previous one. */
export async function saveCover(
  paths: AppPaths,
  label: string,
  src: string,
  at: number
): Promise<CoverRef> {
  const ext = coverExt(src)
  if (!ext) throw new Error('Choose a PNG, JPEG or WebP image.')
  const stat = await fs.stat(src).catch(() => null)
  if (!stat?.isFile()) throw new Error(`${path.basename(src)} was not found.`)
  if (stat.size > MAX_COVER_BYTES) throw new Error('That image is too large (over 20 MB).')
  const cover: CoverRef = { ext, at }
  const dest = coverPath(paths, label, cover)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp`
  await fs.copyFile(src, tmp)
  await removeCovers(paths, label)
  await fs.rename(tmp, dest)
  return cover
}
