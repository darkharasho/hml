import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createServices, type DialogPort, type ServiceDeps } from '../../src/main/services'
import { makePaths } from '../../src/main/store/paths'
import { HML_METHODS } from '../../src/shared/ipc'

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '../fixtures/ecosystem-min.json'), 'utf8')
)

let tmp: string
let steamRoot: string
let gameDir: string
let picked: string[]
let spawned: { cmd: string; args: string[] }[]
let deps: ServiceDeps

const dialog: DialogPort = {
  pickFiles: async () => picked,
  pickFolder: async () => null
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
  spawned = []
  const paths = makePaths(path.join(tmp, 'data'))
  mkdirSync(paths.root, { recursive: true })
  writeFileSync(paths.settings, JSON.stringify({ steamRootOverride: steamRoot }))
  deps = {
    paths,
    fetch: (async () => ({ ok: true, json: async () => fixture })) as unknown as typeof fetch,
    snapshotPath: path.join(__dirname, '../fixtures/ecosystem-min.json'),
    platform: 'linux',
    home: tmp,
    dialog,
    shell: { openPath: async () => '' },
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

  test('launch modded spawns steam with doorstop args', async () => {
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

  test('setGamePath overrides the install dir and saveSettings invalidates the steam root', async () => {
    const api = createServices(deps)
    expect((await api.searchGames('repo'))[0].installDir).toBe(gameDir)
    const other = path.join(tmp, 'elsewhere')
    mkdirSync(other)
    await api.setGamePath('repo', other)
    expect((await api.searchGames('repo'))[0].installDir).toBe(other)
    await api.setGamePath('repo', null)
    await api.saveSettings({ ...(await api.getSettings()), steamRootOverride: null })
    const noSteam = createServices({ ...deps, home: path.join(tmp, 'nohome') })
    await noSteam.saveSettings({ ...(await noSteam.getSettings()), steamRootOverride: null })
    expect((await noSteam.searchGames('repo'))[0].installDir).toBeNull()
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

  test('mutations on one profile run serially', async () => {
    const api = createServices(deps)
    const profile = await api.createProfile('repo', 'Test')
    const zip = (name: string): Uint8Array =>
      zipSync({
        'manifest.json': strToU8(JSON.stringify({ name, version_number: '1.0.0' })),
        [`${name}.dll`]: strToU8('x')
      })
    const files = ['A', 'B', 'C'].map((n) => {
      const f = path.join(tmp, `${n}.zip`)
      writeFileSync(f, zip(n))
      return f
    })
    picked = files
    await Promise.all([
      api.installFromFile('repo', profile.id),
      api.renameProfile('repo', profile.id, 'Renamed')
    ])
    const [p] = await api.listProfiles('repo')
    expect(p.name).toBe('Renamed')
    expect(p.mods.map((m) => m.id).sort()).toEqual(['A', 'B', 'C'])
  })

  test('HML_METHODS covers every HmlApi key', () => {
    expect([...HML_METHODS].sort()).toEqual(Object.keys(createServices(deps)).sort())
  })
})
