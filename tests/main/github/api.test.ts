import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  downloadAsset,
  fetchLogin,
  fetchRelease,
  GhPrereleaseOnlyError,
  isNewerRelease,
  isNewerTag,
  GH_RELEASE_MEMO_MS,
  MAX_DOWNLOAD_BYTES
} from '../../../src/main/github/api'
import type { GhReleaseAsset } from '../../../src/main/github/assets'

const API = 'https://api.github.com/repos/o/r'
let tmp: string
let cacheFile: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-gh-'))
  cacheFile = path.join(tmp, 'cache', 'github.json')
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

interface Reply {
  status: number
  body?: unknown
  headers?: Record<string, string>
  raw?: Uint8Array
}
interface Call {
  url: string
  headers: Record<string, string>
}
function fakeFetch(routes: Record<string, Reply | Reply[]>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const f = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} })
    const r = routes[url]
    if (!r) throw new Error(`unrouted ${url}`)
    const reply = Array.isArray(r) ? (r.shift() as Reply) : r
    const h = new Headers(reply.headers)
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: h,
      json: async () => reply.body,
      arrayBuffer: async () => {
        const b = reply.raw ?? new Uint8Array()
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      }
    }
  }) as unknown as typeof fetch
  return { fetch: f, calls }
}

const rawAsset = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 7,
  name: 'Mod-1.0.0.zip',
  size: 10,
  browser_download_url: 'https://github.com/o/r/releases/download/v1.0.0/Mod-1.0.0.zip',
  url: 'https://api.github.com/repos/o/r/releases/assets/7',
  digest: 'sha256:abc',
  ...over
})
const rawRelease = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: 'v1.0.0',
  name: 'One',
  prerelease: false,
  draft: false,
  published_at: '2026-01-01T00:00:00Z',
  html_url: 'https://github.com/o/r/releases/tag/v1.0.0',
  assets: [rawAsset()],
  ...over
})
const base = (f: typeof fetch, extra = {}): Parameters<typeof fetchRelease>[0] => ({
  fetch: f,
  token: null,
  cacheFile,
  owner: 'o',
  repo: 'r',
  ...extra
})

describe('fetchRelease', () => {
  it('fetches latest, normalizes, sends headers without auth', async () => {
    const { fetch: f, calls } = fakeFetch({
      [`${API}/releases/latest`]: { status: 200, body: rawRelease(), headers: { etag: 'W/"1"' } }
    })
    const rel = await fetchRelease(base(f))
    expect(calls).toHaveLength(1)
    expect(calls[0].headers).toEqual({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'HML'
    })
    expect(rel).toEqual({
      tag: 'v1.0.0',
      name: 'One',
      prerelease: false,
      publishedAt: '2026-01-01T00:00:00Z',
      htmlUrl: 'https://github.com/o/r/releases/tag/v1.0.0',
      assets: [
        {
          id: 7,
          name: 'Mod-1.0.0.zip',
          size: 10,
          downloadUrl: 'https://github.com/o/r/releases/download/v1.0.0/Mod-1.0.0.zip',
          apiUrl: 'https://api.github.com/repos/o/r/releases/assets/7',
          digest: 'sha256:abc'
        }
      ]
    })
  })

  it('sends Authorization with a token', async () => {
    const { fetch: f, calls } = fakeFetch({
      [`${API}/releases/latest`]: { status: 200, body: rawRelease() }
    })
    await fetchRelease(base(f, { token: 't0k' }))
    expect(calls[0].headers.Authorization).toBe('Bearer t0k')
  })

  it('uses If-None-Match and the cached body on 304', async () => {
    const { fetch: f, calls } = fakeFetch({
      [`${API}/releases/latest`]: [
        { status: 200, body: rawRelease(), headers: { etag: 'W/"1"' } },
        { status: 304 }
      ]
    })
    const a = await fetchRelease(base(f, { now: () => 1000 }))
    const b = await fetchRelease(base(f, { now: () => 2000 }))
    expect(calls[1].headers['If-None-Match']).toBe('W/"1"')
    expect(b).toEqual(a)
    const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
    expect(cache[`${API}/releases/latest`]).toMatchObject({ etag: 'W/"1"', fetchedAt: 2000 })
  })

  it('honours maxAgeMs', async () => {
    const { fetch: f, calls } = fakeFetch({
      [`${API}/releases/latest`]: [
        { status: 200, body: rawRelease(), headers: { etag: 'e' } },
        { status: 304 }
      ]
    })
    await fetchRelease(base(f, { now: () => 0 }))
    await fetchRelease(base(f, { now: () => 599_999, maxAgeMs: GH_RELEASE_MEMO_MS }))
    expect(calls).toHaveLength(1)
    await fetchRelease(base(f, { now: () => 600_001, maxAgeMs: GH_RELEASE_MEMO_MS }))
    expect(calls).toHaveLength(2)
    expect(calls[1].headers['If-None-Match']).toBe('e')
  })

  it('without prereleases, a repo with only pre-releases throws GhPrereleaseOnlyError', async () => {
    const { fetch: f } = fakeFetch({
      [`${API}/releases/latest`]: { status: 404 },
      [`${API}/releases?per_page=100`]: {
        status: 200,
        body: [
          rawRelease({ tag_name: 'd', draft: true }),
          rawRelease({ tag_name: 'v2-beta', prerelease: true })
        ]
      }
    })
    const err = await fetchRelease(base(f)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GhPrereleaseOnlyError)
    expect((err as Error).message).toBe('o/r only publishes pre-releases.')
  })

  it('with prereleases, picks the newest non-draft release of any kind from the list', async () => {
    const { fetch: f, calls } = fakeFetch({
      [`${API}/releases?per_page=100`]: {
        status: 200,
        body: [
          rawRelease({ tag_name: 'v3-draft', draft: true }),
          rawRelease({ tag_name: 'v2.0.0-beta.1', prerelease: true }),
          rawRelease({ tag_name: 'v1.0.0' })
        ]
      }
    })
    const rel = await fetchRelease(base(f, { prereleases: true }))
    expect(rel.tag).toBe('v2.0.0-beta.1')
    expect(rel.prerelease).toBe(true)
    expect(calls.map((c) => c.url)).toEqual([`${API}/releases?per_page=100`])
  })

  it('with prereleases, looks past a page start full of drafts', async () => {
    const drafts = Array.from({ length: 12 }, (_, i) =>
      rawRelease({ tag_name: `d${i}`, draft: true })
    )
    const { fetch: f } = fakeFetch({
      [`${API}/releases?per_page=100`]: {
        status: 200,
        body: [...drafts, rawRelease({ tag_name: 'v2-beta', prerelease: true })]
      }
    })
    expect((await fetchRelease(base(f, { prereleases: true }))).tag).toBe('v2-beta')
  })

  it('with prereleases, a newer stable release wins', async () => {
    const { fetch: f } = fakeFetch({
      [`${API}/releases?per_page=100`]: {
        status: 200,
        body: [
          rawRelease({ tag_name: 'v2.0.0' }),
          rawRelease({ tag_name: 'v2.0.0-rc.1', prerelease: true })
        ]
      }
    })
    const rel = await fetchRelease(base(f, { prereleases: true }))
    expect(rel.tag).toBe('v2.0.0')
    expect(rel.prerelease).toBe(false)
  })

  it('with prereleases, reports empty lists and missing repos', async () => {
    const empty = fakeFetch({
      [`${API}/releases?per_page=100`]: { status: 200, body: [rawRelease({ draft: true })] }
    })
    await expect(fetchRelease(base(empty.fetch, { prereleases: true }))).rejects.toThrow(
      'o/r has no releases yet.'
    )
    const gone = fakeFetch({ [`${API}/releases?per_page=100`]: { status: 404 } })
    await expect(fetchRelease(base(gone.fetch, { prereleases: true }))).rejects.toThrow(
      "Couldn't find github.com/o/r."
    )
  })

  it('a tag or a track ignores prereleases', async () => {
    const { fetch: f } = fakeFetch({
      [`${API}/releases/tags/v1`]: { status: 200, body: rawRelease({ tag_name: 'v1' }) }
    })
    expect((await fetchRelease(base(f, { tag: 'v1', prereleases: true }))).tag).toBe('v1')
  })

  it('reports empty lists, missing repos and missing tags', async () => {
    const empty = fakeFetch({
      [`${API}/releases/latest`]: { status: 404 },
      [`${API}/releases?per_page=100`]: { status: 200, body: [] }
    })
    await expect(fetchRelease(base(empty.fetch))).rejects.toThrow('o/r has no releases yet.')
    const gone = fakeFetch({
      [`${API}/releases/latest`]: { status: 404 },
      [`${API}/releases?per_page=100`]: { status: 404 }
    })
    await expect(fetchRelease(base(gone.fetch))).rejects.toThrow(
      "Couldn't find github.com/o/r. Check the URL; private repositories need a GitHub token in Settings."
    )
    const tag = fakeFetch({ [`${API}/releases/tags/v9`]: { status: 404 } })
    await expect(fetchRelease(base(tag.fetch, { tag: 'v9' }))).rejects.toThrow(
      'o/r has no release v9.'
    )
  })

  it('encodes slash tags', async () => {
    const { fetch: f, calls } = fakeFetch({
      [`${API}/releases/tags/rel%2F1`]: { status: 200, body: rawRelease() }
    })
    await fetchRelease(base(f, { tag: 'rel/1' }))
    expect(calls[0].url).toBe(`${API}/releases/tags/rel%2F1`)
  })

  it('maps errors', async () => {
    const rl = fakeFetch({
      [`${API}/releases/latest`]: {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }
      }
    })
    await expect(fetchRelease(base(rl.fetch))).rejects.toThrow(
      "GitHub's rate limit was reached. Try again after"
    )
    const un = fakeFetch({ [`${API}/releases/latest`]: { status: 401 } })
    await expect(fetchRelease(base(un.fetch))).rejects.toThrow(
      'GitHub rejected the saved token. Update or remove it in Settings.'
    )
    const down = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    await expect(fetchRelease(base(down))).rejects.toThrow(
      "Couldn't reach GitHub. Check your connection and try again."
    )
    const odd = fakeFetch({ [`${API}/releases/latest`]: { status: 500 } })
    await expect(fetchRelease(base(odd.fetch))).rejects.toThrow('GitHub returned HTTP 500 for o/r.')
  })

  it('drops assets with non-github urls', async () => {
    const { fetch: f } = fakeFetch({
      [`${API}/releases/latest`]: {
        status: 200,
        body: rawRelease({
          assets: [
            rawAsset({ browser_download_url: 'https://evil.example/x.zip' }),
            rawAsset({ id: 8, url: 'https://evil.example/api' }),
            rawAsset({ id: 9, digest: undefined })
          ]
        })
      }
    })
    const rel = await fetchRelease(base(f))
    expect(rel.assets.map((a) => a.id)).toEqual([9])
    expect(rel.assets[0].digest).toBeNull()
  })

  it('treats a corrupt cache as empty', async () => {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true })
    await fs.writeFile(cacheFile, '{nope')
    const { fetch: f, calls } = fakeFetch({
      [`${API}/releases/latest`]: { status: 200, body: rawRelease() }
    })
    await fetchRelease(base(f))
    expect(calls[0].headers['If-None-Match']).toBeUndefined()
  })
})

describe('fetchRelease with a cached body', () => {
  const url = `${API}/releases/latest`
  const primed = (later: Reply | 'offline'): typeof fetch => {
    let first = true
    const ok = fakeFetch({ [url]: { status: 200, body: rawRelease(), headers: { etag: 'e' } } })
    const bad = later === 'offline' ? null : fakeFetch({ [url]: later })
    return (async (u: string, init?: never) => {
      if (first) {
        first = false
        return ok.fetch(u, init)
      }
      if (!bad) throw new Error('ECONNRESET')
      return bad.fetch(u, init)
    }) as unknown as typeof fetch
  }

  it('returns the cached release on a rate limit, a rejected token or no connection', async () => {
    const cases: (Reply | 'offline')[] = [
      { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
      { status: 429, headers: { 'retry-after': '60' } },
      { status: 401 },
      'offline'
    ]
    for (const later of cases) {
      await fs.rm(cacheFile, { force: true })
      const f = primed(later)
      await fetchRelease(base(f))
      expect((await fetchRelease(base(f))).tag).toBe('v1.0.0')
    }
  })

  it('still throws without a cached body, and on other errors', async () => {
    const rl = fakeFetch({ [url]: { status: 403, headers: { 'x-ratelimit-remaining': '0' } } })
    await expect(fetchRelease(base(rl.fetch))).rejects.toThrow("GitHub's rate limit was reached.")
    const f = primed({ status: 500 })
    await fetchRelease(base(f))
    await expect(fetchRelease(base(f))).rejects.toThrow('GitHub returned HTTP 500 for o/r.')
  })
})

describe('fetchRelease cache robustness', () => {
  it('merges concurrent writers for different repos', async () => {
    const mk = (r: string): Record<string, Reply> => ({
      [`https://api.github.com/repos/o/${r}/releases/latest`]: { status: 200, body: rawRelease() }
    })
    const { fetch: f } = fakeFetch({ ...mk('a'), ...mk('b'), ...mk('c') })
    await Promise.all(['a', 'b', 'c'].map((r) => fetchRelease(base(f, { repo: r }))))
    const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
    expect(Object.keys(cache).sort()).toEqual(
      ['a', 'b', 'c'].map((r) => `https://api.github.com/repos/o/${r}/releases/latest`)
    )
  })

  it('keys authenticated entries separately and skips empty etags', async () => {
    const url = `${API}/releases/latest`
    const { fetch: f, calls } = fakeFetch({
      [url]: [
        { status: 200, body: rawRelease({ tag_name: 'private' }) },
        { status: 200, body: rawRelease({ tag_name: 'public' }) }
      ]
    })
    await fetchRelease(base(f, { token: 't0k' }))
    const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
    expect(Object.keys(cache)).toEqual([`${url}#auth`])
    const rel = await fetchRelease(base(f, { maxAgeMs: GH_RELEASE_MEMO_MS }))
    expect(rel.tag).toBe('public')
    expect(calls[1].headers['If-None-Match']).toBeUndefined()
  })

  it('handles 429 with retry-after and missing reset', async () => {
    const a = fakeFetch({
      [`${API}/releases/latest`]: { status: 429, headers: { 'retry-after': '60' } }
    })
    await expect(fetchRelease(base(a.fetch))).rejects.toThrow(
      "GitHub's rate limit was reached. Try again after"
    )
    const b = fakeFetch({
      [`${API}/releases/latest`]: { status: 403, headers: { 'x-ratelimit-remaining': '0' } }
    })
    await expect(fetchRelease(base(b.fetch))).rejects.toThrow(
      "GitHub's rate limit was reached. Try again later, or add a GitHub token in Settings."
    )
  })
})

describe('downloadAsset', () => {
  const bytes = new TextEncoder().encode('hello zip')
  const sha = createHash('sha256').update(bytes).digest('hex')
  const asset = (digest: string | null = null): GhReleaseAsset => ({
    id: 7,
    name: 'Mod.zip',
    size: bytes.length,
    downloadUrl: 'https://github.com/o/r/releases/download/v1/Mod.zip',
    apiUrl: 'https://api.github.com/repos/o/r/releases/assets/7',
    digest
  })

  it('downloads via the public url without a token', async () => {
    const a = asset(`sha256:${sha}`)
    const { fetch: f, calls } = fakeFetch({ [a.downloadUrl]: { status: 200, raw: bytes } })
    const out = await downloadAsset({ fetch: f, token: null, asset: a })
    expect(calls[0].headers).toEqual({ 'User-Agent': 'HML' })
    expect(out.sha256).toBe(sha)
    expect(Buffer.from(out.data).toString()).toBe('hello zip')
  })

  it('downloads via the api url with a token', async () => {
    const a = asset()
    const { fetch: f, calls } = fakeFetch({ [a.apiUrl]: { status: 200, raw: bytes } })
    await downloadAsset({ fetch: f, token: 't0k', asset: a })
    expect(calls[0].headers).toEqual({
      Accept: 'application/octet-stream',
      'User-Agent': 'HML',
      Authorization: 'Bearer t0k'
    })
  })

  it('never sends the token to a non-api host', async () => {
    const a = { ...asset(), apiUrl: 'https://evil.example/asset' }
    const { fetch: f, calls } = fakeFetch({ [a.downloadUrl]: { status: 200, raw: bytes } })
    await downloadAsset({ fetch: f, token: 't0k', asset: a })
    expect(calls[0].url).toBe(a.downloadUrl)
    expect(calls[0].headers.Authorization).toBeUndefined()
  })

  it('rejects on digest mismatch and http errors', async () => {
    const a = asset('sha256:deadbeef')
    const ok = fakeFetch({ [a.downloadUrl]: { status: 200, raw: bytes } })
    await expect(downloadAsset({ fetch: ok.fetch, token: null, asset: a })).rejects.toThrow(
      "Download of Mod.zip failed: it doesn't match the checksum GitHub published for it"
    )
    const nf = fakeFetch({ [a.downloadUrl]: { status: 404 } })
    await expect(downloadAsset({ fetch: nf.fetch, token: null, asset: a })).rejects.toThrow(
      'Download of Mod.zip failed: HTTP 404'
    )
    const down = (async () => {
      throw new Error('boom')
    }) as unknown as typeof fetch
    await expect(downloadAsset({ fetch: down, token: null, asset: a })).rejects.toThrow(
      'Download of Mod.zip failed: boom'
    )
  })
})

describe('downloadAsset size cap', () => {
  const base: GhReleaseAsset = {
    id: 7,
    name: 'Big.zip',
    size: 10,
    downloadUrl: 'https://github.com/o/r/releases/download/v1/Big.zip',
    apiUrl: 'https://api.github.com/repos/o/r/releases/assets/7',
    digest: null
  }
  const LIMIT = "over HML's 512 MB limit"

  it('exports a 512 MiB cap', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(512 * 1024 * 1024)
  })
  it('refuses an asset whose reported size is over the cap without fetching', async () => {
    const { fetch: f, calls } = fakeFetch({})
    const a = { ...base, size: MAX_DOWNLOAD_BYTES + 1 }
    await expect(downloadAsset({ fetch: f, token: null, asset: a })).rejects.toThrow(
      `Download of Big.zip failed: it is 513 MB, ${LIMIT}`
    )
    expect(calls).toEqual([])
  })
  it('accepts an asset exactly at the cap size', async () => {
    const bytes = new TextEncoder().encode('ok')
    const { fetch: f } = fakeFetch({ [base.downloadUrl]: { status: 200, raw: bytes } })
    const a = { ...base, size: MAX_DOWNLOAD_BYTES }
    await expect(downloadAsset({ fetch: f, token: null, asset: a })).resolves.toMatchObject({
      data: bytes
    })
  })
  it('refuses a response whose Content-Length is over the cap', async () => {
    const { fetch: f } = fakeFetch({
      [base.downloadUrl]: {
        status: 200,
        headers: { 'content-length': String(MAX_DOWNLOAD_BYTES * 2) },
        raw: new Uint8Array(1)
      }
    })
    await expect(downloadAsset({ fetch: f, token: null, asset: base })).rejects.toThrow(
      `Download of Big.zip failed: it is 1024 MB, ${LIMIT}`
    )
  })
  it('passes a timeout signal and reports a timeout clearly', async () => {
    let signal: AbortSignal | undefined
    const slow = (async (_url: string, init?: { signal?: AbortSignal }) => {
      signal = init?.signal
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }) as unknown as typeof fetch
    await expect(downloadAsset({ fetch: slow, token: null, asset: base })).rejects.toThrow(
      'Download of Big.zip failed: it took too long'
    )
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})

describe('fetchLogin', () => {
  it('returns the login', async () => {
    const { fetch: f, calls } = fakeFetch({
      'https://api.github.com/user': { status: 200, body: { login: 'octo' } }
    })
    expect(await fetchLogin({ fetch: f, token: 't' })).toBe('octo')
    expect(calls[0].headers.Authorization).toBe('Bearer t')
  })
  it('maps 401', async () => {
    const { fetch: f } = fakeFetch({ 'https://api.github.com/user': { status: 401 } })
    await expect(fetchLogin({ fetch: f, token: 't' })).rejects.toThrow(
      "GitHub didn't accept that token."
    )
  })
})

describe('isNewerTag', () => {
  it('compares version-like tags numerically, others by difference', () => {
    expect(isNewerTag('v1.10.0', 'v1.9.0')).toBe(true)
    expect(isNewerTag('1.0', 'v1.0.0')).toBe(false)
    expect(isNewerTag('v1.0', 'v2.0')).toBe(false)
    expect(isNewerTag('nightly-b', 'nightly-a')).toBe(true)
    expect(isNewerTag('same', 'same')).toBe(false)
  })
})

describe('fetchRelease with a track', () => {
  const list = [
    rawRelease({ tag_name: 'v6.0.0-pre.2', prerelease: true }),
    rawRelease({ tag_name: 'v5.4.23.5' }),
    rawRelease({ tag_name: 'v5.4.23.4' })
  ]
  const routes = (releases: unknown[] = list): Record<string, Reply> => ({
    [`${API}/releases?per_page=30`]: { status: 200, body: releases }
  })

  it('a 5.x stable track picks the newest 5.x release', async () => {
    const { fetch: f } = fakeFetch(routes())
    const rel = await fetchRelease(base(f, { track: { major: 5, prerelease: false } }))
    expect(rel.tag).toBe('v5.4.23.5')
  })

  it('a 6.x pre-release track picks the newest 6.x release', async () => {
    const { fetch: f } = fakeFetch(routes())
    const rel = await fetchRelease(base(f, { track: { major: 6, prerelease: true } }))
    expect(rel.tag).toBe('v6.0.0-pre.2')
  })

  it('a 6.x stable-only track with only pre-releases throws', async () => {
    const { fetch: f } = fakeFetch(routes())
    await expect(
      fetchRelease(base(f, { track: { major: 6, prerelease: false }, owner: 'o', repo: 'r' }))
    ).rejects.toThrow('o/r has no 6.x release.')
  })
})

describe('isNewerRelease', () => {
  type Rel = { tag: string; prerelease: boolean; publishedAt: string }
  const rel = (tag: string, prerelease = false, publishedAt = '2026-01-01T00:00:00Z'): Rel => ({
    tag,
    prerelease,
    publishedAt
  })

  it('keeps isNewerTag for stable releases', () => {
    expect(isNewerRelease(rel('v1.10.0'), { tag: 'v1.9.0' })).toBe(true)
    expect(isNewerRelease(rel('v1.0'), { tag: 'v2.0' })).toBe(false)
    expect(isNewerRelease(rel('nightly-b'), { tag: 'nightly-a' })).toBe(true)
    expect(isNewerRelease(rel('same'), { tag: 'same' })).toBe(false)
  })

  it('orders semver pre-release tags', () => {
    expect(isNewerRelease(rel('v2.0.0-beta.1', true), { tag: 'v1.9.0' })).toBe(true)
    expect(
      isNewerRelease(rel('v2.0.0-beta.2', true), { tag: 'v2.0.0-beta.1', prerelease: true })
    ).toBe(true)
    expect(
      isNewerRelease(rel('v2.0.0-beta.10', true), { tag: 'v2.0.0-beta.9', prerelease: true })
    ).toBe(true)
    expect(
      isNewerRelease(rel('v2.0.0-rc.1', true), { tag: 'v2.0.0-beta.9', prerelease: true })
    ).toBe(true)
    expect(isNewerRelease(rel('v2.0.0'), { tag: 'v2.0.0-rc.1', prerelease: true })).toBe(true)
    expect(isNewerRelease(rel('v2.0.0-rc.1', true), { tag: 'v2.0.0' })).toBe(false)
  })

  it('ignores +build metadata and never offers a lower version when both tags parse', () => {
    expect(isNewerRelease(rel('v1.0.0+build.5'), { tag: 'v1.0.0+build.4' })).toBe(false)
    expect(isNewerRelease(rel('v1.0.1+b1'), { tag: 'v1.0.0+b9' })).toBe(true)
    expect(isNewerRelease(rel('v2.0.0-rc.1+b2', true), { tag: 'v2.0.0-rc.1+b1' })).toBe(false)
    // An old install of a pre-release has no flag or date; its tag shape still orders it.
    expect(isNewerRelease(rel('v1.9.0'), { tag: 'v2.0.0-beta.1' })).toBe(false)
    expect(isNewerRelease(rel('v2.0.0'), { tag: 'v2.0.0-beta.1' })).toBe(true)
  })

  it('never offers an older stable over an installed pre-release', () => {
    expect(isNewerRelease(rel('v1.9.0'), { tag: 'v2.0.0-beta.1', prerelease: true })).toBe(false)
    expect(isNewerRelease(rel('v1.9.1'), { tag: 'v2.0.0-beta.1', prerelease: true })).toBe(false)
    expect(isNewerRelease(rel('v2.0.1'), { tag: 'v2.0.0-beta.1', prerelease: true })).toBe(true)
  })

  it('compares publish dates when an installed pre-release tag is not a version', () => {
    const installed = { tag: 'beta-7', prerelease: true, publishedAt: '2026-03-01T00:00:00Z' }
    expect(isNewerRelease(rel('release-6', false, '2026-02-01T00:00:00Z'), installed)).toBe(false)
    expect(isNewerRelease(rel('release-7', false, '2026-04-01T00:00:00Z'), installed)).toBe(true)
    // Without a recorded date, a different tag still counts as newer (today's behavior).
    expect(isNewerRelease(rel('release-6'), { tag: 'beta-7', prerelease: true })).toBe(true)
  })
})
