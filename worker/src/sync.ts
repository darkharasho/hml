import { newSyncCode, normalizeSyncCode } from './code'
import { err, isZip, MAX_BYTES, readCapped, startsWithExport, TTL_SECONDS } from './http'
import type { Env } from './index'

export interface CacheLike {
  match(req: Request): Promise<Response | undefined>
  put(req: Request, res: Response): Promise<void>
  delete(req: Request): Promise<boolean>
}

interface Meta {
  revision: number
  keyHash: string
  ended?: true
}

const MAX_ATTEMPTS = 3
const META_MAX_AGE = 60
const NO_STORE = { 'cache-control': 'no-store' }

const fail = (status: number, error: string): Response => err(status, error, NO_STORE)

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...NO_STORE }
  })
}

const metaReq = (code: string): Request => new Request(`https://sync-meta.hml/${code}`)

function toBase64Url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('')
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
  return m ? m[1].trim() : null
}

async function limited(limiter: Env['SYNC_CHECK_LIMITER'], req: Request): Promise<boolean> {
  const { success } = await limiter.limit({ key: req.headers.get('CF-Connecting-IP') ?? 'unknown' })
  return !success
}

/** Reads and validates an .hml body; returns the bytes or an error response. */
async function readHml(req: Request): Promise<Uint8Array | Response> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BYTES) return fail(413, 'too-large')
  const body = await readCapped(req)
  if (!body) return fail(413, 'too-large')
  if (!isZip(body)) return fail(400, 'not-a-zip')
  if (!startsWithExport(body)) return fail(400, 'not-an-hml')
  return body
}

async function create(req: Request, env: Env, rand?: (n: number) => Uint8Array): Promise<Response> {
  if (await limited(env.SYNC_PUBLISH_LIMITER, req)) return fail(429, 'rate-limited')
  const body = await readHml(req)
  if (body instanceof Response) return body
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const code = newSyncCode(rand)
    if ((await env.PROFILES.get(`s:${code}`, 'arrayBuffer')) !== null) continue
    const ownerKey = toBase64Url(randomBytes(32))
    const meta: Meta = { revision: 1, keyHash: await sha256Hex(ownerKey) }
    await env.PROFILES.put(`s:${code}`, body, { expirationTtl: TTL_SECONDS, metadata: meta })
    return json(201, { code, ownerKey, revision: 1 })
  }
  return fail(500, 'code-collision')
}

/** Checks the bearer key against the stored meta; returns the meta or an error response. */
async function authorize(req: Request, env: Env, code: string): Promise<Meta | Response> {
  const { metadata } = await env.PROFILES.getWithMetadata<Meta>(`s:${code}`, 'arrayBuffer')
  if (!metadata) return fail(404, 'not-found')
  if (metadata.ended) return fail(410, 'ended')
  const key = bearer(req)
  if (!key || (await sha256Hex(key)) !== metadata.keyHash) return fail(401, 'bad-key')
  return metadata
}

async function update(req: Request, env: Env, cache: CacheLike, code: string): Promise<Response> {
  if (await limited(env.SYNC_PUBLISH_LIMITER, req)) return fail(429, 'rate-limited')
  const auth = await authorize(req, env, code)
  if (auth instanceof Response) return auth
  const body = await readHml(req)
  if (body instanceof Response) return body
  const meta: Meta = { revision: auth.revision + 1, keyHash: auth.keyHash }
  await env.PROFILES.put(`s:${code}`, body, { expirationTtl: TTL_SECONDS, metadata: meta })
  await cache.delete(metaReq(code))
  return json(200, { revision: meta.revision })
}

async function end(req: Request, env: Env, cache: CacheLike, code: string): Promise<Response> {
  if (await limited(env.SYNC_PUBLISH_LIMITER, req)) return fail(429, 'rate-limited')
  const auth = await authorize(req, env, code)
  if (auth instanceof Response) return auth
  const meta: Meta = { revision: auth.revision, keyHash: auth.keyHash, ended: true }
  await env.PROFILES.put(`s:${code}`, new Uint8Array(0), {
    expirationTtl: TTL_SECONDS,
    metadata: meta
  })
  await cache.delete(metaReq(code))
  return new Response(null, { status: 204, headers: NO_STORE })
}

const notModified = (revision: number): Response =>
  new Response(null, { status: 304, headers: { ...NO_STORE, 'x-hml-revision': String(revision) } })

async function check(req: Request, env: Env, cache: CacheLike, code: string): Promise<Response> {
  if (await limited(env.SYNC_CHECK_LIMITER, req)) return fail(429, 'rate-limited')
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0)

  const hit = await cache.match(metaReq(code))
  if (hit) {
    const cached = (await hit.json()) as Meta
    if (cached.ended) return fail(410, 'ended')
    if (cached.revision <= since) return notModified(cached.revision)
  }

  const { value, metadata } = await env.PROFILES.getWithMetadata<Meta>(`s:${code}`, 'arrayBuffer')
  if (!metadata || !value) return fail(404, 'not-found')
  await cache.put(
    metaReq(code),
    new Response(JSON.stringify({ revision: metadata.revision, ended: metadata.ended }), {
      headers: { 'cache-control': `public, max-age=${META_MAX_AGE}` }
    })
  )
  if (metadata.ended) return fail(410, 'ended')
  if (metadata.revision <= since) return notModified(metadata.revision)
  return new Response(value, {
    headers: {
      'content-type': 'application/zip',
      'x-hml-revision': String(metadata.revision),
      ...NO_STORE
    }
  })
}

export async function handleSync(
  req: Request,
  env: Env,
  cache: CacheLike,
  rand: ((n: number) => Uint8Array) | undefined,
  raw: string
): Promise<Response> {
  if (raw === '')
    return req.method === 'POST' ? create(req, env, rand) : fail(405, 'method-not-allowed')

  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return fail(400, 'bad-code')
  }
  const code = normalizeSyncCode(decoded)
  if (!code) return fail(400, 'bad-code')
  switch (req.method) {
    case 'GET':
      return check(req, env, cache, code)
    case 'PUT':
      return update(req, env, cache, code)
    case 'DELETE':
      return end(req, env, cache, code)
    default:
      return fail(405, 'method-not-allowed')
  }
}
