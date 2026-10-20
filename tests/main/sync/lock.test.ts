import { describe, expect, it, vi } from 'vitest'
import type { HmlApi } from '../../../src/shared/ipc'
import {
  FOLLOWER_LOCKED,
  FOLLOWER_LOCKED_MESSAGE,
  lockFollowers
} from '../../../src/main/sync/lock'

const GAME = 'repo'

/** A fake API whose every method resolves to its own name. */
function fakeApi(): HmlApi & { calls: string[] } {
  const calls: string[] = []
  const names = [...FOLLOWER_LOCKED, 'writeConfig', 'launch', 'renameProfile', 'listProfiles']
  const api: Record<string, unknown> = { calls }
  for (const n of names) {
    api[n] = vi.fn(async () => {
      calls.push(n)
      return n
    })
  }
  return api as unknown as HmlApi & { calls: string[] }
}

const call = (api: HmlApi, name: string, profileId: string): Promise<unknown> =>
  (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](
    GAME,
    profileId,
    'x',
    'y'
  )

function guard(
  roles: Record<string, 'follower' | 'owner' | undefined>,
  applying = new Set<string>()
): Parameters<typeof lockFollowers>[1] {
  return {
    isFollower: async (game: string, profileId: string) =>
      game === GAME && roles[profileId] === 'follower',
    isApplying: (game: string, profileId: string) => game === GAME && applying.has(profileId)
  }
}

describe('lockFollowers', () => {
  it('refuses each locked method on a follower', async () => {
    const inner = fakeApi()
    const api = lockFollowers(inner, guard({ f: 'follower' }))
    for (const name of FOLLOWER_LOCKED) {
      await expect(call(api, name, 'f')).rejects.toThrow(FOLLOWER_LOCKED_MESSAGE)
    }
    expect(inner.calls).toEqual([])
    expect(FOLLOWER_LOCKED_MESSAGE).toBe(
      'This profile is synced from a friend. Detach it to change its mods.'
    )
  })

  it('lets them through while applying', async () => {
    const inner = fakeApi()
    const api = lockFollowers(inner, guard({ f: 'follower' }, new Set(['f'])))
    for (const name of FOLLOWER_LOCKED) expect(await call(api, name, 'f')).toBe(name)
    expect(inner.calls).toEqual([...FOLLOWER_LOCKED])
  })

  it('leaves owners and plain profiles alone', async () => {
    const inner = fakeApi()
    const api = lockFollowers(inner, guard({ o: 'owner', p: undefined }))
    for (const name of FOLLOWER_LOCKED) {
      expect(await call(api, name, 'o')).toBe(name)
      expect(await call(api, name, 'p')).toBe(name)
    }
    expect(inner.calls).toHaveLength(FOLLOWER_LOCKED.length * 2)
  })

  it('does not lock writeConfig, launch, renameProfile', async () => {
    const inner = fakeApi()
    const isFollower = vi.fn(async () => true)
    const api = lockFollowers(inner, { isFollower, isApplying: () => false })
    for (const name of ['writeConfig', 'launch', 'renameProfile', 'listProfiles']) {
      expect(await call(api, name, 'f')).toBe(name)
    }
    expect(isFollower).not.toHaveBeenCalled()
  })
})
