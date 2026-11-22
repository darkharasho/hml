/**
 * Nexus Mods sign-in with OAuth 2.0 + PKCE. HML opens the Nexus authorise page in the browser and
 * catches the redirect on a one-shot loopback server (http://127.0.0.1:<port>/callback), then
 * trades the code for tokens. Endpoints: https://users.nexusmods.com/.well-known/openid-configuration
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { NX_SSO_CANCELLED, NX_SSO_FAILED, NX_SSO_TIMED_OUT } from '../../shared/messages'

/**
 * HML's OAuth client id, issued by Nexus Mods. Null until Nexus registers HML; sign-in stays
 * hidden and users paste a personal API key instead.
 */
export const NX_OAUTH_CLIENT_ID: string | null = null
/** Loopback port for the redirect; 0 picks a free one. Set if Nexus registers a fixed port. */
export const NX_OAUTH_PORT = 0
export const NX_OAUTH_AUTHORIZE = 'https://users.nexusmods.com/oauth/authorize'
export const NX_OAUTH_TOKEN = 'https://users.nexusmods.com/oauth/token'
export const NX_OAUTH_SCOPE = 'openid profile email'
/** How long HML waits for the user to authorise it. */
export const NX_OAUTH_TIMEOUT_MS = 10 * 60_000
/** Tokens are refreshed this long before they expire. */
export const NX_OAUTH_REFRESH_EARLY_MS = 60_000

export const NX_SIGNED_OUT = 'Your Nexus Mods sign-in has expired. Sign in again in Settings.'

export interface NxTokens {
  access: string
  refresh: string
  /** Epoch ms. */
  expiresAt: number
}

export interface NxTokenUser {
  userId: number
  name: string
  isPremium: boolean
}

const b64url = (b: Buffer): string => b.toString('base64url')

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function authorizeUrl(o: {
  clientId: string
  redirectUri: string
  state: string
  challenge: string
}): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: NX_OAUTH_SCOPE,
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: 'S256'
  })
  return `${NX_OAUTH_AUTHORIZE}?${q}`
}

/** Thrown when Nexus refuses a refresh token: the user has to sign in again. */
export class NxSignedOutError extends Error {
  constructor() {
    super(NX_SIGNED_OUT)
    this.name = 'NxSignedOutError'
  }
}

async function tokenRequest(
  fetchFn: typeof fetch,
  body: Record<string, string>,
  now: number
): Promise<NxTokens> {
  let res: Response
  try {
    res = await fetchFn(NX_OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000)
    })
  } catch {
    throw new Error(NX_SSO_FAILED)
  }
  if (res.status === 400 || res.status === 401) {
    const b = (await res.json().catch(() => ({}))) as { error?: unknown }
    if (body.grant_type === 'refresh_token' || b.error === 'invalid_grant') {
      throw new NxSignedOutError()
    }
  }
  if (!res.ok) throw new Error(`Nexus Mods sign-in failed (HTTP ${res.status}).`)
  const b = (await res.json()) as Record<string, unknown>
  const access = b.access_token
  const refresh = b.refresh_token
  if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) {
    throw new Error('Nexus Mods sent an incomplete sign-in reply.')
  }
  const secs = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 3600
  return { access, refresh, expiresAt: now + secs * 1000 }
}

export function exchangeCode(
  fetchFn: typeof fetch,
  o: { clientId: string; redirectUri: string; code: string; verifier: string },
  now: number
): Promise<NxTokens> {
  return tokenRequest(
    fetchFn,
    {
      grant_type: 'authorization_code',
      client_id: o.clientId,
      redirect_uri: o.redirectUri,
      code: o.code,
      code_verifier: o.verifier
    },
    now
  )
}

export function refreshTokens(
  fetchFn: typeof fetch,
  clientId: string,
  refresh: string,
  now: number
): Promise<NxTokens> {
  return tokenRequest(
    fetchFn,
    { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh },
    now
  )
}

/**
 * The account an access token belongs to, from its JWT claims. The token came straight from
 * Nexus over TLS, so its signature isn't checked here; Nexus checks it on every request.
 */
export function tokenUser(access: string, now: number): NxTokenUser {
  const part = access.split('.')[1]
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8'))
  } catch {
    throw new Error('Nexus Mods sent an unreadable sign-in token.')
  }
  const u = (claims.user ?? {}) as Record<string, unknown>
  const roles = Array.isArray(u.membership_roles) ? u.membership_roles.map(String) : []
  const expiry = typeof u.premium_expiry === 'number' ? u.premium_expiry : 0
  const userId = Number(u.id ?? claims.sub)
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('Nexus Mods sent a sign-in token without an account.')
  }
  return {
    userId,
    name: String(u.username ?? ''),
    // premium_expiry is in seconds; roles cover lifetime Premium.
    isPremium: roles.some((r) => r.toLowerCase().includes('premium')) || expiry * 1000 > now
  }
}

/** Stored form of the Nexus credential: a pasted API key, or OAuth tokens as JSON. */
export type NxCredential = { kind: 'apikey'; key: string } | ({ kind: 'oauth' } & NxTokens)

export function parseCredential(stored: string | null): NxCredential | null {
  if (!stored) return null
  if (!stored.startsWith('{')) return { kind: 'apikey', key: stored }
  try {
    const o = JSON.parse(stored) as Record<string, unknown>
    if (
      typeof o.access === 'string' &&
      typeof o.refresh === 'string' &&
      typeof o.expiresAt === 'number'
    ) {
      return { kind: 'oauth', access: o.access, refresh: o.refresh, expiresAt: o.expiresAt }
    }
  } catch {
    // fall through
  }
  return null
}

export function serializeTokens(t: NxTokens): string {
  return JSON.stringify({ access: t.access, refresh: t.refresh, expiresAt: t.expiresAt })
}

export interface LoopbackDeps {
  open(url: string): Promise<void>
  signal?: AbortSignal
  timeoutMs?: number
  port?: number
  /** Test hook: called with the redirect URI once the server listens. */
  onListening?(redirectUri: string): void
}

const PAGE = (msg: string): string =>
  `<!doctype html><meta charset="utf-8"><title>HML</title><body style="font:16px system-ui;background:#0e1b20;color:#e3ece9;display:grid;place-items:center;height:100vh;margin:0"><p>${msg}</p></body>`

/**
 * Opens the authorise page and resolves with the code Nexus redirects back with.
 * `build` turns the redirect URI into the authorise URL (it needs the port, known only once
 * the server listens).
 */
export function loopbackCode(
  deps: LoopbackDeps,
  state: string,
  build: (redirectUri: string) => string
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let done = false
    let redirectUri = ''
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const send = (status: number, msg: string): void => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE(msg))
      }
      // Another site can't finish HML's sign-in: the state has to match.
      if (url.searchParams.get('state') !== state) {
        send(400, 'This sign-in link is out of date. Start again from HML.')
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (error || !code) {
        send(400, 'Sign-in was not completed. You can close this tab.')
        finish(new Error(error === 'access_denied' ? NX_SSO_CANCELLED : NX_SSO_FAILED))
        return
      }
      send(200, 'Signed in to Nexus Mods. You can close this tab and return to HML.')
      finish(null, code)
    })
    const finish = (err: Error | null, code?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      deps.signal?.removeEventListener('abort', onAbort)
      server.close()
      server.closeAllConnections?.()
      if (err) reject(err)
      else resolve({ code: code!, redirectUri })
    }
    const onAbort = (): void => finish(new Error(NX_SSO_CANCELLED))
    const timer = setTimeout(
      () => finish(new Error(NX_SSO_TIMED_OUT)),
      deps.timeoutMs ?? NX_OAUTH_TIMEOUT_MS
    )
    if (deps.signal?.aborted) return onAbort()
    deps.signal?.addEventListener('abort', onAbort)
    server.on('error', () => finish(new Error(NX_SSO_FAILED)))
    server.listen(deps.port ?? NX_OAUTH_PORT, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      redirectUri = `http://127.0.0.1:${port}/callback`
      deps.onListening?.(redirectUri)
      deps
        .open(build(redirectUri))
        .catch((e) => finish(e instanceof Error ? e : new Error(String(e))))
    })
  })
}
