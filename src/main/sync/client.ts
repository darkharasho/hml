import { MAX_HML_BYTES } from '../share/hmlFile'
import {
  baseOf,
  readBody,
  request,
  type ShareClientOptions,
  type StatusMessages
} from '../share/client'
import { normalizeSyncCode } from '../../shared/shareCode'

export type SyncClientOptions = ShareClientOptions

const UNAVAILABLE = 'Syncing is unavailable right now.'
const CANT_PUBLISH = "This PC can't publish to that sync code."

const MESSAGES: StatusMessages = {
  401: CANT_PUBLISH,
  429: 'Too many sync requests. Try again in a minute.'
}

/** Thrown when publishing to a sync code that has ended or no longer exists. */
export class SyncGoneError extends Error {
  constructor(readonly reason: 'ended' | 'missing') {
    super(reason === 'ended' ? 'This sync code has ended.' : 'This sync code no longer exists.')
    this.name = 'SyncGoneError'
  }
}

const STATUS_HEADER = 'x-hml-status'

/** Longest 404 body read when telling the Worker's own not-found from anything else. */
const MAX_NOT_FOUND_BYTES = 1024

/**
 * Whether a 404 is the Worker's sync route saying the code doesn't exist: its JSON
 * `{"error":"not-found"}` with `cache-control: no-store`. Any other 404 (a proxy, an outage page,
 * a Worker without sync routes) says nothing about the code, so it must not detach anyone.
 */
async function isSyncNotFound(res: Response): Promise<boolean> {
  if (!/\bno-store\b/i.test(res.headers.get('cache-control') ?? '')) {
    void res.body?.cancel().catch(() => undefined)
    return false
  }
  try {
    const body = await readBody(res, MAX_NOT_FOUND_BYTES, UNAVAILABLE)
    const json = JSON.parse(new TextDecoder().decode(body)) as { error?: unknown }
    return json?.error === 'not-found'
  } catch {
    return false
  }
}

/**
 * Wraps fetch so the given non-2xx statuses reach the handler as a 200 carrying the original
 * status in a header, instead of being turned into errors by `request`. A 404 passes only when
 * it is the Worker's own sync-route not-found; any other 404 stays an error.
 */
function passing(o: SyncClientOptions, statuses: number[]): SyncClientOptions {
  return {
    ...o,
    fetch: async (input, init) => {
      const res = await o.fetch(input, init)
      if (!statuses.includes(res.status)) return res
      if (res.status === 404) {
        if (!(await isSyncNotFound(res))) return new Response(null, { status: 404 })
      } else {
        void res.body?.cancel().catch(() => undefined)
      }
      const headers = new Headers({ [STATUS_HEADER]: String(res.status) })
      const rev = res.headers.get('x-hml-revision')
      if (rev) headers.set('x-hml-revision', rev)
      return new Response(null, { status: 200, headers })
    }
  }
}

const statusOf = (res: Response): number | null => Number(res.headers.get(STATUS_HEADER)) || null

const syncUrl = (o: SyncClientOptions, code: string): string => {
  const normalized = normalizeSyncCode(code)
  if (!normalized) throw new Error("That isn't a valid sync code.")
  return `${baseOf(o)}/v1/sync/${normalized}`
}

/** Upload timeout scales with size like share uploads: 30 s plus 1 s per 50 KB, capped at 5 min. */
const uploadOptions = (o: SyncClientOptions, data: Uint8Array): SyncClientOptions => ({
  ...o,
  timeoutMs: o.timeoutMs ?? Math.min(300_000, 30_000 + Math.ceil(data.byteLength / 50_000) * 1000)
})

const auth = (key: string): Record<string, string> => ({
  authorization: `Bearer ${key}`,
  'user-agent': 'HML'
})

export async function createSync(
  o: SyncClientOptions,
  data: Uint8Array
): Promise<{ code: string; ownerKey: string; revision: number }> {
  return request(
    uploadOptions(o, data),
    MESSAGES,
    `${baseOf(o)}/v1/sync`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'user-agent': 'HML' },
      body: data as BodyInit
    },
    async (res) => {
      const body = (await res.json()) as { code?: unknown; ownerKey?: unknown; revision?: unknown }
      const code = typeof body.code === 'string' ? normalizeSyncCode(body.code) : null
      if (!code || typeof body.ownerKey !== 'string' || typeof body.revision !== 'number')
        throw new Error(UNAVAILABLE)
      return { code, ownerKey: body.ownerKey, revision: body.revision }
    },
    UNAVAILABLE
  )
}

export async function publishSync(
  o: SyncClientOptions,
  code: string,
  ownerKey: string,
  data: Uint8Array
): Promise<{ revision: number }> {
  const out = await request(
    passing(uploadOptions(o, data), [404, 410]),
    MESSAGES,
    syncUrl(o, code),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/zip', ...auth(ownerKey) },
      body: data as BodyInit
    },
    async (res): Promise<{ revision: number } | 'ended' | 'missing'> => {
      const status = statusOf(res)
      if (status === 410) return 'ended'
      if (status === 404) return 'missing'
      const body = (await res.json()) as { revision?: unknown }
      if (typeof body.revision !== 'number') throw new Error(UNAVAILABLE)
      return { revision: body.revision }
    },
    UNAVAILABLE
  )
  if (out === 'ended' || out === 'missing') throw new SyncGoneError(out)
  return out
}

export type FetchSyncResult =
  | { kind: 'unchanged'; revision: number }
  | { kind: 'updated'; revision: number; data: Uint8Array }
  | { kind: 'ended' }
  | { kind: 'missing' }

export async function fetchSync(
  o: SyncClientOptions,
  code: string,
  since: number
): Promise<FetchSyncResult> {
  return request(
    passing(o, [304, 404, 410]),
    MESSAGES,
    `${syncUrl(o, code)}?since=${since}`,
    { headers: { 'user-agent': 'HML' } },
    async (res): Promise<FetchSyncResult> => {
      const status = statusOf(res)
      if (status === 410) return { kind: 'ended' }
      if (status === 404) return { kind: 'missing' }
      const revision = Number(res.headers.get('x-hml-revision'))
      if (!Number.isInteger(revision)) throw new Error(UNAVAILABLE)
      if (status === 304) return { kind: 'unchanged', revision }
      return { kind: 'updated', revision, data: await readBody(res, MAX_HML_BYTES, UNAVAILABLE) }
    },
    UNAVAILABLE
  )
}

/** Ends a sync code. A code that is already gone counts as ended. */
export async function endSync(o: SyncClientOptions, code: string, ownerKey: string): Promise<void> {
  await request(
    passing(o, [404, 410]),
    MESSAGES,
    syncUrl(o, code),
    { method: 'DELETE', headers: auth(ownerKey) },
    async (res) => {
      void res.body?.cancel().catch(() => undefined)
    },
    UNAVAILABLE
  )
}
