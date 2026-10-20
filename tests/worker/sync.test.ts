import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { CROCKFORD, newSyncCode, normalizeCode, normalizeSyncCode } from '../../worker/src/code'
import { createHandler, TTL_SECONDS, type CacheLike, type Env } from '../../worker/src/index'

interface Entry {
  value: Uint8Array
  metadata: { revision: number; keyHash: string; ended?: true } | null
  ttl: number | undefined
}

function makeEnv(limiterOk = true): {
  env: Env
  store: Map<string, Entry>
  cache: CacheLike
  kvReads: { count: number }
  streamRead: { value: boolean }
} {
  const store = new Map<string, Entry>()
  const kvReads = { count: 0 }
  const streamRead = { value: false }
  const limiter = {
    async limit() {
      return { success: limiterOk }
    }
  }
  const env: Env = {
    PROFILES: {
      async get(key) {
        const v = store.get(key)
        return v ? (v.value.slice().buffer as ArrayBuffer) : null
      },
      async getWithMetadata(key: string, type: 'arrayBuffer' | 'stream') {
        kvReads.count++
        const v = store.get(key)
        if (!v) return { value: null, metadata: null }
        const bytes = v.value.slice()
        const value =
          type === 'stream'
            ? new ReadableStream(
                {
                  pull(c) {
                    streamRead.value = true
                    c.enqueue(bytes)
                    c.close()
                  }
                },
                { highWaterMark: 0 }
              )
            : (bytes.buffer as ArrayBuffer)
        return { value, metadata: v.metadata } as never
      },
      async put(key, value, opts) {
        store.set(key, {
          value: new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)),
          metadata: (opts?.metadata ?? null) as Entry['metadata'],
          ttl: opts?.expirationTtl
        })
      }
    },
    UPLOAD_LIMITER: limiter,
    DOWNLOAD_LIMITER: limiter,
    SYNC_CHECK_LIMITER: limiter,
    SYNC_PUBLISH_LIMITER: limiter
  }
  const map = new Map<string, Response>()
  const cache: CacheLike = {
    async match(req) {
      return map.get(req.url)?.clone()
    },
    async put(req, res) {
      map.set(req.url, res.clone())
    },
    async delete(req) {
      return map.delete(req.url)
    }
  }
  return { env, store, cache, kvReads, streamRead }
}

const ZIP = zipSync({ 'export.json': strToU8('{}'), 'a.cfg': strToU8('x') })
const ZIP2 = zipSync({ 'export.json': strToU8('{"v":2}'), 'a.cfg': strToU8('y') })
const BASE = 'https://x.test/v1/sync'
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

async function publish(
  h: ReturnType<typeof createHandler>,
  env: Env
): Promise<{ code: string; ownerKey: string }> {
  const res = await h.fetch(new Request(BASE, { method: 'POST', body: ZIP }), env)
  return (await res.json()) as { code: string; ownerKey: string }
}
const put = (code: string, key: string, body: BodyInit = ZIP2): Request =>
  new Request(`${BASE}/${code}`, {
    method: 'PUT',
    body,
    headers: { authorization: `Bearer ${key}` }
  })
const get = (code: string, since = 0): Request => new Request(`${BASE}/${code}?since=${since}`)

describe('sync codes', () => {
  it('newSyncCode gives 12 Crockford chars', () => {
    const c = newSyncCode()
    expect(c).toHaveLength(12)
    for (const ch of c) expect(CROCKFORD).toContain(ch)
  })
  it('normalizes', () => {
    expect(normalizeSyncCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN')
    expect(normalizeSyncCode('ABCDE-FGHJK')).toBeNull()
    expect(normalizeCode('ABCDEFGHJKMN')).toBeNull()
  })
})

describe('/v1/sync', () => {
  it('POST creates revision 1', async () => {
    const { env, store, cache } = makeEnv()
    const res = await createHandler(undefined, cache).fetch(
      new Request(BASE, { method: 'POST', body: ZIP }),
      env
    )
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const { code, ownerKey, revision } = (await res.json()) as {
      code: string
      ownerKey: string
      revision: number
    }
    expect(revision).toBe(1)
    expect(normalizeSyncCode(code)).toBe(code)
    const e = store.get(`s:${code}`)!
    expect(e.metadata!.revision).toBe(1)
    expect(e.metadata!.keyHash).toBe(sha(ownerKey))
    expect(e.ttl).toBe(TTL_SECONDS)
  })

  it('PUT with the right key bumps the revision', async () => {
    const { env, store, cache } = makeEnv()
    const h = createHandler(undefined, cache)
    const { code, ownerKey } = await publish(h, env)
    const res = await h.fetch(put(code, ownerKey), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revision: 2 })
    expect(Array.from(store.get(`s:${code}`)!.value)).toEqual(Array.from(ZIP2))
    expect(store.get(`s:${code}`)!.metadata!.revision).toBe(2)
  })

  it('PUT with a wrong key is 401 and changes nothing', async () => {
    const { env, store, cache } = makeEnv()
    const h = createHandler(undefined, cache)
    const { code } = await publish(h, env)
    const res = await h.fetch(put(code, 'nope'), env)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'bad-key' })
    expect(store.get(`s:${code}`)!.metadata!.revision).toBe(1)
    expect(Array.from(store.get(`s:${code}`)!.value)).toEqual(Array.from(ZIP))
  })

  it('GET since=current is 304, since=0 is 200 with the zip', async () => {
    const { env, cache } = makeEnv()
    const h = createHandler(undefined, cache)
    const { code } = await publish(h, env)
    const a = await h.fetch(get(code, 1), env)
    expect(a.status).toBe(304)
    expect(a.headers.get('x-hml-revision')).toBe('1')
    expect(a.headers.get('cache-control')).toBe('no-store')
    const b = await h.fetch(get(code, 0), env)
    expect(b.status).toBe(200)
    expect(b.headers.get('x-hml-revision')).toBe('1')
    expect(b.headers.get('content-type')).toBe('application/zip')
    expect(Array.from(new Uint8Array(await b.arrayBuffer()))).toEqual(Array.from(ZIP))
  })

  it('GET with cached meta answers 304 without reading KV', async () => {
    const { env, cache, kvReads } = makeEnv()
    const h = createHandler(undefined, cache)
    const { code } = await publish(h, env)
    expect((await h.fetch(get(code, 1), env)).status).toBe(304)
    const after = kvReads.count
    expect((await h.fetch(get(code, 1), env)).status).toBe(304)
    expect(kvReads.count).toBe(after)
  })

  it('a cache-miss 304 never reads the body from KV', async () => {
    const { env, cache, streamRead } = makeEnv()
    const h = createHandler(undefined, cache)
    const { code } = await publish(h, env)
    expect((await h.fetch(get(code, 1), env)).status).toBe(304)
    expect(streamRead.value).toBe(false)
  })

  it('a warm-cache GET for an ended code is 410 without reading KV', async () => {
    const { env, cache, kvReads } = makeEnv()
    const h = createHandler(undefined, cache)
    const { code, ownerKey } = await publish(h, env)
    await h.fetch(
      new Request(`${BASE}/${code}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${ownerKey}` }
      }),
      env
    )
    expect((await h.fetch(get(code, 0), env)).status).toBe(410)
    const after = kvReads.count
    const res = await h.fetch(get(code, 0), env)
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ error: 'ended' })
    expect(kvReads.count).toBe(after)
  })

  it('a failing cache falls back to KV instead of 500', async () => {
    const { env } = makeEnv()
    const boom = async (): Promise<never> => {
      throw new Error('cache down')
    }
    const broken: CacheLike = { match: boom, put: boom, delete: async () => false }
    const h = createHandler(undefined, broken)
    const { code } = await publish(h, env)
    expect((await h.fetch(get(code, 1), env)).status).toBe(304)
    const res = await h.fetch(get(code, 0), env)
    expect(res.status).toBe(200)
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(ZIP))
  })

  it('PUT invalidates the cached meta', async () => {
    const { env, cache } = makeEnv()
    const h = createHandler(undefined, cache)
    const { code, ownerKey } = await publish(h, env)
    expect((await h.fetch(get(code, 1), env)).status).toBe(304)
    await h.fetch(put(code, ownerKey), env)
    const res = await h.fetch(get(code, 1), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-hml-revision')).toBe('2')
  })

  it('DELETE with the key ends it', async () => {
    const { env, store, cache } = makeEnv()
    const h = createHandler(undefined, cache)
    const { code, ownerKey } = await publish(h, env)
    expect((await h.fetch(get(code, 1), env)).status).toBe(304)
    const del = await h.fetch(
      new Request(`${BASE}/${code}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${ownerKey}` }
      }),
      env
    )
    expect(del.status).toBe(204)
    const e = store.get(`s:${code}`)!
    expect(e.value.length).toBe(0)
    expect(e.metadata!.ended).toBe(true)
    expect(e.ttl).toBe(TTL_SECONDS)
    const g = await h.fetch(get(code, 1), env)
    expect(g.status).toBe(410)
    expect(await g.json()).toEqual({ error: 'ended' })
    expect((await h.fetch(put(code, ownerKey), env)).status).toBe(410)
  })

  it('DELETE with a wrong key is 401', async () => {
    const { env, cache } = makeEnv()
    const h = createHandler(undefined, cache)
    const { code } = await publish(h, env)
    const del = await h.fetch(
      new Request(`${BASE}/${code}`, { method: 'DELETE', headers: { authorization: 'Bearer x' } }),
      env
    )
    expect(del.status).toBe(401)
    expect((await h.fetch(get(code, 1), env)).status).toBe(304)
  })

  it('rejects non-hml bodies on POST and PUT', async () => {
    const { env, cache } = makeEnv()
    const h = createHandler(undefined, cache)
    const bad = zipSync({ 'other.json': strToU8('{}') })
    const a = await h.fetch(new Request(BASE, { method: 'POST', body: bad }), env)
    expect(a.status).toBe(400)
    expect(await a.json()).toEqual({ error: 'not-an-hml' })
    const { code, ownerKey } = await publish(h, env)
    const b = await h.fetch(put(code, ownerKey, bad), env)
    expect(b.status).toBe(400)
    expect(await b.json()).toEqual({ error: 'not-an-hml' })
  })

  it('rate limits', async () => {
    const { env, store, cache } = makeEnv(false)
    const h = createHandler(undefined, cache)
    const a = await h.fetch(new Request(BASE, { method: 'POST', body: ZIP }), env)
    expect(a.status).toBe(429)
    expect(store.size).toBe(0)
    expect((await h.fetch(get('ABCDEFGHJKMN'), env)).status).toBe(429)
    expect((await h.fetch(put('ABCDEFGHJKMN', 'k'), env)).status).toBe(429)
  })

  it('unknown code is 404; a 10-char share code is 400 bad-code', async () => {
    const { env, cache } = makeEnv()
    const h = createHandler(undefined, cache)
    expect((await h.fetch(get('ABCDEFGHJKMN'), env)).status).toBe(404)
    const res = await h.fetch(get('ABCDEFGHJK'), env)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad-code' })
  })
})
