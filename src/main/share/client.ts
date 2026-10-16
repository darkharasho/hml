import { MAX_HML_BYTES } from './hmlFile'
import { normalizeCode } from '../../shared/shareCode'

export interface ShareClientOptions {
  fetch: typeof fetch
  base: string
  /** Per-request timeout; defaults to 30 s. */
  timeoutMs?: number
}

const UNAVAILABLE = 'Share codes are unavailable right now. Export a file instead.'
const TIMEOUT_MS = 30_000

type StatusMessages = Record<number, string>

const UPLOAD_MESSAGES: StatusMessages = {
  400: "This profile file couldn't be shared.",
  404: UNAVAILABLE,
  413: 'This profile is too large to share (over 10 MB).',
  429: 'Too many share codes created. Try again in a minute.'
}

const DOWNLOAD_MESSAGES: StatusMessages = {
  404: 'No profile has that share code. It may have expired.',
  413: UNAVAILABLE,
  429: 'Too many downloads. Try again in a minute.'
}

const baseOf = (o: ShareClientOptions): string => o.base.replace(/\/+$/, '')

async function request<T>(
  o: ShareClientOptions,
  messages: StatusMessages,
  url: string,
  init: RequestInit,
  handle: (res: Response) => Promise<T>
): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? TIMEOUT_MS)
  try {
    const res = await o.fetch(url, { ...init, signal: ctl.signal })
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined)
      throw new Error(messages[res.status] ?? UNAVAILABLE)
    }
    return await handle(res)
  } catch (e) {
    if (e instanceof Error && Object.values(messages).includes(e.message)) throw e
    throw new Error(UNAVAILABLE, { cause: e })
  } finally {
    clearTimeout(timer)
  }
}

/** Uploads a .hml file and resolves its normalized share code. */
export async function uploadShare(o: ShareClientOptions, data: Uint8Array): Promise<string> {
  // 30 s plus 1 s per 50 KB, capped at 5 min; downloads keep the 30 s default.
  const timeoutMs = Math.min(300_000, 30_000 + Math.ceil(data.byteLength / 50_000) * 1000)
  return request(
    { ...o, timeoutMs: o.timeoutMs ?? timeoutMs },
    UPLOAD_MESSAGES,
    `${baseOf(o)}/v1/profiles`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'user-agent': 'HML' },
      body: data as BodyInit
    },
    async (res) => {
      const body = (await res.json()) as { code?: unknown }
      const code = typeof body.code === 'string' ? normalizeCode(body.code) : null
      if (!code) throw new Error(UNAVAILABLE)
      return code
    }
  )
}

export async function downloadShare(o: ShareClientOptions, input: string): Promise<Uint8Array> {
  const code = normalizeCode(input)
  if (!code) throw new Error("That isn't a valid share code.")
  return request(
    o,
    DOWNLOAD_MESSAGES,
    `${baseOf(o)}/v1/profiles/${code}`,
    { headers: { 'user-agent': 'HML' } },
    async (res) => {
      const declared = Number(res.headers.get('content-length') ?? 0)
      if (declared > MAX_HML_BYTES) {
        void res.body?.cancel().catch(() => undefined)
        throw new Error(UNAVAILABLE)
      }
      if (!res.body) throw new Error(UNAVAILABLE)
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > MAX_HML_BYTES) {
          await reader.cancel()
          throw new Error(UNAVAILABLE)
        }
        chunks.push(value)
      }
      const out = new Uint8Array(total)
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.length
      }
      return out
    }
  )
}
