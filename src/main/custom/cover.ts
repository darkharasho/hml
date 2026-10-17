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
export const MAX_COVER_BYTES = 10 * 1024 * 1024

export const COVER_MIME: Record<CoverExt, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

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

/** The image's type, after checking it is an image file of acceptable size. */
async function checkImage(src: string): Promise<CoverExt> {
  const ext = coverExt(src)
  if (!ext) throw new Error('Choose a PNG, JPEG or WebP image.')
  const stat = await fs.stat(src).catch(() => null)
  if (!stat?.isFile()) throw new Error(`${path.basename(src)} was not found.`)
  if (stat.size > MAX_COVER_BYTES) throw new Error('That image is too large (over 10 MB).')
  return ext
}

/** Copies `src` in as the game's cover, replacing any previous one. */
export async function saveCover(
  paths: AppPaths,
  label: string,
  src: string,
  at: number
): Promise<CoverRef> {
  const cover: CoverRef = { ext: await checkImage(src), at }
  const dest = coverPath(paths, label, cover)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp`
  await fs.copyFile(src, tmp)
  await removeCovers(paths, label)
  await fs.rename(tmp, dest)
  return cover
}

/** A picked image as a data: URL, for the dialog's preview before the game is saved. */
export async function coverPreview(src: string): Promise<string> {
  const ext = await checkImage(src)
  return `data:${COVER_MIME[ext]};base64,${(await fs.readFile(src)).toString('base64')}`
}
