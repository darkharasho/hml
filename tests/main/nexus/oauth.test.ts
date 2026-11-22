import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import {
  authorizeUrl,
  loopbackCode,
  parseCredential,
  pkcePair,
  serializeTokens,
  tokenUser
} from '../../../src/main/nexus/oauth'
import { NX_SSO_CANCELLED, NX_SSO_TIMED_OUT } from '../../../src/shared/messages'

const jwt = (claims: object): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

describe('nexus oauth', () => {
  test('the PKCE challenge is the S256 of the verifier', () => {
    const { verifier, challenge } = pkcePair()
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(pkcePair().verifier).not.toBe(verifier)
  })

  test('authorize URL carries the PKCE and redirect params', () => {
    const u = new URL(
      authorizeUrl({
        clientId: 'hml',
        redirectUri: 'http://127.0.0.1:5/callback',
        state: 's',
        challenge: 'c'
      })
    )
    expect(u.origin + u.pathname).toBe('https://users.nexusmods.com/oauth/authorize')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'hml',
      redirect_uri: 'http://127.0.0.1:5/callback',
      scope: 'openid profile email',
      state: 's',
      code_challenge: 'c',
      code_challenge_method: 'S256'
    })
  })

  test('reads the account and Premium from the token', () => {
    const now = 1_000_000_000_000
    expect(
      tokenUser(
        jwt({ sub: '9', user: { id: 9, username: 'A', membership_roles: ['member'] } }),
        now
      )
    ).toEqual({ userId: 9, name: 'A', isPremium: false })
    expect(
      tokenUser(jwt({ user: { id: 9, username: 'A', membership_roles: ['lifetimepremium'] } }), now)
        .isPremium
    ).toBe(true)
    expect(
      tokenUser(jwt({ user: { id: 9, username: 'A', premium_expiry: now / 1000 + 60 } }), now)
        .isPremium
    ).toBe(true)
    expect(() => tokenUser('garbage', now)).toThrow()
    expect(() => tokenUser(jwt({ user: {} }), now)).toThrow('without an account')
  })

  test('stored credentials: API keys stay plain, tokens round-trip, junk is ignored', () => {
    expect(parseCredential('abc')).toEqual({ kind: 'apikey', key: 'abc' })
    expect(parseCredential(serializeTokens({ access: 'a', refresh: 'r', expiresAt: 5 }))).toEqual({
      kind: 'oauth',
      access: 'a',
      refresh: 'r',
      expiresAt: 5
    })
    expect(parseCredential('{"nope":1}')).toBeNull()
    expect(parseCredential(null)).toBeNull()
  })

  describe('loopback', () => {
    const run = (
      onUrl: (redirect: string) => Promise<unknown> | void,
      o: { signal?: AbortSignal; timeoutMs?: number } = {}
    ): Promise<{ code: string; redirectUri: string }> =>
      loopbackCode(
        { open: async (u) => void onUrl(new URL(u).searchParams.get('r')!), ...o },
        'st',
        (r) => `https://x/?r=${encodeURIComponent(r)}`
      )

    test('resolves with the code when the state matches', async () => {
      const r = await run((redirect) => void fetch(`${redirect}?code=C&state=st`))
      expect(r.code).toBe('C')
      expect(r.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    })

    test('ignores a redirect with the wrong state', async () => {
      const r = await run(async (redirect) => {
        const bad = await fetch(`${redirect}?code=EVIL&state=other`)
        expect(bad.status).toBe(400)
        await fetch(`${redirect}?code=C&state=st`)
      })
      expect(r.code).toBe('C')
    })

    test('a denied sign-in reads as cancelled', async () => {
      await expect(
        run((redirect) => void fetch(`${redirect}?error=access_denied&state=st`))
      ).rejects.toThrow(NX_SSO_CANCELLED)
    })

    test('cancel and timeout', async () => {
      const ctl = new AbortController()
      const p = run(() => ctl.abort(), { signal: ctl.signal })
      await expect(p).rejects.toThrow(NX_SSO_CANCELLED)
      await expect(run(() => {}, { timeoutMs: 20 })).rejects.toThrow(NX_SSO_TIMED_OUT)
    })
  })
})
