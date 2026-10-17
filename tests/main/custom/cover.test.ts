import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  coverExt,
  coverPath,
  isCoverRef,
  removeCovers,
  saveCover
} from '../../../src/main/custom/cover'
import { makePaths, type AppPaths } from '../../../src/main/store/paths'

let tmp: string
let paths: AppPaths
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-cover-'))
  paths = makePaths(path.join(tmp, 'data'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const src = (name: string, body = 'img'): string => {
  const file = path.join(tmp, name)
  writeFileSync(file, body)
  return file
}

describe('cover helpers', () => {
  it('accepts image extensions only', () => {
    expect(coverExt('a/B.PNG')).toBe('png')
    expect(coverExt('a.jpeg')).toBe('jpeg')
    expect(coverExt('a.webp')).toBe('webp')
    expect(coverExt('a.gif')).toBeNull()
    expect(coverExt('png')).toBeNull()
  })
  it('validates stored refs', () => {
    expect(isCoverRef({ ext: 'png', at: 1 })).toBe(true)
    expect(isCoverRef({ ext: '../x', at: 1 })).toBe(false)
    expect(isCoverRef({ ext: 'png' })).toBe(false)
    expect(isCoverRef(null)).toBe(false)
  })
})

describe('saveCover / removeCovers', () => {
  it('copies the image into the game dir', async () => {
    const cover = await saveCover(paths, 'custom-x', src('pic.JPG', 'one'), 5)
    expect(cover).toEqual({ ext: 'jpg', at: 5 })
    const dest = coverPath(paths, 'custom-x', cover)
    expect(dest).toBe(path.join(paths.gameDir('custom-x'), 'cover.jpg'))
    expect(readFileSync(dest, 'utf8')).toBe('one')
  })
  it('replaces a previous cover of another type', async () => {
    const a = await saveCover(paths, 'custom-x', src('a.png', 'one'), 1)
    const b = await saveCover(paths, 'custom-x', src('b.webp', 'two'), 2)
    expect(existsSync(coverPath(paths, 'custom-x', a))).toBe(false)
    expect(readFileSync(coverPath(paths, 'custom-x', b), 'utf8')).toBe('two')
  })
  it('refuses other file types and missing files', async () => {
    await expect(saveCover(paths, 'custom-x', src('a.gif'), 1)).rejects.toThrow(/PNG/)
    await expect(saveCover(paths, 'custom-x', path.join(tmp, 'gone.png'), 1)).rejects.toThrow(
      /not found/
    )
  })
  it('removes every cover and nothing else', async () => {
    const cover = await saveCover(paths, 'custom-x', src('a.png'), 1)
    const keep = path.join(paths.gameDir('custom-x'), 'deployment.json')
    writeFileSync(keep, '{}')
    await removeCovers(paths, 'custom-x')
    expect(existsSync(coverPath(paths, 'custom-x', cover))).toBe(false)
    expect(existsSync(keep)).toBe(true)
    await removeCovers(paths, 'custom-never')
  })
})
