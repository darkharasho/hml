import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8 } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProfile, getProfile } from '../../../src/main/profiles/profiles'
import { zipHmlParts } from '../../../src/main/share/hmlFile'
import { createShareServices, type ShareContext } from '../../../src/main/share/service'
import { makePaths, type AppPaths } from '../../../src/main/store/paths'
import { createSyncServices } from '../../../src/main/sync/service'
import type { HmlExport, HmlExportMod } from '../../../src/shared/types'

const SYNC = 'ABCDEFGHJKMN'
const SHARE = '0123456789'
const CFG = 'BepInEx/config/a.cfg'

let root: string
let paths: AppPaths
let requests: string[]
let syncStatus: number
let mods: HmlExportMod[]
let syncApi: ReturnType<typeof createSyncServices>

const exp = (): HmlExport => ({ formatVersion: 1, game: 'repo', profileName: 'Friends', mods })
const data = (): Uint8Array =>
  zipHmlParts({ export: exp(), configs: new Map([[CFG, strToU8('[G]\nA = 1\n')]]) })

const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  requests.push(url)
  if (url.includes('/v1/sync/')) {
    if (syncStatus !== 200) return new Response(null, { status: syncStatus })
    return new Response(data() as BodyInit, { headers: { 'x-hml-revision': '6' } })
  }
  if (url.includes('/v1/profiles/')) return new Response(data() as BodyInit)
  return new Response(null, { status: 500 })
}) as unknown as typeof fetch

function make(
  withSync = true,
  found?: { game: string; profileId: string }
): ReturnType<typeof createShareServices> {
  const deps = {
    paths,
    fetch: fakeFetch,
    shareBaseUrl: 'https://share.test',
    emit: () => undefined
  } as never
  const sync = (syncApi = createSyncServices({
    deps,
    lock: (_g, _p, fn) => fn(),
    requireGame: async (label) => ({ label }) as never,
    getCustomGame: async () => null,
    isGameRunning: async () => false,
    apply: async () => {
      throw new Error('not used')
    }
  }))
  const ctx: ShareContext = {
    deps,
    getCatalog: async () => ({ games: [{ label: 'repo', displayName: 'R.E.P.O.' }] }) as never,
    requireGame: async (label) => ({ label }),
    serialize: (_g, _p, fn) => fn(),
    installers: {
      createProfile: (game: string, name: string) => createProfile(paths, game, name),
      tsGetPackage: async () => null,
      tsRefresh: async () => undefined
    } as never,
    findCustomGameByName: async () => undefined,
    findCustomGameByFolder: async () => undefined,
    isSteamAppInstalled: async () => false,
    getCustomGame: async () => null,
    describeMods: async () => [],
    ...(withSync
      ? {
          sync: {
            fetchLatest: sync.fetchLatest,
            findByCode: found ? async () => found : sync.findByCode,
            attachFollower: sync.attachFollower
          }
        }
      : {})
  }
  return createShareServices(ctx)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hml-sync-import-'))
  paths = makePaths(root)
  requests = []
  syncStatus = 200
  mods = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('sync code import', () => {
  it('previewShare of a sync code downloads the latest revision', async () => {
    const p = await make().previewShare({ code: 'abcd-efgh-jkmn' })
    expect(requests).toEqual([`https://share.test/v1/sync/${SYNC}?since=0`])
    expect(p).toMatchObject({
      game: 'repo',
      gameName: 'R.E.P.O.',
      profileName: 'Friends',
      configFiles: 1,
      sync: true
    })
    expect(p!.token).not.toBe('')
  })

  it('previewShare of a followed sync code returns existing without downloading', async () => {
    const share = make()
    const imported = await share.importShare(
      (await share.previewShare({ code: SYNC }))!.token,
      'Mine'
    )
    requests = []
    const p = await share.previewShare({ code: SYNC })
    expect(requests).toEqual([])
    expect(p).toEqual({
      token: '',
      game: 'repo',
      gameName: 'R.E.P.O.',
      profileName: 'Mine',
      mods: [],
      configFiles: 0,
      sync: true,
      existing: { game: 'repo', profileId: imported.profile.id }
    })
  })

  it('importShare of a sync code attaches the follower and writes bases', async () => {
    const share = make()
    const p = await share.previewShare({ code: SYNC })
    const r = await share.importShare(p!.token, '')
    expect(r.warnings).toEqual([])
    expect(r.profile.sync).toEqual({ role: 'follower', code: SYNC, revision: 6 })
    const dir = paths.profileDir('repo', r.profile.id)
    expect(await readFile(join(dir, '.hml-sync', 'base', ...CFG.split('/')), 'utf8')).toBe(
      '[G]\nA = 1\n'
    )
    expect(await readFile(join(dir, ...CFG.split('/')), 'utf8')).toBe('[G]\nA = 1\n')
  })

  it('an ended sync code says so', async () => {
    syncStatus = 410
    await expect(make().previewShare({ code: SYNC })).rejects.toThrow(
      'No synced profile has that code. It may have ended.'
    )
  })

  it('a sync code without syncing available is refused', async () => {
    await expect(make(false).previewShare({ code: SYNC })).rejects.toThrow(
      'Syncing is unavailable right now.'
    )
  })

  it('a share code still imports as before', async () => {
    const share = make()
    const p = await share.previewShare({ code: SHARE })
    expect(requests).toEqual([`https://share.test/v1/profiles/${SHARE}`])
    expect(p!.sync).toBeUndefined()
    const r = await share.importShare(p!.token, '')
    expect(r.warnings).toEqual([])
    expect((await getProfile(paths, 'repo', r.profile.id)).sync).toBeUndefined()
  })

  it('a sync import whose mods did not all install is retried by the next check', async () => {
    mods = [
      { source: { kind: 'thunderstore', fullName: 'Gone-Mod' }, version: '1.0.0', enabled: true }
    ]
    const share = make()
    const r = await share.importShare((await share.previewShare({ code: SYNC }))!.token, '')
    expect(r.unresolved).toHaveLength(1)
    expect(r.profile.sync).toEqual({ role: 'follower', code: SYNC, revision: 6, behind: true })
    requests = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await syncApi.checkFollower('repo', r.profile.id)
    } finally {
      warn.mockRestore()
    }
    expect(requests).toEqual([`https://share.test/v1/sync/${SYNC}?since=0`])
  })

  it("the owner's local mods don't mark a sync import behind", async () => {
    mods = [
      {
        source: { kind: 'local', fileName: 'x.zip', sha256: 'a'.repeat(64) },
        version: '1.0.0',
        enabled: true
      }
    ]
    const share = make()
    const r = await share.importShare((await share.previewShare({ code: SYNC }))!.token, '')
    expect(r.profile.sync).toEqual({ role: 'follower', code: SYNC, revision: 6 })
  })

  it('a followed profile deleted since it was found falls through to a normal preview', async () => {
    const share = make(true, { game: 'repo', profileId: 'gone' })
    const p = await share.previewShare({ code: SYNC })
    expect(p!.existing).toBeUndefined()
    expect(p!.token).not.toBe('')
    expect(requests).toEqual([`https://share.test/v1/sync/${SYNC}?since=0`])
  })
})
