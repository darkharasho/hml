import { newCode, normalizeCode } from './code'
import { err, isZip, MAX_BYTES, readCapped, startsWithExport, TTL_SECONDS } from './http'
import { handleSync, type CacheLike } from './sync'

export { MAX_BYTES, TTL_SECONDS }
export type { CacheLike }

export interface KvLike {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    opts?: { expirationTtl?: number; metadata?: unknown }
  ): Promise<void>
  getWithMetadata<M>(
    key: string,
    type: 'arrayBuffer'
  ): Promise<{ value: ArrayBuffer | null; metadata: M | null }>
  getWithMetadata<M>(
    key: string,
    type: 'stream'
  ): Promise<{ value: ReadableStream | null; metadata: M | null }>
}

export interface Env {
  PROFILES: KvLike
  UPLOAD_LIMITER: { limit(o: { key: string }): Promise<{ success: boolean }> }
  DOWNLOAD_LIMITER: { limit(o: { key: string }): Promise<{ success: boolean }> }
  SYNC_CHECK_LIMITER: { limit(o: { key: string }): Promise<{ success: boolean }> }
  SYNC_PUBLISH_LIMITER: { limit(o: { key: string }): Promise<{ success: boolean }> }
}

const MAX_ATTEMPTS = 3
const PREFIX = '/v1/profiles'
const SYNC_PREFIX = '/v1/sync'

async function upload(req: Request, env: Env, rand?: (n: number) => Uint8Array): Promise<Response> {
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown'
  const { success } = await env.UPLOAD_LIMITER.limit({ key: ip })
  if (!success) return err(429, 'rate-limited')

  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BYTES) return err(413, 'too-large')

  const body = await readCapped(req)
  if (!body) return err(413, 'too-large')
  if (!isZip(body)) return err(400, 'not-a-zip')
  if (!startsWithExport(body)) return err(400, 'not-an-hml')

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const code = newCode(rand)
    if ((await env.PROFILES.get(`p:${code}`, 'arrayBuffer')) !== null) continue
    await env.PROFILES.put(`p:${code}`, body, { expirationTtl: TTL_SECONDS })
    return new Response(JSON.stringify({ code }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    })
  }
  return err(500, 'code-collision')
}

async function download(req: Request, raw: string, env: Env): Promise<Response> {
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown'
  const { success } = await env.DOWNLOAD_LIMITER.limit({ key: ip })
  if (!success) return err(429, 'rate-limited')

  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return err(400, 'bad-code')
  }
  const code = normalizeCode(decoded)
  if (!code) return err(400, 'bad-code')
  const bytes = await env.PROFILES.get(`p:${code}`, 'arrayBuffer')
  if (!bytes) return err(404, 'not-found')
  return new Response(bytes, {
    headers: {
      'content-type': 'application/zip',
      'cache-control': 'public, max-age=86400, immutable'
    }
  })
}

export function createHandler(
  rand?: (n: number) => Uint8Array,
  cache?: CacheLike
): {
  fetch(req: Request, env: Env): Promise<Response>
} {
  return {
    async fetch(req: Request, env: Env): Promise<Response> {
      const path = new URL(req.url).pathname
      if (path === SYNC_PREFIX || path.startsWith(`${SYNC_PREFIX}/`)) {
        const raw = path.slice(SYNC_PREFIX.length + 1)
        if (raw.includes('/')) return err(404, 'not-found')
        return handleSync(
          req,
          env,
          cache ?? (caches as unknown as { default: CacheLike }).default,
          rand,
          raw
        )
      }
      if (path === PREFIX) {
        return req.method === 'POST' ? upload(req, env, rand) : err(405, 'method-not-allowed')
      }
      if (path.startsWith(`${PREFIX}/`)) {
        const raw = path.slice(PREFIX.length + 1)
        if (raw.includes('/')) return err(404, 'not-found')
        return req.method === 'GET' ? download(req, raw, env) : err(405, 'method-not-allowed')
      }
      return err(404, 'not-found')
    }
  }
}

export default createHandler()
