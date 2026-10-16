import { describe, expect, it } from 'vitest'
import { CROCKFORD, newCode, normalizeCode } from '../../worker/src/code'
import worker, { createHandler, MAX_BYTES, TTL_SECONDS, type Env } from '../../worker/src/index'

function makeEnv(success = true): {
  env: Env
  store: Map<string, Uint8Array>
  ttls: Map<string, number | undefined>
  limitKeys: string[]
} {
  const store = new Map<string, Uint8Array>()
  const ttls = new Map<string, number | undefined>()
  const limitKeys: string[] = []
  const env: Env = {
    PROFILES: {
      async get(key) {
        const v = store.get(key)
        return v ? (v.slice().buffer as ArrayBuffer) : null
      },
      async put(key, value, opts) {
        store.set(key, new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)))
        ttls.set(key, opts?.expirationTtl)
      }
    },
    UPLOAD_LIMITER: {
      async limit({ key }) {
        limitKeys.push(key)
        return { success }
      }
    }
  }
  return { env, store, ttls, limitKeys }
}

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])
const URL_ = 'https://x.test/v1/profiles'
const post = (body: BodyInit, headers: Record<string, string> = {}): Request =>
  new Request(URL_, { method: 'POST', body, headers })

describe('codes', () => {
  it('newCode gives 10 Crockford chars', () => {
    const c = newCode()
    expect(c).toHaveLength(10)
    for (const ch of c) expect(CROCKFORD).toContain(ch)
  })
  it('normalizes', () => {
    expect(normalizeCode(' abcde-fghjk ')).toBe('ABCDEFGHJK')
    expect(normalizeCode('oil00-00000')).toBe('0110000000')
    expect(normalizeCode('ABCDE')).toBeNull()
    expect(normalizeCode('ABCDEFGHJU')).toBeNull()
  })
})

describe('POST /v1/profiles', () => {
  it('stores a zip and returns a code', async () => {
    const { env, store, ttls } = makeEnv()
    const res = await worker.fetch(post(ZIP), env)
    expect(res.status).toBe(201)
    const { code } = (await res.json()) as { code: string }
    expect(normalizeCode(code)).toBe(code)
    expect(Array.from(store.get(`p:${code}`)!)).toEqual(Array.from(ZIP))
    expect(ttls.get(`p:${code}`)).toBe(TTL_SECONDS)
    expect(TTL_SECONDS).toBe(31536000)
  })
  it('rejects non-zip', async () => {
    const res = await worker.fetch(post(new Uint8Array([1, 2, 3, 4, 5])), makeEnv().env)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'not-a-zip' })
  })
  it('413 on declared content-length without reading the body', async () => {
    let pulled = false
    const body = new ReadableStream(
      {
        pull() {
          pulled = true
        }
      },
      { highWaterMark: 0 }
    )
    const req = new Request(URL_, {
      method: 'POST',
      body,
      headers: { 'content-length': String(MAX_BYTES + 1) },
      duplex: 'half'
    } as RequestInit)
    const res = await worker.fetch(req, makeEnv().env)
    expect(res.status).toBe(413)
    expect(pulled).toBe(false)
  })
  it('413 on chunked body over the cap', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let n = 0
    const body = new ReadableStream({
      pull(c) {
        if (n++ < 11) c.enqueue(chunk)
        else c.close()
      }
    })
    const req = new Request(URL_, { method: 'POST', body, duplex: 'half' } as RequestInit)
    const res = await worker.fetch(req, makeEnv().env)
    expect(res.status).toBe(413)
  })
  it('429 when limited, keyed by CF-Connecting-IP', async () => {
    const { env, limitKeys, store } = makeEnv(false)
    const res = await worker.fetch(post(ZIP, { 'CF-Connecting-IP': '1.2.3.4' }), env)
    expect(res.status).toBe(429)
    expect(limitKeys).toEqual(['1.2.3.4'])
    expect(store.size).toBe(0)
  })
  it('500 after three forced collisions', async () => {
    const { env, store } = makeEnv()
    const fixed = (n: number): Uint8Array => new Uint8Array(n)
    store.set(`p:${newCode(fixed)}`, ZIP)
    const res = await createHandler(fixed).fetch(post(ZIP), env)
    expect(res.status).toBe(500)
  })
})

describe('GET /v1/profiles/:code', () => {
  it('returns bytes with content type and cache header; accepts lowercase/dashed', async () => {
    const { env, store } = makeEnv()
    store.set('p:ABCDEFGHJK', ZIP)
    for (const c of ['ABCDEFGHJK', 'abcde-fghjk']) {
      const res = await worker.fetch(new Request(`${URL_}/${c}`), env)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/zip')
      expect(res.headers.get('cache-control')).toContain('max-age')
      expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(ZIP))
    }
  })
  it('404 unknown, 400 bad code', async () => {
    const { env } = makeEnv()
    const a = await worker.fetch(new Request(`${URL_}/ABCDEFGHJK`), env)
    expect(a.status).toBe(404)
    expect(await a.json()).toEqual({ error: 'not-found' })
    const b = await worker.fetch(new Request(`${URL_}/short`), env)
    expect(b.status).toBe(400)
    expect(await b.json()).toEqual({ error: 'bad-code' })
  })
})

describe('routing', () => {
  it('405 and 404', async () => {
    const { env } = makeEnv()
    expect((await worker.fetch(new Request(URL_, { method: 'PUT', body: 'x' }), env)).status).toBe(
      405
    )
    expect((await worker.fetch(new Request('https://x.test/other'), env)).status).toBe(404)
  })
})
