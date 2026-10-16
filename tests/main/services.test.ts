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

const hooks = vi.hoisted(() => ({
  rename: null as null | ((...a: unknown[]) => Promise<void>)
}))
vi.mock('../../src/main/profiles/profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/profiles/profiles')>()
  return {
    ...actual,
    renameProfile: (...a: Parameters<typeof actual.renameProfile>) =>
      hooks.rename ? hooks.rename(...a) : actual.renameProfile(...a)
  }
})

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
      gamePathOverrides: { repo: '/a' },
      steamRootOverride: null,
      lastGame: null,
      lastProfile: {}
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
      await api.saveSettings({ ...(await api.getSettings()), gamePathOverrides: overrides })
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

  test('HML_METHODS covers every HmlApi key', () => {
    expect([...HML_METHODS].sort()).toEqual(Object.keys(createServices(deps)).sort())
  })
})
