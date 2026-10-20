import { describe, expect, it, vi } from 'vitest'
import {
  SyncGoneError,
  createSync,
  endSync,
  fetchSync,
  publishSync
} from '../../../src/main/sync/client'
import { formatSyncCode } from '../../../src/shared/shareCode'

const base = 'https://share.test'
const UNAVAILABLE = 'Syncing is unavailable right now.'
const CODE = 'ABCDEFGHJKMN'

const reply = (body: BodyInit | null, status = 200, headers?: HeadersInit): typeof fetch =>
  vi.fn(async () => new Response(body, { status, headers })) as unknown as typeof fetch

/** The Worker's own sync-route 404: its JSON error body with `cache-control: no-store`. */
const syncNotFound = (): typeof fetch =>
  reply(JSON.stringify({ error: 'not-found' }), 404, {
    'content-type': 'application/json',
    'cache-control': 'no-store'
  })

const lastCall = (f: typeof fetch): [string, RequestInit] =>
  (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]

describe('formatSyncCode', () => {
  it('splits into three groups of four', () => {
    expect(formatSyncCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN')
  })
})

describe('createSync', () => {
  it('posts the zip and returns code, key, revision', async () => {
    const f = reply(JSON.stringify({ code: CODE, ownerKey: 'k', revision: 1 }), 201)
    const data = new Uint8Array([1, 2, 3])
    expect(await createSync({ fetch: f, base }, data)).toEqual({
      code: CODE,
      ownerKey: 'k',
      revision: 1
    })
    const [url, init] = lastCall(f)
    expect(url).toBe(`${base}/v1/sync`)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(data)
  })
})

describe('publishSync', () => {
  it('sends the bearer key', async () => {
    const f = reply(JSON.stringify({ revision: 4 }))
    expect(await publishSync({ fetch: f, base }, CODE, 'secret', new Uint8Array([1]))).toEqual({
      revision: 4
    })
    const [url, init] = lastCall(f)
    expect(url).toBe(`${base}/v1/sync/${CODE}`)
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret')
  })

  it("401 throws the can't-publish message", async () => {
    await expect(
      publishSync({ fetch: reply(null, 401), base }, CODE, 'k', new Uint8Array())
    ).rejects.toThrow("This PC can't publish to that sync code.")
  })

  it('429 throws the rate-limit message', async () => {
    await expect(
      publishSync({ fetch: reply(null, 429), base }, CODE, 'k', new Uint8Array())
    ).rejects.toThrow('Too many sync requests. Try again in a minute.')
  })

  it('throws SyncGoneError on 410', async () => {
    const err = await publishSync(
      { fetch: reply(null, 410), base },
      CODE,
      'k',
      new Uint8Array()
    ).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(SyncGoneError)
    expect((err as SyncGoneError).reason).toBe('ended')
    expect((err as SyncGoneError).message).toBe('This sync code has ended.')
  })

  it("throws SyncGoneError on the Worker's sync-route 404", async () => {
    const err = await publishSync(
      { fetch: syncNotFound(), base },
      CODE,
      'k',
      new Uint8Array()
    ).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(SyncGoneError)
    expect((err as SyncGoneError).reason).toBe('missing')
  })

  it('any other 404 is unavailable, not gone', async () => {
    for (const f of [
      reply(null, 404),
      reply('<html>Not Found</html>', 404, { 'content-type': 'text/html' }),
      // An older Worker without sync routes answers with the same JSON but no no-store.
      reply(JSON.stringify({ error: 'not-found' }), 404, { 'content-type': 'application/json' })
    ]) {
      const err = await publishSync({ fetch: f, base }, CODE, 'k', new Uint8Array()).then(
        () => null,
        (e: unknown) => e
      )
      expect(err).not.toBeInstanceOf(SyncGoneError)
      expect((err as Error).message).toBe(UNAVAILABLE)
    }
  })

  it('a network error throws the unavailable message', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(publishSync({ fetch: f, base }, CODE, 'k', new Uint8Array())).rejects.toThrow(
      UNAVAILABLE
    )
  })
})

describe('fetchSync', () => {
  it('maps 304 to unchanged with the header revision', async () => {
    const f = reply(null, 304, { 'x-hml-revision': '7' })
    expect(await fetchSync({ fetch: f, base }, CODE, 7)).toEqual({ kind: 'unchanged', revision: 7 })
  })

  it('maps 200 to updated with the body and revision', async () => {
    const f = reply(new Uint8Array([9, 8, 7]), 200, { 'x-hml-revision': '8' })
    const out = await fetchSync({ fetch: f, base }, CODE, 7)
    expect(out).toEqual({ kind: 'updated', revision: 8, data: new Uint8Array([9, 8, 7]) })
  })

  it('maps 410 to ended', async () => {
    expect(await fetchSync({ fetch: reply(null, 410), base }, CODE, 1)).toEqual({ kind: 'ended' })
  })

  it("maps the Worker's sync-route 404 to missing", async () => {
    expect(await fetchSync({ fetch: syncNotFound(), base }, CODE, 1)).toEqual({
      kind: 'missing'
    })
  })

  it('any other 404 throws the unavailable message', async () => {
    await expect(fetchSync({ fetch: reply(null, 404), base }, CODE, 1)).rejects.toThrow(UNAVAILABLE)
    await expect(
      fetchSync({ fetch: reply('Not Found', 404, { 'content-type': 'text/plain' }), base }, CODE, 1)
    ).rejects.toThrow(UNAVAILABLE)
    await expect(
      fetchSync(
        {
          fetch: reply(JSON.stringify({ error: 'not-found' }), 404, {
            'content-type': 'application/json'
          }),
          base
        },
        CODE,
        1
      )
    ).rejects.toThrow(UNAVAILABLE)
  })

  it('passes since in the query', async () => {
    const f = reply(null, 304, { 'x-hml-revision': '3' })
    await fetchSync({ fetch: f, base }, CODE, 3)
    expect(lastCall(f)[0]).toBe(`${base}/v1/sync/${CODE}?since=3`)
  })

  it('other statuses throw the unavailable message', async () => {
    await expect(fetchSync({ fetch: reply(null, 500), base }, CODE, 1)).rejects.toThrow(UNAVAILABLE)
  })
})

describe('endSync', () => {
  it('sends DELETE with the bearer key', async () => {
    const f = reply(null, 204)
    await endSync({ fetch: f, base }, CODE, 'secret')
    const [url, init] = lastCall(f)
    expect(url).toBe(`${base}/v1/sync/${CODE}`)
    expect(init.method).toBe('DELETE')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret')
  })

  it("resolves on the Worker's sync-route 404 and on 410", async () => {
    await expect(endSync({ fetch: syncNotFound(), base }, CODE, 'k')).resolves.toBeUndefined()
    await expect(endSync({ fetch: reply(null, 410), base }, CODE, 'k')).resolves.toBeUndefined()
  })

  it('throws on any other 404', async () => {
    await expect(endSync({ fetch: reply(null, 404), base }, CODE, 'k')).rejects.toThrow(UNAVAILABLE)
  })

  it('throws on 401', async () => {
    await expect(endSync({ fetch: reply(null, 401), base }, CODE, 'k')).rejects.toThrow(
      "This PC can't publish to that sync code."
    )
  })
})
