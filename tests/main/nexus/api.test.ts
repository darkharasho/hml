import { describe, expect, it } from 'vitest'
import {
  NX_MAX_DOWNLOAD,
  NxPremiumRequiredError,
  downloadFile,
  downloadLinks,
  gameByDomain,
  getMod,
  modFiles,
  nxHeaders,
  searchMods,
  validateKey,
  type NxClientOpts
} from '../../../src/main/nexus/api'
import type { NxQuery } from '../../../src/shared/types'

interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  raw?: Uint8Array
}
interface Call {
  url: string
  headers: Record<string, string>
  body: string | undefined
  redirect: string | undefined
}
const KEY = 'sekrit-key-123'

function fake(handler: (url: string, body: string | undefined) => Reply | Error): {
  o: NxClientOpts
  calls: Call[]
} {
  const calls: Call[] = []
  const f = (async (
    url: string,
    init?: { headers?: Record<string, string>; body?: string; redirect?: string }
  ) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body, redirect: init?.redirect })
    const r = handler(url, init?.body)
    if (r instanceof Error) throw r
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(r.headers),
      json: async () => r.body,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          if (r.raw && r.raw.byteLength > 0) c.enqueue(r.raw)
          c.close()
        }
      })
    }
  }) as unknown as typeof fetch
  return {
    o: { fetch: f, appVersion: '1.2.3', os: { type: 'Linux', release: '6.0', arch: 'x64' } },
    calls
  }
}

const q = (over: Partial<NxQuery> = {}): NxQuery => ({
  text: 'cam',
  sort: 'downloads',
  includeAdult: false,
  offset: 0,
  limit: 20,
  ...over
})
const node = {
  modId: 5,
  name: 'Cam',
  summary: 's',
  author: 'a',
  version: '1.0',
  pictureUrl: null,
  thumbnailUrl: 't',
  downloads: 3,
  endorsements: 2,
  updatedAt: 'x',
  adultContent: false
}
const GQL = 'https://api.nexusmods.com/v2/graphql'

describe('headers', () => {
  it('identifies HML and carries no key', () => {
    const h = nxHeaders(fake(() => ({})).o)
    expect(h['Application-Name']).toBe('HML')
    expect(h['Application-Version']).toBe('1.2.3')
    expect(h['User-Agent']).toBe('HML/1.2.3 (Linux 6.0; x64)')
    expect(h.apikey).toBeUndefined()
  })
})

describe('searchMods', () => {
  it('posts the filters and sort and parses nodes', async () => {
    const { o, calls } = fake(() => ({
      body: { data: { mods: { totalCount: 7, nodes: [node] } } }
    }))
    const r = await searchMods(o, 'repo', q())
    expect(calls[0].url).toBe(GQL)
    const query = (JSON.parse(calls[0].body as string) as { query: string }).query
    expect(query).toContain('gameDomainName:[{value:"repo"}]')
    expect(query).toContain('name:[{value:"cam", op:WILDCARD}]')
    expect(query).toContain('adultContent:[{value:false}]')
    expect(query).toContain('sort:[{downloads:{direction:DESC}}]')
    expect(r.total).toBe(7)
    expect(r.items[0]).toMatchObject({ modId: 5, name: 'Cam', thumbnailUrl: 't', pictureUrl: null })
  })
  it('maps sorts, adult and empty relevance', async () => {
    const { o, calls } = fake(() => ({ body: { data: { mods: { totalCount: 0, nodes: [] } } } }))
    const text = async (p: Partial<NxQuery>): Promise<string> => {
      await searchMods(o, 'repo', q(p))
      return (JSON.parse(calls[calls.length - 1].body as string) as { query: string }).query
    }
    expect(await text({ sort: 'updated' })).toContain('sort:[{updatedAt:{direction:DESC}}]')
    expect(await text({ sort: 'name' })).toContain('sort:[{name:{direction:ASC}}]')
    expect(await text({ sort: 'relevance' })).toContain('sort:[{relevance:{direction:DESC}}]')
    const empty = await text({ text: '', sort: 'relevance', includeAdult: true })
    expect(empty).toContain('sort:[{downloads:{direction:DESC}}]')
    expect(empty).not.toContain('WILDCARD')
    expect(empty).not.toContain('adultContent:[')
    expect(await text({ limit: 999 })).toContain('count:50')
  })
  it('maps GraphQL errors', async () => {
    const { o } = fake(() => ({ body: { errors: [{ message: 'boom' }, { message: 'two' }] } }))
    await expect(searchMods(o, 'repo', q())).rejects.toThrow('Nexus Mods search failed: boom')
  })
  it('maps network failures', async () => {
    const { o } = fake(() => new Error(`fetch failed ${KEY}`))
    const err = await searchMods(o, 'repo', q()).catch((e: Error) => e)
    expect((err as Error).message).toBe(
      "Couldn't reach Nexus Mods. Check your connection and try again."
    )
  })
  it('maps 429 with reset header', async () => {
    const reset = '2026-10-16T18:30:00Z'
    const { o } = fake(() => ({ status: 429, headers: { 'X-RL-Hourly-Reset': reset } }))
    const when = new Date(reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    await expect(searchMods(o, 'repo', q())).rejects.toThrow(
      `Nexus Mods' rate limit was reached. Try again after ${when}.`
    )
    const bare = fake(() => ({ status: 429 }))
    await expect(searchMods(bare.o, 'repo', q())).rejects.toThrow(
      "Nexus Mods' rate limit was reached. Try again later."
    )
  })
})

describe('games and mods', () => {
  it('gameByDomain returns null for an unknown game', async () => {
    const { o } = fake(() => ({
      body: {
        data: { game: null },
        errors: [{ message: 'nope', extensions: { code: 'GAME_NOT_FOUND' } }]
      }
    }))
    expect(await gameByDomain(o, 'zzz')).toBeNull()
  })
  it('getMod resolves the game id then filters by modId', async () => {
    const { o, calls } = fake((_u, body) =>
      (body as string).includes('game(domainName')
        ? { body: { data: { game: { id: 7398, name: 'R.E.P.O.', domainName: 'repo' } } } }
        : { body: { data: { mods: { nodes: [node] } } } }
    )
    expect((await getMod(o, 'repo', 5)).modId).toBe(5)
    expect(calls[1].body).toContain('gameId:[{value:\\"7398\\"}]')
    expect(calls[1].body).toContain('modId:[{value:\\"5\\"}]')
  })
  it('modFiles maps sizes and orders newest first', async () => {
    const { o } = fake(() => ({
      body: {
        data: {
          modFiles: [
            {
              fileId: 1,
              name: 'old',
              version: '1',
              category: 'MAIN',
              size: 9,
              sizeInBytes: '0',
              date: 100
            },
            {
              fileId: 2,
              name: 'new',
              version: '2',
              category: 'UPDATE',
              size: 9,
              sizeInBytes: '5000',
              date: 200
            }
          ]
        }
      }
    }))
    const files = await modFiles(o, 7398, 5)
    expect(files.map((f) => f.fileId)).toEqual([2, 1])
    expect(files[0].sizeBytes).toBe(5000)
    expect(files[1].sizeBytes).toBe(9216)
  })
})

describe('validateKey', () => {
  it('sends apikey and maps is_premium without keeping the email', async () => {
    const { o, calls } = fake(() => ({
      body: { user_id: 42, name: 'Haro', is_premium: true, email: 'a@b.c' }
    }))
    const u = await validateKey(o, KEY)
    expect(calls[0].url).toBe('https://api.nexusmods.com/v1/users/validate.json')
    expect(calls[0].headers.apikey).toBe(KEY)
    expect(u).toEqual({ name: 'Haro', isPremium: true, userId: 42 })
  })
  it('maps 401 without leaking the key', async () => {
    const { o } = fake(() => ({ status: 401 }))
    const err = (await validateKey(o, KEY).catch((e: Error) => e)) as Error
    expect(err.message).toBe("Nexus Mods didn't accept that API key.")
    expect(err.message).not.toContain(KEY)
  })
})

describe('downloads', () => {
  const base = 'https://api.nexusmods.com/v1/games/repo/mods/5/files/9/download_link.json'
  it('builds key and expires only when given', async () => {
    const { o, calls } = fake(() => ({
      body: [{ name: 'CDN', short_name: 'c', URI: 'https://cf-files.nexusmods.com/x.zip' }]
    }))
    expect(await downloadLinks(o, KEY, 'repo', 5, 9)).toEqual([
      'https://cf-files.nexusmods.com/x.zip'
    ])
    await downloadLinks(o, KEY, 'repo', 5, 9, { key: 'k', expires: 123 })
    expect(calls[0].url).toBe(base)
    expect(calls[1].url).toBe(`${base}?key=k&expires=123`)
    expect(calls[1].headers.apikey).toBe(KEY)
  })
  it('maps statuses', async () => {
    const run = (status: number): Promise<unknown> =>
      downloadLinks(fake(() => ({ status })).o, KEY, 'repo', 5, 9)
    await expect(run(403)).rejects.toBeInstanceOf(NxPremiumRequiredError)
    await expect(run(410)).rejects.toThrow(
      'This Nexus download link has expired. Click "Mod Manager Download" again.'
    )
    await expect(run(400)).rejects.toThrow("This Nexus download link isn't valid for your account.")
    await expect(run(404)).rejects.toThrow('That file is no longer on Nexus Mods.')
  })
  it('downloadFile sends no apikey and returns bytes', async () => {
    const { o, calls } = fake(() => ({ raw: new Uint8Array([1, 2, 3]) }))
    expect(Array.from(await downloadFile(o, 'https://cf-files.nexusmods.com/x.zip'))).toEqual([
      1, 2, 3
    ])
    expect(calls[0].headers.apikey).toBeUndefined()
    expect(calls[0].headers['Application-Name']).toBe('HML')
  })
  it('enforces the size cap by header', async () => {
    const msg = "This file is larger than 1 GB, which HML can't install yet."
    const byHeader = fake(() => ({ headers: { 'content-length': String(NX_MAX_DOWNLOAD + 1) } }))
    await expect(downloadFile(byHeader.o, 'https://cf-files.nexusmods.com/x')).rejects.toThrow(msg)
  })
  it('enforces the cap on streamed bytes without a Content-Length', async () => {
    const { o } = fake(() => ({ raw: new Uint8Array(10) }))
    await expect(downloadFile(o, 'https://cf-files.nexusmods.com/x', 9)).rejects.toThrow(
      "This file is larger than 1 GB, which HML can't install yet."
    )
    expect((await downloadFile(o, 'https://cf-files.nexusmods.com/x', 10)).byteLength).toBe(10)
  })
  it('refuses non-https download URLs', async () => {
    const { o, calls } = fake(() => ({ raw: new Uint8Array(1) }))
    await expect(downloadFile(o, 'http://cf-files.nexusmods.com/x')).rejects.toThrow('https')
    await expect(downloadFile(o, 'file:///etc/passwd')).rejects.toThrow('https')
    expect(calls).toHaveLength(0)
  })
  it('rejects non-integer ids before any request', async () => {
    const { o, calls } = fake(() => ({}))
    await expect(downloadLinks(o, KEY, 'repo', NaN, 9)).rejects.toThrow('Invalid Nexus mod id')
    await expect(downloadLinks(o, KEY, 'repo', 5, 1.5)).rejects.toThrow('Invalid Nexus file id')
    await expect(modFiles(o, 7398, 0)).rejects.toThrow('Invalid Nexus mod id')
    await expect(getMod(o, 'repo', -1)).rejects.toThrow('Invalid Nexus mod id')
    expect(calls).toHaveLength(0)
  })
})

describe('key hygiene', () => {
  it('never sends apikey outside /v1/', async () => {
    const { o, calls } = fake((url) => {
      if (url.includes('validate')) return { body: { user_id: 1, name: 'n', is_premium: false } }
      if (url.includes('download_link'))
        return { body: [{ URI: 'https://cf-files.nexusmods.com/x' }] }
      if (url === GQL) return { body: { data: { mods: { totalCount: 0, nodes: [] } } } }
      return { raw: new Uint8Array([1]) }
    })
    await validateKey(o, KEY)
    await searchMods(o, 'repo', q())
    const [link] = await downloadLinks(o, KEY, 'repo', 5, 9)
    await downloadFile(o, link)
    for (const c of calls) {
      if (!c.url.startsWith('https://api.nexusmods.com/v1/'))
        expect(c.headers.apikey).toBeUndefined()
    }
    expect(calls.some((c) => c.headers.apikey === KEY)).toBe(true)
  })

  it('refuses redirects on every request that carries the key', async () => {
    const { o, calls } = fake((url) => {
      if (url.includes('validate')) return { body: { user_id: 1, name: 'n', is_premium: false } }
      if (url.includes('download_link'))
        return { body: [{ URI: 'https://cf-files.nexusmods.com/x' }] }
      if (url === GQL) return { body: { data: { mods: { totalCount: 0, nodes: [] } } } }
      return { raw: new Uint8Array([1]) }
    })
    await validateKey(o, KEY)
    const [link] = await downloadLinks(o, KEY, 'repo', 5, 9)
    await searchMods(o, 'repo', q())
    await downloadFile(o, link)
    const keyed = calls.filter((c) => c.headers.apikey !== undefined)
    expect(keyed).toHaveLength(2)
    for (const c of keyed) expect(c.redirect).toBe('error')
  })
})
