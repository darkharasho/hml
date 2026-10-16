import { newCode, normalizeCode } from './code'

export interface KvLike {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    opts?: { expirationTtl?: number }
  ): Promise<void>
}

export interface Env {
  PROFILES: KvLike
  UPLOAD_LIMITER: { limit(o: { key: string }): Promise<{ success: boolean }> }
}

export const MAX_BYTES = 10485760
export const TTL_SECONDS = 31536000

const MAX_ATTEMPTS = 3
const PREFIX = '/v1/profiles'

function err(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** Reads the body, aborting with null as soon as it exceeds MAX_BYTES. */
async function readCapped(req: Request): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
}

async function upload(req: Request, env: Env, rand?: (n: number) => Uint8Array): Promise<Response> {
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown'
  const { success } = await env.UPLOAD_LIMITER.limit({ key: ip })
  if (!success) return err(429, 'rate-limited')

  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BYTES) return err(413, 'too-large')

  const body = await readCapped(req)
  if (!body) return err(413, 'too-large')
  if (!isZip(body)) return err(400, 'not-a-zip')

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

async function download(raw: string, env: Env): Promise<Response> {
  const code = normalizeCode(decodeURIComponent(raw))
  if (!code) return err(400, 'bad-code')
  const bytes = await env.PROFILES.get(`p:${code}`, 'arrayBuffer')
  if (!bytes) return err(404, 'not-found')
  return new Response(bytes, {
    headers: {
      'content-type': 'application/zip',
      'cache-control': 'public, max-age=3600'
    }
  })
}

export function createHandler(rand?: (n: number) => Uint8Array): {
  fetch(req: Request, env: Env): Promise<Response>
} {
  return {
    async fetch(req: Request, env: Env): Promise<Response> {
      const path = new URL(req.url).pathname
      if (path === PREFIX) {
        return req.method === 'POST' ? upload(req, env, rand) : err(405, 'method-not-allowed')
      }
      if (path.startsWith(`${PREFIX}/`)) {
        const raw = path.slice(PREFIX.length + 1)
        if (raw.includes('/')) return err(404, 'not-found')
        return req.method === 'GET' ? download(raw, env) : err(405, 'method-not-allowed')
      }
      return err(404, 'not-found')
    }
  }
}

export default createHandler()
