import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecretPort } from '../../../src/main/secrets'
import { makePaths, type AppPaths } from '../../../src/main/store/paths'
import {
  SYNC_DEBOUNCE_MS,
  createSyncServices,
  type SyncContext,
  type SyncTimers
} from '../../../src/main/sync/service'
import type {
  HmlEvent,
  InstalledMod,
  ProfileManifest,
  ProfileSync
} from '../../../src/shared/types'

const CODE = 'ABCDEFGHJKMN'
const GAME = 'repo'
const ID = 'p1'
const CFG = ['BepInEx', 'config', 'a.cfg']

let root: string
let paths: AppPaths
let available: boolean
let events: HmlEvent[]
let requests: { method: string; url: string }[]
let putResponse: () => Promise<Response>
let revision: number
let timers: FakeTimers

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
  /** Runs every pending timer whose delay is `ms`. */
  fire(ms: number): void {
    for (const [id, t] of [...this.pending]) {
      if (t.ms !== ms) continue
      this.pending.delete(id)
      t.fn()
    }
  }
}

const rev = (s: string): string => s.split('').reverse().join('')
const secrets: SecretPort = {
  isAvailable: () => available,
  encrypt: (p) => Buffer.from(rev(p)),
  decrypt: (d) => rev(d.toString())
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  requests.push({ method, url: String(input) })
  if (method === 'POST') {
    return new Response(JSON.stringify({ code: CODE, ownerKey: 'owner-key', revision: 1 }), {
      status: 201
    })
  }
  if (method === 'PUT') return putResponse()
  if (method === 'DELETE') return new Response(null, { status: 200 })
  return new Response(null, { status: 500 })
}) as unknown as typeof fetch

const mod: InstalledMod = {
  id: 'm1',
  name: 'Mod',
  version: '1.0.0',
  source: { kind: 'thunderstore', fullName: 'o-Mod' },
  enabled: true,
  files: [],
  disableable: [],
  installedAt: ''
}
const localMod: InstalledMod = {
  ...mod,
  id: 'l1',
  source: { kind: 'local', fileName: 'x.zip' } as InstalledMod['source']
}

const profileDir = (): string => paths.profileDir(GAME, ID)
const manifestFile = (): string => join(profileDir(), 'hml-profile.json')

async function writeManifest(extra: Partial<ProfileManifest> = {}): Promise<void> {
  await mkdir(profileDir(), { recursive: true })
  const m: ProfileManifest = {
    formatVersion: 1,
    id: ID,
    name: 'P',
    game: GAME,
    createdAt: '',
    mods: [mod, localMod],
    ...extra
  }
  await writeFile(manifestFile(), JSON.stringify(m))
}
const readSync = async (): Promise<ProfileSync | undefined> =>
  (JSON.parse(await readFile(manifestFile(), 'utf8')) as ProfileManifest).sync

async function writeConfig(text: string): Promise<void> {
  await mkdir(join(profileDir(), ...CFG.slice(0, -1)), { recursive: true })
  await writeFile(join(profileDir(), ...CFG), text)
}

const exists = async (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false
  )

function makeCtx(): SyncContext {
  const boom = (): never => {
    throw new Error('not used')
  }
  return {
    deps: {
      paths,
      fetch: fakeFetch,
      secrets,
      shareBaseUrl: 'https://share.test',
      emit: (e: HmlEvent) => events.push(e)
    } as never,
    lock: (_g, _p, fn) => fn(),
    requireGame: async (label) => ({ label }) as never,
    getCustomGame: async () => null,
    isGameRunning: async () => false,
    apply: boom,
    timers
  }
}

const puts = (): number => requests.filter((r) => r.method === 'PUT').length
const syncEvents = (): number => events.filter((e) => e.type === 'sync-state').length

async function makeOwner(): Promise<ReturnType<typeof createSyncServices>> {
  const s = createSyncServices(makeCtx())
  await s.createSyncCode(GAME, ID)
  requests = []
  events = []
  return s
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hml-sync-owner-'))
  paths = makePaths(root)
  available = true
  events = []
  requests = []
  revision = 1
  timers = new FakeTimers()
  putResponse = async () => new Response(JSON.stringify({ revision: ++revision }), { status: 200 })
  vi.mocked(fakeFetch).mockClear()
  await writeManifest()
  await writeConfig('[General]\nA = 1\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('createSyncCode', () => {
  it('createSyncCode publishes revision 1 and stores the key and owner state', async () => {
    const s = createSyncServices(makeCtx())
    expect(await s.createSyncCode(GAME, ID)).toEqual({ code: CODE, localMods: 1 })
    expect(requests).toEqual([{ method: 'POST', url: 'https://share.test/v1/sync' }])
    const sync = await readSync()
    expect(sync).toMatchObject({ role: 'owner', code: CODE, revision: 1 })
    expect(sync && 'digest' in sync && sync.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(secrets.decrypt(await readFile(paths.syncKey(CODE)))).toBe('owner-key')
    expect(events).toContainEqual({ type: 'sync-state', game: GAME, profileId: ID })
  })

  it('createSyncCode returns the existing code for an owner profile', async () => {
    const s = await makeOwner()
    expect(await s.createSyncCode(GAME, ID)).toEqual({ code: CODE, localMods: 1 })
    expect(requests).toEqual([])
  })

  it('createSyncCode refuses without secure storage and never calls fetch', async () => {
    available = false
    const s = createSyncServices(makeCtx())
    await expect(s.createSyncCode(GAME, ID)).rejects.toThrow(
      "Secure storage isn't available on this system, so HML can't save sync codes."
    )
    expect(requests).toEqual([])
    expect(await readSync()).toBeUndefined()
  })

  it('createSyncCode refuses on a follower profile', async () => {
    await writeManifest({ sync: { role: 'follower', code: CODE, revision: 3 } })
    const s = createSyncServices(makeCtx())
    await expect(s.createSyncCode(GAME, ID)).rejects.toThrow(
      'Detach this profile from its sync before creating a sync code.'
    )
    expect(requests).toEqual([])
  })
})

describe('publishing', () => {
  it('touched debounces several edits into one publish after SYNC_DEBOUNCE_MS', async () => {
    const s = await makeOwner()
    await writeConfig('[General]\nA = 2\n')
    s.touched(GAME, ID)
    s.touched(GAME, ID)
    s.touched(GAME, ID)
    expect(timers.pending.size).toBe(1)
    expect([...timers.pending.values()][0].ms).toBe(SYNC_DEBOUNCE_MS)
    expect(requests).toEqual([])
    timers.fire(SYNC_DEBOUNCE_MS)
    await vi.waitFor(async () => expect((await readSync())?.revision).toBe(2))
    expect(puts()).toBe(1)
  })

  it('does not publish when only file timestamps change', async () => {
    const s = await makeOwner()
    await writeConfig('[General]\nA = 1\n')
    await s.publishNow(GAME, ID)
    expect(requests).toEqual([])
    expect(syncEvents()).toBe(0)
  })

  it('publishes when a config value changes', async () => {
    const s = await makeOwner()
    const before = await readSync()
    await writeConfig('[General]\nA = 5\n')
    await s.publishNow(GAME, ID)
    expect(requests).toEqual([{ method: 'PUT', url: `https://share.test/v1/sync/${CODE}` }])
    const after = await readSync()
    expect(after).toMatchObject({ role: 'owner', code: CODE, revision: 2 })
    expect(after && 'digest' in after && after.digest).not.toBe(
      before && 'digest' in before && before.digest
    )
    expect(syncEvents()).toBe(1)
  })

  it('a failed publish marks pending and the next publishNow retries', async () => {
    const s = await makeOwner()
    await writeConfig('[General]\nA = 5\n')
    putResponse = async () => new Response(null, { status: 500 })
    await s.publishNow(GAME, ID)
    expect(await readSync()).toMatchObject({ revision: 1, pending: true })
    expect(syncEvents()).toBe(1)
    putResponse = async () => new Response(JSON.stringify({ revision: 2 }), { status: 200 })
    await s.publishNow(GAME, ID)
    const sync = await readSync()
    expect(sync).toMatchObject({ revision: 2 })
    expect(sync && 'pending' in sync && sync.pending).toBeFalsy()
    expect(puts()).toBe(2)
  })

  it('a missing key marks the profile orphaned', async () => {
    const s = await makeOwner()
    await rm(paths.syncKey(CODE))
    await writeConfig('[General]\nA = 5\n')
    await s.publishNow(GAME, ID)
    expect(await readSync()).toMatchObject({ orphaned: true, pending: true })
    expect(requests).toEqual([])
    expect(syncEvents()).toBe(1)
  })

  it('a code the server has ended marks the profile orphaned', async () => {
    const s = await makeOwner()
    await writeConfig('[General]\nA = 5\n')
    putResponse = async () => new Response(null, { status: 410 })
    await s.publishNow(GAME, ID)
    expect(await readSync()).toMatchObject({ orphaned: true, revision: 1 })
  })

  it('secure storage unavailable at publish marks pending, not orphaned', async () => {
    const s = await makeOwner()
    available = false
    await writeConfig('[General]\nA = 5\n')
    await s.publishNow(GAME, ID)
    const sync = await readSync()
    expect(sync).toMatchObject({ pending: true })
    expect(sync && 'orphaned' in sync && sync.orphaned).toBeFalsy()
    expect(requests).toEqual([])
  })

  it('touched ignores the deploy lock key', async () => {
    const s = await makeOwner()
    s.touched(GAME, '__deploy__')
    expect(timers.pending.size).toBe(0)
  })

  it('touched during a publish leads to exactly one follow-up publish', async () => {
    const s = await makeOwner()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    putResponse = async () => {
      await gate
      return new Response(JSON.stringify({ revision: ++revision }), { status: 200 })
    }
    await writeConfig('[General]\nA = 5\n')
    const first = s.publishNow(GAME, ID)
    await vi.waitFor(() => expect(puts()).toBe(1))
    await writeConfig('[General]\nA = 6\n')
    s.touched(GAME, ID)
    s.touched(GAME, ID)
    timers.fire(SYNC_DEBOUNCE_MS)
    release()
    await first
    expect(puts()).toBe(2)
    expect(await readSync()).toMatchObject({ revision: 3 })
    await s.publishNow(GAME, ID)
    expect(puts()).toBe(2)
  })
})

describe('stopSync', () => {
  it('stopSync ends the code, deletes the key and clears sync', async () => {
    const s = await makeOwner()
    s.touched(GAME, ID)
    await s.stopSync(GAME, ID)
    expect(requests).toEqual([{ method: 'DELETE', url: `https://share.test/v1/sync/${CODE}` }])
    expect(await exists(paths.syncKey(CODE))).toBe(false)
    expect(await readSync()).toBeUndefined()
    expect(timers.pending.size).toBe(0)
    expect(events).toContainEqual({ type: 'sync-state', game: GAME, profileId: ID })
  })

  it('a network error keeps the owner state so the user can retry', async () => {
    const s = await makeOwner()
    vi.mocked(fakeFetch).mockRejectedValueOnce(new TypeError('offline'))
    await expect(s.stopSync(GAME, ID)).rejects.toThrow()
    expect(await readSync()).toMatchObject({ role: 'owner', code: CODE })
    expect(await exists(paths.syncKey(CODE))).toBe(true)
  })

  it('refuses on a follower profile', async () => {
    await writeManifest({ sync: { role: 'follower', code: CODE, revision: 3 } })
    const s = createSyncServices(makeCtx())
    await expect(s.stopSync(GAME, ID)).rejects.toThrow()
    expect(await readSync()).toMatchObject({ role: 'follower' })
  })

  it('stopSync during an in-flight publish does not resurrect the sync state', async () => {
    const s = await makeOwner()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    putResponse = async () => {
      await gate
      return new Response(JSON.stringify({ revision: ++revision }), { status: 200 })
    }
    await writeConfig('[General]\nA = 5\n')
    const publishing = s.publishNow(GAME, ID)
    await vi.waitFor(() => expect(puts()).toBe(1))
    await s.stopSync(GAME, ID)
    release()
    await publishing
    expect(await readSync()).toBeUndefined()
  })
})

describe('forgetOwnerKey', () => {
  it('deletes the key file', async () => {
    const s = await makeOwner()
    await s.forgetOwnerKey(CODE)
    expect(await exists(paths.syncKey(CODE))).toBe(false)
  })
})
