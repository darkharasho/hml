import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createServices, type DialogPort, type ServiceDeps } from '../../src/main/services'
import { makePaths } from '../../src/main/store/paths'
import { HML_METHODS } from '../../src/shared/ipc'
import type { HmlEvent, TsQuery } from '../../src/shared/types'

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
let execCalls: { file: string; args: string[] }[]
let deps: ServiceDeps
let emitted: HmlEvent[]

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
  execCalls = []
  const paths = makePaths(path.join(tmp, 'data'))
  mkdirSync(paths.root, { recursive: true })
  writeFileSync(paths.settings, JSON.stringify({ steamRootOverride: steamRoot }))
  emitted = []
  deps = {
    paths,
    emit: (e) => emitted.push(e),
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
          return { ok: true, status: 200, arrayBuffer: async () => buf }
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
    // ghAutoUpdateAll is for the main-process scheduler, not an IPC method.
    const keys = Object.keys(createServices(deps)).filter((k) => k !== 'ghAutoUpdateAll')
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
      headers: new Headers(),
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
          return { ok: true, status: 200, arrayBuffer: async () => buf }
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
        'owner/repo: Download of a.zip failed: checksum mismatch'
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
        'owner/repo: owner/repo v2.0.0 has several files and none matches the one you picked before. Reinstall it from its GitHub link to choose again.'
      )
      expect((await modsOf())[0].source).toMatchObject({ tag: 'v1.0.0' })
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
          return { ok: true, status: 200, arrayBuffer: async () => buf } as never
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
            return { ok: true, status: 200, arrayBuffer: async () => buf }
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
        api = createServices({ ...deps, secrets, fetch: loginFetch([]) })
        await expect(api.ghSetToken('ghp_abc123')).rejects.toThrow(
          "Secure storage isn't available on this system, so HML can't save a GitHub token."
        )
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
    test('policy: explicit ports on allowed hosts are accepted', async () => {
      expect(await run('https://thunderstore.io:8443/')).toEqual(['https://thunderstore.io:8443/'])
    })
    test.each(['javascript:alert(1)', 'https://thunderstore.io./'])('rejects %s', async (u) => {
      await expect(run(u)).rejects.toThrow('HML only opens Thunderstore and GitHub links.')
    })
  })

  describe('openExternal', () => {
    const MSG = 'HML only opens Thunderstore and GitHub links.'
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
