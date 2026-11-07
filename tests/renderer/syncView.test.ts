import { describe, expect, it } from 'vitest'
import type { ProfileManifest, ProfileSync, SyncChangeSummary } from '../../src/shared/types'
import {
  BEHIND_NOTE,
  ORPHANED_NOTE,
  SYNC_LOCKED_NOTE,
  followerStatus,
  followerTally,
  isFollower,
  manualDownloadToast,
  moreManualToast,
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

describe('moreManualToast', () => {
  it('counts the downloads still to open', () => {
    expect(moreManualToast(1)).toBe('1 more mod needs a manual download')
    expect(moreManualToast(2)).toBe('2 more mods need a manual download')
  })
})

describe('syncBadge', () => {
  it('is null without sync', () => {
    expect(syncBadge(undefined)).toBeNull()
  })

  it('shows an owner as Syncing, pending or orphaned', () => {
    expect(syncBadge(owner)).toEqual({ label: 'Syncing', tone: 'teal' })
    expect(syncBadge({ ...owner, pending: true })).toEqual({ label: 'Sync pending', tone: 'warn' })
    expect(syncBadge({ ...owner, orphaned: true })).toEqual({
      label: "Can't sync",
      tone: 'warn',
      title: ORPHANED_NOTE
    })
  })

  it("orphaned wins over pending: the code can't be published at all", () => {
    expect(syncBadge({ ...owner, pending: true, orphaned: true })).toEqual({
      label: "Can't sync",
      tone: 'warn',
      title: ORPHANED_NOTE
    })
  })

  it('shows a follower as Synced', () => {
    expect(syncBadge(follower)).toEqual({ label: 'Synced', tone: 'muted' })
  })

  it('shows a behind follower as missing mods', () => {
    expect(syncBadge({ ...follower, behind: true })).toEqual({
      label: 'Missing mods',
      tone: 'warn',
      title: BEHIND_NOTE
    })
  })

  it("shows a follower's tally of the owner's mods", () => {
    expect(syncBadge({ ...follower, total: 24 })).toEqual({ label: 'Synced 24/24', tone: 'muted' })
    expect(
      syncBadge({ ...follower, total: 24, behind: true, missing: ['nickklmao-MenuLib'] })
    ).toEqual({
      label: 'Synced 23/24',
      tone: 'warn',
      title: `Missing: nickklmao-MenuLib\n${BEHIND_NOTE}`
    })
    expect(syncBadge({ ...follower, total: 3, local: ['Mine'] })).toEqual({
      label: 'Synced 2/3',
      tone: 'warn',
      title: "Only on the owner's PC (local files never sync): Mine"
    })
  })

  it('live progress wins over the saved state', () => {
    expect(syncBadge(follower, { phase: 'checking' })).toEqual({
      label: 'Checking…',
      tone: 'teal'
    })
    expect(
      syncBadge(follower, { phase: 'applying', done: 3, total: 24, current: 'MenuLib' })
    ).toEqual({ label: 'Syncing 3/24', tone: 'teal', loud: true, title: 'Installing MenuLib' })
    expect(syncBadge(follower, { phase: 'held', revision: 4 })).toMatchObject({
      label: 'Waiting for game',
      tone: 'warn',
      loud: true
    })
    expect(syncBadge(follower, { phase: 'updating', revision: 5 })).toMatchObject({
      label: 'Getting latest…',
      tone: 'teal',
      loud: true
    })
  })

  it('stays quiet while up to date or only checking', () => {
    expect(syncBadge({ ...follower, total: 24 })?.loud).toBeUndefined()
    expect(syncBadge(follower, { phase: 'checking' })?.loud).toBeUndefined()
  })
})

describe('followerStatus', () => {
  const f = follower as Extract<ProfileSync, { role: 'follower' }>

  it('is a quiet note when up to date', () => {
    expect(followerStatus({ ...f, total: 3 })).toEqual({
      tone: 'muted',
      busy: false,
      text: `Up to date with the owner. ${SYNC_LOCKED_NOTE}`
    })
  })

  it('names local mods that never sync without calling it out of sync', () => {
    const s = followerStatus({ ...f, total: 3, local: ['Mine'] })
    expect(s.tone).toBe('muted')
    expect(s.detail).toContain('Mine')
  })

  it('is loud and busy while catching up, with a progress bar', () => {
    expect(followerStatus(f, { phase: 'updating', revision: 5 })).toMatchObject({
      tone: 'teal',
      busy: true,
      text: "Out of sync: getting the owner's latest changes…"
    })
    expect(followerStatus(f, { phase: 'applying', done: 1, total: 4, current: 'MenuLib' })).toEqual(
      {
        tone: 'teal',
        busy: true,
        text: "Out of sync: getting the owner's latest changes (1/4)",
        detail: 'Installing MenuLib',
        bar: 0.25
      }
    )
  })

  it('asks to close the game while a revision is held', () => {
    expect(followerStatus(f, { phase: 'held', revision: 5 })).toMatchObject({
      tone: 'warn',
      busy: false,
      text: "Out of sync: close the game to apply the owner's latest changes."
    })
  })

  it('offers Sync now when mods are missing', () => {
    const s = followerStatus({ ...f, total: 24, behind: true, missing: ['MenuLib'] })
    expect(s).toMatchObject({
      tone: 'warn',
      text: "Out of sync: 23/24 of the owner's mods installed.",
      syncNow: true
    })
    expect(s.detail).toContain('Missing: MenuLib')
  })
})

describe('followerTally', () => {
  it('is null before the owner total is known', () => {
    expect(followerTally(follower as Extract<ProfileSync, { role: 'follower' }>)).toBeNull()
  })
})

describe('sync notes', () => {
  it('tells an orphaned owner what to do', () => {
    expect(ORPHANED_NOTE).toBe(
      "This PC can't publish to this code anymore. Stop syncing and create a new code."
    )
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
