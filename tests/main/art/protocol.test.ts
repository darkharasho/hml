import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  customArtUrl,
  modArtUrl,
  parseArtUrl,
  resolveArt,
  serveArt,
  steamArtUrl,
  type ArtSources
} from '../../../src/main/art/protocol'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-artproto-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('parseArtUrl', () => {
  it('round-trips the URL builders', () => {
    expect(parseArtUrl(steamArtUrl('3314580'))).toEqual({ kind: 'steam', appId: '3314580' })
    expect(parseArtUrl(customArtUrl('custom-trash-day', 17))).toEqual({
      kind: 'custom',
      label: 'custom-trash-day'
    })
    expect(parseArtUrl(modArtUrl('repo', 'default', 'Owner-My Mod', '1.0.0'))).toEqual({
      kind: 'mod',
      game: 'repo',
      profileId: 'default',
      modId: 'Owner-My Mod'
    })
  })
  it('rejects bad app ids, paths and other schemes', () => {
    expect(parseArtUrl('hml-art://steam/12a')).toBeNull()
    expect(parseArtUrl('hml-art://steam/')).toBeNull()
    expect(parseArtUrl('hml-art://steam/1/2')).toBeNull()
    expect(parseArtUrl('hml-art://custom/..%2F..%2Fetc')).toBeNull()
    expect(parseArtUrl('hml-art://custom/a%5Cb')).toBeNull()
    expect(parseArtUrl('hml-art://mod/repo/default/..')).toBeNull()
    expect(parseArtUrl('hml-art://mod/repo/default')).toBeNull()
    expect(parseArtUrl('hml-art://mod/repo/default/%E0%A4%A')).toBeNull()
    expect(parseArtUrl('hml-art://file/etc/passwd')).toBeNull()
    expect(parseArtUrl('file:///etc/passwd')).toBeNull()
    expect(parseArtUrl('not a url')).toBeNull()
  })
})

describe('resolveArt / serveArt', () => {
  const png = (): string => {
    const file = path.join(tmp, 'icon.png')
    writeFileSync(file, 'PNGDATA')
    return file
  }
  const sources = (over: Partial<ArtSources> = {}): ArtSources => ({
    steamCover: async () => null,
    customCover: async () => null,
    modIcon: async () => null,
    ...over
  })

  it('dispatches to the matching source', async () => {
    const seen: string[] = []
    const s = sources({
      steamCover: async (id) => (seen.push(`steam:${id}`), null),
      customCover: async (l) => (seen.push(`custom:${l}`), null),
      modIcon: async (g, p, m) => (seen.push(`mod:${g}/${p}/${m}`), null)
    })
    await resolveArt('hml-art://steam/10', s)
    await resolveArt('hml-art://custom/custom-x?v=1', s)
    await resolveArt('hml-art://mod/repo/p/A-B?v=1', s)
    await resolveArt('hml-art://steam/x', s)
    expect(seen).toEqual(['steam:10', 'custom:custom-x', 'mod:repo/p/A-B'])
  })
  it('swallows source errors', async () => {
    const s = sources({
      steamCover: async () => {
        throw new Error('boom')
      }
    })
    expect(await resolveArt('hml-art://steam/10', s)).toBeNull()
  })
  it('serves an image with its type', async () => {
    const file = png()
    const res = await serveArt('hml-art://steam/10', sources({ steamCover: async () => file }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('PNGDATA')
  })
  it("serves a disabled mod's icon.png.old as a png", async () => {
    const file = path.join(tmp, 'icon.png.old')
    writeFileSync(file, 'OLD')
    const res = await serveArt('hml-art://mod/g/p/m', sources({ modIcon: async () => file }))
    expect(res.headers.get('content-type')).toBe('image/png')
  })
  it('404s for missing files, non-images and bad URLs', async () => {
    const txt = path.join(tmp, 'a.txt')
    writeFileSync(txt, 'x')
    expect((await serveArt('hml-art://steam/10', sources())).status).toBe(404)
    expect(
      (await serveArt('hml-art://steam/10', sources({ steamCover: async () => txt }))).status
    ).toBe(404)
    expect(
      (
        await serveArt(
          'hml-art://steam/10',
          sources({ steamCover: async () => path.join(tmp, 'gone.png') })
        )
      ).status
    ).toBe(404)
    expect((await serveArt('hml-art://nope/1', sources())).status).toBe(404)
  })
})
