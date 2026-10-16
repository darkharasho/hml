import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createServices, type DialogPort, type ServiceDeps } from '../../src/main/services'
import { makePaths } from '../../src/main/store/paths'
import { loadCatalog } from '../../src/main/catalog/catalog'
import { createNexusServices } from '../../src/main/nexus/service'
import { createNexusGames } from '../../src/main/nexus/games'
import { createGithubServices } from '../../src/main/github/service'
import { saveProfile } from '../../src/main/profiles/profiles'
import { readHmlFile } from '../../src/main/share/hmlFile'
import { HML_METHODS } from '../../src/shared/ipc'
import type { HmlEvent, TsQuery } from '../../src/shared/types'

const hooks = vi.hoisted(() => ({
  rename: null as null | ((...a: unknown[]) => Promise<void>),
  getProfile: null as null | ((...a: unknown[]) => Promise<unknown>)
}))
vi.mock('../../src/main/profiles/profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/profiles/profiles')>()
  return {
    ...actual,
    renameProfile: (...a: Parameters<typeof actual.renameProfile>) =>
      hooks.rename ? hooks.rename(...a) : actual.renameProfile(...a),
    getProfile: (...a: Parameters<typeof actual.getProfile>) =>
      hooks.getProfile
        ? (hooks.getProfile(...a) as ReturnType<typeof actual.getProfile>)
        : actual.getProfile(...a)
  }
})

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '../fixtures/ecosystem-min.json'), 'utf8')
)

let tmp: string
let steamRoot: string
let gameDir: string
let picked: string[]
let saveTarget: string | null
let spawned: { cmd: string; args: string[] }[]
let execCalls: { file: string; args: string[] }[]
let deps: ServiceDeps
let emitted: HmlEvent[]

const dialog: DialogPort = {
  pickFiles: async () => picked,
  pickFolder: async () => null,
  saveFile: async () => saveTarget
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-services-'))
  steamRoot = path.join(tmp, 'steam')
  mkdirSync(path.join(steamRoot, 'steamapps', 'common', 'REPO'), { recursive: true })
  gameDir = path.join(steamRoot, 'steamapps', 'common', 'REPO')
  writeFileSync(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), '"libraryfolders"\n{\n}\n')
  writeFileSync(
    path.join(steamRoot, 'steamapps', 'appmanifest_3241660.acf'),
    '"AppState"\n{\n"installdir" "REPO"\n}\n'
  )
  picked = []
  saveTarget = null
  spawned = []
  execCalls = []
  const paths = makePaths(path.join(tmp, 'data'))
  mkdirSync(paths.root, { recursive: true })
  writeFileSync(paths.settings, JSON.stringify({ steamRootOverride: steamRoot }))
  emitted = []
  deps = {
    paths,
    appVersion: '1.0.0',
    os: { type: 'Linux', release: '6', arch: 'x64' },
    emit: (e) => emitted.push(e),
    nxmHandler: { status: async () => 'not-registered', register: async () => undefined },
    shareBaseUrl: 'https://share.test',
    fetch: (async () => ({ ok: true, json: async () => fixture })) as unknown as typeof fetch,
    snapshotPath: path.join(__dirname, '../fixtures/ecosystem-min.json'),
    platform: 'linux',
    home: tmp,
    secrets: {
      isAvailable: () => true,
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString()
    },
    dialog,
    shell: { openPath: async () => '', openExternal: async () => undefined },
    execFile: async (file, args) => {
      execCalls.push({ file, args })
      throw new Error('reg is not available in tests')
    },
    spawn: ((cmd: string, args: string[]) => {
      spawned.push({ cmd, args })
      const child = new EventEmitter() as EventEmitter & { unref(): void }
      child.unref = () => undefined
      process.nextTick(() => child.emit('spawn'))
      return child
    }) as unknown as ServiceDeps['spawn']
  }
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('services', () => {
  test('searchGames returns catalog games', async () => {
    const api = createServices(deps)
    const games = await api.searchGames('repo')
    expect(games.map((g) => g.label)).toContain('repo')
    expect(games.find((g) => g.label === 'repo')?.installDir).toBe(gameDir)
  })

  test('getGame returns one summary without a Nexus search, null when unknown', async () => {
    const urls: string[] = []
    const base = deps.fetch
    deps.fetch = (async (url: string, init?: unknown) => {
      urls.push(String(url))
      return (base as (u: string, i?: unknown) => Promise<Response>)(url, init)
    }) as unknown as typeof fetch
    const api = createServices(deps)
    expect(await api.getGame('repo')).toMatchObject({ label: 'repo', installDir: gameDir })
    expect(await api.getGame('nope')).toBeNull()
    expect(urls.some((u) => u.includes('graphql'))).toBe(false)
  })

  test('addNexusGame persists a Nexus-only game, searchGames appends extras, domains validate', async () => {
    const nx = (game: unknown): unknown => ({ data: { game } })
    deps.fetch = (async (url: string, init?: { body?: string }) => {
      const body = init?.body ?? ''
      let json: unknown = fixture
      if (url.includes('graphql')) {
        if (body.includes('game(domainName:\\"skyrimspecialedition\\")'))
          json = nx({ id: '1704', name: 'Skyrim SE', domainName: 'skyrimspecialedition' })
        else if (body.includes('game(domainName:'))
          json = { data: { game: null }, errors: [{ extensions: { code: 'GAME_NOT_FOUND' } }] }
        else
          json = {
            data: {
              games: {
                nodes: [
                  { id: '1704', name: 'Skyrim SE', domainName: 'skyrimspecialedition', modCount: 1 }
                ]
              }
            }
          }
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => json }
    }) as unknown as typeof fetch
    const api = createServices(deps)
    const extra = (await api.searchGames('sky')).find(
      (g) => g.label === 'nexus-skyrimspecialedition'
    )
    expect(extra).toMatchObject({ loader: 'deploy', installDir: null, loaderPackageIds: [] })
    const added = await api.addNexusGame('skyrimspecialedition')
    expect(added.label).toBe('nexus-skyrimspecialedition')
    expect(await api.listProfiles('nexus-skyrimspecialedition')).toEqual([])
    await expect(api.addNexusGame('nope')).rejects.toThrow('Nexus Mods has no game "nope".')

    await api.nxSetDomain('repo', 'skyrimspecialedition')
    expect((await api.getSettings()).nexusDomainOverrides).toEqual({ repo: 'skyrimspecialedition' })
    expect(await api.nxGetDomain('repo')).toBe('skyrimspecialedition')
    await expect(api.nxSetDomain('repo', 'nope')).rejects.toThrow('Nexus Mods has no game "nope".')
    await api.nxSetDomain('repo', null)
    expect((await api.getSettings()).nexusDomainOverrides).toEqual({})
    await expect(api.nxSetDomain('nexus-skyrimspecialedition', 'skyrim')).rejects.toThrow(
      'Nexus-only games always use their own Nexus domain.'
    )
  })

  test('a saveSettings during a slow nxSetDomain keeps both changes', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let asked!: () => void
    const reached = new Promise<void>((r) => (asked = r))
    deps.fetch = (async (url: string) => {
      if (url.includes('graphql')) {
        asked()
        await gate
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            data: { game: { id: '1', name: 'Skyrim SE', domainName: 'skyrimspecialedition' } }
          })
        }
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => fixture }
    }) as unknown as typeof fetch
    const api = createServices(deps)
    const slow = api.nxSetDomain('repo', 'skyrimspecialedition')
    await reached
    await api.saveSettings({ ...(await api.getSettings()), lastGame: 'repo' })
    release()
    await slow
    const s = await api.getSettings()
    expect(s.nexusDomainOverrides).toEqual({ repo: 'skyrimspecialedition' })
    expect(s.lastGame).toBe('repo')
  })

  test('saveSettings keeps the path and domain overrides already on disk', async () => {
    const api = createServices(deps)
    await api.setGamePath('repo', gameDir)
    await api.saveSettings({
      ...(await api.getSettings()),
      gamePathOverrides: {},
      nexusDomainOverrides: {},
      lastGame: 'repo'
    })
    const s = await api.getSettings()
    expect(s.gamePathOverrides).toEqual({ repo: gameDir })
    expect(s.lastGame).toBe('repo')
  })

  test('deployment api: exact errors, warnings, deploy and remove', async () => {
    deps.fetch = (async (url: string) => {
      const json = url.includes('graphql')
        ? { data: { game: { id: '1', name: 'Skyrim SE', domainName: 'skyrimspecialedition' } } }
        : fixture
      return { ok: true, status: 200, headers: new Headers(), json: async () => json }
    }) as unknown as typeof fetch
    const api = createServices(deps)
    const label = 'nexus-skyrimspecialedition'
    await api.addNexusGame('skyrimspecialedition')
    const profile = await api.createProfile(label, 'p')
    await expect(api.deployProfile(label, profile.id)).rejects.toThrow('Set the game folder first.')
    // Without a folder and without a deployment there is nothing to show or remove.
    await expect(api.removeDeployment(label)).resolves.toBeUndefined()
    expect(await api.getDeployment(label)).toBeNull()
    expect(await api.getLaunchWarnings(label, profile.id)).toEqual(['game-not-found'])
    for (const call of [
      () => api.deployProfile('repo', 'x'),
      () => api.removeDeployment('repo'),
      () => api.getDeployment('repo')
    ]) {
      await expect(call()).rejects.toThrow("R.E.P.O. doesn't use deployment.")
    }
    await expect(api.launch(label, profile.id, 'modded')).rejects.toThrow(
      "HML doesn't launch Skyrim SE. Deploy mods, then start the game as usual."
    )

    const dir = path.join(tmp, 'skyrim')
    mkdirSync(dir)
    await api.setGamePath(label, dir)
    expect(await api.getLaunchWarnings(label, profile.id)).toEqual([])
    expect(await api.getDeployment(label)).toBeNull()
    const zip = zipSync({ 'Data/a.esp': strToU8('esp') })
    const file = path.join(tmp, 'm.zip')
    writeFileSync(file, zip)
    picked = [file]
    await api.installFromFile(label, profile.id)
    const status = await api.deployProfile(label, profile.id)
    expect(status).toMatchObject({ profileId: profile.id, profileName: 'p', files: 1 })
    expect(readFileSync(path.join(dir, 'Data/a.esp'), 'utf8')).toBe('esp')
    expect(await api.getDeployment(label)).toMatchObject({ files: 1 })
    await api.removeDeployment(label)
    expect(existsSync(path.join(dir, 'Data'))).toBe(false)
    expect(await api.getDeployment(label)).toBeNull()

    // Clearing the folder setting while deployed: the deployment still shows and removes from
    // the folder recorded at deploy time.
    await api.deployProfile(label, profile.id)
    await api.setGamePath(label, null)
    expect(await api.getDeployment(label)).toMatchObject({ files: 1 })
    await api.removeDeployment(label)
    expect(existsSync(path.join(dir, 'Data'))).toBe(false)
    expect(await api.getDeployment(label)).toBeNull()
  })

  /** Nexus responses for any domain: the game is named after its domain. */
  const nexusFetch = (async (url: string, init?: { body?: string }) => {
    const domain = /domainName:\\"([a-z0-9_-]+)\\"/.exec(init?.body ?? '')?.[1] ?? 'x'
    const json = url.includes('graphql')
      ? { data: { game: { id: '1', name: `Game ${domain}`, domainName: domain } } }
      : fixture
    return { ok: true, status: 200, headers: new Headers(), json: async () => json }
  }) as unknown as typeof fetch

  test('a mod change on the deployed profile queued during remove runs after the copy-back', async () => {
    deps.fetch = nexusFetch
    const api = createServices(deps)
    const label = 'nexus-aaa'
    await api.addNexusGame('aaa')
    const profile = await api.createProfile(label, 'p')
    const dir = path.join(tmp, 'aaa')
    mkdirSync(dir)
    await api.setGamePath(label, dir)
    const file = path.join(tmp, 'm.zip')
    writeFileSync(file, zipSync({ 'Data/a.esp': strToU8('esp') }))
    const [mod] = await api.installFromPaths(label, profile.id, [file])
    await api.deployProfile(label, profile.id)
    writeFileSync(path.join(dir, 'Data/a.esp'), 'changed in game')

    // Hold the remove inside copy-back (its first profile read), then queue an uninstall.
    let reached!: () => void
    const inCopyBack = new Promise<void>((r) => (reached = r))
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { getProfile } = await vi.importActual<typeof import('../../src/main/profiles/profiles')>(
      '../../src/main/profiles/profiles'
    )
    hooks.getProfile = async (...a) => {
      hooks.getProfile = null
      reached()
      await gate
      return getProfile(...(a as Parameters<typeof getProfile>))
    }
    const order: string[] = []
    const removing = api.removeDeployment(label).then(() => order.push('remove'))
    await inCopyBack
    const uninstalling = api
      .uninstallMod(label, profile.id, mod.id)
      .then(() => order.push('uninstall'))
    await new Promise((r) => setTimeout(r, 50))
    release()
    await Promise.all([removing, uninstalling])
    expect(order).toEqual(['remove', 'uninstall'])
    expect(existsSync(path.join(dir, 'Data'))).toBe(false)
    expect((await api.listProfiles(label))[0].mods).toEqual([])
  })

  test('deploying another profile removes the old deployment under its own profile lock', async () => {
    deps.fetch = nexusFetch
    const api = createServices(deps)
    const label = 'nexus-aaa'
    await api.addNexusGame('aaa')
    const a = await api.createProfile(label, 'a')
    const b = await api.createProfile(label, 'b')
    const dir = path.join(tmp, 'aaa')
    mkdirSync(dir)
    await api.setGamePath(label, dir)
    const file = path.join(tmp, 'm.zip')
    writeFileSync(file, zipSync({ 'Data/a.esp': strToU8('esp') }))
    const [mod] = await api.installFromPaths(label, a.id, [file])
    await api.deployProfile(label, a.id)
    writeFileSync(path.join(dir, 'Data/a.esp'), 'changed in game')

    let reached!: () => void
    const inCopyBack = new Promise<void>((r) => (reached = r))
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { getProfile } = await vi.importActual<typeof import('../../src/main/profiles/profiles')>(
      '../../src/main/profiles/profiles'
    )
    hooks.getProfile = async (...a2) => {
      // Gate profile a's read in copy-back, not the up-front check of profile b.
      if (a2[2] !== a.id) return getProfile(...(a2 as Parameters<typeof getProfile>))
      hooks.getProfile = null
      reached()
      await gate
      return getProfile(...(a2 as Parameters<typeof getProfile>))
    }
    const order: string[] = []
    const deploying = api.deployProfile(label, b.id).then(() => order.push('deploy b'))
    await inCopyBack
    const uninstalling = api.uninstallMod(label, a.id, mod.id).then(() => order.push('uninstall a'))
    await new Promise((r) => setTimeout(r, 50))
    expect(order).toEqual([])
    release()
    await Promise.all([deploying, uninstalling])
    expect(await api.getDeployment(label)).toMatchObject({ profileId: b.id, files: 0 })
    expect((await api.listProfiles(label)).find((p) => p.id === a.id)?.mods).toEqual([])
  })

  test('deploying a missing profile or into a missing folder leaves the current deployment', async () => {
    deps.fetch = nexusFetch
    const api = createServices(deps)
    const label = 'nexus-aaa'
    await api.addNexusGame('aaa')
    const a = await api.createProfile(label, 'a')
    const b = await api.createProfile(label, 'b')
    const dir = path.join(tmp, 'aaa')
    mkdirSync(dir)
    await api.setGamePath(label, dir)
    const file = path.join(tmp, 'm.zip')
    writeFileSync(file, zipSync({ 'Data/a.esp': strToU8('esp') }))
    await api.installFromPaths(label, a.id, [file])
    await api.deployProfile(label, a.id)
    await expect(api.deployProfile(label, 'nope')).rejects.toThrow(
      `Profile not found: ${label}/nope`
    )
    expect(await api.getDeployment(label)).toMatchObject({ profileId: a.id, files: 1 })
    expect(readFileSync(path.join(dir, 'Data/a.esp'), 'utf8')).toBe('esp')
    // A game folder setting that is no longer a folder (the deployment's own folder is intact).
    const elsewhere = path.join(tmp, 'gone')
    await api.setGamePath(label, elsewhere)
    await expect(api.deployProfile(label, b.id)).rejects.toThrow(
      `The game folder ${elsewhere} doesn't exist.`
    )
    expect(await api.getDeployment(label)).toMatchObject({ profileId: a.id, files: 1 })
    expect(readFileSync(path.join(dir, 'Data/a.esp'), 'utf8')).toBe('esp')
  })

  test('two deploy games can not deploy to one folder', async () => {
    deps.fetch = nexusFetch
    const api = createServices(deps)
    await api.addNexusGame('aaa')
    await api.addNexusGame('bbb')
    const a = await api.createProfile('nexus-aaa', 'a')
    const b = await api.createProfile('nexus-bbb', 'b')
    const dir = path.join(tmp, 'shared')
    mkdirSync(dir)
    // Pointing both at the folder is fine while nothing is deployed.
    await api.setGamePath('nexus-aaa', dir)
    await api.setGamePath('nexus-bbb', dir)
    const file = path.join(tmp, 'm.zip')
    writeFileSync(file, zipSync({ 'Data/a.esp': strToU8('esp') }))
    await api.installFromPaths('nexus-aaa', a.id, [file])
    await api.installFromPaths('nexus-bbb', b.id, [file])
    await api.deployProfile('nexus-aaa', a.id)
    const msg = 'Game aaa has mods deployed to this folder. Remove them in HML first.'
    await expect(api.deployProfile('nexus-bbb', b.id)).rejects.toThrow(msg)
    expect(await api.getDeployment('nexus-bbb')).toBeNull()
    expect(readFileSync(path.join(dir, 'Data/a.esp'), 'utf8')).toBe('esp')
    // The same folder by another path (a symlink) is the same folder.
    const link = path.join(tmp, 'link')
    symlinkSync(dir, link)
    await api.setGamePath('nexus-bbb', null)
    await expect(api.setGamePath('nexus-bbb', link)).rejects.toThrow(msg)
    await expect(api.setGamePath('nexus-bbb', dir + path.sep)).rejects.toThrow(msg)
    expect((await api.getSettings()).gamePathOverrides['nexus-bbb']).toBeUndefined()
    // The game that owns the deployment can keep its folder.
    await api.setGamePath('nexus-aaa', dir)
    await api.removeDeployment('nexus-aaa')
    await api.setGamePath('nexus-bbb', link)
    await api.deployProfile('nexus-bbb', b.id)
    expect(await api.getDeployment('nexus-bbb')).toMatchObject({ files: 1 })
  })

  test('a deploy game whose folder is gone or is a file shows as not found', async () => {
    deps.fetch = nexusFetch
    const api = createServices(deps)
    const label = 'nexus-aaa'
    await api.addNexusGame('aaa')
    const profile = await api.createProfile(label, 'p')
    const dir = path.join(tmp, 'aaa')
    mkdirSync(dir)
    await api.setGamePath(label, dir)
    const installDir = async (): Promise<string | null | undefined> =>
      (await api.searchGames('aaa')).find((g) => g.label === label)?.installDir
    expect(await installDir()).toBe(dir)
    expect(await api.getLaunchWarnings(label, profile.id)).toEqual([])
    rmSync(dir, { recursive: true })
    expect(await installDir()).toBeNull()
    expect(await api.getLaunchWarnings(label, profile.id)).toEqual(['game-not-found'])
    writeFileSync(dir, 'a file')
    expect(await installDir()).toBeNull()
    expect(await api.getLaunchWarnings(label, profile.id)).toEqual(['game-not-found'])
  })

  test('installFromFile installs selected zip as local source with sha256', async () => {
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Test')
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Cool', version_number: '1.2.3' })),
      'Cool.dll': strToU8('dll')
    })
    const file = path.join(tmp, 'Cool.zip')
    writeFileSync(file, zip)
    picked = [file]
    const mods = await api.installFromFile('repo', profile.id)
    expect(mods).toHaveLength(1)
    expect(mods[0].source).toEqual({
      kind: 'local',
      fileName: 'Cool.zip',
      sha256: createHash('sha256').update(zip).digest('hex')
    })
    expect((await api.listProfiles('repo'))[0].mods).toHaveLength(1)
  })

  test('installFromFile returns [] on cancel and names the failing file', async () => {
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Test')
    expect(await api.installFromFile('repo', profile.id)).toEqual([])
    const bad = path.join(tmp, 'bad.zip')
    writeFileSync(bad, 'not a zip')
    picked = [bad]
    await expect(api.installFromFile('repo', profile.id)).rejects.toThrow(/bad\.zip/)
  })

  test('installFromPaths installs dropped zips as local source with sha256', async () => {
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Test')
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Dropped', version_number: '0.1.0' })),
      'Dropped.dll': strToU8('dll')
    })
    const file = path.join(tmp, 'Dropped.ZIP')
    writeFileSync(file, zip)
    const mods = await api.installFromPaths('repo', profile.id, [file])
    expect(mods).toHaveLength(1)
    expect(mods[0].source).toEqual({
      kind: 'local',
      fileName: 'Dropped.ZIP',
      sha256: createHash('sha256').update(zip).digest('hex')
    })
    expect((await api.listProfiles('repo'))[0].mods).toHaveLength(1)
  })

  test('installFromPaths rejects non-zip, relative, missing and directory paths', async () => {
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Test')
    const txt = path.join(tmp, 'notes.txt')
    writeFileSync(txt, 'hi')
    const dir = path.join(tmp, 'folder.zip')
    mkdirSync(dir)
    await expect(api.installFromPaths('repo', profile.id, [txt])).rejects.toThrow(
      /notes\.txt.*\.zip/
    )
    await expect(api.installFromPaths('repo', profile.id, ['rel/Mod.zip'])).rejects.toThrow(
      /absolute/
    )
    await expect(
      api.installFromPaths('repo', profile.id, [path.join(tmp, 'missing.zip')])
    ).rejects.toThrow(/missing\.zip/)
    await expect(api.installFromPaths('repo', profile.id, [dir])).rejects.toThrow(/folder\.zip/)
    await expect(
      api.installFromPaths('repo', profile.id, 'x' as unknown as string[])
    ).rejects.toThrow()
    expect((await api.listProfiles('repo'))[0].mods).toHaveLength(0)
  })

  test('launch modded spawns steam with doorstop args', async () => {
    writeFileSync(path.join(gameDir, 'REPO.exe'), '')
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Test')
    await api.launch('repo', profile.id, 'modded')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].cmd).toBe('steam')
    expect(spawned[0].args.slice(0, 4)).toEqual([
      '-applaunch',
      '3241660',
      '--doorstop-enable',
      'true'
    ])
  })

  test('vanilla launch detects doorstop 4 from the game install dir', async () => {
    writeFileSync(path.join(gameDir, 'REPO.exe'), '')
    writeFileSync(path.join(gameDir, 'doorstop_config.ini'), '[General]\nenabled = true\n')
    const api = createServices(deps)
    await api.launch('repo', null, 'vanilla')
    expect(spawned).toEqual([
      { cmd: 'steam', args: ['-applaunch', '3241660', '--doorstop-enabled', 'false'] }
    ])
  })

  test('vanilla launch with a profile still reads the game install dir ini', async () => {
    writeFileSync(path.join(gameDir, 'REPO.exe'), '')
    writeFileSync(path.join(gameDir, 'doorstop_config.ini'), '[General]\nenabled = true\n')
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Test')
    await api.launch('repo', profile.id, 'vanilla')
    expect(spawned[0].args).toEqual(['-applaunch', '3241660', '--doorstop-enabled', 'false'])
  })

  test('modded launch still detects doorstop from the profile ini', async () => {
    writeFileSync(path.join(gameDir, 'REPO.exe'), '')
    writeFileSync(path.join(gameDir, 'doorstop_config.ini'), '[General]\nenabled = true\n')
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Test')
    await api.launch('repo', profile.id, 'modded')
    expect(spawned[0].args.slice(2, 4)).toEqual(['--doorstop-enable', 'true'])
  })

  test('modded launch of a native Linux game is a readable error; vanilla still works', async () => {
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Test')
    await expect(api.launch('repo', profile.id, 'modded')).rejects.toThrow(
      "Native Linux games aren't supported for modded launch yet. Force Proton for this game in Steam (Properties → Compatibility)."
    )
    expect(spawned).toHaveLength(0)
    expect(await api.getLaunchWarnings('repo', profile.id)).toContain('native-linux-unsupported')
    await api.launch('repo', null, 'vanilla')
    expect(spawned).toHaveLength(1)
  })

  describe('windows registry Steam lookup', () => {
    test('uses HKCU SteamPath from reg query before the default path', async () => {
      writeFileSync(deps.paths.settings, JSON.stringify({ steamRootOverride: null }))
      const api = createServices({
        ...deps,
        platform: 'win32',
        execFile: async (file, args) => {
          execCalls.push({ file, args })
          return {
            stdout: `\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    ${steamRoot}\r\n`
          }
        }
      })
      expect((await api.searchGames('repo'))[0].installDir).toBe(gameDir)
      expect(execCalls).toEqual([
        { file: 'reg', args: ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'] }
      ])
    })

    test('a failing reg query falls back to the default path', async () => {
      writeFileSync(deps.paths.settings, JSON.stringify({ steamRootOverride: null }))
      const api = createServices({ ...deps, platform: 'win32' })
      expect((await api.searchGames('repo'))[0].installDir).toBeNull()
      expect(execCalls).toHaveLength(1)
    })

    test('reg is not queried on linux', async () => {
      writeFileSync(deps.paths.settings, JSON.stringify({ steamRootOverride: null }))
      await createServices(deps).searchGames('repo')
      expect(execCalls).toHaveLength(0)
    })
  })

  test('flatpak Steam adds the flatpak-filesystem warning and exposes the games data dir', async () => {
    const flatpakRoot = path.join(
      tmp,
      '.var',
      'app',
      'com.valvesoftware.Steam',
      '.local',
      'share',
      'Steam'
    )
    const flatpakGame = path.join(flatpakRoot, 'steamapps', 'common', 'REPO')
    mkdirSync(flatpakGame, { recursive: true })
    writeFileSync(
      path.join(flatpakRoot, 'steamapps', 'libraryfolders.vdf'),
      '"libraryfolders"\n{\n}\n'
    )
    writeFileSync(
      path.join(flatpakRoot, 'steamapps', 'appmanifest_3241660.acf'),
      '"AppState"\n{\n"installdir" "REPO"\n}\n'
    )
    writeFileSync(path.join(flatpakGame, 'REPO.exe'), '')
    writeFileSync(deps.paths.settings, JSON.stringify({ steamRootOverride: null }))
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Test')
    expect(await api.getLaunchWarnings('repo', profile.id)).toContain('flatpak-filesystem')
    expect(await api.getGamesDataDir()).toBe(path.join(deps.paths.root, 'games'))
    // Warning only: the modded launch still goes ahead.
    await api.launch('repo', profile.id, 'modded')
    expect(spawned[0].cmd).toBe('flatpak')
  })

  test('a Flatpak override that grants the games folder drops the flatpak-filesystem warning', async () => {
    const flatpakRoot = path.join(
      tmp,
      '.var',
      'app',
      'com.valvesoftware.Steam',
      '.local',
      'share',
      'Steam'
    )
    const flatpakGame = path.join(flatpakRoot, 'steamapps', 'common', 'REPO')
    mkdirSync(flatpakGame, { recursive: true })
    writeFileSync(
      path.join(flatpakRoot, 'steamapps', 'libraryfolders.vdf'),
      '"libraryfolders"\n{\n}\n'
    )
    writeFileSync(
      path.join(flatpakRoot, 'steamapps', 'appmanifest_3241660.acf'),
      '"AppState"\n{\n"installdir" "REPO"\n}\n'
    )
    writeFileSync(path.join(flatpakGame, 'REPO.exe'), '')
    writeFileSync(deps.paths.settings, JSON.stringify({ steamRootOverride: null }))
    const systemDir = path.join(tmp, 'flatpak-system')
    const userDir = path.join(tmp, '.local', 'share', 'flatpak', 'overrides')
    mkdirSync(systemDir, { recursive: true })
    mkdirSync(userDir, { recursive: true })
    const api = createServices({ ...deps, flatpakSystemOverridesDir: systemDir })
    const profile = await api.createProfile('repo', 'Test')
    const warnings = (): Promise<string[]> => api.getLaunchWarnings('repo', profile.id)
    expect(await warnings()).toContain('flatpak-filesystem')
    const app = 'com.valvesoftware.Steam'
    writeFileSync(path.join(userDir, app), `[Context]\nfilesystems=${deps.paths.gamesDir}\n`)
    expect(await warnings()).not.toContain('flatpak-filesystem')
    writeFileSync(path.join(userDir, app), '')
    writeFileSync(path.join(systemDir, app), '[Context]\nfilesystems=host\n')
    expect(await warnings()).not.toContain('flatpak-filesystem')
    writeFileSync(path.join(userDir, app), '[Context]\nfilesystems=!host\n')
    expect(await warnings()).toContain('flatpak-filesystem')
  })

  test('native Steam has no flatpak-filesystem warning', async () => {
    writeFileSync(path.join(gameDir, 'REPO.exe'), '')
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Test')
    expect(await api.getLaunchWarnings('repo', profile.id)).not.toContain('flatpak-filesystem')
  })

  test('launch modded without a profile is a readable error', async () => {
    await expect(createServices(deps).launch('repo', null, 'modded')).rejects.toThrow(/profile/i)
    expect(spawned).toHaveLength(0)
  })

  test('launch fails readably when Steam is missing', async () => {
    writeFileSync(deps.paths.settings, JSON.stringify({ steamRootOverride: null }))
    const api = createServices({ ...deps, home: path.join(tmp, 'nohome') })
    const profile = await api.createProfile('repo', 'Test')
    await expect(api.launch('repo', profile.id, 'modded')).rejects.toThrow(/Steam was not found/)
  })

  test('setGamePath overrides the install dir and rejects unknown games', async () => {
    const api = createServices(deps)
    expect((await api.searchGames('repo'))[0].installDir).toBe(gameDir)
    const other = path.join(tmp, 'elsewhere')
    mkdirSync(other)
    await api.setGamePath('repo', other)
    expect((await api.searchGames('repo'))[0].installDir).toBe(other)
    await expect(api.setGamePath('nope', other)).rejects.toThrow(/Unknown game/)
  })

  test('saveSettings invalidates the cached steam root on the same instance', async () => {
    const api = createServices(deps)
    expect((await api.searchGames('repo'))[0].installDir).toBe(gameDir)
    const steam2 = path.join(tmp, 'steam2')
    const game2 = path.join(steam2, 'steamapps', 'common', 'REPO')
    mkdirSync(game2, { recursive: true })
    writeFileSync(path.join(steam2, 'steamapps', 'libraryfolders.vdf'), '"libraryfolders"\n{\n}\n')
    writeFileSync(
      path.join(steam2, 'steamapps', 'appmanifest_3241660.acf'),
      '"AppState"\n{\n"installdir" "REPO"\n}\n'
    )
    await api.saveSettings({ ...(await api.getSettings()), steamRootOverride: steam2 })
    expect((await api.searchGames('repo'))[0].installDir).toBe(game2)
  })

  test('saveSettings refuses a new Steam folder without steamapps/libraryfolders.vdf', async () => {
    const api = createServices(deps)
    const before = readFileSync(deps.paths.settings, 'utf8')
    const empty = path.join(tmp, 'not-steam')
    mkdirSync(empty, { recursive: true })
    await expect(
      api.saveSettings({ ...(await api.getSettings()), steamRootOverride: empty })
    ).rejects.toThrow(
      "That folder doesn't look like Steam: it has no steamapps/libraryfolders.vdf."
    )
    expect(readFileSync(deps.paths.settings, 'utf8')).toBe(before)
    // Clearing the override, or saving the unchanged one, needs no check.
    await api.saveSettings({ ...(await api.getSettings()), steamRootOverride: null })
    await api.saveSettings({ ...(await api.getSettings()), steamRootOverride: null })
  })

  test('a Steam root that appears after the first lookup is found on the next', async () => {
    writeFileSync(deps.paths.settings, JSON.stringify({ steamRootOverride: null }))
    const late = path.join(tmp, 'late-home')
    const api = createServices({ ...deps, home: late })
    expect((await api.searchGames('repo'))[0].installDir).toBeNull()
    const lateRoot = path.join(late, '.steam', 'steam')
    mkdirSync(path.join(lateRoot, 'steamapps', 'common', 'REPO'), { recursive: true })
    writeFileSync(
      path.join(lateRoot, 'steamapps', 'libraryfolders.vdf'),
      '"libraryfolders"\n{\n}\n'
    )
    writeFileSync(
      path.join(lateRoot, 'steamapps', 'appmanifest_3241660.acf'),
      '"AppState"\n{\n"installdir" "REPO"\n}\n'
    )
    expect((await api.searchGames('repo'))[0].installDir).toBe(
      path.join(lateRoot, 'steamapps', 'common', 'REPO')
    )
  })

  test('saveSettings drops unknown keys and non-string values', async () => {
    const api = createServices(deps)
    await api.saveSettings({
      gamePathOverrides: { repo: '/a', bad: 5 },
      steamRootOverride: null,
      lastGame: 7,
      lastProfile: {},
      evil: true
    } as never)
    expect(JSON.parse(readFileSync(deps.paths.settings, 'utf8'))).toEqual({
      gamePathOverrides: {},
      steamRootOverride: null,
      lastGame: null,
      lastProfile: {},
      nexusDomainOverrides: {}
    })
  })

  test('launch rejects an unknown mode', async () => {
    await expect(createServices(deps).launch('repo', 'x', 'turbo' as never)).rejects.toThrow(
      /launch mode/i
    )
  })

  describe('searchGames ordering', () => {
    function catalogWith(games: Record<string, string>): typeof fetch {
      const base = fixture.games.repo
      const out: Record<string, unknown> = {}
      for (const [label, displayName] of Object.entries(games)) {
        const g = structuredClone(base)
        g.label = label
        g.meta.displayName = displayName
        // Unknown app ids keep Steam detection from marking every clone installed.
        g.distributions[0].identifier = `9${Object.keys(out).length}`
        g.r2modman[0].additionalSearchStrings = []
        g.r2modman[0].meta.displayName = displayName
        out[label] = g
      }
      return (async () => ({
        ok: true,
        json: async () => ({ ...fixture, games: out })
      })) as unknown as typeof fetch
    }
    async function install(
      api: ReturnType<typeof createServices>,
      labels: string[]
    ): Promise<void> {
      const overrides: Record<string, string> = {}
      for (const l of labels) {
        overrides[l] = path.join(tmp, `dir-${l}`)
        mkdirSync(overrides[l], { recursive: true })
      }
      for (const [l, dir] of Object.entries(overrides)) await api.setGamePath(l, dir)
    }

    test('a non-installed exact match beats an installed substring match', async () => {
      const api = createServices({
        ...deps,
        fetch: catalogWith({ exact: 'Foo', sub: 'Big Foo Game' })
      })
      await install(api, ['sub'])
      expect((await api.searchGames('foo')).map((g) => g.label)).toEqual(['exact', 'sub'])
    })

    test('an installed game wins within the same rank', async () => {
      const api = createServices({
        ...deps,
        fetch: catalogWith({ bar: 'Foo Bar', baz: 'Foo Baz', qux: 'Foo Qux' })
      })
      await install(api, ['baz'])
      expect((await api.searchGames('foo')).map((g) => g.label)).toEqual(['baz', 'bar', 'qux'])
    })
  })

  test('refreshCatalog refetches', async () => {
    const fetchSpy = vi.fn(deps.fetch)
    const api = createServices({ ...deps, fetch: fetchSpy })
    await api.searchGames('')
    await api.searchGames('')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await api.refreshCatalog()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test('mutations on one profile run serially, even after a rejection', async () => {
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Test')
    const { renameProfile: actualRename } = await vi.importActual<
      typeof import('../../src/main/profiles/profiles')
    >('../../src/main/profiles/profiles')
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    hooks.rename = async (...a) => {
      const n = ++calls
      events.push(`start${n}`)
      if (n === 1) {
        await gate
        events.push('fail1')
        throw new Error('first failed')
      }
      await (actualRename as (...x: unknown[]) => Promise<void>)(...a)
      events.push(`end${n}`)
    }
    try {
      const first = api.renameProfile('repo', profile.id, 'One')
      const second = api.renameProfile('repo', profile.id, 'Two')
      const firstSettled = first.catch((e: Error) => e.message)
      await new Promise((r) => setTimeout(r, 30))
      expect(events).toEqual(['start1'])
      release()
      expect(await firstSettled).toBe('first failed')
      await second
      expect(events).toEqual(['start1', 'fail1', 'start2', 'end2'])
      expect((await api.listProfiles('repo'))[0].name).toBe('Two')
    } finally {
      hooks.rename = null
    }
  })

  describe('thunderstore', () => {
    const IDX = 'https://thunderstore.io/c/repo/api/v1/package-listing-index/'
    let CHUNK = 'https://ts.test/chunk-1'
    const dl = (n: string, v: string): string => `https://ts.test/dl/${n}/${v}`
    const gz = (v: unknown): Uint8Array => gzipSync(Buffer.from(JSON.stringify(v)))
    const zipOf = (name: string, version: string): Uint8Array =>
      zipSync({
        'manifest.json': strToU8(JSON.stringify({ name, version_number: version })),
        [`${name}.dll`]: strToU8('dll')
      })
    const rawPkg = (
      owner: string,
      name: string,
      versions: string[],
      deps: string[] = []
    ): Record<string, unknown> => ({
      name,
      full_name: `${owner}-${name}`,
      owner,
      package_url: `https://thunderstore.io/c/repo/p/${owner}/${name}/`,
      date_updated: '2026-01-01T00:00:00Z',
      rating_score: 1,
      is_pinned: false,
      is_deprecated: false,
      has_nsfw_content: false,
      categories: ['mods'],
      versions: versions.map((v) => ({
        name,
        full_name: `${owner}-${name}-${v}`,
        description: `${name} ${v}`,
        icon: 'x',
        version_number: v,
        dependencies: deps,
        download_url: dl(`${owner}-${name}`, v),
        downloads: 1,
        date_created: '2026-01-01T00:00:00Z',
        website_url: '',
        is_active: true,
        file_size: 1
      }))
    })
    let packages: unknown[]
    let blobs: Map<string, Uint8Array | number>
    let offline: boolean
    let tsFetch: typeof fetch & ReturnType<typeof vi.fn>

    beforeEach(() => {
      offline = false
      CHUNK = 'https://ts.test/chunk-1'
      packages = [
        rawPkg('Own', 'Mod', ['1.0.0'], ['Dep-Lib-1.0.0']),
        rawPkg('Dep', 'Lib', ['1.0.0'])
      ]
      blobs = new Map([
        [dl('Own-Mod', '1.0.0'), zipOf('Mod', '1.0.0')],
        [dl('Dep-Lib', '1.0.0'), zipOf('Lib', '1.0.0')]
      ])
      tsFetch = vi.fn(async (url: string) => {
        if (url === IDX || url === CHUNK || blobs.has(url)) {
          if (offline) throw new Error('network down')
          const b = url === IDX ? gz([CHUNK]) : url === CHUNK ? gz(packages) : blobs.get(url)!
          if (typeof b === 'number') return { ok: false, status: b }
          const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
          return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => buf }
        }
        return deps.fetch(url)
      }) as never
    })
    const make = (): ReturnType<typeof createServices> =>
      createServices({ ...deps, fetch: tsFetch })

    test('install with a dependency installs both, dependency first, with progress', async () => {
      const api = make()
      const profile = await api.createProfile('repo', 'T')
      const r = await api.tsInstall('repo', profile.id, 'Own-Mod')
      expect(r.installed.map((m) => m.id)).toEqual(['Dep-Lib', 'Own-Mod'])
      expect(r.installed.every((m) => m.source.kind === 'thunderstore')).toBe(true)
      const mods = (await api.listProfiles('repo'))[0].mods
      expect(mods.map((m) => m.id).sort()).toEqual(['Dep-Lib', 'Own-Mod'])
      const progress = emitted.filter(
        (e): e is Extract<HmlEvent, { type: 'progress' }> => e.type === 'progress'
      )
      expect(progress.map((e) => e.done)).toEqual([0, 1, 2])
      expect(progress.every((e) => e.total === 2)).toBe(true)
      expect(progress[0].message).toBe('Installing Lib 1.0.0')
    })

    test('a failing second download names the package and keeps the first', async () => {
      blobs.set(dl('Own-Mod', '1.0.0'), 404)
      const api = make()
      const profile = await api.createProfile('repo', 'T')
      await expect(api.tsInstall('repo', profile.id, 'Own-Mod')).rejects.toThrow(/^Own-Mod: /)
      expect((await api.listProfiles('repo'))[0].mods.map((m) => m.id)).toEqual(['Dep-Lib'])
    })

    test('unsupported game rejects', async () => {
      const api = make()
      const profile = await api.createProfile('bonelab', 'T')
      await expect(api.tsInstall('bonelab', profile.id, 'Own-Mod')).rejects.toThrow(
        "BONELAB uses a mod loader HML doesn't support yet."
      )
    })

    test('no package index rejects', async () => {
      const g = structuredClone(fixture.games.repo)
      g.r2modman[0].packageIndex = null
      const api = createServices({
        ...deps,
        fetch: (async () => ({
          ok: true,
          json: async () => ({ ...fixture, games: { repo: g } })
        })) as unknown as typeof fetch
      })
      const profile = await api.createProfile('repo', 'T')
      await expect(api.tsInstall('repo', profile.id, 'Own-Mod')).rejects.toThrow(
        'R.E.P.O. has no Thunderstore listing.'
      )
      await expect(api.tsSearch('repo', query())).rejects.toThrow(
        'R.E.P.O. has no Thunderstore listing.'
      )
    })

    const query = (over: Partial<TsQuery> = {}): TsQuery => ({
      text: '',
      categories: [],
      sort: 'name' as const,
      includeDeprecated: false,
      includeNsfw: false,
      offset: 0,
      limit: 1,
      ...over
    })

    test('check updates and update', async () => {
      const api = make()
      const profile = await api.createProfile('repo', 'T')
      await api.tsInstall('repo', profile.id, 'Own-Mod')
      expect(await api.tsCheckUpdates('repo', profile.id)).toEqual([])
      packages = [
        rawPkg('Own', 'Mod', ['1.1.0', '1.0.0'], ['Dep-Lib-1.0.0']),
        rawPkg('Dep', 'Lib', ['1.0.0'])
      ]
      blobs.set(dl('Own-Mod', '1.1.0'), zipOf('Mod', '1.1.0'))
      CHUNK = 'https://ts.test/chunk-2' // content-addressed: new content, new URL
      await api.tsRefresh('repo')
      expect(await api.tsCheckUpdates('repo', profile.id)).toEqual([
        { modId: 'Own-Mod', fullName: 'Own-Mod', current: '1.0.0', latest: '1.1.0' }
      ])
      const r = await api.tsUpdate('repo', profile.id, ['Own-Mod', 'local-thing'])
      expect(r.installed.map((m) => m.id)).toEqual(['Own-Mod'])
      const mods = (await api.listProfiles('repo'))[0].mods
      expect(mods.find((m) => m.id === 'Own-Mod')?.version).toBe('1.1.0')
      expect(await api.tsCheckUpdates('repo', profile.id)).toEqual([])
    })

    const installLocal = async (
      api: ReturnType<typeof createServices>,
      profileId: string,
      fileName: string,
      files: Record<string, Uint8Array>
    ): Promise<void> => {
      const file = path.join(tmp, fileName)
      writeFileSync(file, zipSync(files))
      await api.installFromPaths('repo', profileId, [file])
    }
    const bepZip = (v: string): Uint8Array =>
      zipSync({
        'manifest.json': strToU8(JSON.stringify({ name: 'BepInExPack', version_number: v })),
        'BepInExPack/winhttp.dll': strToU8('w' + v),
        'BepInExPack/BepInEx/core/BepInEx.dll': strToU8('c' + v)
      })

    test('a Thunderstore loader install replaces the local BepInExPack record', async () => {
      packages = [
        rawPkg('Own', 'Mod', ['1.0.0'], ['BepInEx-BepInExPack-5.4.2200']),
        rawPkg('BepInEx', 'BepInExPack', ['5.4.2200', '5.4.2100'])
      ]
      blobs.set(dl('BepInEx-BepInExPack', '5.4.2200'), bepZip('5.4.2200'))
      const api = make()
      const profile = await api.createProfile('repo', 'T')
      await installLocal(api, profile.id, 'BepInExPack.zip', {
        'manifest.json': strToU8(
          JSON.stringify({ name: 'BepInExPack', version_number: '5.4.2100' })
        ),
        'BepInExPack/winhttp.dll': strToU8('w5.4.2100'),
        'BepInExPack/BepInEx/core/BepInEx.dll': strToU8('c5.4.2100')
      })
      const r = await api.tsInstall('repo', profile.id, 'Own-Mod')
      expect(r.installed.map((m) => m.id)).toEqual(['BepInEx-BepInExPack', 'Own-Mod'])
      expect(r.replaced).toEqual(['BepInExPack'])
      const mods = (await api.listProfiles('repo'))[0].mods
      const loaders = mods.filter((m) => m.name === 'BepInExPack')
      expect(loaders.map((m) => `${m.id}@${m.version}`)).toEqual(['BepInEx-BepInExPack@5.4.2200'])
      const dir = deps.paths.profileDir('repo', profile.id)
      expect(readFileSync(path.join(dir, 'winhttp.dll'), 'utf8')).toBe('w5.4.2200')
      expect(await api.tsCheckUpdates('repo', profile.id)).toEqual([])
      await api.uninstallMod('repo', profile.id, 'BepInEx-BepInExPack')
      expect(existsSync(path.join(dir, 'winhttp.dll'))).toBe(false)
      expect(existsSync(path.join(dir, 'BepInEx/core/BepInEx.dll'))).toBe(false)
    })

    test('installing a package replaces a local copy with the same manifest name', async () => {
      const api = make()
      const profile = await api.createProfile('repo', 'T')
      await installLocal(api, profile.id, 'Lib.zip', {
        'manifest.json': strToU8(JSON.stringify({ name: 'Lib', version_number: '1.0.0' })),
        'Lib.dll': strToU8('local')
      })
      await installLocal(api, profile.id, 'Other.zip', {
        'manifest.json': strToU8(JSON.stringify({ name: 'Other', version_number: '1.0.0' })),
        'Other.dll': strToU8('o')
      })
      const r = await api.tsInstall('repo', profile.id, 'Own-Mod')
      // The local Lib does not satisfy Dep-Lib-1.0.0; it is replaced by the Thunderstore copy.
      expect(r.installed.map((m) => m.id)).toEqual(['Dep-Lib', 'Own-Mod'])
      expect(r.skipped).toEqual([])
      expect(r.replaced).toEqual(['Lib'])
      const mods = (await api.listProfiles('repo'))[0].mods
      expect(mods.map((m) => m.id).sort()).toEqual(['Dep-Lib', 'Other', 'Own-Mod'])
      const dir = deps.paths.profileDir('repo', profile.id)
      expect(existsSync(path.join(dir, 'BepInEx/plugins/Lib'))).toBe(false)
    })

    describe('a GitHub copy of a Thunderstore package', () => {
      /** Serves `gh/<repo>` releases: the latest is the last published zip. */
      const ghReleases = new Map<string, { tag: string; zip: Uint8Array }[]>()
      const ghPublish = (repo: string, tag: string, zip: Uint8Array): void => {
        ghReleases.set(repo, [...(ghReleases.get(repo) ?? []), { tag, zip }])
      }
      const both = (async (url: string, init?: never) => {
        const u = new URL(url)
        const api = /^\/repos\/gh\/([^/]+)\/releases\/latest$/.exec(u.pathname)
        if (u.host === 'api.github.com' && api) {
          const rels = ghReleases.get(api[1])
          const rel = rels?.[rels.length - 1]
          if (!rel)
            return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) }
          const body = {
            tag_name: rel.tag,
            name: rel.tag,
            prerelease: false,
            draft: false,
            published_at: '2026-01-01T00:00:00Z',
            html_url: `https://github.com/gh/${api[1]}/releases/tag/${rel.tag}`,
            assets: [
              {
                id: 1,
                name: 'lib.zip',
                size: rel.zip.length,
                browser_download_url: `https://github.com/gh/${api[1]}/releases/download/${rel.tag}/lib.zip`,
                url: `https://api.github.com/repos/gh/${api[1]}/releases/assets/1`,
                digest: `sha256:${createHash('sha256').update(rel.zip).digest('hex')}`
              }
            ]
          }
          return { ok: true, status: 200, headers: new Headers(), json: async () => body }
        }
        const down = /^\/gh\/([^/]+)\/releases\/download\/([^/]+)\/lib\.zip$/.exec(u.pathname)
        if (u.host === 'github.com' && down) {
          const b = ghReleases.get(down[1])!.find((r) => r.tag === down[2])!.zip
          const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
          return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => buf }
        }
        return tsFetch(url, init)
      }) as unknown as typeof fetch
      const makeBoth = (): ReturnType<typeof createServices> =>
        createServices({ ...deps, fetch: both })
      const modsIn = async (
        api: ReturnType<typeof createServices>
      ): Promise<import('../../src/shared/types').InstalledMod[]> =>
        (await api.listProfiles('repo'))[0].mods
      beforeEach(() => ghReleases.clear())

      test('a GitHub install replaces the one Thunderstore mod with its manifest name', async () => {
        const api = makeBoth()
        const profile = await api.createProfile('repo', 'T')
        await api.tsInstall('repo', profile.id, 'Own-Mod')
        ghPublish('lib', 'v1.5.0', zipOf('Lib', '1.5.0'))
        const r = await api.ghInstall('repo', profile.id, 'gh/lib')
        if (r.kind !== 'installed') throw new Error('expected install')
        expect(r.replaced).toEqual(['Dep-Lib'])
        expect(r.mod).toMatchObject({ id: 'gh-lib', version: '1.5.0', provides: ['Dep-Lib'] })
        const mods = await modsIn(api)
        expect(mods.map((m) => m.id).sort()).toEqual(['Own-Mod', 'gh-lib'])
        const dir = deps.paths.profileDir('repo', profile.id)
        expect(existsSync(path.join(dir, 'BepInEx/plugins/Dep-Lib'))).toBe(false)
        expect(existsSync(path.join(dir, 'BepInEx/plugins/gh-lib/Lib.dll'))).toBe(true)

        // An update of the GitHub mod keeps what it provides.
        ghPublish('lib', 'v1.6.0', zipOf('Lib', '1.6.0'))
        const [u] = await api.ghUpdate('repo', profile.id, ['gh-lib'])
        expect(u.provides).toEqual(['Dep-Lib'])
      })

      test('a Thunderstore dependency on the provided package is satisfied, at any version', async () => {
        const api = makeBoth()
        const profile = await api.createProfile('repo', 'T')
        await api.tsInstall('repo', profile.id, 'Dep-Lib')
        ghPublish('lib', 'v1.5.0', zipOf('Lib', '1.5.0'))
        await api.ghInstall('repo', profile.id, 'gh/lib')
        const r = await api.tsInstall('repo', profile.id, 'Own-Mod')
        expect(r.installed.map((m) => m.id)).toEqual(['Own-Mod'])
        expect(r.skipped).toEqual(['Dep-Lib'])
        expect((await modsIn(api)).map((m) => m.id).sort()).toEqual(['Own-Mod', 'gh-lib'])

        // A newer Own-Mod that needs a newer Lib than the GitHub copy still doesn't bring it back.
        packages = [
          rawPkg('Own', 'Mod', ['1.1.0', '1.0.0'], ['Dep-Lib-9.0.0']),
          rawPkg('Dep', 'Lib', ['9.0.0', '1.0.0'])
        ]
        blobs.set(dl('Own-Mod', '1.1.0'), zipOf('Mod', '1.1.0'))
        blobs.set(dl('Dep-Lib', '9.0.0'), zipOf('Lib', '9.0.0'))
        CHUNK = 'https://ts.test/chunk-2'
        await api.tsRefresh('repo')
        const u = await api.tsUpdate('repo', profile.id, ['Own-Mod'])
        expect(u.installed.map((m) => m.id)).toEqual(['Own-Mod'])
        expect((await modsIn(api)).map((m) => m.id).sort()).toEqual(['Own-Mod', 'gh-lib'])
      })

      test('installing the provided package itself replaces the GitHub mod', async () => {
        const api = makeBoth()
        const profile = await api.createProfile('repo', 'T')
        ghPublish('lib', 'v1.0.0', zipOf('Lib', '1.0.0'))
        await api.tsInstall('repo', profile.id, 'Dep-Lib')
        await api.ghInstall('repo', profile.id, 'gh/lib')
        const r = await api.tsInstall('repo', profile.id, 'Dep-Lib')
        expect(r.installed.map((m) => m.id)).toEqual(['Dep-Lib'])
        expect(r.replaced).toEqual(['gh-lib'])
        expect((await modsIn(api)).map((m) => m.id)).toEqual(['Dep-Lib'])
        const dir = deps.paths.profileDir('repo', profile.id)
        expect(existsSync(path.join(dir, 'BepInEx/plugins/gh-lib'))).toBe(false)
      })

      test('a raw BepInEx release installs as the loader and satisfies BepInExPack', async () => {
        const official = zipSync({
          'BepInEx/core/BepInEx.Preloader.dll': strToU8('pre'),
          'winhttp.dll': strToU8('w'),
          'doorstop_config.ini': strToU8('[General]')
        })
        packages = [
          rawPkg('Own', 'Mod', ['1.0.0'], ['BepInEx-BepInExPack-5.4.2100']),
          rawPkg('BepInEx', 'BepInExPack', ['5.4.2100'])
        ]
        blobs.set(
          dl('BepInEx-BepInExPack', '5.4.2100'),
          zipSync({
            'manifest.json': strToU8(
              JSON.stringify({ name: 'BepInExPack', version_number: '5.4.2100' })
            ),
            'BepInExPack/winhttp.dll': strToU8('ts'),
            'BepInExPack/BepInEx/core/BepInEx.Preloader.dll': strToU8('ts')
          })
        )
        const api = makeBoth()
        const profile = await api.createProfile('repo', 'T')
        expect(await api.getLaunchWarnings('repo', profile.id)).toContain('no-bepinex')
        ghPublish('bepinex', 'v5.4.23.2', official)
        const r = await api.ghInstall('repo', profile.id, 'gh/bepinex')
        if (r.kind !== 'installed') throw new Error('expected install')
        const dir = deps.paths.profileDir('repo', profile.id)
        expect(readFileSync(path.join(dir, 'BepInEx/core/BepInEx.Preloader.dll'), 'utf8')).toBe(
          'pre'
        )
        expect(existsSync(path.join(dir, 'winhttp.dll'))).toBe(true)
        expect(r.mod.disableable).toEqual([])
        expect(await api.getLaunchWarnings('repo', profile.id)).not.toContain('no-bepinex')

        // A dependency on BepInExPack (versioned differently from upstream) is satisfied.
        const t = await api.tsInstall('repo', profile.id, 'Own-Mod')
        expect(t.installed.map((m) => m.id)).toEqual(['Own-Mod'])
        expect(t.skipped).toEqual(['BepInEx-BepInExPack'])

        // Installing BepInExPack itself replaces the GitHub loader.
        const b = await api.tsInstall('repo', profile.id, 'BepInEx-BepInExPack')
        expect(b.replaced).toEqual(['gh-bepinex'])
        expect((await modsIn(api)).map((m) => m.id).sort()).toEqual([
          'BepInEx-BepInExPack',
          'Own-Mod'
        ])
        expect(readFileSync(path.join(dir, 'winhttp.dll'), 'utf8')).toBe('ts')
      })

      test('a GitHub mod installed first stands in for a dependency with its manifest name', async () => {
        const api = makeBoth()
        const profile = await api.createProfile('repo', 'T')
        ghPublish('lib', 'v1.5.0', zipOf('Lib', '1.5.0'))
        await api.ghInstall('repo', profile.id, 'gh/lib')
        const r = await api.tsInstall('repo', profile.id, 'Own-Mod')
        expect(r.installed.map((m) => m.id)).toEqual(['Own-Mod'])
        expect(r.skipped).toEqual(['Dep-Lib'])
        const mods = await modsIn(api)
        expect(mods.map((m) => m.id).sort()).toEqual(['Own-Mod', 'gh-lib'])
        expect(mods.find((m) => m.id === 'gh-lib')!.provides).toEqual(['Dep-Lib'])
        // Recorded, so a direct install of the package replaces the GitHub mod.
        const d = await api.tsInstall('repo', profile.id, 'Dep-Lib')
        expect(d.replaced).toEqual(['gh-lib'])
      })

      test('two GitHub mods with the manifest name are ambiguous: the dependency installs', async () => {
        const api = makeBoth()
        const profile = await api.createProfile('repo', 'T')
        ghPublish('lib', 'v1.5.0', zipOf('Lib', '1.5.0'))
        ghPublish('lib2', 'v1.5.0', zipOf('Lib', '1.5.0'))
        await api.ghInstall('repo', profile.id, 'gh/lib')
        await api.ghInstall('repo', profile.id, 'gh/lib2')
        const r = await api.tsInstall('repo', profile.id, 'Own-Mod')
        expect(r.installed.map((m) => m.id)).toEqual(['Dep-Lib', 'Own-Mod'])
        const mods = await modsIn(api)
        expect(mods.every((m) => m.provides === undefined)).toBe(true)
      })

      test('two Thunderstore mods with the manifest name are ambiguous: none is replaced', async () => {
        packages = [rawPkg('Dep', 'Lib', ['1.0.0']), rawPkg('Alt', 'Lib', ['1.0.0'])]
        blobs.set(dl('Alt-Lib', '1.0.0'), zipOf('Lib', '1.0.0'))
        const api = makeBoth()
        const profile = await api.createProfile('repo', 'T')
        await api.tsInstall('repo', profile.id, 'Dep-Lib')
        await api.tsInstall('repo', profile.id, 'Alt-Lib')
        ghPublish('lib', 'v1.5.0', zipOf('Lib', '1.5.0'))
        const r = await api.ghInstall('repo', profile.id, 'gh/lib')
        if (r.kind !== 'installed') throw new Error('expected install')
        expect(r.replaced).toEqual([])
        expect(r.mod.provides).toBeUndefined()
        expect((await modsIn(api)).map((m) => m.id).sort()).toEqual([
          'Alt-Lib',
          'Dep-Lib',
          'gh-lib'
        ])
      })
    })

    test('a disabled dependency that is already satisfied is enabled', async () => {
      const api = make()
      const profile = await api.createProfile('repo', 'T')
      await api.tsInstall('repo', profile.id, 'Own-Mod')
      await api.setModEnabled('repo', profile.id, 'Dep-Lib', false)
      await api.uninstallMod('repo', profile.id, 'Own-Mod')
      const r = await api.tsInstall('repo', profile.id, 'Own-Mod')
      expect(r.installed.map((m) => m.id)).toEqual(['Own-Mod'])
      expect(r.skipped).toEqual(['Dep-Lib'])
      expect(r.enabled).toEqual(['Dep-Lib'])
      const mods = (await api.listProfiles('repo'))[0].mods
      expect(mods.find((m) => m.id === 'Dep-Lib')?.enabled).toBe(true)
    })

    test('the in-memory index expires after maxAge and picks up new versions', async () => {
      let clock = Date.parse('2026-10-15T00:00:00Z')
      const api = createServices({ ...deps, fetch: tsFetch, now: () => clock })
      const profile = await api.createProfile('repo', 'T')
      await api.tsInstall('repo', profile.id, 'Own-Mod')
      packages = [
        rawPkg('Own', 'Mod', ['1.1.0', '1.0.0'], ['Dep-Lib-1.0.0']),
        rawPkg('Dep', 'Lib', ['1.0.0'])
      ]
      CHUNK = 'https://ts.test/chunk-2'
      clock += 30 * 60_000
      expect(await api.tsCheckUpdates('repo', profile.id)).toEqual([])
      clock += 31 * 60_000
      expect((await api.tsCheckUpdates('repo', profile.id)).map((u) => u.latest)).toEqual(['1.1.0'])
    })

    test('an expired index refresh that fails keeps serving the old index', async () => {
      let clock = Date.parse('2026-10-15T00:00:00Z')
      const api = createServices({ ...deps, fetch: tsFetch, now: () => clock })
      expect((await api.tsSearch('repo', query())).total).toBe(2)
      offline = true
      clock += 2 * 3_600_000
      const r = await api.tsSearch('repo', query())
      expect(r.total).toBe(2)
      expect(r.stale).toBe(true)
    })

    test('a stale in-memory index is retried, so the offline notice clears', async () => {
      let clock = Date.parse('2026-10-15T00:00:00Z')
      const api = createServices({ ...deps, fetch: tsFetch, now: () => clock })
      await api.tsSearch('repo', query())
      offline = true
      expect((await api.tsRefresh('repo')).stale).toBe(true)
      expect((await api.tsSearch('repo', query())).stale).toBe(true)
      offline = false
      clock += 60_000
      expect((await api.tsSearch('repo', query())).stale).toBe(false)
    })

    test('a failed first load is not retried within 30 s, unless refresh is forced', async () => {
      let clock = Date.parse('2026-10-15T00:00:00Z')
      const api = createServices({ ...deps, fetch: tsFetch, now: () => clock })
      offline = true
      const calls = (): number => tsFetch.mock.calls.length
      const before = calls()
      const first = await api.tsSearch('repo', query()).then(
        () => null,
        (e: Error) => e
      )
      expect(first).toBeInstanceOf(Error)
      const afterFirst = calls()
      expect(afterFirst).toBeGreaterThan(before)

      clock += 10_000
      await expect(api.tsSearch('repo', query())).rejects.toThrow(first!.message)
      expect(calls()).toBe(afterFirst)

      await api.tsRefresh('repo').catch(() => undefined)
      expect(calls()).toBeGreaterThan(afterFirst)

      offline = false
      clock += 31_000
      expect((await api.tsSearch('repo', query())).total).toBe(2)
    })

    test('concurrent forced refreshes share one load', async () => {
      const calls = (): number => tsFetch.mock.calls.length
      // Warm the disk cache, so each forced refresh below costs the same.
      await createServices({ ...deps, fetch: tsFetch }).tsRefresh('repo')
      const c0 = calls()
      await createServices({ ...deps, fetch: tsFetch }).tsRefresh('repo')
      const single = calls() - c0
      const api = createServices({ ...deps, fetch: tsFetch })
      const c1 = calls()
      await Promise.all([api.tsRefresh('repo'), api.tsRefresh('repo')])
      expect(calls() - c1).toBe(single)
    })

    test('search is paged; the index stays in memory; refresh failure serves stale cache', async () => {
      const api = make()
      const a = await api.tsSearch('repo', query())
      expect(a.items).toHaveLength(1)
      expect(a.total).toBe(2)
      expect(a.stale).toBe(false)
      const calls = tsFetch.mock.calls.length
      await api.tsSearch('repo', query({ text: 'lib' }))
      expect(await api.tsGetPackage('repo', 'Own-Mod')).not.toBeNull()
      expect(await api.tsGetPackage('repo', 'Nope-Nope')).toBeNull()
      expect(tsFetch.mock.calls.length).toBe(calls)
      offline = true
      const r = await api.tsRefresh('repo')
      expect(r.stale).toBe(true)
      const b = await api.tsSearch('repo', query())
      expect(b.stale).toBe(true)
      expect(b.items).toHaveLength(1)
    })
  })

  test('HML_METHODS covers every HmlApi key', () => {
    // ghAutoUpdateAll and handleNxm are for the main process, not IPC methods.
    const keys = Object.keys(createServices(deps)).filter(
      (k) => k !== 'ghAutoUpdateAll' && k !== 'handleNxm'
    )
    expect([...HML_METHODS].sort()).toEqual(keys.sort())
  })

  test('HML_METHODS includes the thunderstore methods and openExternal', () => {
    for (const m of [
      'tsSearch',
      'tsRefresh',
      'tsGetPackage',
      'tsInstall',
      'tsCheckUpdates',
      'tsUpdate',
      'openExternal'
    ])
      expect(HML_METHODS).toContain(m)
  })

  describe('github', () => {
    interface Rel {
      tag: string
      files: Record<string, Uint8Array>
      wrongDigest?: boolean
    }
    const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
    const zipOf = (name: string, version: string, dll = `${name}.dll`): Uint8Array =>
      zipSync({
        'manifest.json': strToU8(JSON.stringify({ name, version_number: version })),
        [dll]: strToU8('dll')
      })
    let repos: Map<string, { releases: Rel[]; down?: number }>
    let calls: string[]
    let ghFetch: typeof fetch
    let api: ReturnType<typeof createServices>
    let pid: string
    let clock: number

    const slug = (o: string, r: string): string => `${o}/${r}`.toLowerCase()
    const publish = (
      o: string,
      r: string,
      tag: string,
      files: Record<string, Uint8Array>,
      wrong = false
    ): void => {
      const entry = repos.get(slug(o, r)) ?? { releases: [] }
      entry.releases.push({ tag, files, wrongDigest: wrong })
      repos.set(slug(o, r), entry)
    }
    const json = (o: string, r: string, rel: Rel): unknown => ({
      tag_name: rel.tag,
      name: rel.tag,
      prerelease: false,
      draft: false,
      published_at: '2026-01-01T00:00:00Z',
      html_url: `https://github.com/${o}/${r}/releases/tag/${rel.tag}`,
      assets: Object.entries(rel.files).map(([name, data], i) => ({
        id: i + 1,
        name,
        size: data.length,
        browser_download_url: `https://github.com/${o}/${r}/releases/download/${rel.tag}/${name}`,
        url: `https://api.github.com/repos/${o}/${r}/releases/assets/${i + 1}`,
        digest: `sha256:${rel.wrongDigest ? '0'.repeat(64) : sha(data)}`
      }))
    })
    const res = (status: number, body?: unknown): unknown => ({
      ok: status >= 200 && status < 300,
      status,
      // A 429 is GitHub's secondary rate limit, sent with retry-after.
      headers: new Headers(status === 429 ? { 'retry-after': '60' } : {}),
      json: async () => body
    })

    beforeEach(() => {
      repos = new Map()
      calls = []
      ghFetch = vi.fn(async (url: string) => {
        const u = new URL(url)
        if (u.host === 'api.github.com') {
          calls.push(url)
          const m = /^\/repos\/([^/]+)\/([^/]+)\/releases\/(latest|tags\/(.+))$/.exec(u.pathname)
          const entry = m && repos.get(slug(m[1], m[2]))
          if (!m || !entry) return res(404)
          if (entry.down) return res(entry.down)
          const rel = m[4]
            ? entry.releases.find((x) => x.tag === decodeURIComponent(m[4]))
            : entry.releases[entry.releases.length - 1]
          return rel ? res(200, json(m[1], m[2], rel)) : res(404)
        }
        if (u.host === 'github.com') {
          const m = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(u.pathname)
          const rel = m && repos.get(slug(m[1], m[2]))?.releases.find((x) => x.tag === m[3])
          const data = rel?.files[decodeURIComponent(m![4])]
          if (!data) return res(404)
          const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => buf }
        }
        return deps.fetch(url)
      }) as never
      clock = Date.now()
      api = createServices({ ...deps, fetch: ghFetch, now: () => clock })
    })
    const setup = async (): Promise<void> => {
      pid = (await api.createProfile('repo', 'p')).id
    }
    const modsOf = async (id = pid): Promise<import('../../src/shared/types').InstalledMod[]> =>
      (await api.listProfiles('repo')).find((p) => p.id === id)!.mods
    const pluginsDir = (id = pid): string =>
      path.join(deps.paths.profileDir('repo', id), 'BepInEx', 'plugins')

    test('repo url installs the latest release as an auto mod', async () => {
      await setup()
      const zip = zipOf('Thing', '1.2.3')
      publish('owner', 'repo', 'v1.2.3', { 'thing.zip': zip })
      const r = await api.ghInstall('repo', pid, 'https://github.com/owner/repo')
      if (r.kind !== 'installed') throw new Error('expected install')
      expect(r.mod.id).toBe('owner-repo')
      expect(r.mod.version).toBe('1.2.3')
      expect(r.mod.source).toEqual({
        kind: 'github',
        owner: 'owner',
        repo: 'repo',
        tag: 'v1.2.3',
        asset: 'thing.zip',
        sha256: sha(zip)
      })
      expect(r.mod.github).toEqual({ updateMode: 'auto', assetPattern: null })
      expect(r.mod.files.every((f) => f.startsWith('BepInEx/plugins/owner-repo/'))).toBe(true)
      expect(existsSync(path.join(pluginsDir(), 'owner-repo', 'Thing.dll'))).toBe(true)
      expect((await modsOf())[0].github?.updateMode).toBe('auto')
      const progress = emitted.filter((e) => e.type === 'progress')
      expect(progress.map((e) => e.type === 'progress' && e.message)).toEqual([
        'Checking owner/repo',
        'Downloading thing.zip',
        'Installing Thing 1.2.3',
        'Done'
      ])
      const last = progress[progress.length - 1]
      expect(last.type === 'progress' && last.done === last.total && last.total === 3).toBe(true)
    })

    test('a tag url installs that release and pins it', async () => {
      await setup()
      publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
      publish('owner', 'repo', 'v2.0.0', { 'a.zip': zipOf('Thing', '2.0.0') })
      const r = await api.ghInstall(
        'repo',
        pid,
        'https://github.com/owner/repo/releases/tag/v1.0.0'
      )
      if (r.kind !== 'installed') throw new Error('expected install')
      expect(r.mod.source).toMatchObject({ tag: 'v1.0.0' })
      expect(r.mod.github?.updateMode).toBe('pinned')
    })

    test('a lone dll release installs the dll into the plugins folder', async () => {
      await setup()
      publish('owner', 'repo', '1.0', { 'Cool.dll': strToU8('dll') })
      const r = await api.ghInstall('repo', pid, 'owner/repo')
      if (r.kind !== 'installed') throw new Error('expected install')
      expect(r.mod.version).toBe('1.0')
      expect(existsSync(path.join(pluginsDir(), 'owner-repo', 'Cool.dll'))).toBe(true)
    })

    test('several manifest-less zips ask, install nothing, then a pick is remembered', async () => {
      await setup()
      const bare = (n: string): Uint8Array => zipSync({ [n]: strToU8('x') })
      publish('owner', 'repo', 'v1.0.0', {
        'mod-win-1.0.0.zip': bare('win.dll'),
        'mod-linux-1.0.0.zip': bare('linux.dll')
      })
      const first = await api.ghInstall('repo', pid, 'owner/repo')
      expect(first).toMatchObject({
        kind: 'choose-asset',
        owner: 'owner',
        repo: 'repo',
        tag: 'v1.0.0'
      })
      if (first.kind !== 'choose-asset') throw new Error('expected ask')
      expect(first.assets.map((a) => a.name).sort()).toEqual([
        'mod-linux-1.0.0.zip',
        'mod-win-1.0.0.zip'
      ])
      expect(first.assets.every((a) => a.size > 0)).toBe(true)
      expect(await modsOf()).toEqual([])
      const r = await api.ghInstall('repo', pid, 'owner/repo', 'mod-linux-1.0.0.zip')
      if (r.kind !== 'installed') throw new Error('expected install')
      expect(r.mod.github?.assetPattern).toBe('mod-linux-{version}.zip')
      expect(existsSync(path.join(pluginsDir(), 'owner-repo', 'linux.dll'))).toBe(true)
      await expect(api.ghInstall('repo', pid, 'owner/repo', 'nope.zip')).rejects.toThrow(
        'v1.0.0 has no file named nope.zip.'
      )

      // per-platform update picks the matching zip of the next release
      publish('owner', 'repo', 'v1.1.0', {
        'mod-win-1.1.0.zip': bare('win.dll'),
        'mod-linux-1.1.0.zip': bare('linux.dll')
      })
      const [u] = await api.ghUpdate('repo', pid, ['owner-repo'])
      expect(u.source).toMatchObject({ tag: 'v1.1.0', asset: 'mod-linux-1.1.0.zip' })
      expect(u.github?.assetPattern).toBe('mod-linux-{version}.zip')
    })

    test('reinstall under another case keeps one mod and its update mode', async () => {
      await setup()
      publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
      await api.ghInstall('repo', pid, 'https://github.com/owner/repo')
      await api.ghSetUpdateMode('repo', pid, 'owner-repo', 'notify')
      await api.ghInstall('repo', pid, 'https://github.com/Owner/Repo')
      const list = await modsOf()
      expect(list).toHaveLength(1)
      expect(list[0].github?.updateMode).toBe('notify')
      expect(list[0].id).toBe('owner-repo')
      expect(existsSync(path.join(pluginsDir(), 'owner-repo', 'Thing.dll'))).toBe(true)
      expect(existsSync(path.join(pluginsDir(), 'Owner-Repo'))).toBe(false)
    })

    test('a local mod with the manifest name is replaced', async () => {
      await setup()
      picked = []
      const file = path.join(tmp, 'Thing.zip')
      writeFileSync(file, zipOf('Thing', '0.1.0'))
      await api.installFromPaths('repo', pid, [file])
      expect((await modsOf()).map((m) => m.id)).toEqual(['Thing'])
      publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
      const r = await api.ghInstall('repo', pid, 'owner/repo')
      if (r.kind !== 'installed') throw new Error('expected install')
      expect(r.replaced).toEqual(['Thing'])
      expect((await modsOf()).map((m) => m.id)).toEqual(['owner-repo'])
    })

    test('ghCheckUpdates lists newer tags, skips pinned and memoizes for 10 minutes', async () => {
      await setup()
      publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
      publish('pin', 'ned', 'v1.0.0', { 'a.zip': zipOf('Pinned', '1.0.0') })
      await api.ghInstall('repo', pid, 'owner/repo')
      await api.ghInstall('repo', pid, 'https://github.com/pin/ned/releases/tag/v1.0.0')
      publish('owner', 'repo', 'v1.1.0', { 'a.zip': zipOf('Thing', '1.1.0') })
      publish('pin', 'ned', 'v2.0.0', { 'a.zip': zipOf('Pinned', '2.0.0') })
      clock += 11 * 60_000 // past the install-time lookup's memo window
      calls.length = 0
      expect(await api.ghCheckUpdates('repo', pid)).toEqual([
        {
          modId: 'owner-repo',
          owner: 'owner',
          repo: 'repo',
          current: 'v1.0.0',
          latest: 'v1.1.0',
          mode: 'auto'
        }
      ])
      const n = calls.length
      expect(n).toBe(1)
      clock += 9 * 60_000
      await api.ghCheckUpdates('repo', pid)
      expect(calls.length).toBe(n)
    })

    test('ghUpdate installs the new tag keeping config; a checksum mismatch keeps the old version', async () => {
      await setup()
      publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
      await api.ghInstall('repo', pid, 'owner/repo')
      await api.ghSetUpdateMode('repo', pid, 'owner-repo', 'notify')
      publish('owner', 'repo', 'v1.1.0', { 'a.zip': zipOf('Thing', '1.1.0') })
      const [u] = await api.ghUpdate('repo', pid, ['owner-repo'])
      expect(u.version).toBe('1.1.0')
      expect(u.source).toMatchObject({ tag: 'v1.1.0' })
      expect(u.github).toEqual({ updateMode: 'notify', assetPattern: null })
      expect((await modsOf())[0].source).toMatchObject({ tag: 'v1.1.0' })

      publish('owner', 'repo', 'v1.2.0', { 'a.zip': zipOf('Thing', '1.2.0') }, true)
      await expect(api.ghUpdate('repo', pid, ['owner-repo'])).rejects.toThrow(
        "owner/repo: Download of a.zip failed: it doesn't match the checksum GitHub published for it"
      )
      const [kept] = await modsOf()
      expect(kept.source).toMatchObject({ tag: 'v1.1.0' })
      expect(existsSync(path.join(pluginsDir(), 'owner-repo', 'Thing.dll'))).toBe(true)
    })

    test('bad url, unsupported game and non-github mod reject with exact messages', async () => {
      await setup()
      await expect(api.ghInstall('repo', pid, 'https://example.com/a/b')).rejects.toThrow(
        "That isn't a GitHub repository link. Paste one like https://github.com/owner/repo."
      )
      await expect(api.ghInstall('bonelab', pid, 'owner/repo')).rejects.toThrow(
        "BONELAB uses a mod loader HML doesn't support yet."
      )
      const file = path.join(tmp, 'Loc.zip')
      writeFileSync(file, zipOf('Loc', '1.0.0'))
      await api.installFromPaths('repo', pid, [file])
      await expect(api.ghSetUpdateMode('repo', pid, 'Loc', 'auto')).rejects.toThrow(
        "Loc isn't a GitHub mod."
      )
      await expect(api.ghSetUpdateMode('repo', pid, 'Loc', 'bogus' as never)).rejects.toThrow(
        'Unknown update mode: bogus'
      )
    })

    test('ghAutoUpdateAll updates auto mods, logs failures, and shares one run', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        await setup()
        const p2 = (await api.createProfile('repo', 'q')).id
        for (const [o, r, t] of [
          ['a', 'ra', 'v1.0.0'],
          ['b', 'rb', 'v1.0.0'],
          ['c', 'rc', 'v1.0.0']
        ]) {
          publish(o, r, t, { 'x.zip': zipOf(`${r}mod`, '1.0.0') })
        }
        await api.ghInstall('repo', pid, 'a/ra')
        await api.ghInstall('repo', pid, 'c/rc')
        await api.ghSetUpdateMode('repo', pid, 'c-rc', 'notify')
        await api.ghInstall('repo', p2, 'b/rb')
        for (const [o, r] of [
          ['a', 'ra'],
          ['b', 'rb'],
          ['c', 'rc']
        ]) {
          publish(o, r, 'v2.0.0', { 'x.zip': zipOf(`${r}mod`, '2.0.0') })
        }
        repos.get('a/ra')!.down = 500
        emitted.length = 0
        calls.length = 0
        await Promise.all([api.ghAutoUpdateAll(), api.ghAutoUpdateAll()])
        expect(calls.filter((c) => c.includes('/b/rb/')).length).toBe(1)
        expect((await modsOf(pid)).find((m) => m.id === 'a-ra')!.source).toMatchObject({
          tag: 'v1.0.0'
        })
        expect((await modsOf(pid)).find((m) => m.id === 'c-rc')!.source).toMatchObject({
          tag: 'v1.0.0'
        })
        expect((await modsOf(p2))[0].source).toMatchObject({ tag: 'v2.0.0' })
        const events = emitted.filter((e) => e.type === 'github-updated')
        expect(events).toEqual([
          {
            type: 'github-updated',
            game: 'repo',
            profileId: p2,
            mods: [{ name: 'rbmod', tag: 'v2.0.0' }]
          }
        ])
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
    })

    test('auto-update announces new notify-mode releases once per release', async () => {
      await setup()
      const p2 = (await api.createProfile('repo', 'q')).id
      publish('a', 'ra', 'v1.0.0', { 'x.zip': zipOf('ramod', '1.0.0') })
      publish('b', 'rb', 'v1.0.0', { 'x.zip': zipOf('rbmod', '1.0.0') })
      publish('c', 'rc', 'v1.0.0', { 'x.zip': zipOf('rcmod', '1.0.0') })
      await api.ghInstall('repo', pid, 'a/ra')
      await api.ghInstall('repo', pid, 'b/rb')
      await api.ghInstall('repo', pid, 'c/rc')
      await api.ghInstall('repo', p2, 'a/ra')
      for (const id of ['a-ra', 'b-rb']) await api.ghSetUpdateMode('repo', pid, id, 'notify')
      await api.ghSetUpdateMode('repo', p2, 'a-ra', 'notify')
      const available = (): HmlEvent[] =>
        emitted.filter((e) => e.type === 'github-updates-available')

      emitted.length = 0
      await api.ghAutoUpdateAll()
      expect(available()).toEqual([])

      publish('a', 'ra', 'v2.0.0', { 'x.zip': zipOf('ramod', '2.0.0') })
      publish('b', 'rb', 'v2.0.0', { 'x.zip': zipOf('rbmod', '2.0.0') })
      await api.ghAutoUpdateAll()
      expect(available()).toEqual([
        { type: 'github-updates-available', game: 'repo', profileId: pid, count: 2 },
        { type: 'github-updates-available', game: 'repo', profileId: p2, count: 1 }
      ])
      // notify mods are not installed
      expect((await modsOf(pid)).find((m) => m.id === 'a-ra')!.source).toMatchObject({
        tag: 'v1.0.0'
      })

      // Already announced: no new event until a newer release.
      emitted.length = 0
      await api.ghAutoUpdateAll()
      expect(available()).toEqual([])
      publish('a', 'ra', 'v3.0.0', { 'x.zip': zipOf('ramod', '3.0.0') })
      await api.ghAutoUpdateAll()
      expect(available()).toEqual([
        { type: 'github-updates-available', game: 'repo', profileId: pid, count: 1 },
        { type: 'github-updates-available', game: 'repo', profileId: p2, count: 1 }
      ])
    })

    test('pinned mods are skipped by ghUpdate and ghAutoUpdateAll', async () => {
      await setup()
      publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
      await api.ghInstall('repo', pid, 'https://github.com/owner/repo/releases/tag/v1.0.0')
      publish('owner', 'repo', 'v2.0.0', { 'a.zip': zipOf('Thing', '2.0.0') })
      expect(await api.ghUpdate('repo', pid, ['owner-repo'])).toEqual([])
      emitted.length = 0
      await api.ghAutoUpdateAll()
      expect(emitted.filter((e) => e.type === 'github-updated')).toEqual([])
      expect((await modsOf())[0].source).toMatchObject({ tag: 'v1.0.0' })
    })

    test('ghUpdate asks the user to reinstall when no file matches the saved pattern', async () => {
      await setup()
      const bare = (n: string): Uint8Array => zipSync({ [n]: strToU8('x') })
      publish('owner', 'repo', 'v1.0.0', { 'mod-1.0.0.zip': bare('a.dll') })
      await api.ghInstall('repo', pid, 'owner/repo')
      publish('owner', 'repo', 'v2.0.0', { 'one.zip': bare('b.dll'), 'two.zip': bare('c.dll') })
      await expect(api.ghUpdate('repo', pid, ['owner-repo'])).rejects.toThrow(
        "owner/repo: owner/repo v2.0.0 has several files and HML can't tell which one replaces mod-1.0.0.zip. Reinstall it from its GitHub link to choose."
      )
      expect((await modsOf())[0].source).toMatchObject({ tag: 'v1.0.0' })
    })

    test('without a saved pattern, an update picks the file named like the installed one', async () => {
      await setup()
      publish('owner', 'repo', 'v1.0.0', { 'Mod-1.0.0.zip': zipOf('Thing', '1.0.0') })
      await api.ghInstall('repo', pid, 'owner/repo')
      expect((await modsOf())[0].github?.assetPattern).toBeNull()
      publish('owner', 'repo', 'v1.1.0', {
        'Mod-1.1.0.zip': zipOf('Thing', '1.1.0'),
        'Mod-1.1.0-debug.zip': zipOf('Thing', '1.1.0', 'Debug.dll')
      })
      const downloads: string[] = []
      const inner = ghFetch
      api = createServices({
        ...deps,
        now: () => clock,
        fetch: (async (url: string, init?: never) => {
          if (new URL(url).host === 'github.com') downloads.push(path.posix.basename(url))
          return inner(url, init)
        }) as unknown as typeof fetch
      })
      const [u] = await api.ghUpdate('repo', pid, ['owner-repo'])
      expect(u.source).toMatchObject({ tag: 'v1.1.0', asset: 'Mod-1.1.0.zip' })
      expect(downloads).toEqual(['Mod-1.1.0.zip'])
      expect(existsSync(path.join(pluginsDir(), 'owner-repo', 'Debug.dll'))).toBe(false)
    })

    describe('changes while an update downloads', () => {
      /** Holds the first asset download until `release()`; `reached` resolves when it starts. */
      const holdFirstDownload = (): {
        fetch: typeof fetch
        reached: Promise<void>
        release(): void
      } => {
        let release!: () => void
        let reach!: () => void
        const held = new Promise<void>((r) => (release = r))
        const reached = new Promise<void>((r) => (reach = r))
        let first = true
        const inner = ghFetch
        const f = (async (url: string, init?: never) => {
          if (first && new URL(url).host === 'github.com') {
            first = false
            reach()
            await held
          }
          return inner(url, init)
        }) as unknown as typeof fetch
        return { fetch: f, reached, release }
      }
      const start = async (): Promise<ReturnType<typeof holdFirstDownload>> => {
        await setup()
        publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
        await api.ghInstall('repo', pid, 'owner/repo')
        publish('owner', 'repo', 'v2.0.0', { 'a.zip': zipOf('Thing', '2.0.0') })
        const gate = holdFirstDownload()
        api = createServices({ ...deps, fetch: gate.fetch, now: () => clock })
        return gate
      }

      test('ghUpdate installs nothing when the mod is pinned meanwhile', async () => {
        const gate = await start()
        const pending = api.ghUpdate('repo', pid, ['owner-repo'])
        await gate.reached
        await api.ghSetUpdateMode('repo', pid, 'owner-repo', 'pinned')
        gate.release()
        expect(await pending).toEqual([])
        const [m] = await modsOf()
        expect(m.source).toMatchObject({ tag: 'v1.0.0' })
        expect(m.github?.updateMode).toBe('pinned')
      })

      test('auto-update installs nothing when the mod is set to notify meanwhile', async () => {
        const gate = await start()
        emitted.length = 0
        const pending = api.ghAutoUpdateAll()
        await gate.reached
        await api.ghSetUpdateMode('repo', pid, 'owner-repo', 'notify')
        gate.release()
        await pending
        expect((await modsOf())[0].source).toMatchObject({ tag: 'v1.0.0' })
        expect(emitted.filter((e) => e.type === 'github-updated')).toEqual([])
      })

      test('auto-update skips a mod whose tag changed meanwhile, so it installs once', async () => {
        const gate = await start()
        emitted.length = 0
        const auto = api.ghAutoUpdateAll()
        await gate.reached
        const [manual] = await api.ghUpdate('repo', pid, ['owner-repo'])
        expect(manual.source).toMatchObject({ tag: 'v2.0.0' })
        gate.release()
        await auto
        expect((await modsOf())[0].source).toMatchObject({ tag: 'v2.0.0' })
        expect(emitted.filter((e) => e.type === 'github-updated')).toEqual([])
      })

      test('ghUpdate skips a mod reinstalled at another tag meanwhile', async () => {
        const gate = await start()
        const pending = api.ghUpdate('repo', pid, ['owner-repo'])
        await gate.reached
        publish('owner', 'repo', 'v1.5.0', { 'a.zip': zipOf('Thing', '1.5.0') })
        await api.ghInstall('repo', pid, 'https://github.com/owner/repo/releases/tag/v1.5.0')
        gate.release()
        expect(await pending).toEqual([])
        expect((await modsOf())[0].source).toMatchObject({ tag: 'v1.5.0' })
      })
    })

    test('ghUpdate updates the rest after one fails, then names the failure', async () => {
      await setup()
      publish('good', 'one', 'v1.0.0', { 'a.zip': zipOf('Good', '1.0.0') })
      publish('bad', 'two', 'v1.0.0', { 'a.zip': zipOf('Bad', '1.0.0') })
      await api.ghInstall('repo', pid, 'bad/two')
      await api.ghInstall('repo', pid, 'good/one')
      publish('bad', 'two', 'v2.0.0', { 'a.zip': zipOf('Bad', '2.0.0') }, true)
      publish('good', 'one', 'v2.0.0', { 'a.zip': zipOf('Good', '2.0.0') })
      await expect(api.ghUpdate('repo', pid, ['bad-two', 'good-one'])).rejects.toThrow(
        "Updated 1 of 2 GitHub mods. bad/two: Download of a.zip failed: it doesn't match the checksum GitHub published for it"
      )
      const mods = await modsOf()
      expect(mods.find((m) => m.id === 'good-one')!.source).toMatchObject({ tag: 'v2.0.0' })
      expect(mods.find((m) => m.id === 'bad-two')!.source).toMatchObject({ tag: 'v1.0.0' })
    })

    test('the background auto-update skips a game that is running', async () => {
      await setup()
      publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
      await api.ghInstall('repo', pid, 'owner/repo')
      publish('owner', 'repo', 'v2.0.0', { 'a.zip': zipOf('Thing', '2.0.0') })
      const running = new Set(['repo'])
      const ghDeps = { ...deps, fetch: ghFetch, now: () => clock }
      const catalog = loadCatalog(ghDeps.paths, ghFetch, ghDeps.snapshotPath)
      const gh = createGithubServices({
        deps: ghDeps,
        getCatalog: () => catalog,
        requireGame: async (label) => (await catalog).games.find((g) => g.label === label)!,
        serialize: (_g, _p, fn) => fn(),
        isGameRunning: async (def) => running.has(def.label)
      })
      await gh.ghAutoUpdateAll()
      expect((await modsOf())[0].source).toMatchObject({ tag: 'v1.0.0' })
      running.clear()
      await gh.ghAutoUpdateAll()
      expect((await modsOf())[0].source).toMatchObject({ tag: 'v2.0.0' })
    })

    describe('a running game on Windows', () => {
      const CLOSE = 'Close R.E.P.O. before changing its mods.'
      let tasks: string[] | 'fail'
      let tasklistCalls: number
      const winApi = (platform: NodeJS.Platform = 'win32'): ReturnType<typeof createServices> =>
        createServices({
          ...deps,
          platform,
          fetch: ghFetch,
          now: () => clock,
          execFile: async (file) => {
            if (file !== 'tasklist') throw new Error(`${file} is not available in tests`)
            tasklistCalls++
            if (tasks === 'fail') throw new Error('tasklist failed')
            return { stdout: tasks.map((t) => `"${t}","1","Console","1","1 K"`).join('\r\n') }
          }
        })
      const installOld = async (): Promise<void> => {
        await setup()
        publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
        await api.ghInstall('repo', pid, 'owner/repo')
        publish('owner', 'repo', 'v2.0.0', { 'a.zip': zipOf('Thing', '2.0.0') })
      }
      beforeEach(() => {
        tasks = ['explorer.exe']
        tasklistCalls = 0
      })

      test('auto-update skips the game while REPO.exe runs, and runs once it is gone', async () => {
        await installOld()
        api = winApi()
        tasks = ['explorer.exe', 'REPO.exe']
        await api.ghAutoUpdateAll()
        expect(tasklistCalls).toBe(1)
        expect((await modsOf())[0].source).toMatchObject({ tag: 'v1.0.0' })
        tasks = ['explorer.exe']
        await api.ghAutoUpdateAll()
        expect((await modsOf())[0].source).toMatchObject({ tag: 'v2.0.0' })
      })

      test('while the game runs, notify-mode releases are still announced', async () => {
        await installOld()
        publish('n', 'note', 'v1.0.0', { 'a.zip': zipOf('Note', '1.0.0') })
        await api.ghInstall('repo', pid, 'n/note')
        await api.ghSetUpdateMode('repo', pid, 'n-note', 'notify')
        publish('n', 'note', 'v2.0.0', { 'a.zip': zipOf('Note', '2.0.0') })
        api = winApi()
        tasks = ['REPO.exe']
        emitted.length = 0
        await api.ghAutoUpdateAll()
        expect(emitted.filter((e) => e.type === 'github-updates-available')).toEqual([
          { type: 'github-updates-available', game: 'repo', profileId: pid, count: 1 }
        ])
        expect(emitted.filter((e) => e.type === 'github-updated')).toEqual([])
        expect((await modsOf()).find((m) => m.id === 'owner-repo')!.source).toMatchObject({
          tag: 'v1.0.0'
        })
      })

      test('auto-update skips the game silently when tasklist fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        try {
          await installOld()
          api = winApi()
          tasks = 'fail'
          await api.ghAutoUpdateAll()
          expect((await modsOf())[0].source).toMatchObject({ tag: 'v1.0.0' })
          expect(warn).not.toHaveBeenCalled()
        } finally {
          warn.mockRestore()
        }
      })

      test('manual update, uninstall and Thunderstore/Nexus updates refuse while it runs', async () => {
        await installOld()
        api = winApi()
        tasks = ['REPO.exe']
        await expect(api.ghUpdate('repo', pid, ['owner-repo'])).rejects.toThrow(CLOSE)
        await expect(api.uninstallMod('repo', pid, 'owner-repo')).rejects.toThrow(CLOSE)
        await expect(api.tsUpdate('repo', pid, ['owner-repo'])).rejects.toThrow(CLOSE)
        await expect(api.nxUpdate('repo', pid, ['owner-repo'])).rejects.toThrow(CLOSE)
        const [m] = await modsOf()
        expect(m.source).toMatchObject({ tag: 'v1.0.0' })
        expect(existsSync(path.join(pluginsDir(), 'owner-repo', 'Thing.dll'))).toBe(true)
      })

      test('tsInstall refuses only when it would replace something installed', async () => {
        const IDX = 'https://thunderstore.io/c/repo/api/v1/package-listing-index/'
        const CHUNK = 'https://ts.test/chunk'
        const dlUrl = (n: string, v: string): string => `https://ts.test/dl/${n}/${v}`
        const rawPkg = (owner: string, name: string, v: string): Record<string, unknown> => ({
          name,
          full_name: `${owner}-${name}`,
          owner,
          package_url: `https://thunderstore.io/c/repo/p/${owner}/${name}/`,
          date_updated: '2026-01-01T00:00:00Z',
          rating_score: 1,
          is_pinned: false,
          is_deprecated: false,
          has_nsfw_content: false,
          categories: ['mods'],
          versions: [
            {
              name,
              full_name: `${owner}-${name}-${v}`,
              description: '',
              icon: 'x',
              version_number: v,
              dependencies: [],
              download_url: dlUrl(`${owner}-${name}`, v),
              downloads: 1,
              date_created: '2026-01-01T00:00:00Z',
              website_url: '',
              is_active: true,
              file_size: 1
            }
          ]
        })
        const blobs = new Map<string, Uint8Array>([
          [
            CHUNK,
            gzipSync(
              Buffer.from(
                JSON.stringify([rawPkg('New', 'Fresh', '1.0.0'), rawPkg('Dep', 'Thing', '1.0.0')])
              )
            )
          ],
          [IDX, gzipSync(Buffer.from(JSON.stringify([CHUNK])))],
          [dlUrl('New-Fresh', '1.0.0'), zipOf('Fresh', '1.0.0')],
          [dlUrl('Dep-Thing', '1.0.0'), zipOf('Thing', '1.0.0')]
        ])
        const inner = ghFetch
        ghFetch = (async (url: string, init?: never) => {
          const b = blobs.get(url)
          if (!b) return inner(url, init)
          const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
          return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => buf }
        }) as unknown as typeof fetch
        // owner/repo installs a mod whose manifest name is Thing, so it replaces Dep-Thing.
        await setup()
        publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
        api = winApi()
        await api.tsInstall('repo', pid, 'Dep-Thing')
        await api.ghInstall('repo', pid, 'owner/repo')
        tasks = ['REPO.exe']
        // Installing Dep-Thing again would replace the GitHub mod that provides it.
        await expect(api.tsInstall('repo', pid, 'Dep-Thing')).rejects.toThrow(CLOSE)
        // A package that isn't installed yet still installs.
        const r = await api.tsInstall('repo', pid, 'New-Fresh')
        expect(r.installed.map((m) => m.id)).toEqual(['New-Fresh'])
        // A failing tasklist doesn't block.
        tasks = 'fail'
        const again = await api.tsInstall('repo', pid, 'Dep-Thing')
        expect(again.replaced).toEqual(['owner-repo'])
      })

      test('ghInstall refuses only when it would replace an installed mod', async () => {
        await installOld()
        api = winApi()
        tasks = ['REPO.exe']
        // Reinstalling owner/repo replaces the installed copy.
        await expect(api.ghInstall('repo', pid, 'owner/repo')).rejects.toThrow(CLOSE)
        expect((await modsOf())[0].source).toMatchObject({ tag: 'v1.0.0' })
        // A mod the profile doesn't have yet still installs.
        publish('n', 'fresh', 'v1.0.0', { 'a.zip': zipOf('Fresh', '1.0.0') })
        const r = await api.ghInstall('repo', pid, 'n/fresh')
        expect(r.kind).toBe('installed')
        // A failing tasklist doesn't block.
        tasks = 'fail'
        const again = await api.ghInstall('repo', pid, 'owner/repo')
        if (again.kind !== 'installed') throw new Error('expected install')
        expect(again.mod.source).toMatchObject({ tag: 'v2.0.0' })
      })

      test('a failing tasklist does not block manual actions', async () => {
        await installOld()
        api = winApi()
        tasks = 'fail'
        const [u] = await api.ghUpdate('repo', pid, ['owner-repo'])
        expect(u.source).toMatchObject({ tag: 'v2.0.0' })
        await api.uninstallMod('repo', pid, 'owner-repo')
        expect(await modsOf()).toEqual([])
      })

      test('linux is exempt: nothing is checked and everything runs', async () => {
        await installOld()
        api = winApi('linux')
        tasks = ['REPO.exe']
        await api.ghAutoUpdateAll()
        expect((await modsOf())[0].source).toMatchObject({ tag: 'v2.0.0' })
        await api.uninstallMod('repo', pid, 'owner-repo')
        expect(tasklistCalls).toBe(0)
      })
    })

    test('ghCheckUpdates skips a mod whose lookup fails', async () => {
      await setup()
      publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
      publish('ok', 'fine', 'v1.0.0', { 'a.zip': zipOf('Fine', '1.0.0') })
      await api.ghInstall('repo', pid, 'owner/repo')
      await api.ghInstall('repo', pid, 'ok/fine')
      publish('owner', 'repo', 'v1.1.0', { 'a.zip': zipOf('Thing', '1.1.0') })
      publish('ok', 'fine', 'v1.1.0', { 'a.zip': zipOf('Fine', '1.1.0') })
      repos.get('owner/repo')!.down = 500
      clock += 11 * 60_000
      const found = await api.ghCheckUpdates('repo', pid)
      expect(found.map((u) => u.modId)).toEqual(['ok-fine'])
    })

    test('ghCheckUpdates rethrows a rate limit or rejected token when no mod could be checked', async () => {
      await setup()
      publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
      publish('ok', 'fine', 'v1.0.0', { 'a.zip': zipOf('Fine', '1.0.0') })
      await api.ghInstall('repo', pid, 'owner/repo')
      await api.ghInstall('repo', pid, 'ok/fine')
      rmSync(deps.paths.ghCache, { force: true })
      clock += 11 * 60_000
      repos.get('owner/repo')!.down = 401
      repos.get('ok/fine')!.down = 401
      await expect(api.ghCheckUpdates('repo', pid)).rejects.toThrow(
        'GitHub rejected the saved token. Update or remove it in Settings.'
      )
      // One mod checked: the failure only skips the other.
      repos.get('ok/fine')!.down = undefined
      publish('ok', 'fine', 'v1.1.0', { 'a.zip': zipOf('Fine', '1.1.0') })
      expect((await api.ghCheckUpdates('repo', pid)).map((u) => u.modId)).toEqual(['ok-fine'])
      // Another error with nothing checked still just skips.
      repos.get('owner/repo')!.down = 500
      repos.get('ok/fine')!.down = 500
      clock += 11 * 60_000
      rmSync(deps.paths.ghCache, { force: true })
      expect(await api.ghCheckUpdates('repo', pid)).toEqual([])
    })

    test('ghCheckUpdates keeps showing a known update through a rate limit', async () => {
      await setup()
      publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
      await api.ghInstall('repo', pid, 'owner/repo')
      publish('owner', 'repo', 'v1.1.0', { 'a.zip': zipOf('Thing', '1.1.0') })
      clock += 11 * 60_000
      expect((await api.ghCheckUpdates('repo', pid)).map((u) => u.latest)).toEqual(['v1.1.0'])
      repos.get('owner/repo')!.down = 429
      clock += 11 * 60_000
      expect((await api.ghCheckUpdates('repo', pid)).map((u) => u.latest)).toEqual(['v1.1.0'])
    })

    test('the token goes to api.github.com only, not to the asset download host', async () => {
      await setup()
      const seen: { url: string; auth: string | undefined }[] = []
      const inner = ghFetch
      const spy = (async (url: string, init?: { headers?: Record<string, string> }) => {
        seen.push({ url, auth: init?.headers?.Authorization })
        const m =
          /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/(\d+)$/.exec(url)
        if (m) {
          // the asset API endpoint redirects to the download host; serve the file directly
          const rel = repos.get(slug(m[1], m[2]))!.releases[0]
          const data = Object.values(rel.files)[Number(m[3]) - 1]
          const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            arrayBuffer: async () => buf
          } as never
        }
        return inner(url, init as never)
      }) as unknown as typeof fetch
      mkdirSync(path.dirname(deps.paths.ghToken), { recursive: true })
      writeFileSync(deps.paths.ghToken, 'ghp_secret')
      api = createServices({ ...deps, fetch: spy, now: () => clock })
      publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
      await api.ghInstall('repo', pid, 'owner/repo')
      const apiCalls = seen.filter((s) => new URL(s.url).host === 'api.github.com')
      expect(apiCalls.length).toBeGreaterThan(0)
      expect(apiCalls.every((s) => s.auth === 'Bearer ghp_secret')).toBe(true)
      expect(seen.some((s) => s.url.includes('/releases/assets/') && s.auth)).toBe(true)
      expect(
        seen.filter((s) => new URL(s.url).host !== 'api.github.com').every((s) => !s.auth)
      ).toBe(true)

      // without a token the download goes straight to github.com, unauthenticated
      rmSync(deps.paths.ghToken)
      seen.length = 0
      publish('other', 'thing', 'v1.0.0', { 'a.zip': zipOf('Other', '1.0.0') })
      await api.ghInstall('repo', pid, 'other/thing')
      const dl = seen.filter((s) => new URL(s.url).host === 'github.com')
      expect(dl.length).toBeGreaterThan(0)
      expect(seen.every((s) => !s.auth)).toBe(true)
    })

    describe('token settings', () => {
      type Seen = { url: string; auth: string | undefined }
      const loginFetch = (seen: Seen[], status = 200): typeof fetch =>
        (async (url: string, init?: { headers?: Record<string, string> }) => {
          seen.push({ url, auth: init?.headers?.Authorization })
          if (url === 'https://api.github.com/user') {
            return res(status, { login: 'octo' })
          }
          const m =
            /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/(\d+)$/.exec(
              url
            )
          if (m) {
            const rel = repos.get(slug(m[1], m[2]))!.releases[0]
            const data = Object.values(rel.files)[Number(m[3]) - 1]
            const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => buf }
          }
          return ghFetch(url, init as never)
        }) as unknown as typeof fetch

      test('ghSetToken verifies, saves and reports the login; status never leaks the token', async () => {
        const seen: Seen[] = []
        api = createServices({ ...deps, fetch: loginFetch(seen) })
        expect(await api.ghTokenStatus()).toEqual({ set: false, encryptionAvailable: true })
        expect(await api.ghSetToken('  ghp_abc123  ')).toEqual({ login: 'octo' })
        expect(seen).toEqual([{ url: 'https://api.github.com/user', auth: 'Bearer ghp_abc123' }])
        const status = await api.ghTokenStatus()
        expect(status).toEqual({ set: true, encryptionAvailable: true })
        expect(JSON.stringify(status)).not.toContain('ghp_abc123')
      })

      test('a saved token authenticates api.github.com requests only, never browser_download_url', async () => {
        await setup()
        const seen: Seen[] = []
        api = createServices({ ...deps, fetch: loginFetch(seen), now: () => clock })
        await api.ghSetToken('ghp_abc123')
        seen.length = 0
        publish('owner', 'repo', 'v1.0.0', { 'a.zip': zipOf('Thing', '1.0.0') })
        await api.ghInstall('repo', pid, 'owner/repo')
        expect(seen.some((s) => s.url.includes('/releases/latest'))).toBe(true)
        expect(seen.some((s) => s.url.includes('/releases/assets/'))).toBe(true)
        for (const s of seen) {
          if (s.url.startsWith('https://api.github.com/')) expect(s.auth).toBe('Bearer ghp_abc123')
          else expect(s.auth).toBeUndefined()
        }
        expect(
          seen.some(
            (s) => s.url.includes('browser_download_url') || s.url.startsWith('https://github.com/')
          )
        ).toBe(false)
      })

      test('a rejected token is not saved', async () => {
        api = createServices({ ...deps, fetch: loginFetch([], 401) })
        await expect(api.ghSetToken('ghp_bad')).rejects.toThrow("GitHub didn't accept that token.")
        expect((await api.ghTokenStatus()).set).toBe(false)
        expect(existsSync(deps.paths.ghToken)).toBe(false)
      })

      test('malformed tokens are rejected before any request', async () => {
        const seen: Seen[] = []
        api = createServices({ ...deps, fetch: loginFetch(seen) })
        for (const bad of ['ab cd', 'ab\u0000cd', 'ab\ncd', 'x'.repeat(256)]) {
          await expect(api.ghSetToken(bad)).rejects.toThrow(
            "That doesn't look like a GitHub token."
          )
        }
        expect(seen).toEqual([])
      })

      test('null or empty clears the token', async () => {
        api = createServices({ ...deps, fetch: loginFetch([]) })
        await api.ghSetToken('ghp_abc123')
        expect(await api.ghSetToken(null)).toEqual({ login: null })
        expect((await api.ghTokenStatus()).set).toBe(false)
        await api.ghSetToken('ghp_abc123')
        expect(await api.ghSetToken('   ')).toEqual({ login: null })
        expect((await api.ghTokenStatus()).set).toBe(false)
      })

      test('unavailable secure storage refuses to save and reports it', async () => {
        const secrets = { ...deps.secrets, isAvailable: () => false }
        const seen: Seen[] = []
        api = createServices({ ...deps, secrets, fetch: loginFetch(seen) })
        await expect(api.ghSetToken('ghp_abc123')).rejects.toThrow(
          "Secure storage isn't available on this system, so HML can't save a GitHub token."
        )
        expect(seen).toEqual([])
        expect(await api.ghTokenStatus()).toEqual({ set: false, encryptionAvailable: false })
        expect(await api.ghSetToken(null)).toEqual({ login: null })
      })
    })

    test('ghAutoUpdateAll resolves even when listing profiles or the catalog fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        await setup()
        const profilesDir = deps.paths.profilesDir('repo')
        chmodSync(profilesDir, 0o000) // listProfiles fails with EACCES
        try {
          await expect(api.ghAutoUpdateAll()).resolves.toBeUndefined()
        } finally {
          chmodSync(profilesDir, 0o755)
        }
        expect(warn).toHaveBeenCalledTimes(1)
        const broken = createServices({
          ...deps,
          paths: makePaths(path.join(tmp, 'fresh')),
          fetch: (async () => {
            throw new Error('offline')
          }) as never,
          snapshotPath: path.join(tmp, 'missing.json')
        })
        await expect(broken.ghAutoUpdateAll()).resolves.toBeUndefined()
        expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
          expect.stringContaining('GitHub auto-update failed')
        )
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('nexus', () => {
    const KEY = 'test-key-not-real'
    const EMAIL = 'someone@example.com'
    interface Call {
      url: string
      headers: Record<string, string>
    }
    interface F {
      fileId: number
      category: string
      date: number
      version?: string
      primary?: number
    }
    let calls: Call[]
    let files: F[]
    let premium: boolean
    let validateStatus: number
    let downloadStatus: number
    let failMod: number | null
    let cdn: Record<number, Uint8Array>
    let api: ReturnType<typeof createServices>
    let pid: string

    const zipOf = (name: string, version: string): Uint8Array =>
      zipSync({
        'manifest.json': strToU8(JSON.stringify({ name, version_number: version })),
        [`${name}.dll`]: strToU8('dll')
      })
    const reply = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status })
    const gqlReply = (body: string): Response => {
      if (body.includes('modFiles')) {
        return reply({
          data: {
            modFiles: files.map((f) => ({
              fileId: String(f.fileId),
              name: `file${f.fileId}`,
              version: f.version ?? `v${f.fileId}`,
              category: f.category,
              primary: f.primary ?? 0,
              size: 1,
              sizeInBytes: '1024',
              date: f.date
            }))
          }
        })
      }
      if (body.includes('game(domainName')) {
        return reply({ data: { game: { id: '7398', name: 'R.E.P.O.', domainName: 'repo' } } })
      }
      if (body.includes('games(')) {
        return reply({
          data: { games: { nodes: [{ id: '7398', name: 'R.E.P.O.', domainName: 'repo' }] } }
        })
      }
      return reply({
        data: {
          mods: {
            totalCount: 1,
            nodes: [
              {
                modId: '5',
                name: 'Cool Mod',
                summary: 's',
                author: 'a',
                version: '9.9',
                downloads: 1,
                endorsements: 1,
                updatedAt: 'x',
                adultContent: false
              }
            ]
          }
        }
      })
    }
    const nxFetch = (async (
      url: string,
      init?: { headers?: Record<string, string>; body?: string }
    ) => {
      calls.push({ url, headers: init?.headers ?? {} })
      const u = new URL(url)
      if (u.host === 'api.nexusmods.com' && u.pathname === '/v2/graphql') {
        return gqlReply(init?.body ?? '')
      }
      if (u.pathname === '/v1/users/validate.json') {
        if (validateStatus !== 200) return reply({}, validateStatus)
        return reply({ user_id: 77, name: 'Haro', is_premium: premium, email: EMAIL, key: KEY })
      }
      const dl = /\/files\/(\d+)\/download_link\.json$/.exec(u.pathname)
      if (dl) {
        if (downloadStatus !== 200) return reply({}, downloadStatus)
        if (failMod !== null && u.pathname.includes(`/mods/${failMod}/`)) return reply({}, 404)
        return reply([
          { name: 'CDN', short_name: 'CDN', URI: `https://cf-files.nexusmods.com/f/${dl[1]}.zip` }
        ])
      }
      const cd = /^\/f\/(\d+)\.zip$/.exec(u.pathname)
      if (u.host === 'cf-files.nexusmods.com' && cd) {
        return new Response((cdn[Number(cd[1])] ?? new Uint8Array()) as BodyInit)
      }
      return deps.fetch(url)
    }) as unknown as typeof fetch

    beforeEach(async () => {
      calls = []
      premium = true
      validateStatus = 200
      downloadStatus = 200
      failMod = null
      files = [
        { fileId: 11, category: 'MAIN', date: 100 },
        { fileId: 12, category: 'OPTIONAL', date: 400 },
        { fileId: 13, category: 'MAIN', date: 300, primary: 0 }
      ]
      cdn = {
        11: zipOf('CoolMod', '1.0.0'),
        13: zipOf('CoolMod', '2.0.0'),
        12: zipOf('Opt', '1.0.0')
      }
      api = createServices({ ...deps, fetch: nxFetch })
      pid = (await api.createProfile('repo', 'p')).id
    })
    const modsOf = async (): Promise<import('../../src/shared/types').InstalledMod[]> =>
      (await api.listProfiles('repo')).find((p) => p.id === pid)!.mods
    // Task 6 exposes handleNxm; until then installFromNxm is reached through the nexus service.
    const createNexusServicesOf = (
      a: unknown
    ): ((l: unknown) => Promise<{ game: string; profileId: string; mod: { id: string } }>) => {
      void a
      const client = { fetch: nxFetch, appVersion: '1.0.0', os: deps.os }
      const catalog = loadCatalog(deps.paths, deps.fetch, deps.snapshotPath)
      const nx = createNexusServices({
        deps: { ...deps, fetch: nxFetch },
        client,
        games: createNexusGames({ paths: deps.paths, client, now: Date.now }),
        getCatalog: () => catalog,
        requireGame: async (l) => (await catalog).games.find((g) => g.label === l)!,
        serialize: (_g, _p, fn) => fn()
      })
      return nx.installFromNxm as never
    }
    const withKey = async (): Promise<void> => void (await api.nxSetKey(KEY))
    const NO_DOMAIN = "R.E.P.O. isn't on Nexus Mods. Set its Nexus domain in the game's menu."

    test('setting the key validates, saves and reports the user without secrets', async () => {
      expect(await api.nxSetKey(`  ${KEY}\n`)).toEqual({ name: 'Haro', isPremium: true })
      const st = await api.nxStatus()
      expect(st).toMatchObject({ set: true, user: { name: 'Haro', isPremium: true } })
      const json = JSON.stringify(st)
      expect(json).not.toContain(KEY)
      expect(json).not.toContain(EMAIL)
      expect(readFileSync(deps.paths.nxKey).toString()).toBe(KEY)
      expect(calls.find((c) => c.url.endsWith('validate.json'))?.headers.apikey).toBe(KEY)
    })

    test.each(['has space', 'bad\u0007key', 'x'.repeat(513)])(
      'rejects bad format %#',
      async (k) => {
        await expect(api.nxSetKey(k)).rejects.toThrow(
          "That doesn't look like a Nexus Mods API key."
        )
        expect(calls).toEqual([])
        expect(existsSync(deps.paths.nxKey)).toBe(false)
      }
    )

    test('a 401 gives the message and saves nothing', async () => {
      validateStatus = 401
      await expect(api.nxSetKey(KEY)).rejects.toThrow("Nexus Mods didn't accept that API key.")
      expect(existsSync(deps.paths.nxKey)).toBe(false)
    })

    test('unavailable storage is reported before any request', async () => {
      const a = createServices({
        ...deps,
        fetch: nxFetch,
        secrets: { ...deps.secrets, isAvailable: () => false }
      })
      await expect(a.nxSetKey(KEY)).rejects.toThrow(
        "Secure storage isn't available on this system, so HML can't save a Nexus Mods API key."
      )
      expect(calls).toEqual([])
    })

    test('null removes the key', async () => {
      await withKey()
      expect(await api.nxSetKey(null)).toBeNull()
      expect(existsSync(deps.paths.nxKey)).toBe(false)
      expect((await api.nxStatus()).set).toBe(false)
    })

    test('a later 401 in status clears the user but keeps the key', async () => {
      await withKey()
      const again = createServices({ ...deps, fetch: nxFetch })
      validateStatus = 401
      expect(await again.nxStatus()).toMatchObject({ set: true, user: null })
      expect(existsSync(deps.paths.nxKey)).toBe(true)
    })

    test('a premium install picks the newest MAIN file and keys only /v1/', async () => {
      await withKey()
      calls = []
      const r = await api.nxInstall('repo', pid, 5)
      expect(r.kind).toBe('installed')
      const mods = await modsOf()
      expect(mods).toHaveLength(1)
      expect(mods[0]).toMatchObject({
        id: 'nexus-5',
        name: 'Cool Mod',
        version: 'v13',
        source: { kind: 'nexus', domain: 'repo', modId: 5, fileId: 13 }
      })
      const keyed = calls.filter((c) => c.headers.apikey)
      expect(keyed.length).toBeGreaterThan(0)
      for (const c of keyed) expect(c.url.startsWith('https://api.nexusmods.com/v1/')).toBe(true)
      for (const c of calls.filter((x) => x.url.includes('api.nexusmods.com'))) {
        expect(c.headers['Application-Name']).toBe('HML')
      }
    })

    test('installing a chosen file works', async () => {
      await withKey()
      await api.nxInstall('repo', pid, 5, 12)
      expect((await modsOf())[0].source).toMatchObject({ fileId: 12 })
    })

    test('a free install opens the website and downloads nothing', async () => {
      premium = false
      await withKey()
      calls = []
      expect(await api.nxInstall('repo', pid, 5)).toEqual({
        kind: 'open-website',
        url: 'https://www.nexusmods.com/repo/mods/5?tab=files&file_id=13'
      })
      expect(calls.some((c) => c.url.includes('download_link') || c.url.includes('cf-files'))).toBe(
        false
      )
      expect(await modsOf()).toEqual([])
    })

    test('a 403 from the download link falls back to the website', async () => {
      await withKey()
      downloadStatus = 403
      expect((await api.nxInstall('repo', pid, 5)).kind).toBe('open-website')
    })

    test('without a key it asks for one', async () => {
      await expect(api.nxInstall('repo', pid, 5)).rejects.toThrow(
        'Add your Nexus Mods API key in Settings to download.'
      )
    })

    test('a mod without a main file is refused', async () => {
      await withKey()
      files = [{ fileId: 12, category: 'OPTIONAL', date: 1 }]
      await expect(api.nxInstall('repo', pid, 5)).rejects.toThrow(
        'This mod has no main file to install.'
      )
    })

    test('a local mod with the manifest name is replaced', async () => {
      await withKey()
      const zip = join()
      await api.installFromPaths('repo', pid, [zip])
      expect((await modsOf()).map((m) => m.id)).toEqual(['CoolMod'])
      const r = await api.nxInstall('repo', pid, 5)
      expect(r).toMatchObject({ kind: 'installed', replaced: ['CoolMod'] })
      expect((await modsOf()).map((m) => m.id)).toEqual(['nexus-5'])
    })
    const join = (): string => {
      const f = path.join(tmp, 'CoolMod.zip')
      writeFileSync(f, zipOf('CoolMod', '0.1.0'))
      picked = [f]
      return f
    }

    test('a 7z download installs', async () => {
      const { path7za } = await import('7zip-bin')
      if (!existsSync(path7za)) return
      const { execFileSync } = await import('node:child_process')
      const src = path.join(tmp, 'src7z')
      mkdirSync(src, { recursive: true })
      writeFileSync(path.join(src, 'Seven.dll'), 'dll')
      const out = path.join(tmp, 'o.7z')
      chmodSync(path7za, 0o755)
      execFileSync(path7za, ['a', '-bd', out, '.'], { cwd: src, stdio: 'ignore' })
      cdn[13] = readFileSync(out)
      await withKey()
      expect((await api.nxInstall('repo', pid, 5)).kind).toBe('installed')
      expect((await modsOf())[0].files.some((f) => f.endsWith('Seven.dll'))).toBe(true)
    })

    test('a game without a domain gives the exact message everywhere', async () => {
      await withKey()
      const none = createServices({
        ...deps,
        fetch: (async (url: string, init?: { body?: string }) =>
          String(init?.body).includes('games(')
            ? reply({ data: { games: { nodes: [] } } })
            : nxFetch(url, init as never)) as unknown as typeof fetch
      })
      const q = { text: '', sort: 'downloads', includeAdult: false, offset: 0, limit: 10 } as const
      await expect(none.nxSearch('repo', q)).rejects.toThrow(NO_DOMAIN)
      await expect(none.nxGetMod('repo', 5)).rejects.toThrow(NO_DOMAIN)
      await expect(none.nxInstall('repo', pid, 5)).rejects.toThrow(NO_DOMAIN)
      await expect(none.nxCheckUpdates('repo', pid)).rejects.toThrow(NO_DOMAIN)
      await expect(none.nxUpdate('repo', pid, [])).rejects.toThrow(NO_DOMAIN)
    })

    test('installs into a game whose loader HML does not support are refused', async () => {
      const UNSUPPORTED = "BONELAB uses a mod loader HML doesn't support yet."
      const s = JSON.parse(readFileSync(deps.paths.settings, 'utf8'))
      const bp = (await api.createProfile('bonelab', 'p')).id
      writeFileSync(
        deps.paths.settings,
        JSON.stringify({
          ...s,
          lastProfile: { bonelab: bp },
          nexusDomainOverrides: { bonelab: 'bonelab' }
        })
      )
      await withKey()
      calls = []
      await expect(api.nxInstall('bonelab', bp, 5)).rejects.toThrow(UNSUPPORTED)
      await expect(api.nxUpdate('bonelab', bp, ['nexus-5'])).rejects.toThrow(UNSUPPORTED)
      await expect(
        createNexusServicesOf(api)({
          domain: 'bonelab',
          modId: 5,
          fileId: 11,
          key: 'k',
          expires: 1,
          userId: 77
        })
      ).rejects.toThrow(UNSUPPORTED)
      expect(calls.some((c) => c.url.includes('download_link.json'))).toBe(false)
      expect((await api.listProfiles('bonelab'))[0].mods).toEqual([])
    })

    test('search and detail go through the domain', async () => {
      const q = {
        text: 'cool',
        sort: 'downloads',
        includeAdult: false,
        offset: 0,
        limit: 10
      } as const
      expect((await api.nxSearch('repo', q)).items[0].name).toBe('Cool Mod')
      const d = await api.nxGetMod('repo', 5)
      expect(d.domain).toBe('repo')
      expect(d.files.map((f) => f.fileId)).toEqual([12, 13, 11])
    })

    describe('updates', () => {
      test('flags a newer MAIN file, skips OPTIONAL-installed mods', async () => {
        await withKey()
        files = [{ fileId: 11, category: 'MAIN', date: 100 }]
        await api.nxInstall('repo', pid, 5)
        expect(await api.nxCheckUpdates('repo', pid)).toEqual([])
        files = [
          { fileId: 11, category: 'MAIN', date: 100 },
          { fileId: 13, category: 'MAIN', date: 300 }
        ]
        // memoized for 10 minutes: a fresh service sees the new list
        const fresh = createServices({ ...deps, fetch: nxFetch })
        expect(await fresh.nxCheckUpdates('repo', pid)).toEqual([
          {
            modId: 'nexus-5',
            domain: 'repo',
            nexusModId: 5,
            current: 'v11',
            latest: 'v13',
            latestFileId: 13
          }
        ])
        const res = await fresh.nxUpdate('repo', pid, ['nexus-5'])
        expect(res.map((r) => r.kind)).toEqual(['installed'])
        expect((await modsOf())[0].source).toMatchObject({ fileId: 13 })
      })

      test('an OPTIONAL-installed mod is not checked', async () => {
        await withKey()
        await api.nxInstall('repo', pid, 5, 12)
        const fresh = createServices({ ...deps, fetch: nxFetch })
        expect(await fresh.nxCheckUpdates('repo', pid)).toEqual([])
      })

      test('lookups are memoized and failures skipped', async () => {
        await withKey()
        files = [{ fileId: 11, category: 'MAIN', date: 100 }]
        await api.nxInstall('repo', pid, 5)
        calls = []
        await api.nxCheckUpdates('repo', pid)
        await api.nxCheckUpdates('repo', pid)
        expect(calls.filter((c) => c.url.endsWith('graphql'))).toHaveLength(1)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const broken = createServices({
          ...deps,
          fetch: (async (url: string, init?: { body?: string }) =>
            String(init?.body).includes('modFiles')
              ? reply({ errors: [{ message: 'boom' }] })
              : nxFetch(url, init as never)) as unknown as typeof fetch
        })
        expect(await broken.nxCheckUpdates('repo', pid)).toEqual([])
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
      })

      test('nxUpdate continues past a failing mod and reports it', async () => {
        await withKey()
        cdn[21] = zipOf('Other', '1.0.0')
        files = [{ fileId: 11, category: 'MAIN', date: 100 }]
        await api.nxInstall('repo', pid, 5)
        files = [{ fileId: 21, category: 'MAIN', date: 50 }]
        await api.nxInstall('repo', pid, 6)
        files = [
          { fileId: 11, category: 'MAIN', date: 100 },
          { fileId: 21, category: 'MAIN', date: 50 },
          { fileId: 13, category: 'MAIN', date: 300 }
        ]
        failMod = 6
        const mods = await modsOf()
        await expect(
          api.nxUpdate(
            'repo',
            pid,
            mods.map((m) => m.id)
          )
        ).rejects.toThrow(/^Updated 1 of 2 Nexus mods\. Cool Mod: That file is no longer/)
        const after = await modsOf()
        expect(after.find((m) => m.id === 'nexus-5')?.source).toMatchObject({ fileId: 13 })
        expect(after.find((m) => m.id === 'nexus-6')?.source).toMatchObject({ fileId: 21 })
      })

      test('nxUpdate does not count website hand-offs as updated', async () => {
        await withKey()
        cdn[21] = zipOf('Other', '1.0.0')
        cdn[31] = zipOf('Third', '1.0.0')
        for (const [modId, fileId] of [
          [5, 11],
          [6, 21],
          [7, 31]
        ]) {
          files = [{ fileId, category: 'MAIN', date: 50 }]
          await api.nxInstall('repo', pid, modId)
        }
        files = [11, 21, 31, 13].map((fileId) => ({
          fileId,
          category: 'MAIN' as const,
          date: fileId === 13 ? 300 : 50
        }))
        failMod = 7
        const fresh = createServices({
          ...deps,
          fetch: (async (url: string, init?: { body?: string }) =>
            url.includes('/mods/6/') && url.includes('download_link')
              ? reply({}, 403)
              : nxFetch(url, init as never)) as unknown as typeof fetch
        })
        const mods = await modsOf()
        const err = await fresh
          .nxUpdate(
            'repo',
            pid,
            mods.map((m) => m.id)
          )
          .catch((e: Error) => e)
        expect((err as Error).message).toMatch(/^Updated 1 of 2 Nexus mods\. /)
      })
    })

    describe('installFromNxm', () => {
      const link = {
        domain: 'repo',
        modId: 5,
        fileId: 11,
        key: 'LINKKEY',
        expires: 1234,
        userId: 77
      }
      const lastProfile = (): void => {
        const s = JSON.parse(readFileSync(deps.paths.settings, 'utf8'))
        writeFileSync(
          deps.paths.settings,
          JSON.stringify({
            ...s,
            lastProfile: { repo: pid },
            nexusDomainOverrides: { repo: 'repo' }
          })
        )
      }

      test('routes to the game and last profile and sends key and expires', async () => {
        lastProfile()
        await withKey()
        premium = false
        const nx = createNexusServicesOf(api)
        const r = await nx(link)
        expect(r).toMatchObject({ game: 'repo', profileId: pid, mod: { id: 'nexus-5' } })
        expect(
          calls.some((c) => c.url.includes('download_link.json?key=LINKKEY&expires=1234'))
        ).toBe(true)
      })

      test('no matching game', async () => {
        lastProfile()
        await expect(createNexusServicesOf(api)({ ...link, domain: 'nowhere' })).rejects.toThrow(
          'Open nowhere in HML before downloading its mods.'
        )
      })

      test('no profile', async () => {
        const s = JSON.parse(readFileSync(deps.paths.settings, 'utf8'))
        writeFileSync(
          deps.paths.settings,
          JSON.stringify({ ...s, nexusDomainOverrides: { repo: 'repo' } })
        )
        await expect(createNexusServicesOf(api)(link)).rejects.toThrow(
          'Pick a profile for R.E.P.O. in HML first.'
        )
      })

      describe('handleNxm', () => {
        const raw = (over = ''): string =>
          `nxm://repo/mods/5/files/11?key=LINKKEY&expires=1234&user_id=${over || 77}`
        const last = (): HmlEvent => emitted[emitted.length - 1]

        test('installs and emits nexus-installed', async () => {
          lastProfile()
          await withKey()
          premium = false
          await api.handleNxm(raw())
          expect(last()).toEqual({
            type: 'nexus-installed',
            game: 'repo',
            profileId: pid,
            mod: { name: 'Cool Mod', version: 'v11' }
          })
          expect(
            calls.some((c) => c.url.includes('download_link.json?key=LINKKEY&expires=1234'))
          ).toBe(true)
        })

        test('a link for another account is refused', async () => {
          lastProfile()
          await withKey()
          await api.handleNxm(raw('78'))
          expect(last()).toEqual({
            type: 'nexus-failed',
            message: 'This download link is for a different Nexus Mods account.'
          })
          expect(calls.some((c) => c.url.includes('download_link.json'))).toBe(false)
        })

        test('a link without a user id is refused once the user is known', async () => {
          lastProfile()
          await withKey()
          await api.handleNxm('nxm://repo/mods/5/files/11?key=LINKKEY&expires=1234')
          expect(last()).toEqual({
            type: 'nexus-failed',
            message: 'This download link is for a different Nexus Mods account.'
          })
          expect(calls.some((c) => c.url.includes('download_link.json'))).toBe(false)
        })

        test('unknown domain, no profile, expired link and invalid link all emit failures', async () => {
          lastProfile()
          await withKey()
          await api.handleNxm('nxm://nowhere/mods/5/files/11?key=k&expires=1&user_id=77')
          expect(last()).toEqual({
            type: 'nexus-failed',
            message: 'Open nowhere in HML before downloading its mods.'
          })
          downloadStatus = 410
          await expect(api.handleNxm(raw())).resolves.toBeUndefined()
          expect(last()).toMatchObject({ type: 'nexus-failed' })
          expect((last() as { message: string }).message).toMatch(/expired/i)
          await expect(api.handleNxm('https://example.com/')).resolves.toBeUndefined()
          expect(last()).toEqual({
            type: 'nexus-failed',
            message: "That isn't a Nexus Mods download link."
          })
        })

        test('no profile picked', async () => {
          const s = JSON.parse(readFileSync(deps.paths.settings, 'utf8'))
          writeFileSync(
            deps.paths.settings,
            JSON.stringify({ ...s, nexusDomainOverrides: { repo: 'repo' } })
          )
          await withKey()
          await api.handleNxm(raw())
          expect(last()).toEqual({
            type: 'nexus-failed',
            message: 'Pick a profile for R.E.P.O. in HML first.'
          })
        })
      })

      test('nxRegisterHandler delegates and nxStatus reads the handler', async () => {
        let registered = 0
        const a = createServices({
          ...deps,
          fetch: nxFetch,
          nxmHandler: {
            status: async () => (registered ? 'registered' : 'not-registered'),
            register: async () => void registered++
          }
        })
        expect((await a.nxStatus()).handler).toBe('not-registered')
        await a.nxRegisterHandler()
        expect((await a.nxStatus()).handler).toBe('registered')
      })
    })
  })

  describe('openExternal normalization', () => {
    const run = async (u: string): Promise<string[]> => {
      const opened: string[] = []
      const api = createServices({
        ...deps,
        shell: { openPath: async () => '', openExternal: async (x) => void opened.push(x) }
      })
      await api.openExternal(u)
      return opened
    }
    test('opens the normalized href', async () => {
      expect(await run('HTTPS://THUNDERSTORE.IO/x')).toEqual(['https://thunderstore.io/x'])
    })
    test.each([
      'javascript:alert(1)',
      'https://thunderstore.io./',
      'https://thunderstore.io:8443/'
    ])('rejects %s', async (u) => {
      await expect(run(u)).rejects.toThrow(
        'HML only opens Thunderstore, GitHub and Nexus Mods links.'
      )
    })
  })

  describe('openExternal', () => {
    const MSG = 'HML only opens Thunderstore, GitHub and Nexus Mods links.'
    test.each([
      'https://thunderstore.io/c/repo/p/a/b/',
      'https://github.com/x/y',
      'https://www.github.com/x',
      'https://new.thunderstore.io/'
    ])('accepts %s', async (u) => {
      const opened: string[] = []
      const api = createServices({
        ...deps,
        shell: { openPath: async () => '', openExternal: async (x) => void opened.push(x) }
      })
      await api.openExternal(u)
      expect(opened).toEqual([u])
    })
    test.each([
      'http://thunderstore.io/',
      'https://evil.com/',
      'https://thunderstore.io.evil.com/',
      'file:///etc/passwd',
      'not a url',
      'https://user@evil.com@thunderstore.io.evil.com/'
    ])('rejects %s', async (u) => {
      const opened: string[] = []
      const api = createServices({
        ...deps,
        shell: { openPath: async () => '', openExternal: async (x) => void opened.push(x) }
      })
      await expect(api.openExternal(u)).rejects.toThrow(MSG)
      expect(opened).toEqual([])
    })
  })
})

describe('share', () => {
  const fixtureResponse = { ok: true, json: async () => fixture }
  test('exportProfileFile leaves no temp file behind, and none when the rename fails', async () => {
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Atomic')
    const outDir = path.join(tmp, 'atomic-out')
    mkdirSync(outDir, { recursive: true })
    const ok = path.join(outDir, 'ok.hml')
    const mk = (target: string): ReturnType<typeof createServices> =>
      createServices({ ...deps, dialog: { ...dialog, saveFile: async () => target } })
    expect(await mk(ok).exportProfileFile('repo', profile.id)).toBe(ok)
    expect(readdirSync(outDir)).toEqual(['ok.hml'])

    // A directory at the target makes the rename fail.
    const blocked = path.join(outDir, 'blocked.hml')
    mkdirSync(path.join(blocked, 'child'), { recursive: true })
    await expect(mk(blocked).exportProfileFile('repo', profile.id)).rejects.toThrow()
    expect(readdirSync(outDir).sort()).toEqual(['blocked.hml', 'ok.hml'])
  })

  test.each(['write', 'rename'] as const)(
    'exportProfileFile keeps the old target and leaves no temp file when the %s fails partway',
    async (stage) => {
      const api = createServices(deps)
      const profile = await api.createProfile('repo', 'Atomic Fail')
      const outDir = path.join(tmp, 'atomic-fail')
      mkdirSync(outDir, { recursive: true })
      const target = path.join(outDir, 'keep.hml')
      writeFileSync(target, 'OLD CONTENT')
      const real = fsPromises.writeFile.bind(fsPromises)
      const spies =
        stage === 'write'
          ? [
              vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (file, data) => {
                // Land a truncated file first, so a direct write to the target would corrupt it.
                await real(file, String(data).slice(0, 3))
                throw new Error('disk full')
              })
            ]
          : [
              vi.spyOn(fsPromises, 'rename').mockImplementation(async () => {
                throw new Error('rename denied')
              })
            ]
      try {
        const svc = createServices({ ...deps, dialog: { ...dialog, saveFile: async () => target } })
        await expect(svc.exportProfileFile('repo', profile.id)).rejects.toThrow(
          stage === 'write' ? 'disk full' : 'rename denied'
        )
      } finally {
        spies.forEach((s) => s.mockRestore())
      }
      expect(readFileSync(target, 'utf8')).toBe('OLD CONTENT')
      expect(readdirSync(outDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
      expect(readdirSync(outDir)).toEqual(['keep.hml'])
    }
  )

  test('exportProfileFile writes a file readHmlFile reads back, and returns null on cancel', async () => {
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'My: Profile?')
    const cfg = path.join(deps.paths.profileDir('repo', profile.id), 'BepInEx', 'config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(path.join(cfg, 'a.cfg'), 'x=1')
    let defaultPath = ''
    const dlg = (opts: { defaultPath: string }): Promise<string | null> => {
      defaultPath = opts.defaultPath
      return Promise.resolve(saveTarget)
    }
    const a2 = createServices({ ...deps, dialog: { ...dialog, saveFile: dlg } })

    expect(await a2.exportProfileFile('repo', profile.id)).toBeNull()

    saveTarget = path.join(tmp, 'out.hml')
    expect(await a2.exportProfileFile('repo', profile.id)).toBe(saveTarget)
    expect(defaultPath).toBe('My_ Profile_.hml')
    const read = await readHmlFile(new Uint8Array(readFileSync(saveTarget)))
    expect(read.export.profileName).toBe('My: Profile?')
    expect([...read.configs.keys()]).toEqual(['BepInEx/config/a.cfg'])
  })

  test('shareProfile uploads only the zip, with no credentials or absolute paths', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const api = createServices({
      ...deps,
      fetch: (async (url: string, init: RequestInit) => {
        if (!url.startsWith('https://share.test')) return fixtureResponse
        calls.push({ url, init })
        return { ok: true, status: 200, json: async () => ({ code: '0123456789' }) }
      }) as unknown as typeof fetch
    })
    const profile = await api.createProfile('repo', 'Shared')
    const manifest = { ...profile }
    manifest.mods = [
      {
        id: 'local-1',
        name: 'Mine',
        version: '1.0.0',
        enabled: true,
        files: [],
        disableable: [],
        installedAt: '2026-01-01T00:00:00Z',
        source: { kind: 'local', fileName: 'mine.dll', sha256: 'ab' }
      },
      {
        id: 'ts-1',
        name: 'Other',
        version: '1.0.0',
        enabled: true,
        files: [],
        disableable: [],
        installedAt: '2026-01-01T00:00:00Z',
        source: { kind: 'thunderstore', fullName: 'A-B' }
      }
    ]
    await saveProfile(deps.paths, manifest)

    const res = await api.shareProfile('repo', profile.id)
    expect(res).toEqual({ code: '0123456789', localMods: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://share.test/v1/profiles')
    expect(calls[0].init.method).toBe('POST')
    const headers = Object.keys(calls[0].init.headers as Record<string, string>).map((h) =>
      h.toLowerCase()
    )
    expect(headers).not.toContain('apikey')
    expect(headers).not.toContain('authorization')
    const body = Buffer.from(calls[0].init.body as Uint8Array)
    expect(body.includes(Buffer.from(tmp))).toBe(false)
    const read = await readHmlFile(new Uint8Array(body))
    expect(JSON.stringify(read.export)).not.toContain(tmp)
  })

  test('shareProfile does not hold the profile lock during the upload', async () => {
    let release!: () => void
    let uploading!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const started = new Promise<void>((r) => (uploading = r))
    const api = createServices({
      ...deps,
      fetch: (async (url: string) => {
        if (!url.startsWith('https://share.test')) return fixtureResponse
        uploading()
        await gate
        return { ok: true, status: 200, json: async () => ({ code: '0123456789' }) }
      }) as unknown as typeof fetch
    })
    const profile = await api.createProfile('repo', 'Lock')
    const pending = api.shareProfile('repo', profile.id)
    await started
    // A serialized operation on the same profile settles while the upload is still pending.
    await api.setModEnabled('repo', profile.id, 'nope', true).catch(() => undefined)
    release()
    await expect(pending).resolves.toMatchObject({ code: '0123456789' })
  })

  test('HML_METHODS lists export and share', () => {
    expect(HML_METHODS).toEqual(expect.arrayContaining(['exportProfileFile', 'shareProfile']))
  })
})

describe('share import', () => {
  const IDX = 'https://thunderstore.io/c/repo/api/v1/package-listing-index/'
  const CHUNK = 'https://ts.test/chunk-1'
  const CODE = '0123456789'
  const KEY = 'test-key-not-real'
  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
  const gz = (v: unknown): Uint8Array => gzipSync(Buffer.from(JSON.stringify(v)))
  const tsDl = (n: string, v: string): string => `https://ts.test/dl/${n}/${v}`
  const zipOf = (name: string, version: string): Uint8Array =>
    zipSync({
      'manifest.json': strToU8(JSON.stringify({ name, version_number: version })),
      [`${name}.dll`]: strToU8('dll')
    })
  const bin = (b: Uint8Array): unknown => {
    const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => buf }
  }
  const reply = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status })
  const rawPkg = (
    owner: string,
    name: string,
    versions: string[],
    deps: string[] = []
  ): unknown => ({
    name,
    full_name: `${owner}-${name}`,
    owner,
    package_url: `https://thunderstore.io/c/repo/p/${owner}/${name}/`,
    date_updated: '2026-01-01T00:00:00Z',
    rating_score: 1,
    is_pinned: false,
    is_deprecated: false,
    has_nsfw_content: false,
    categories: ['mods'],
    versions: versions.map((v) => ({
      name,
      full_name: `${owner}-${name}-${v}`,
      description: `${name} ${v}`,
      icon: 'x',
      version_number: v,
      dependencies: deps,
      download_url: tsDl(`${owner}-${name}`, v),
      downloads: 1,
      date_created: '2026-01-01T00:00:00Z',
      website_url: '',
      is_active: true,
      file_size: 1
    }))
  })
  const thing1 = zipOf('Thing', '1.0.0')
  const thing2 = zipOf('Thing', '2.0.0')
  const ghReleases: Record<string, Record<string, Uint8Array>> = {
    'v1.0.0': { 'thing.zip': thing1 },
    'v2.0.0': { 'thing.zip': thing2 },
    // A GitHub build of Dep-Lib: its manifest name is Lib.
    'v3.0.0': { 'thing.zip': zipOf('Lib', '1.5.0') }
  }
  const ghJson = (tag: string): unknown => ({
    tag_name: tag,
    name: tag,
    prerelease: false,
    draft: false,
    published_at: '2026-01-01T00:00:00Z',
    html_url: `https://github.com/owner/thing/releases/tag/${tag}`,
    assets: Object.entries(ghReleases[tag]).map(([name, data], i) => ({
      id: i + 1,
      name,
      size: data.length,
      browser_download_url: `https://github.com/owner/thing/releases/download/${tag}/${name}`,
      url: `https://api.github.com/repos/owner/thing/releases/assets/${i + 1}`,
      digest: `sha256:${sha(data)}`
    }))
  })

  let premium: boolean
  let hml: Uint8Array
  let ghDown: boolean
  let ghLimited: boolean
  let nexusDown: boolean
  let ownModVersions: string[]
  let ownModDeps: string[]
  let chunkUrl: string
  let idxFetches: number
  let clock: number
  let api: ReturnType<typeof createServices>

  const tsBlobs = new Map<string, Uint8Array>([
    [tsDl('Own-Mod', '1.0.0'), zipOf('Mod', '1.0.0')],
    [tsDl('Own-Mod', '2.0.0'), zipOf('Mod', '2.0.0')],
    [tsDl('Dep-Lib', '1.0.0'), zipOf('Lib', '1.0.0')],
    [tsDl('Dep-Lib', '1.5.0'), zipOf('Lib', '1.5.0')]
  ])
  const gql = (body: string): Response => {
    const dom = /domainName:\\"([a-z0-9_-]+)\\"/.exec(body)?.[1]
    if (body.includes('modFiles')) {
      return reply({
        data: {
          modFiles: [
            {
              fileId: '11',
              name: 'file11',
              version: '1.0.0',
              category: 'MAIN',
              primary: 0,
              size: 1,
              sizeInBytes: '1024',
              date: 100
            }
          ]
        }
      })
    }
    if (body.includes('game(domainName')) {
      const name = dom === 'repo' ? 'R.E.P.O.' : 'Stardew Valley'
      return reply({
        data: { game: { id: dom === 'repo' ? '7398' : '1303', name, domainName: dom } }
      })
    }
    if (body.includes('games(')) {
      return reply({
        data: { games: { nodes: [{ id: '7398', name: 'R.E.P.O.', domainName: 'repo' }] } }
      })
    }
    return reply({
      data: {
        mods: {
          totalCount: 1,
          nodes: [
            {
              modId: '5',
              name: 'Cool Mod',
              summary: 's',
              author: 'a',
              version: '1.0.0',
              downloads: 1,
              endorsements: 1,
              updatedAt: 'x',
              adultContent: false
            }
          ]
        }
      }
    })
  }
  const impFetch = (async (url: string, init?: { body?: string }) => {
    const u = new URL(url)
    if (url === IDX) {
      idxFetches++
      return bin(gz([chunkUrl]))
    }
    if (url.startsWith(CHUNK)) {
      return bin(
        gz([
          rawPkg('Own', 'Mod', ownModVersions, ownModDeps),
          rawPkg('Dep', 'Lib', ['1.5.0', '1.0.0'])
        ])
      )
    }
    if (tsBlobs.has(url)) return bin(tsBlobs.get(url)!)
    if (u.host === 'api.github.com') {
      if (ghDown) throw new Error('network down')
      if (ghLimited) {
        return {
          ok: false,
          status: 403,
          headers: new Headers({ 'x-ratelimit-remaining': '0' }),
          json: async () => ({})
        }
      }
      const m = /^\/repos\/owner\/thing\/releases\/tags\/(.+)$/.exec(u.pathname)
      const tag = m && decodeURIComponent(m[1])
      return tag && ghReleases[tag]
        ? { ok: true, status: 200, headers: new Headers(), json: async () => ghJson(tag) }
        : { ok: false, status: 404, headers: new Headers(), json: async () => ({}) }
    }
    if (u.host === 'github.com') {
      const m = /^\/owner\/thing\/releases\/download\/([^/]+)\/(.+)$/.exec(u.pathname)
      const data = m && ghReleases[m[1]]?.[decodeURIComponent(m[2])]
      return data ? bin(data) : { ok: false, status: 404, headers: new Headers() }
    }
    if (u.host === 'api.nexusmods.com' && nexusDown) throw new TypeError('fetch failed')
    if (u.host === 'api.nexusmods.com' && u.pathname === '/v2/graphql') return gql(init?.body ?? '')
    if (u.pathname === '/v1/users/validate.json') {
      return reply({ user_id: 77, name: 'Haro', is_premium: premium, key: KEY })
    }
    const nxDl = /\/files\/(\d+)\/download_link\.json$/.exec(u.pathname)
    if (nxDl) {
      return reply([
        { name: 'CDN', short_name: 'CDN', URI: `https://cf-files.nexusmods.com/f/${nxDl[1]}.zip` }
      ])
    }
    if (u.host === 'cf-files.nexusmods.com')
      return new Response(zipOf('CoolMod', '1.0.0') as BodyInit)
    if (url === `https://share.test/v1/profiles/${CODE}`) return new Response(hml as BodyInit)
    return { ok: true, json: async () => fixture }
  }) as unknown as typeof fetch

  type ExportMod = import('../../src/shared/types').HmlExportMod
  const ts = (fullName: string, version: string, enabled = true): ExportMod => ({
    source: { kind: 'thunderstore', fullName },
    version,
    enabled
  })
  const gh = (tag: string, sum = sha(ghReleases[tag]?.['thing.zip'] ?? thing1)): ExportMod => ({
    name: 'Thing',
    source: { kind: 'github', owner: 'owner', repo: 'thing', tag, asset: 'thing.zip', sha256: sum },
    version: tag.replace(/^v/, ''),
    enabled: true
  })
  const nx = (domain = 'repo'): ExportMod => ({
    name: 'Cool Mod',
    source: { kind: 'nexus', domain, modId: 5, fileId: 11 },
    version: '1.0.0',
    enabled: true
  })
  const local: ExportMod = {
    source: { kind: 'local', fileName: 'mine.zip', sha256: 'ab' },
    version: '1.0.0',
    enabled: true
  }
  const makeHml = (
    mods: ExportMod[],
    o: { game?: string; profileName?: string; configs?: Record<string, string> } = {}
  ): Uint8Array =>
    zipSync({
      'export.json': strToU8(
        JSON.stringify({
          formatVersion: 1,
          game: o.game ?? 'repo',
          profileName: o.profileName ?? 'Friends',
          mods
        })
      ),
      ...Object.fromEntries(Object.entries(o.configs ?? {}).map(([k, v]) => [k, strToU8(v)]))
    })
  const progressOf = (): Extract<HmlEvent, { type: 'progress' }>[] =>
    emitted.filter((e): e is Extract<HmlEvent, { type: 'progress' }> => e.type === 'progress')

  beforeEach(async () => {
    premium = true
    ghDown = false
    ghLimited = false
    nexusDown = false
    ownModVersions = ['2.0.0', '1.0.0']
    ownModDeps = ['Dep-Lib-1.0.0']
    chunkUrl = CHUNK
    idxFetches = 0
    hooks.getProfile = null
    clock = Date.now()
    hml = makeHml([])
    api = createServices({ ...deps, fetch: impFetch, now: () => clock })
  })
  const withKey = async (): Promise<void> => void (await api.nxSetKey(KEY))
  const importCode = async (
    mods: ExportMod[],
    o: Parameters<typeof makeHml>[1] = {},
    name = ''
  ): Promise<import('../../src/shared/types').ImportResult> => {
    hml = makeHml(mods, o)
    const preview = await api.previewShare({ code: '01234-56789' })
    return api.importShare(preview!.token, name)
  }

  test('a code preview names the game, profile and mods', async () => {
    hml = makeHml([ts('Own-Mod', '1.0.0'), gh('v1.0.0'), local], {
      configs: { 'BepInEx/config/a.cfg': 'x=1' }
    })
    const p = await api.previewShare({ code: '01234-56789' })
    expect(p).toMatchObject({
      game: 'repo',
      gameName: 'R.E.P.O.',
      profileName: 'Friends',
      configFiles: 1,
      mods: [
        { name: 'Own-Mod', version: '1.0.0', kind: 'thunderstore' },
        { name: 'Thing', version: '1.0.0', kind: 'github' },
        { name: 'mine.zip', version: '1.0.0', kind: 'local' }
      ]
    })
    expect(typeof p!.token).toBe('string')
  })

  test('a file preview reads the picked .hml, and cancel returns null', async () => {
    let filters: unknown
    const a = createServices({
      ...deps,
      fetch: impFetch,
      dialog: {
        ...dialog,
        pickFiles: async (o) => {
          filters = o.filters
          return picked
        }
      }
    })
    expect(await a.previewShare({ file: true })).toBeNull()
    expect(filters).toEqual([{ name: 'HML profile', extensions: ['hml'] }])
    const file = path.join(tmp, 'p.hml')
    writeFileSync(file, makeHml([local], { profileName: 'From file' }))
    picked = [file]
    expect(await a.previewShare({ file: true })).toMatchObject({
      game: 'repo',
      profileName: 'From file',
      mods: [{ kind: 'local' }]
    })
  })

  test('import rebuilds every mod at its exact version, keeps disabled mods off and writes configs', async () => {
    await withKey()
    const r = await importCode(
      [ts('Dep-Lib', '1.0.0'), ts('Own-Mod', '1.0.0', false), gh('v1.0.0'), nx()],
      { configs: { 'BepInEx/config/sub/a.cfg': 'shared=1' } },
      'Mine'
    )
    expect(r.unresolved).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.installed).toBe(4)
    expect(r.game).toBe('repo')
    const byId = Object.fromEntries(r.profile.mods.map((m) => [m.id, m]))
    expect(byId['Own-Mod']).toMatchObject({ version: '1.0.0', enabled: false })
    expect(byId['Dep-Lib']).toMatchObject({ version: '1.0.0', enabled: true })
    expect(byId['owner-thing']).toMatchObject({
      version: '1.0.0',
      source: { kind: 'github', tag: 'v1.0.0' }
    })
    expect(byId['nexus-5']).toMatchObject({ source: { kind: 'nexus', modId: 5, fileId: 11 } })
    const dir = deps.paths.profileDir('repo', r.profile.id)
    expect(readFileSync(path.join(dir, 'BepInEx', 'config', 'sub', 'a.cfg'), 'utf8')).toBe(
      'shared=1'
    )
    // The installs' own progress events are interleaved; the import's count up to the mod total.
    const prog = progressOf()
    const importing = prog.filter((e) => e.message.startsWith('Importing '))
    expect(importing.map((e) => [e.message, e.done, e.total])).toEqual([
      ['Importing Dep-Lib', 0, 4],
      ['Importing Own-Mod', 1, 4],
      ['Importing Thing', 2, 4],
      ['Importing Cool Mod', 3, 4]
    ])
    expect(prog[prog.length - 1]).toEqual({ type: 'progress', message: 'Done', done: 4, total: 4 })
  })

  test('an explicit Thunderstore version wins over one a dependency pulled in', async () => {
    const r = await importCode([ts('Own-Mod', '1.0.0'), ts('Dep-Lib', '1.5.0')])
    expect(r.installed).toBe(2)
    const byId = Object.fromEntries(r.profile.mods.map((m) => [m.id, m]))
    expect(byId['Dep-Lib'].version).toBe('1.5.0')
    expect(byId['Own-Mod'].version).toBe('1.0.0')
  })

  test('unresolved entries carry the exact reasons', async () => {
    premium = false
    await withKey()
    const r = await importCode([
      ts('Own-Mod', '0.5.0'),
      ts('Gone-Pkg', '1.0.0'),
      gh('v9.9.9', 'ab'),
      nx(),
      nx('skyrim'),
      local
    ])
    expect(r.installed).toBe(0)
    expect(r.unresolved).toEqual([
      {
        name: 'Own-Mod',
        version: '0.5.0',
        kind: 'thunderstore',
        reason: 'Version 0.5.0 is no longer on Thunderstore.'
      },
      {
        name: 'Gone-Pkg',
        version: '1.0.0',
        kind: 'thunderstore',
        reason: 'Not on Thunderstore anymore.'
      },
      {
        name: 'Thing',
        version: '9.9.9',
        kind: 'github',
        reason: "Release v9.9.9 isn't available on GitHub anymore."
      },
      {
        name: 'Cool Mod',
        version: '1.0.0',
        kind: 'nexus',
        reason: 'Needs Nexus Mods Premium. Download it from the website.',
        url: 'https://www.nexusmods.com/repo/mods/5?tab=files&file_id=11'
      },
      {
        name: 'Cool Mod',
        version: '1.0.0',
        kind: 'nexus',
        reason: 'This mod is for a different game on Nexus Mods (skyrim).'
      },
      {
        name: 'mine.zip',
        version: '1.0.0',
        kind: 'local',
        reason: "Local file (mine.zip). Files aren't included in share codes."
      }
    ])
  })

  test('without a Nexus key the mod is unresolved with the Settings hint', async () => {
    const r = await importCode([nx()])
    expect(r.unresolved).toEqual([
      expect.objectContaining({ reason: 'Add your Nexus Mods API key in Settings to download.' })
    ])
  })

  test('a changed GitHub file is installed with a warning', async () => {
    const r = await importCode([gh('v1.0.0', '0'.repeat(64))])
    expect(r.installed).toBe(1)
    expect(r.warnings).toEqual([
      'owner/thing v1.0.0: the release file changed since this profile was shared.'
    ])
    expect(r.profile.mods.map((m) => m.id)).toEqual(['owner-thing'])
  })

  test('a failure in the middle leaves the other mods installed', async () => {
    ghDown = true
    const r = await importCode([ts('Dep-Lib', '1.0.0'), gh('v1.0.0'), ts('Own-Mod', '1.0.0')])
    expect(r.installed).toBe(2)
    expect(r.unresolved.map((u) => u.reason)).toEqual([
      "Couldn't reach GitHub. Check your connection and try again."
    ])
    expect(r.profile.mods.map((m) => m.id).sort()).toEqual(['Dep-Lib', 'Own-Mod'])
  })

  test("a GitHub rate limit keeps GitHub's message; a missing asset says the release is gone", async () => {
    ghLimited = true
    const r = await importCode([gh('v1.0.0')])
    expect(r.unresolved.map((u) => u.reason)).toEqual([
      "GitHub's rate limit was reached. Try again later, or add a GitHub token in Settings."
    ])
    ghLimited = false
    const missingAsset: ExportMod = {
      ...gh('v1.0.0'),
      source: { ...(gh('v1.0.0').source as object), asset: 'other.zip' } as ExportMod['source']
    }
    const r2 = await importCode([missingAsset])
    expect(r2.unresolved.map((u) => u.reason)).toEqual([
      "Release v1.0.0 isn't available on GitHub anymore."
    ])
  })

  test('a version missing from the cached index is found after one forced refresh', async () => {
    ownModVersions = ['1.0.0']
    expect((await api.tsGetPackage('repo', 'Own-Mod'))!.versions.map((v) => v.version)).toEqual([
      '1.0.0'
    ])
    const before = idxFetches
    // Thunderstore's chunk URLs change with their content.
    ownModVersions = ['2.0.0', '1.0.0']
    chunkUrl = `${CHUNK}-v2`
    const r = await importCode([ts('Own-Mod', '2.0.0'), ts('Gone-Pkg', '1.0.0')])
    expect(r.profile.mods.find((m) => m.id === 'Own-Mod')?.version).toBe('2.0.0')
    expect(r.unresolved.map((u) => u.reason)).toEqual(['Not on Thunderstore anymore.'])
    // Both misses share one refresh.
    expect(idxFetches - before).toBe(1)
  })

  test('missing dependencies and unwritable config files become warnings', async () => {
    ownModDeps = ['Dep-Lib-1.0.0', 'Gone-A-1.0.0', 'Gone-B-2.0.0']
    const r0 = await importCode([ts('Own-Mod', '1.0.0')])
    expect(r0.warnings).toEqual(['Own-Mod: missing dependencies Gone-A-1.0.0, Gone-B-2.0.0.'])
    expect(r0.installed).toBe(1)
    // A config path whose parent is a file can't be written; the next one still is.
    hml = makeHml([], {
      configs: {
        'BepInEx/config/blocker': 'file',
        'BepInEx/config/blocker/x.cfg': 'x',
        'BepInEx/config/ok.cfg': 'ok'
      }
    })
    const p = await api.previewShare({ code: CODE })
    const r = await api.importShare(p!.token, 'Cfg')
    expect(r.warnings).toEqual(["Couldn't write BepInEx/config/blocker/x.cfg."])
    const dir = deps.paths.profileDir('repo', r.profile.id)
    expect(readFileSync(path.join(dir, 'BepInEx', 'config', 'ok.cfg'), 'utf8')).toBe('ok')
  })

  test('a taken name gets a unique id and a blank name uses the profile name', async () => {
    await api.createProfile('repo', 'Friends')
    const r = await importCode([], {}, '   ')
    expect(r.profile.name).toBe('Friends')
    expect(r.profile.id).toBe('friends-2')
  })

  test('an unconfirmable Nexus domain leaves the mod unresolved without installing it', async () => {
    await withKey()
    nexusDown = true
    const r = await importCode([nx('skyrim')])
    nexusDown = false
    expect(r.installed).toBe(0)
    expect(r.unresolved).toEqual([
      {
        name: 'Cool Mod',
        version: '1.0.0',
        kind: 'nexus',
        reason:
          "HML couldn't confirm this game's Nexus Mods domain (skyrim). Set it in the game's menu, then import again."
      }
    ])
  })

  test('a nexus-<domain> export adds the game; an unknown game is rejected', async () => {
    hml = makeHml([], { game: 'nexus-stardewvalley' })
    const p = await api.previewShare({ code: CODE })
    const r = await api.importShare(p!.token, '')
    expect(r.game).toBe('nexus-stardewvalley')
    expect((await api.searchGames('')).map((g) => g.label)).toContain('nexus-stardewvalley')

    hml = makeHml([], { game: 'nosuchgame' })
    await expect(api.previewShare({ code: CODE })).rejects.toThrow(
      "This profile is for a game HML doesn't know (nosuchgame)."
    )
  })

  const NEXUS_UNREACHABLE = "Couldn't reach Nexus Mods. Check your connection and try again."

  test('a resolveGame failure keeps the token, so the import can be retried', async () => {
    hml = makeHml([], { game: 'nexus-stardewvalley' })
    const p = await api.previewShare({ code: CODE })
    nexusDown = true
    await expect(api.importShare(p!.token, '')).rejects.toThrow(NEXUS_UNREACHABLE)
    nexusDown = false
    const r = await api.importShare(p!.token, '')
    expect(r.game).toBe('nexus-stardewvalley')
    await expect(api.importShare(p!.token, '')).rejects.toThrow(
      'This import has expired. Open the code or file again.'
    )
  })

  test('a second concurrent import of one token is refused by inFlight, not a spent token', async () => {
    const EXPIRED = 'This import has expired. Open the code or file again.'
    hml = makeHml([], { game: 'nexus-stardewvalley' })
    const p = await api.previewShare({ code: CODE })
    // The first import claims the token, then fails resolving the game.
    nexusDown = true
    const first = api.importShare(p!.token, '')
    const firstSettled = expect(first).rejects.toThrow(NEXUS_UNREACHABLE)
    await expect(api.importShare(p!.token, '')).rejects.toThrow(EXPIRED)
    await firstSettled
    // The failed first import released the token, so a retry works: the refusal above came
    // from the in-flight guard.
    nexusDown = false
    await expect(api.importShare(p!.token, '')).resolves.toMatchObject({
      game: 'nexus-stardewvalley'
    })
  })

  test('a failing final read still returns the created profile with a warning', async () => {
    const p = await api.previewShare({ code: CODE })
    hooks.getProfile = async () => {
      throw new Error('disk gone')
    }
    const r = await api.importShare(p!.token, 'Read')
    hooks.getProfile = null
    expect(r.profile).toMatchObject({ name: 'Read', game: 'repo', mods: [] })
    expect(r.warnings).toEqual(["The imported profile couldn't be read back: disk gone"])
  })

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a picked file over 10 MB is refused without being read',
    async () => {
      const file = path.join(tmp, 'huge.hml')
      writeFileSync(file, '')
      truncateSync(file, 10485761)
      // Unreadable: only a stat can succeed, so the refusal proves the file wasn't read.
      chmodSync(file, 0o000)
      picked = [file]
      await expect(api.previewShare({ file: true })).rejects.toThrow(
        'This HML profile file is too large to import (over 10 MB).'
      )
    }
  )

  test('unknown, used and expired tokens give the exact message', async () => {
    const EXPIRED = 'This import has expired. Open the code or file again.'
    await expect(api.importShare('nope', '')).rejects.toThrow(EXPIRED)
    const p1 = await api.previewShare({ code: CODE })
    await api.importShare(p1!.token, '')
    await expect(api.importShare(p1!.token, '')).rejects.toThrow(EXPIRED)
    const p2 = await api.previewShare({ code: CODE })
    clock += 600_001
    await expect(api.importShare(p2!.token, '')).rejects.toThrow(EXPIRED)
  })

  test('a profile built by real installs round trips through a share code', async () => {
    // A fake Worker: the upload stores the bytes that the code download then serves.
    const shareFetch = (async (url: string, init?: RequestInit) => {
      if (url === 'https://share.test/v1/profiles' && init?.method === 'POST') {
        hml = new Uint8Array(init.body as Uint8Array)
        return Response.json({ code: CODE }, { status: 201 })
      }
      return impFetch(url, init as { body?: string })
    }) as unknown as typeof fetch
    const src = createServices({ ...deps, fetch: shareFetch, now: () => clock })
    const profile = await src.createProfile('repo', 'Round trip')
    await src.tsInstall('repo', profile.id, 'Own-Mod', '1.0.0')
    await src.ghInstall(
      'repo',
      profile.id,
      'https://github.com/owner/thing/releases/download/v1.0.0/thing.zip'
    )
    await src.setModEnabled('repo', profile.id, 'Dep-Lib', false)
    const cfgBytes = new Uint8Array([0, 1, 2, 255, 10, 13])
    const cfgDir = path.join(deps.paths.profileDir('repo', profile.id), 'BepInEx', 'config')
    mkdirSync(path.join(cfgDir, 'sub'), { recursive: true })
    writeFileSync(path.join(cfgDir, 'sub', 'mod.cfg'), cfgBytes)
    const shared = await src.shareProfile('repo', profile.id)
    expect(shared.code).toBe(CODE)

    // A fresh install of HML with its own data dir.
    const otherPaths = makePaths(path.join(tmp, 'data-2'))
    mkdirSync(otherPaths.root, { recursive: true })
    writeFileSync(otherPaths.settings, JSON.stringify({ steamRootOverride: steamRoot }))
    const dst = createServices({ ...deps, paths: otherPaths, fetch: shareFetch, now: () => clock })
    const preview = await dst.previewShare({ code: shared.code })
    const r = await dst.importShare(preview!.token, '')
    expect(r.unresolved).toEqual([])
    expect(r.warnings).toEqual([])

    const summary = (mods: typeof r.profile.mods): unknown[] =>
      mods
        .map((m) => ({ id: m.id, version: m.version, enabled: m.enabled, source: m.source }))
        .sort((x, y) => (x.id < y.id ? -1 : 1))
    const original = (await src.listProfiles('repo')).find((p) => p.id === profile.id)!
    expect(summary(r.profile.mods)).toEqual(summary(original.mods))
    expect(summary(r.profile.mods)).toEqual([
      expect.objectContaining({ id: 'Dep-Lib', version: '1.0.0', enabled: false }),
      expect.objectContaining({ id: 'Own-Mod', version: '1.0.0', enabled: true }),
      expect.objectContaining({ id: 'owner-thing', version: '1.0.0', enabled: true })
    ])
    const copied = readFileSync(
      path.join(otherPaths.profileDir('repo', r.profile.id), 'BepInEx', 'config', 'sub', 'mod.cfg')
    )
    expect([...copied]).toEqual([...cfgBytes])
  })

  test('an imported GitHub mod keeps what it provides, limited to packages on Thunderstore', async () => {
    const r = await importCode([
      { ...gh('v1.0.0'), provides: ['Dep-Lib', 'Nope-Gone'] },
      ts('Own-Mod', '1.0.0')
    ])
    expect(r.unresolved).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.profile.mods.map((m) => m.id).sort()).toEqual(['Own-Mod', 'owner-thing'])
    expect(r.profile.mods.find((m) => m.id === 'owner-thing')!.provides).toEqual(['Dep-Lib'])
  })

  test('a GitHub stand-in before its Thunderstore dependent round-trips as one copy', async () => {
    const shareFetch = (async (url: string, init?: RequestInit) => {
      if (url === 'https://share.test/v1/profiles' && init?.method === 'POST') {
        hml = new Uint8Array(init.body as Uint8Array)
        return Response.json({ code: CODE }, { status: 201 })
      }
      return impFetch(url, init as { body?: string })
    }) as unknown as typeof fetch
    const src = createServices({ ...deps, fetch: shareFetch, now: () => clock })
    const profile = await src.createProfile('repo', 'Stand-in')
    await src.ghInstall(
      'repo',
      profile.id,
      'https://github.com/owner/thing/releases/download/v3.0.0/thing.zip'
    )
    await src.tsInstall('repo', profile.id, 'Own-Mod', '1.0.0')
    const original = (await src.listProfiles('repo')).find((p) => p.id === profile.id)!
    expect(original.mods.map((m) => m.id)).toEqual(['owner-thing', 'Own-Mod'])
    const shared = await src.shareProfile('repo', profile.id)

    const otherPaths = makePaths(path.join(tmp, 'data-2'))
    mkdirSync(otherPaths.root, { recursive: true })
    writeFileSync(otherPaths.settings, JSON.stringify({ steamRootOverride: steamRoot }))
    const dst = createServices({ ...deps, paths: otherPaths, fetch: shareFetch, now: () => clock })
    const r = await dst.importShare((await dst.previewShare({ code: shared.code }))!.token, '')
    expect(r.unresolved).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.profile.mods.map((m) => m.id)).toEqual(['owner-thing', 'Own-Mod'])
    expect(r.profile.mods[0].provides).toEqual(['Dep-Lib'])
  })

  test('an import on Windows is not refused while the game runs (the new profile has no locked files)', async () => {
    api = createServices({
      ...deps,
      platform: 'win32',
      fetch: impFetch,
      now: () => clock,
      execFile: async (file) => {
        if (file !== 'tasklist') throw new Error(`${file} is not available in tests`)
        return { stdout: '"REPO.exe","1","Console","1","1 K"' }
      }
    })
    ownModDeps = ['Dep-Lib-1.5.0']
    // Own-Mod moves Dep-Lib to 1.5.0 and the export's 1.0.0 is put back, and the second
    // owner/thing release replaces the first: each replaces an installed mod.
    const r = await importCode([
      ts('Dep-Lib', '1.0.0'),
      ts('Own-Mod', '2.0.0'),
      gh('v1.0.0'),
      gh('v2.0.0')
    ])
    expect(r.unresolved).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.profile.mods.map((m) => `${m.id}@${m.version}`).sort()).toEqual([
      'Dep-Lib@1.0.0',
      'Own-Mod@2.0.0',
      'owner-thing@2.0.0'
    ])
  })

  test('HML_METHODS lists the import methods', () => {
    expect(HML_METHODS).toEqual(expect.arrayContaining(['previewShare', 'importShare']))
  })
})

describe('services launch, folders and domains', () => {
  // A catalog with two extra games that share REPO's install folder: one on another mod loader
  // and one without a Steam app id.
  function withExtraGames(): ServiceDeps {
    const base = fixture.games.repo
    const extra = (label: string, loader: string, distributions: unknown[]): unknown => ({
      ...base,
      uuid: label,
      label,
      meta: { ...base.meta, displayName: label.toUpperCase() },
      distributions,
      r2modman: [{ ...base.r2modman[0], packageLoader: loader, distributions }]
    })
    const eco = {
      ...fixture,
      games: {
        ...fixture.games,
        othergame: extra('othergame', 'melonloader', base.distributions),
        noapp: extra('noapp', 'bepinex', [])
      }
    }
    const snapshotPath = path.join(tmp, 'eco-extra.json')
    writeFileSync(snapshotPath, JSON.stringify(eco))
    return {
      ...deps,
      snapshotPath,
      fetch: (async () => ({ ok: true, json: async () => eco })) as unknown as typeof fetch
    }
  }

  test('launching a game on an unsupported mod loader is refused', async () => {
    const api = createServices(withExtraGames())
    await expect(api.launch('othergame', null, 'vanilla')).rejects.toThrow(
      'OTHERGAME uses a mod loader HML does not support yet.'
    )
    expect(spawned).toEqual([])
  })

  test('launching a game without a Steam app id is refused', async () => {
    const api = createServices(withExtraGames())
    await expect(api.launch('noapp', null, 'vanilla')).rejects.toThrow(
      'NOAPP has no Steam app id, so HML cannot launch it.'
    )
    expect(spawned).toEqual([])
  })

  test('pickGamePath saves the chosen folder and returns null on cancel', async () => {
    let chosen: string | null = null
    const api = createServices({
      ...deps,
      dialog: { ...dialog, pickFolder: async () => chosen }
    })
    expect(await api.pickGamePath('repo')).toBeNull()
    expect((await api.getSettings()).gamePathOverrides).toEqual({})
    chosen = gameDir
    expect(await api.pickGamePath('repo')).toBe(gameDir)
    expect((await api.getSettings()).gamePathOverrides).toEqual({ repo: gameDir })
  })

  test('openProfileFolder opens the profile dir and reports a shell error', async () => {
    let result = ''
    const opened: string[] = []
    const api = createServices({
      ...deps,
      shell: {
        openPath: async (p) => (opened.push(p), result),
        openExternal: async () => undefined
      }
    })
    const profile = await api.createProfile('repo', 'Folder')
    await api.openProfileFolder('repo', profile.id)
    expect(opened).toEqual([deps.paths.profileDir('repo', profile.id)])
    result = 'no file manager'
    await expect(api.openProfileFolder('repo', profile.id)).rejects.toThrow(
      'Could not open the profile folder: no file manager'
    )
  })

  test('nxSetDomain rejects a malformed domain without a request', async () => {
    const calls: string[] = []
    const api = createServices({
      ...deps,
      fetch: (async (url: string) => {
        calls.push(String(url))
        return { ok: true, json: async () => fixture }
      }) as unknown as typeof fetch
    })
    // Warm the catalog, whose load may fetch, so only the domain check is measured.
    await api.getSettings()
    await api.searchGames('')
    const before = calls.length
    await expect(api.nxSetDomain('repo', '../x')).rejects.toThrow('Nexus Mods has no game "../x".')
    expect(calls.length).toBe(before)
    expect((await api.getSettings()).nexusDomainOverrides).toEqual({})
  })

  test('the export save dialog runs outside the profile lock', async () => {
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Lockless', version_number: '1.0.0' })),
      'Lockless.dll': strToU8('dll')
    })
    const file = path.join(tmp, 'Lockless.zip')
    writeFileSync(file, zip)
    let profileId = ''
    const target = path.join(tmp, 'lockless.hml')
    const api: ReturnType<typeof createServices> = createServices({
      ...deps,
      dialog: {
        ...dialog,
        // Needs the same profile's lock: it can only finish if the dialog holds none.
        saveFile: async () => {
          await api.setModEnabled('repo', profileId, 'Lockless', false)
          return target
        }
      }
    })
    const profile = await api.createProfile('repo', 'Lock')
    profileId = profile.id
    await api.installFromPaths('repo', profile.id, [file])
    expect(await api.exportProfileFile('repo', profile.id)).toBe(target)
    const mods = (await api.listProfiles('repo')).find((p) => p.id === profile.id)!.mods
    expect(mods.find((m) => m.id === 'Lockless')?.enabled).toBe(false)
  })
})
