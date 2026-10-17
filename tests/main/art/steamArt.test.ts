import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSteamArt,
  findLibraryCover,
  isAppId,
  parseStoreCovers,
  steamCdnCover,
  storeItemsUrl
} from '../../../src/main/art/steamArt'

let tmp: string
let root: string
const cache = (): string => path.join(root, 'appcache', 'librarycache')
const put = (rel: string): string => {
  const file = path.join(cache(), rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'jpg')
  return file
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-steamart-'))
  root = path.join(tmp, 'steam')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('isAppId', () => {
  it('accepts digits only', () => {
    expect(isAppId('3314580')).toBe(true)
    expect(isAppId('')).toBe(false)
    expect(isAppId('12a')).toBe(false)
    expect(isAppId('../1')).toBe(false)
    expect(isAppId('1'.repeat(12))).toBe(false)
  })
})

describe('findLibraryCover', () => {
  it('finds the capsule in a hashed subfolder', async () => {
    put('3314580/6d7cb32d/header.jpg')
    const file = put('3314580/2b8d05de/library_capsule.jpg')
    expect(await findLibraryCover(root, '3314580')).toBe(file)
  })
  it('prefers the newest of several hashed capsules', async () => {
    const old = put('10/aaa/library_capsule.jpg')
    const fresh = put('10/bbb/library_capsule.jpg')
    utimesSync(old, new Date(1_000_000), new Date(1_000_000))
    utimesSync(fresh, new Date(2_000_000), new Date(2_000_000))
    expect(await findLibraryCover(root, '10')).toBe(fresh)
  })
  it("uses the app folder's library_600x900.jpg", async () => {
    const file = put('10/library_600x900.jpg')
    put('10/abc/library_capsule.jpg')
    expect(await findLibraryCover(root, '10')).toBe(file)
  })
  it('falls back to the legacy flat file', async () => {
    const file = put('20_library_600x900.jpg')
    expect(await findLibraryCover(root, '20')).toBe(file)
  })
  it('returns null when nothing is cached or the id is not numeric', async () => {
    expect(await findLibraryCover(root, '30')).toBeNull()
    put('x/library_600x900.jpg')
    expect(await findLibraryCover(root, 'x')).toBeNull()
    expect(await findLibraryCover(root, '../x')).toBeNull()
  })
})

describe('store API', () => {
  it('builds a batched GetItems URL', () => {
    const u = new URL(storeItemsUrl(['10', '3314580']))
    expect(u.origin + u.pathname).toBe(
      'https://api.steampowered.com/IStoreBrowseService/GetItems/v1'
    )
    expect(JSON.parse(u.searchParams.get('input_json')!)).toEqual({
      ids: [{ appid: 10 }, { appid: 3314580 }],
      context: { language: 'english', country_code: 'US' },
      data_request: { include_assets: true }
    })
  })
  it('parses capsule URLs and marks items without one', () => {
    const covers = parseStoreCovers({
      response: {
        store_items: [
          {
            appid: 3314580,
            assets: {
              asset_url_format: 'steam/apps/3314580/${FILENAME}?t=1759',
              library_capsule: '2b8d/library_capsule.jpg'
            }
          },
          { appid: 20, assets: { asset_url_format: 'steam/apps/20/${FILENAME}' } },
          { appid: 30, success: 2 },
          { nonsense: true },
          'junk'
        ]
      }
    })
    expect(covers.get('3314580')).toBe(
      'https://shared.steamstatic.com/store_item_assets/steam/apps/3314580/2b8d/library_capsule.jpg?t=1759'
    )
    expect(covers.get('20')).toBeNull()
    expect(covers.get('30')).toBeNull()
    expect(covers.size).toBe(3)
  })
  it('rejects unexpected shapes', () => {
    expect(parseStoreCovers(null).size).toBe(0)
    expect(parseStoreCovers({ response: {} }).size).toBe(0)
    expect(parseStoreCovers({ response: { store_items: 'x' } }).size).toBe(0)
  })
})

describe('createSteamArt', () => {
  const storeItem = (id: number): Record<string, unknown> => ({
    appid: id,
    assets: { asset_url_format: `steam/apps/${id}/\${FILENAME}`, library_capsule: 'c.jpg' }
  })
  const storeUrl = (id: string): string =>
    `https://shared.steamstatic.com/store_item_assets/steam/apps/${id}/c.jpg`

  function art(
    opts: { fail?: boolean; root?: string | null; now?: () => number; gate?: Promise<void> } = {}
  ): {
    art: ReturnType<typeof createSteamArt>
    calls: string[][]
  } {
    const calls: string[][] = []
    const fetch = (async (url: string) => {
      const input = JSON.parse(new URL(url).searchParams.get('input_json')!) as {
        ids: { appid: number }[]
      }
      calls.push(input.ids.map((i) => String(i.appid)))
      await opts.gate
      if (opts.fail) throw new Error('offline')
      return new Response(
        JSON.stringify({ response: { store_items: input.ids.map((i) => storeItem(i.appid)) } }),
        { status: 200 }
      )
    }) as unknown as typeof globalThis.fetch
    return {
      calls,
      art: createSteamArt({
        fetch,
        getSteamRoot: async () => (opts.root === undefined ? root : opts.root),
        cacheFile: path.join(tmp, 'cache', 'steam-art.json'),
        now: opts.now
      })
    }
  }

  it('answers at once from what is cached, fetching the store capsule in the background', async () => {
    put('10/abc/library_capsule.jpg')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { art: a, calls } = art({ gate })
    const first = await a.covers(['10', '20'])
    expect(first.get('10')).toEqual(['hml-art://steam/10', steamCdnCover('10')])
    expect(first.get('20')).toEqual([steamCdnCover('20')])
    expect(calls).toEqual([['10', '20']])
    release()
    await a.idle()
    const next = await a.covers(['10', '20'])
    expect(next.get('10')).toEqual(['hml-art://steam/10', storeUrl('10'), steamCdnCover('10')])
    expect(next.get('20')).toEqual([storeUrl('20'), steamCdnCover('20')])
  })
  it('batches uncached ids and fetches each once', async () => {
    const { art: a, calls } = art()
    await a.covers(['10', '20'])
    await a.idle()
    await a.covers(['20', '30'])
    await a.idle()
    await a.covers(['10', '30'])
    await a.idle()
    expect(calls).toEqual([['10', '20'], ['30']])
  })
  it('shares an in-flight fetch', async () => {
    const { art: a, calls } = art()
    await Promise.all([a.covers(['10']), a.covers(['10'])])
    await a.idle()
    expect(calls).toEqual([['10']])
  })
  it('persists results across instances', async () => {
    const first = art().art
    await first.covers(['10'])
    await first.idle()
    const second = art()
    expect((await second.art.covers(['10'])).get('10')).toContain(storeUrl('10'))
    await second.art.idle()
    expect(second.calls).toEqual([])
  })
  it('falls back silently when the store is unreachable, and backs off', async () => {
    let t = 1_000_000
    const { art: a, calls } = art({ fail: true, root: null, now: () => t })
    expect((await a.covers(['10'])).get('10')).toEqual([steamCdnCover('10')])
    await a.idle()
    expect((await a.covers(['10'])).get('10')).toEqual([steamCdnCover('10')])
    await a.idle()
    expect(calls.length).toBe(1)
    t += 120_000
    await a.covers(['10'])
    await a.idle()
    expect(calls.length).toBe(2)
  })
  it('ignores ids that are not numeric', async () => {
    const { art: a, calls } = art()
    const covers = await a.covers(['abc'])
    expect(covers.has('abc')).toBe(false)
    expect(calls).toEqual([])
  })
})
