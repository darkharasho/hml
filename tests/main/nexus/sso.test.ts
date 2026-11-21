import { describe, expect, it } from 'vitest'
import { nexusSsoKey, ssoPageUrl, type SsoSocket } from '../../../src/main/nexus/sso'
import { NX_SSO_CANCELLED, NX_SSO_FAILED, NX_SSO_TIMED_OUT } from '../../../src/shared/messages'

class FakeSocket implements SsoSocket {
  sent: unknown[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }
  reply(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  /** The server dropping the connection. */
  drop(): void {
    this.closed = true
    this.onclose?.()
  }
}

function setup(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): {
  key: Promise<string>
  sockets: FakeSocket[]
  opened: string[]
} {
  const sockets: FakeSocket[] = []
  const opened: string[] = []
  const key = nexusSsoKey({
    connect: (url) => {
      expect(url).toBe('wss://sso.nexusmods.com')
      const s = new FakeSocket()
      sockets.push(s)
      queueMicrotask(() => s.onopen?.())
      return s
    },
    open: async (url) => {
      opened.push(url)
    },
    uuid: () => 'uuid-1',
    ...opts
  })
  return { key, sockets, opened }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('nexusSsoKey', () => {
  it('sends the session, opens the Nexus page once, and resolves with the key', async () => {
    const { key, sockets, opened } = setup()
    await tick()
    expect(sockets[0].sent).toEqual([{ id: 'uuid-1', token: null, protocol: 2 }])
    sockets[0].reply({ success: true, data: { connection_token: 'tok' }, error: null })
    expect(opened).toEqual([ssoPageUrl('uuid-1')])
    expect(opened[0]).toBe('https://www.nexusmods.com/sso?id=uuid-1&application=hml')
    sockets[0].reply({ success: true, data: { api_key: 'THE-KEY' }, error: null })
    await expect(key).resolves.toBe('THE-KEY')
    expect(sockets[0].closed).toBe(true)
  })

  it('reconnects with its token after a dropped socket, without opening the page again', async () => {
    const { key, sockets, opened } = setup()
    await tick()
    sockets[0].reply({ success: true, data: { connection_token: 'tok' } })
    sockets[0].drop()
    await tick()
    expect(sockets).toHaveLength(2)
    expect(sockets[1].sent).toEqual([{ id: 'uuid-1', token: 'tok', protocol: 2 }])
    sockets[1].reply({ success: true, data: { connection_token: 'tok' } })
    sockets[1].reply({ success: true, data: { api_key: 'K' } })
    await expect(key).resolves.toBe('K')
    expect(opened).toHaveLength(1)
  })

  it('fails when the socket closes before Nexus answers', async () => {
    const { key, sockets } = setup()
    await tick()
    sockets[0].drop()
    await expect(key).rejects.toThrow(NX_SSO_FAILED)
  })

  it('reports a refusal from Nexus', async () => {
    const { key, sockets } = setup()
    await tick()
    sockets[0].reply({ success: false, data: null, error: 'Unknown application' })
    await expect(key).rejects.toThrow('Nexus Mods refused the sign-in: Unknown application')
  })

  it('can be cancelled, and times out', async () => {
    const ctl = new AbortController()
    const a = setup({ signal: ctl.signal })
    await tick()
    ctl.abort()
    await expect(a.key).rejects.toThrow(NX_SSO_CANCELLED)
    expect(a.sockets[0].closed).toBe(true)
    const b = setup({ timeoutMs: 5 })
    await expect(b.key).rejects.toThrow(NX_SSO_TIMED_OUT)
  })
})
