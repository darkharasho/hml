/**
 * Nexus Mods single sign-on: HML opens a socket to Nexus, the user clicks Authorise on the Nexus
 * page HML opens, and Nexus sends that user's API key down the socket.
 * Protocol: https://github.com/Nexus-Mods/sso-integration-demo
 */

import { NX_SSO_CANCELLED, NX_SSO_FAILED, NX_SSO_TIMED_OUT } from '../../shared/messages'

export const NX_SSO_SOCKET = 'wss://sso.nexusmods.com'
/** HML's application slug, registered with Nexus Mods. */
export const NX_SSO_APP = 'hml'
/** How long HML waits for the user to authorise it. */
export const NX_SSO_TIMEOUT_MS = 10 * 60_000
/** Nexus drops idle sockets; HML reconnects (with its connection token) this many times. */
const MAX_RECONNECTS = 5

/** The bits of the WHATWG WebSocket HML uses, so tests can stand in for it. */
export interface SsoSocket {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

export interface SsoDeps {
  connect(url: string): SsoSocket
  open(url: string): Promise<void>
  uuid(): string
  signal?: AbortSignal
  timeoutMs?: number
}

export function ssoPageUrl(id: string): string {
  return `https://www.nexusmods.com/sso?id=${encodeURIComponent(id)}&application=${NX_SSO_APP}`
}

/** Resolves with the API key the user authorised HML for. */
export function nexusSsoKey(deps: SsoDeps): Promise<string> {
  const id = deps.uuid()
  return new Promise<string>((resolve, reject) => {
    let token: string | null = null
    let opened = false
    let done = false
    let reconnects = 0
    let socket: SsoSocket | null = null

    const finish = (err: Error | null, key?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      deps.signal?.removeEventListener('abort', onAbort)
      const s = socket
      socket = null
      try {
        s?.close()
      } catch {
        // already closed
      }
      if (err) reject(err)
      else resolve(key!)
    }
    const onAbort = (): void => finish(new Error(NX_SSO_CANCELLED))
    const timer = setTimeout(
      () => finish(new Error(NX_SSO_TIMED_OUT)),
      deps.timeoutMs ?? NX_SSO_TIMEOUT_MS
    )
    if (deps.signal?.aborted) return onAbort()
    deps.signal?.addEventListener('abort', onAbort)

    const connect = (): void => {
      let s: SsoSocket
      try {
        s = deps.connect(NX_SSO_SOCKET)
      } catch {
        return finish(new Error(NX_SSO_FAILED))
      }
      socket = s
      s.onopen = () => s.send(JSON.stringify({ id, token, protocol: 2 }))
      s.onmessage = (ev) => {
        let msg: { success?: unknown; data?: Record<string, unknown>; error?: unknown }
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg.success !== true) {
          const why = typeof msg.error === 'string' && msg.error ? `: ${msg.error}` : '.'
          return finish(new Error(`Nexus Mods refused the sign-in${why}`))
        }
        const key = msg.data?.api_key
        if (typeof key === 'string' && key) return finish(null, key)
        const t = msg.data?.connection_token
        if (typeof t === 'string' && t) {
          token = t
          if (!opened) {
            opened = true
            deps
              .open(ssoPageUrl(id))
              .catch((e) => finish(e instanceof Error ? e : new Error(String(e))))
          }
        }
      }
      // Errors are followed by close; reconnecting with the token resumes the same sign-in.
      s.onerror = () => {}
      s.onclose = () => {
        if (done || socket !== s) return
        if (token === null || reconnects >= MAX_RECONNECTS) return finish(new Error(NX_SSO_FAILED))
        reconnects++
        connect()
      }
    }
    connect()
  })
}
