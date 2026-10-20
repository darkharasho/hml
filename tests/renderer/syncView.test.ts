import { describe, expect, it } from 'vitest'
import type { ProfileManifest, ProfileSync, SyncChangeSummary } from '../../src/shared/types'
import {
  SYNC_LOCKED_NOTE,
  isFollower,
  manualDownloadToast,
  syncBadge,
  syncUpdatedToast
} from '../../src/renderer/src/syncView'

const none: SyncChangeSummary = {
  added: 0,
  removed: 0,
  updated: 0,
  enabled: 0,
  disabled: 0,
  configs: 0
}

const owner: ProfileSync = { role: 'owner', code: 'ABCDEFGHJKMN', revision: 1, digest: 'd' }
const follower: ProfileSync = { role: 'follower', code: 'ABCDEFGHJKMN', revision: 1 }

const profile = (sync?: ProfileSync): ProfileManifest => ({
  formatVersion: 1,
  id: 'p',
  name: 'P',
  game: 'repo',
  createdAt: '2026-10-19T00:00:00.000Z',
  mods: [],
  ...(sync ? { sync } : {})
})

describe('syncUpdatedToast', () => {
  it('lists every part in order', () => {
    expect(
      syncUpdatedToast('Friends', {
        added: 2,
        removed: 1,
        updated: 1,
        enabled: 1,
        disabled: 1,
        configs: 3
      })
    ).toBe('Friends updated: +2 mods, 1 removed, 1 updated, 1 enabled, 1 disabled, configs changed')
  })

  it('omits parts that are zero', () => {
    expect(syncUpdatedToast('Friends', { ...none, removed: 2, configs: 1 })).toBe(
      'Friends updated: 2 removed, configs changed'
    )
    expect(syncUpdatedToast('Friends', { ...none, disabled: 4 })).toBe(
      'Friends updated: 4 disabled'
    )
  })

  it('says mod or mods for added', () => {
    expect(syncUpdatedToast('Friends', { ...none, added: 1 })).toBe('Friends updated: +1 mod')
    expect(syncUpdatedToast('Friends', { ...none, added: 3 })).toBe('Friends updated: +3 mods')
  })

  it('names only the profile when nothing counted', () => {
    expect(syncUpdatedToast('Friends', none)).toBe('Friends updated')
  })
})

describe('manualDownloadToast', () => {
  it('is singular for one and plural otherwise', () => {
    expect(manualDownloadToast(1)).toBe('1 mod needs a manual download')
    expect(manualDownloadToast(3)).toBe('3 mods need a manual download')
  })
})

describe('syncBadge', () => {
  it('is null without sync', () => {
    expect(syncBadge(undefined)).toBeNull()
  })

  it('shows an owner as Syncing, pending or orphaned', () => {
    expect(syncBadge(owner)).toEqual({ label: 'Syncing', tone: 'teal' })
    expect(syncBadge({ ...owner, pending: true })).toEqual({ label: 'Sync pending', tone: 'warn' })
    expect(syncBadge({ ...owner, orphaned: true })).toEqual({ label: "Can't sync", tone: 'warn' })
  })

  it("orphaned wins over pending: the code can't be published at all", () => {
    expect(syncBadge({ ...owner, pending: true, orphaned: true })).toEqual({
      label: "Can't sync",
      tone: 'warn'
    })
  })

  it('shows a follower as Synced', () => {
    expect(syncBadge(follower)).toEqual({ label: 'Synced', tone: 'muted' })
    expect(syncBadge({ ...follower, behind: true })).toEqual({ label: 'Synced', tone: 'muted' })
  })
})

describe('isFollower', () => {
  it('is true only for a follower profile', () => {
    expect(isFollower(profile(follower))).toBe(true)
    expect(isFollower(profile(owner))).toBe(false)
    expect(isFollower(profile())).toBe(false)
    expect(isFollower(null)).toBe(false)
  })
})

it('SYNC_LOCKED_NOTE', () => {
  expect(SYNC_LOCKED_NOTE).toBe('Synced from a friend. Detach to change mods.')
})
