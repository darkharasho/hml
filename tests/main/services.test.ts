import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      expect(emitted.map((e) => e.done)).toEqual([0, 1, 2])
      expect(emitted.every((e) => e.total === 2)).toBe(true)
      expect(emitted[0].message).toBe('Installing Lib 1.0.0')
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
    expect([...HML_METHODS].sort()).toEqual(Object.keys(createServices(deps)).sort())
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
