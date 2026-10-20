import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaths, type AppPaths } from '../../../src/main/store/paths'
import { zipHmlParts } from '../../../src/main/share/hmlFile'
import type { SyncApplyResult } from '../../../src/main/sync/apply'
import {
  SYNC_HOLD_RETRY_MS,
  SYNC_LAUNCH_CHECK_MS,
  createSyncServices,
  type SyncContext,
  type SyncTimers
} from '../../../src/main/sync/service'
import type {
  HmlEvent,
  HmlExport,
  InstalledMod,
  ProfileManifest,
  ProfileSync
} from '../../../src/shared/types'

const CODE = 'ABCDEFGHJKMN'
const GAME = 'repo'
const ID = 'p1'
const CFG = 'BepInEx/config/a.cfg'

let root: string
let paths: AppPaths
let events: HmlEvent[]
let requests: string[]
let serve: (since: number) => Promise<Response>
let timers: FakeTimers
let running: boolean
let applyImpl: () => Promise<SyncApplyResult>
let applyCalls: number

class FakeTimers implements SyncTimers {
  next = 1
  pending = new Map<number, { fn: () => void; ms: number }>()
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++
    this.pending.set(id, { fn, ms })
    return id
  }
  clearTimeout(h: unknown): void {
    this.pending.delete(h as number)
  }
  fire(ms: number): void {
    for (const [id, t] of [...this.pending]) {
      if (t.ms !== ms) continue
      this.pending.delete(id)
      t.fn()
    }
  }
  count(ms: number): number {
    return [...this.pending.values()].filter((t) => t.ms === ms).length
  }
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  requests.push(url)
  const since = Number(new URL(url).searchParams.get('since'))
  return serve(since)
}) as unknown as typeof fetch

const exportOf = (game = GAME): HmlExport => ({
  formatVersion: 1,
  game,
  profileName: 'Owner',
  mods: []
})
const revData = (game = GAME): Uint8Array =>
  zipHmlParts({ export: exportOf(game), configs: new Map([[CFG, strToU8('[G]\nA = 2\n')]]) })

const updated = (revision: number, data = revData()): Response =>
  new Response(data as BodyInit, { status: 200, headers: { 'x-hml-revision': String(revision) } })
const unchanged = (revision: number): Response =>
  new Response(null, { status: 304, headers: { 'x-hml-revision': String(revision) } })

const emptyResult = (o: Partial<SyncApplyResult> = {}): SyncApplyResult => ({
  added: 0,
  removed: 0,
  updated: 0,
  enabled: 0,
  disabled: 0,
  configs: 0,
  manual: [],
  failed: [],
  ...o
})

const nexusMod = (modId: number): InstalledMod => ({
  id: `n${modId}`,
  name: `Nexus ${modId}`,
  version: '1.0.0',
  source: { kind: 'nexus', domain: 'repo', modId, fileId: 1 },
  enabled: true,
  files: [],
  disableable: [],
  installedAt: ''
})

const profileDir = (): string => paths.profileDir(GAME, ID)
const manifestFile = (): string => join(profileDir(), 'hml-profile.json')
const baseFile = (): string => join(profileDir(), '.hml-sync', 'base', ...CFG.split('/'))

async function writeManifest(extra: Partial<ProfileManifest> = {}): Promise<void> {
  await mkdir(profileDir(), { recursive: true })
  const m: ProfileManifest = {
    formatVersion: 1,
    id: ID,
    name: 'Friends',
    game: GAME,
    createdAt: '',
    mods: [],
    ...extra
  }
  await writeFile(manifestFile(), JSON.stringify(m))
}
const follow = (extra: Partial<Extract<ProfileSync, { role: 'follower' }>> = {}): Promise<void> =>
  writeManifest({ sync: { role: 'follower', code: CODE, revision: 3, ...extra } })
const readSync = async (): Promise<ProfileSync | undefined> =>
  (JSON.parse(await readFile(manifestFile(), 'utf8')) as ProfileManifest).sync
const exists = async (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false
  )
const ofType = <T extends HmlEvent['type']>(t: T): Extract<HmlEvent, { type: T }>[] =>
  events.filter((e): e is Extract<HmlEvent, { type: T }> => e.type === t)

function makeCtx(): SyncContext {
  return {
    deps: {
      paths,
      fetch: fakeFetch,
      shareBaseUrl: 'https://share.test',
      emit: (e: HmlEvent) => events.push(e)
    } as never,
    lock: (_g, _p, fn) => fn(),
    requireGame: async (label) => ({ label }) as never,
    getCustomGame: async () => null,
    isGameRunning: async () => running,
    apply: async () => {
      applyCalls++
      return applyImpl()
    },
    timers
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hml-sync-follower-'))
  paths = makePaths(root)
  events = []
  requests = []
  timers = new FakeTimers()
  running = false
  applyCalls = 0
  applyImpl = async () => emptyResult()
  serve = async (since) => unchanged(since)
  vi.mocked(fakeFetch).mockClear()
  await follow()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('checkFollower', () => {
  it('applies a newer revision and emits sync-applied with the counts', async () => {
    serve = async () => updated(4)
    applyImpl = async () => emptyResult({ added: 2, configs: 1 })
    const s = createSyncServices(makeCtx())
    await s.checkFollower(GAME, ID)
    expect(requests).toEqual([`https://share.test/v1/sync/${CODE}?since=3`])
    expect(applyCalls).toBe(1)
    expect(await readSync()).toEqual({ role: 'follower', code: CODE, revision: 4 })
    expect(ofType('sync-applied')).toEqual([
      {
        type: 'sync-applied',
        game: GAME,
        profileId: ID,
        profileName: 'Friends',
        changes: { added: 2, removed: 0, updated: 0, enabled: 0, disabled: 0, configs: 1 },
        manual: []
      }
    ])
    expect(events.at(-1)).toEqual({ type: 'sync-state', game: GAME, profileId: ID })
  })

  it('records manual and failed mods and skips sync-applied when nothing changed', async () => {
    serve = async () => updated(4)
    const s = createSyncServices(makeCtx())
    await s.checkFollower(GAME, ID)
    expect(ofType('sync-applied')).toEqual([])
    expect(ofType('sync-state')).toHaveLength(1)

    serve = async () => updated(5)
    const manual = [{ name: 'Paid', url: 'https://www.nexusmods.com/repo/mods/7' }]
    applyImpl = async () =>
      emptyResult({
        manual,
        failed: [{ name: 'Gone', version: '1', kind: 'thunderstore' }] as never
      })
    await s.checkFollower(GAME, ID)
    expect(await readSync()).toEqual({
      role: 'follower',
      code: CODE,
      revision: 5,
      behind: true,
      manual
    })
    expect(ofType('sync-applied')).toHaveLength(1)
  })

  it('does nothing when unchanged', async () => {
    const s = createSyncServices(makeCtx())
    await s.checkFollower(GAME, ID)
    expect(requests).toHaveLength(1)
    expect(applyCalls).toBe(0)
    expect(events).toEqual([])
    expect(await readSync()).toEqual({ role: 'follower', code: CODE, revision: 3 })
  })

  it('holds while the game runs and retries after SYNC_HOLD_RETRY_MS', async () => {
    serve = async () => updated(4)
    running = true
    const s = createSyncServices(makeCtx())
    await s.checkFollower(GAME, ID)
    expect(applyCalls).toBe(0)
    expect(timers.count(SYNC_HOLD_RETRY_MS)).toBe(1)
    expect((await readSync())?.revision).toBe(3)

    running = false
    timers.fire(SYNC_HOLD_RETRY_MS)
    await vi.waitFor(async () => expect((await readSync())?.revision).toBe(4))
    expect(applyCalls).toBe(1)
  })

  it('repeated checks while the game runs schedule only one hold timer', async () => {
    serve = async () => updated(4)
    running = true
    const s = createSyncServices(makeCtx())
    await s.checkFollower(GAME, ID)
    await s.checkFollower(GAME, ID)
    await s.checkFollower(GAME, ID)
    expect(timers.count(SYNC_HOLD_RETRY_MS)).toBe(1)
  })

  it('an ended code detaches the profile and emits sync-ended', async () => {
    await mkdir(join(baseFile(), '..'), { recursive: true })
    await writeFile(baseFile(), 'x')
    serve = async () => new Response(null, { status: 410 })
    const s = createSyncServices(makeCtx())
    await s.checkFollower(GAME, ID)
    expect(await readSync()).toBeUndefined()
    expect(await exists(baseFile())).toBe(false)
    expect(ofType('sync-ended')).toEqual([
      { type: 'sync-ended', game: GAME, profileId: ID, profileName: 'Friends' }
    ])
  })

  it('retries a behind profile at the same revision', async () => {
    await follow({ behind: true })
    serve = async () => updated(3)
    const s = createSyncServices(makeCtx())
    await s.checkFollower(GAME, ID)
    expect(requests).toEqual([`https://share.test/v1/sync/${CODE}?since=0`])
    expect(applyCalls).toBe(1)
    expect(await readSync()).toEqual({ role: 'follower', code: CODE, revision: 3 })
    await s.checkFollower(GAME, ID)
    expect(requests.at(-1)).toBe(`https://share.test/v1/sync/${CODE}?since=3`)
  })

  it('runs one check per profile at a time', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    serve = async () => {
      await gate
      return updated(4)
    }
    const s = createSyncServices(makeCtx())
    const a = s.checkFollower(GAME, ID)
    const b = s.checkFollower(GAME, ID)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    release()
    await Promise.all([a, b])
    expect(requests).toHaveLength(1)
    expect(applyCalls).toBe(1)
  })

  it('a newer-format revision emits the update-HML error once', async () => {
    const future = zipSync({
      'export.json': strToU8(JSON.stringify({ ...exportOf(), formatVersion: 2 }))
    })
    serve = async () => updated(4, future)
    const s = createSyncServices(makeCtx())
    await s.checkFollower(GAME, ID)
    await s.checkFollower(GAME, ID)
    expect(requests).toHaveLength(2)
    expect(ofType('sync-error')).toEqual([
      {
        type: 'sync-error',
        game: GAME,
        profileId: ID,
        message: 'Update HML to keep following Friends.'
      }
    ])
    expect(applyCalls).toBe(0)
    expect((await readSync())?.revision).toBe(3)
  })

  it('ignores a revision for another game', async () => {
    serve = async () => updated(4, revData('other'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const s = createSyncServices(makeCtx())
      await s.checkFollower(GAME, ID)
      expect(applyCalls).toBe(0)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('isApplying is true only during apply', async () => {
    serve = async () => updated(4)
    const s = createSyncServices(makeCtx())
    let during = false
    applyImpl = async () => {
      during = s.isApplying(GAME, ID)
      return emptyResult()
    }
    expect(s.isApplying(GAME, ID)).toBe(false)
    await s.checkFollower(GAME, ID)
    expect(during).toBe(true)
    expect(s.isApplying(GAME, ID)).toBe(false)
  })

  it('network errors and apply failures are swallowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      vi.mocked(fakeFetch).mockRejectedValueOnce(new TypeError('offline'))
      const s = createSyncServices(makeCtx())
      await expect(s.checkFollower(GAME, ID)).resolves.toBeUndefined()
      serve = async () => updated(4)
      applyImpl = async () => {
        throw new Error('disk full')
      }
      await expect(s.checkFollower(GAME, ID)).resolves.toBeUndefined()
      expect((await readSync())?.revision).toBe(3)
      expect(s.isApplying(GAME, ID)).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('does nothing for an owner or a missing profile', async () => {
    await writeManifest({ sync: { role: 'owner', code: CODE, revision: 1, digest: 'd' } })
    const s = createSyncServices(makeCtx())
    await s.checkFollower(GAME, ID)
    await s.checkFollower(GAME, 'nope')
    expect(requests).toEqual([])
  })

  it('a detach during apply waits for it and is not undone by it', async () => {
    serve = async () => updated(4)
    const s = createSyncServices(makeCtx())
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let started!: () => void
    const inApply = new Promise<void>((r) => (started = r))
    applyImpl = async () => {
      started()
      await gate
      return emptyResult({ added: 1 })
    }
    const check = s.checkFollower(GAME, ID)
    await inApply
    let detached = false
    const detach = s.detachSync(GAME, ID).then(() => (detached = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(detached).toBe(false)
    release()
    await Promise.all([check, detach])
    expect(await readSync()).toBeUndefined()
    expect(await exists(baseFile())).toBe(false)
  })
})

describe('beforeLaunch', () => {
  it('beforeLaunch gives up after the timeout', async () => {
    serve = () => new Promise<Response>(() => undefined)
    const s = createSyncServices(makeCtx())
    let done = false
    const p = s.beforeLaunch(GAME, ID).then(() => (done = true))
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(done).toBe(false)
    expect(timers.count(SYNC_LAUNCH_CHECK_MS)).toBe(1)
    timers.fire(SYNC_LAUNCH_CHECK_MS)
    await p
    expect(done).toBe(true)
  })

  it('waits for an apply already under way when the timeout hits', async () => {
    serve = async () => updated(4)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let started!: () => void
    const inApply = new Promise<void>((r) => (started = r))
    applyImpl = async () => {
      started()
      await gate
      return emptyResult()
    }
    const s = createSyncServices(makeCtx())
    let done = false
    const p = s.beforeLaunch(GAME, ID).then(() => (done = true))
    await inApply
    timers.fire(SYNC_LAUNCH_CHECK_MS)
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toBe(false)
    release()
    await p
    expect((await readSync())?.revision).toBe(4)
  })

  it('clears its timer when the check finishes first', async () => {
    const s = createSyncServices(makeCtx())
    await s.beforeLaunch(GAME, ID)
    expect(timers.count(SYNC_LAUNCH_CHECK_MS)).toBe(0)
  })
  it('a check that finishes after the launch timeout holds instead of applying', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    serve = async () => {
      await gate
      return updated(4)
    }
    const s = createSyncServices(makeCtx())
    const p = s.beforeLaunch(GAME, ID)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    timers.fire(SYNC_LAUNCH_CHECK_MS)
    await p
    const late = s.checkFollower(GAME, ID)
    release()
    await late
    expect(applyCalls).toBe(0)
    expect(timers.count(SYNC_HOLD_RETRY_MS)).toBe(1)
    expect((await readSync())?.revision).toBe(3)
  })
})

describe('detachSync', () => {
  it('a detach while the fetch is pending stops the apply', async () => {
    await mkdir(join(baseFile(), '..'), { recursive: true })
    await writeFile(baseFile(), 'x')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    serve = async () => {
      await gate
      return updated(4)
    }
    const s = createSyncServices(makeCtx())
    const check = s.checkFollower(GAME, ID)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    const detach = s.detachSync(GAME, ID)
    release()
    await Promise.all([check, detach])
    expect(applyCalls).toBe(0)
    expect(await readSync()).toBeUndefined()
    expect(await exists(baseFile())).toBe(false)
  })

  it('a held revision is applied from memory, not downloaded again', async () => {
    serve = async (since) => (since >= 4 ? unchanged(4) : updated(4))
    running = true
    const s = createSyncServices(makeCtx())
    await s.checkFollower(GAME, ID)
    // A regular poll while held asks only whether there is anything newer.
    await s.checkFollower(GAME, ID)
    expect(requests.at(-1)).toBe(`https://share.test/v1/sync/${CODE}?since=4`)
    expect(applyCalls).toBe(0)
    running = false
    timers.fire(SYNC_HOLD_RETRY_MS)
    await vi.waitFor(async () => expect((await readSync())?.revision).toBe(4))
    expect(requests).toHaveLength(2)
    expect(applyCalls).toBe(1)
  })

  it('an unreadable revision is not downloaded again', async () => {
    const future = zipSync({
      'export.json': strToU8(JSON.stringify({ ...exportOf(), formatVersion: 2 }))
    })
    serve = async (since) => (since >= 4 ? unchanged(4) : updated(4, future))
    const s = createSyncServices(makeCtx())
    await s.checkFollower(GAME, ID)
    await s.checkFollower(GAME, ID)
    expect(requests.at(-1)).toBe(`https://share.test/v1/sync/${CODE}?since=4`)
    expect(ofType('sync-error')).toHaveLength(1)
  })

  it('detachSync clears sync and bases', async () => {
    await mkdir(join(baseFile(), '..'), { recursive: true })
    await writeFile(baseFile(), 'x')
    const s = createSyncServices(makeCtx())
    await s.detachSync(GAME, ID)
    expect(await readSync()).toBeUndefined()
    expect(await exists(baseFile())).toBe(false)
    expect(events).toEqual([{ type: 'sync-state', game: GAME, profileId: ID }])
  })

  it('refuses on a profile that is not a follower', async () => {
    await writeManifest()
    const s = createSyncServices(makeCtx())
    await expect(s.detachSync(GAME, ID)).rejects.toThrow(
      "This profile isn't following a sync code."
    )
  })
})

describe('attach, lookup and tick', () => {
  it('attachFollower saves follower state and writes bases', async () => {
    await writeManifest()
    const s = createSyncServices(makeCtx())
    await s.attachFollower(GAME, ID, CODE, 7, new Map([[CFG, strToU8('base')]]))
    expect(await readSync()).toEqual({ role: 'follower', code: CODE, revision: 7 })
    expect(await readFile(baseFile(), 'utf8')).toBe('base')
    expect(await s.isFollower(GAME, ID)).toBe(true)
    expect(await s.isFollower(GAME, 'nope')).toBe(false)
  })

  it('findByCode finds the profile that follows a code', async () => {
    const s = createSyncServices(makeCtx())
    expect(await s.findByCode('abcd-efgh-jkmn')).toEqual({ game: GAME, profileId: ID })
    expect(await s.findByCode('ZZZZ-ZZZZ-ZZZZ')).toBeNull()
  })

  it('fetchLatest returns the newest revision or says the code is gone', async () => {
    serve = async () => updated(9)
    const s = createSyncServices(makeCtx())
    const latest = await s.fetchLatest(CODE)
    expect(latest.revision).toBe(9)
    expect(requests).toEqual([`https://share.test/v1/sync/${CODE}?since=0`])
    serve = async () => new Response(null, { status: 404 })
    await expect(s.fetchLatest(CODE)).rejects.toThrow(
      'No synced profile has that code. It may have ended.'
    )
  })

  it('tick prunes manual entries that are now installed', async () => {
    const manual = [
      { name: 'Paid', url: 'https://www.nexusmods.com/repo/mods/7' },
      { name: 'Other', url: 'https://www.nexusmods.com/repo/mods/8' }
    ]
    await writeManifest({
      mods: [nexusMod(7)],
      sync: { role: 'follower', code: CODE, revision: 3, manual }
    })
    const s = createSyncServices(makeCtx())
    await s.tick()
    expect(await readSync()).toEqual({
      role: 'follower',
      code: CODE,
      revision: 3,
      manual: [manual[1]]
    })
    expect(requests).toHaveLength(1)
    expect(ofType('sync-state')).toHaveLength(1)
  })

  it('tick keeps going when one profile fails', async () => {
    await writeManifest({ createdAt: '1', sync: { role: 'follower', code: CODE, revision: 3 } })
    const otherDir = paths.profileDir(GAME, 'p0')
    await mkdir(otherDir, { recursive: true })
    await writeFile(
      join(otherDir, 'hml-profile.json'),
      JSON.stringify({
        formatVersion: 1,
        id: 'p0',
        name: 'Zero',
        game: GAME,
        createdAt: '',
        mods: [],
        sync: { role: 'follower', code: 'ZZZZZZZZZZZZ', revision: 1 }
      })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      serve = async () => updated(4)
      vi.mocked(fakeFetch).mockRejectedValueOnce(new TypeError('offline'))
      const s = createSyncServices(makeCtx())
      await s.tick()
      expect(requests).toHaveLength(1)
      expect((await readSync())?.revision).toBe(4)
    } finally {
      warn.mockRestore()
    }
  })
})
