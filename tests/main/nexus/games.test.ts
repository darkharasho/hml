import { mkdtempSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNexusGames, nexusGameDef } from '../../../src/main/nexus/games'
import { makePaths, type AppPaths } from '../../../src/main/store/paths'
import { defaultSettings } from '../../../src/main/store/settings'
import type { NxClientOpts } from '../../../src/main/nexus/api'
import type { Catalog, GameDef } from '../../../src/shared/types'

let tmp: string
let paths: AppPaths
let clock: number
let calls: string[]
let handler: (body: string) => unknown

const client = (): NxClientOpts => ({
  fetch: (async (_url: string, init?: { body?: string }) => {
    calls.push(init?.body ?? '')
    const r = handler(init?.body ?? '')
    if (r instanceof Error) throw r
    return { ok: true, status: 200, headers: new Headers(), json: async () => r }
  }) as unknown as typeof fetch,
  appVersion: '1.0.0',
  os: { type: 'Linux', release: '6', arch: 'x64' }
})

const repo: GameDef = {
  ...nexusGameDef({ name: 'R.E.P.O.', domain: 'x' }),
  label: 'REPO',
  loader: 'bepinex'
}
const make = (): ReturnType<typeof createNexusGames> =>
  createNexusGames({ paths, client: client(), now: () => clock })

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-nxgames-'))
  paths = makePaths(tmp)
  clock = 1_000_000
  calls = []
  handler = () => ({
    data: { games: { nodes: [{ id: '7398', name: 'R.E.P.O.', domainName: 'repo' }] } }
  })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('domainFor', () => {
  it('resolves by name, caches, and re-checks after 7 days', async () => {
    const g = make()
    const s = defaultSettings()
    expect(await g.domainFor(repo, s)).toEqual({ domain: 'repo', gameId: 7398 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('EQUALS')
    await g.domainFor(repo, s)
    expect(calls).toHaveLength(1)
    clock += 7 * 24 * 3_600_000 + 1
    await g.domainFor(repo, s)
    expect(calls).toHaveLength(2)
  })

  it('an override with a known game id wins without a request', async () => {
    await fs.mkdir(path.dirname(paths.nxGames), { recursive: true })
    await fs.writeFile(
      paths.nxGames,
      JSON.stringify({ REPO: { domain: 'mine', gameId: 5, checkedAt: clock } })
    )
    const s = { ...defaultSettings(), nexusDomainOverrides: { REPO: 'mine' } }
    expect(await make().domainFor(repo, s)).toEqual({ domain: 'mine', gameId: 5 })
    expect(calls).toHaveLength(0)
  })

  it('caches a miss as null', async () => {
    handler = () => ({
      data: { games: { nodes: [{ id: '1', name: 'R.E.P.O.', domainName: 'other' }] } }
    })
    const g = make()
    expect(await g.domainFor(repo, defaultSettings())).toBeNull()
    expect(await g.domainFor(repo, defaultSettings())).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('uses the label suffix for deploy games and caches the id', async () => {
    handler = () => ({
      data: { game: { id: '1704', name: 'Skyrim SE', domainName: 'skyrimspecialedition' } }
    })
    const g = make()
    const sky = nexusGameDef({ name: 'Skyrim SE', domain: 'skyrimspecialedition' })
    expect(await g.domainFor(sky, defaultSettings())).toEqual({
      domain: 'skyrimspecialedition',
      gameId: 1704
    })
    await g.domainFor(sky, defaultSettings())
    expect(calls).toHaveLength(1)
    expect(await g.cachedDomain(sky, defaultSettings())).toBe('skyrimspecialedition')
  })
})

describe('nexusGameDef', () => {
  it('deploys Bethesda games into Data and everything else into the game folder', () => {
    const bethesda = [
      'skyrim',
      'skyrimspecialedition',
      'fallout4',
      'fallout3',
      'newvegas',
      'falloutnv',
      'oblivion',
      'morrowind',
      'starfield',
      'enderal',
      'enderalspecialedition'
    ]
    for (const domain of bethesda) {
      expect(nexusGameDef({ name: domain, domain }).deployRoot).toBe('Data')
    }
    for (const domain of ['stardewvalley', 'cyberpunk2077', 'baldursgate3']) {
      expect(nexusGameDef({ name: domain, domain })).not.toHaveProperty('deployRoot')
    }
  })
})

const emptyCatalog = (games: GameDef[]): Catalog => ({
  games,
  modloaderPackages: [],
  fetchedAt: ''
})

describe('searchExtra', () => {
  beforeEach(() => {
    handler = () => ({
      data: {
        games: {
          nodes: [
            { id: '1704', name: 'Skyrim SE', domainName: 'skyrimspecialedition', modCount: 9 },
            { id: '7398', name: 'R.E.P.O.', domainName: 'repo', modCount: 1 }
          ]
        }
      }
    })
  })

  it('returns deploy games and excludes domains of catalog games', async () => {
    await fs.mkdir(path.dirname(paths.nxGames), { recursive: true })
    await fs.writeFile(
      paths.nxGames,
      JSON.stringify({ REPO: { domain: 'repo', gameId: 7398, checkedAt: clock } })
    )
    const out = await make().searchExtra('sky', emptyCatalog([repo]), defaultSettings())
    expect(out.map((g) => g.label)).toEqual(['nexus-skyrimspecialedition'])
    expect(out[0].loader).toBe('deploy')
    expect(out[0].supported).toBe(true)
    expect(out[0].nexusModCount).toBe(9)
  })

  it('makes no request for short queries and swallows failures', async () => {
    const g = make()
    expect(await g.searchExtra(' s ', emptyCatalog([]), defaultSettings())).toEqual([])
    expect(calls).toHaveLength(0)
    handler = () => new Error('offline')
    expect(await g.searchExtra('sky', emptyCatalog([]), defaultSettings())).toEqual([])
  })
})

describe('addGame', () => {
  it('persists a validated game', async () => {
    handler = () => ({
      data: { game: { id: '1704', name: 'Skyrim SE', domainName: 'skyrimspecialedition' } }
    })
    const g = make()
    const def = await g.addGame('skyrimspecialedition')
    expect(def.label).toBe('nexus-skyrimspecialedition')
    await g.addGame('skyrimspecialedition')
    expect((await make().addedGames()).map((d) => d.label)).toEqual(['nexus-skyrimspecialedition'])
  })

  it('stores the mod count and uses it for the added game card', async () => {
    handler = () => ({
      data: {
        game: { id: '1704', name: 'Skyrim SE', domainName: 'skyrimspecialedition', modCount: 77 }
      }
    })
    const def = await make().addGame('skyrimspecialedition')
    expect(def.nexusModCount).toBe(77)
    expect((await make().addedGames())[0].nexusModCount).toBe(77)
  })

  it('rejects an unknown domain', async () => {
    handler = () => ({ data: { game: null }, errors: [{ extensions: { code: 'GAME_NOT_FOUND' } }] })
    await expect(make().addGame('nope')).rejects.toThrow('Nexus Mods has no game "nope".')
  })
})
