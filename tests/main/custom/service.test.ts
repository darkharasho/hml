import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createServices, type ServiceDeps } from '../../../src/main/services'
import { makePaths } from '../../../src/main/store/paths'
import type { HmlEvent } from '../../../src/shared/types'
import type { GameSummary } from '../../../src/shared/ipc'

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '../../fixtures/ecosystem-min.json'), 'utf8')
)

let tmp: string
let steamRoot: string
let deps: ServiceDeps
let wineWorks: boolean
let picked: string | null
let spawned: { cmd: string; args: string[] }[]
/** The fake children spawn returned, in order. */
let children: EventEmitter[]
let emitted: HmlEvent[]

const LOADER_ZIP = zipSync({
  'BepInEx/core/BepInEx.Preloader.dll': strToU8('preloader'),
  'winhttp.dll': strToU8('dll'),
  'doorstop_config.ini': strToU8('[UnityDoorstop]\nenabled=true\n')
})
const GH = 'https://github.com/BepInEx/BepInEx'
let assetId = 0
const release = (tag: string, prerelease: boolean, names: string[]): Record<string, unknown> => ({
  tag_name: tag,
  name: tag,
  prerelease,
  draft: false,
  published_at: '2026-01-01T00:00:00Z',
  html_url: `${GH}/releases/tag/${tag}`,
  assets: names.map((name) => ({
    id: ++assetId,
    name,
    size: LOADER_ZIP.length,
    browser_download_url: `${GH}/releases/download/${tag}/${name}`,
    url: `https://api.github.com/repos/BepInEx/BepInEx/releases/assets/${assetId}`
  }))
})
const RELEASES = [
  release('v6.0.0-pre.2', true, [
    'BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip',
    'BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip',
    'BepInEx-Unity.Mono-linux-x64-6.0.0-pre.2.zip'
  ]),
  release('v5.4.23.5', false, [
    'BepInEx_win_x64_5.4.23.5.zip',
    'BepInEx_win_x86_5.4.23.5.zip',
    'BepInEx_linux_x64_5.4.23.5.zip'
  ])
]

/** Serves BepInEx's GitHub releases (and the catalog for anything else). */
function serveBepInEx(opts: { releases?: unknown[]; zipFails?: boolean } = {}): void {
  deps.fetch = (async (url: string) => {
    const u = new URL(url)
    if (u.host === 'api.github.com' && u.pathname === '/repos/BepInEx/BepInEx/releases') {
      return new Response(JSON.stringify(opts.releases ?? RELEASES), { status: 200 })
    }
    // A pinned install (share import) asks for the one release by its tag.
    const byTag = /^\/repos\/BepInEx\/BepInEx\/releases\/tags\/(.+)$/.exec(u.pathname)
    if (u.host === 'api.github.com' && byTag) {
      const hit = (opts.releases ?? RELEASES).find(
        (r) => (r as { tag_name: string }).tag_name === decodeURIComponent(byTag[1])
      )
      return new Response(JSON.stringify(hit ?? {}), { status: hit ? 200 : 404 })
    }
    if (u.host === 'github.com' && u.pathname.startsWith('/BepInEx/BepInEx/releases/download/')) {
      if (opts.zipFails) throw new Error('offline')
      return new Response(LOADER_ZIP, { status: 200 })
    }
    return { ok: true, json: async () => fixture }
  }) as unknown as typeof fetch
}

/** A Windows Unity game folder outside Steam. */
function gameFolder(name: string): string {
  const dir = path.join(tmp, name)
  mkdirSync(path.join(dir, 'Trash_Data', 'Managed'), { recursive: true })
  writeFileSync(path.join(dir, 'Trash_Data', 'Managed', 'Assembly-CSharp.dll'), '')
  writeFileSync(path.join(dir, 'Trash.exe'), '')
  writeFileSync(path.join(dir, 'UnityPlayer.dll'), '')
  return dir
}

function addProton(): string {
  const proton = path.join(steamRoot, 'steamapps', 'common', 'Proton 9.0')
  mkdirSync(proton, { recursive: true })
  writeFileSync(path.join(proton, 'proton'), '')
  return proton
}

function manifest(appId: string, name: string, installdir: string, exe: boolean): string {
  const apps = path.join(steamRoot, 'steamapps')
  writeFileSync(
    path.join(apps, `appmanifest_${appId}.acf`),
    `"AppState"\n{\n"appid" "${appId}"\n"name" "${name}"\n"installdir" "${installdir}"\n"StateFlags" "4"\n}\n`
  )
  const dir = path.join(apps, 'common', installdir)
  mkdirSync(path.join(dir, 'Trash_Data', 'Managed'), { recursive: true })
  writeFileSync(path.join(dir, 'Trash_Data', 'Managed', 'Assembly-CSharp.dll'), '')
  if (exe) {
    writeFileSync(path.join(dir, 'Trash.exe'), '')
    writeFileSync(path.join(dir, 'UnityPlayer.dll'), '')
  }
  return dir
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-custom-svc-'))
  steamRoot = path.join(tmp, 'steam')
  mkdirSync(path.join(steamRoot, 'steamapps', 'common'), { recursive: true })
  writeFileSync(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), '"libraryfolders"\n{\n}\n')
  manifest('3314580', 'Trash Day', 'Trash Day', true)
  wineWorks = false
  picked = null
  spawned = []
  children = []
  emitted = []
  const paths = makePaths(path.join(tmp, 'data'))
  mkdirSync(paths.root, { recursive: true })
  writeFileSync(paths.settings, JSON.stringify({ steamRootOverride: steamRoot }))
  deps = {
    paths,
    appVersion: '1.0.0',
    os: { type: 'Linux', release: '6', arch: 'x64' },
    emit: (e) => emitted.push(e),
    nxmHandler: { status: async () => 'not-registered', register: async () => undefined },
    shareBaseUrl: 'https://share.test',
    fetch: (async () => ({ ok: true, json: async () => fixture })) as unknown as typeof fetch,
    snapshotPath: path.join(__dirname, '../../fixtures/ecosystem-min.json'),
    platform: 'linux',
    home: tmp,
    secrets: {
      isAvailable: () => true,
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString()
    },
    dialog: {
      pickFiles: async () => [],
      pickFolder: async () => picked,
      saveFile: async () => null
    },
    shell: { openPath: async () => '', openExternal: async () => undefined },
    execFile: async (file) => {
      if (file === 'wine' && wineWorks) return { stdout: 'wine-9' }
      throw new Error('not available in tests')
    },
    spawn: ((cmd: string, args: string[]) => {
      spawned.push({ cmd, args })
      const child = new EventEmitter() as EventEmitter & { unref(): void }
      child.unref = () => undefined
      children.push(child)
      process.nextTick(() => child.emit('spawn'))
      return child
    }) as unknown as ServiceDeps['spawn']
  }
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('custom game services', () => {
  test('searching "trash" lists the installed Steam game under its own label, after catalog games', async () => {
    manifest('999', 'Repo Fan Game', 'Fan', true)
    const api = createServices(deps)
    const trash = await api.searchGames('trash')
    expect(trash).toContainEqual(
      expect.objectContaining({
        label: 'steam-3314580',
        displayName: 'Trash Day',
        installDir: path.join(steamRoot, 'steamapps', 'common', 'Trash Day'),
        custom: expect.objectContaining({ added: false })
      })
    )
    const labels = (await api.searchGames('repo')).map((g) => g.label)
    expect(labels[0]).toBe('repo')
    expect(labels.at(-1)).toBe('steam-999')
  })

  test('Steam search results get Steam cover art without waiting for the store', async () => {
    const capsule = path.join(steamRoot, 'appcache', 'librarycache', '3314580', 'abc')
    mkdirSync(capsule, { recursive: true })
    writeFileSync(path.join(capsule, 'library_capsule.jpg'), 'JPG')
    const storeCalls: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    deps.fetch = (async (url: string) => {
      const u = new URL(url)
      if (u.host === 'api.steampowered.com') {
        storeCalls.push(url)
        await gate
        return new Response(
          JSON.stringify({
            response: {
              store_items: [
                {
                  appid: 3314580,
                  assets: {
                    asset_url_format: 'steam/apps/3314580/${FILENAME}?t=1',
                    library_capsule: 'h/library_capsule.jpg'
                  }
                }
              ]
            }
          })
        )
      }
      return { ok: true, json: async () => fixture }
    }) as unknown as typeof fetch
    const api = createServices(deps)
    const store =
      'https://shared.steamstatic.com/store_item_assets/steam/apps/3314580/h/library_capsule.jpg?t=1'
    const cdn = 'https://cdn.cloudflare.steamstatic.com/steam/apps/3314580/library_600x900.jpg'
    const trash = async (): Promise<GameSummary | undefined> =>
      (await api.searchGames('trash')).find((g) => g.label === 'steam-3314580')
    // The store hasn't answered: search returns anyway, with the local cover and the CDN URL.
    expect(await trash()).toMatchObject({
      iconUrl: 'hml-art://steam/3314580',
      iconFallbacks: [cdn]
    })
    release()
    await vi.waitFor(async () => expect((await trash())?.iconFallbacks).toEqual([store, cdn]))
    expect(storeCalls).toHaveLength(1)
    const added = await api.addCustomGame({
      source: 'steam',
      steamAppId: '3314580',
      loaderChoice: 'none'
    })
    expect(added.iconUrl).toBe('hml-art://steam/3314580')
    const res = await api.serveArt('hml-art://steam/3314580')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('JPG')
    expect((await api.serveArt('hml-art://steam/42')).status).toBe(404)
  })

  test('a chosen cover image is copied in, served, replaced, removed and deleted with the game', async () => {
    const img = path.join(tmp, 'Cover.PNG')
    writeFileSync(img, 'PNG1')
    deps.dialog.pickFiles = async () => [img]
    const api = createServices(deps)
    const pick = await api.pickCustomGameImage()
    expect(pick?.preview).toBe(`data:image/png;base64,${Buffer.from('PNG1').toString('base64')}`)
    const folder = gameFolder('Trash Folder')
    const added = await api.addCustomGame({
      source: 'folder',
      folder,
      displayName: 'Trash',
      loaderChoice: 'none',
      runner: null,
      image: pick!.token
    })
    expect(added.iconUrl).toMatch(/^hml-art:\/\/custom\/custom-trash-folder\?v=\d+$/)
    expect(added.custom?.image).toBe(true)
    const cover = path.join(deps.paths.gameDir(added.label), 'cover.png')
    expect(readFileSync(cover, 'utf8')).toBe('PNG1')
    expect(await (await api.serveArt(added.iconUrl!)).text()).toBe('PNG1')
    expect((await api.serveArt('hml-art://custom/custom-unknown')).status).toBe(404)
    // A token is used once.
    await expect(api.updateCustomGame(added.label, { image: pick!.token })).rejects.toThrow(
      'Choose the image again.'
    )

    const webp = path.join(tmp, 'b.webp')
    writeFileSync(webp, 'WEBP')
    deps.dialog.pickFiles = async () => [webp]
    const next = await api.pickCustomGameImage()
    await api.updateCustomGame(added.label, { image: next!.token })
    expect(existsSync(cover)).toBe(false)
    expect(readFileSync(path.join(deps.paths.gameDir(added.label), 'cover.webp'), 'utf8')).toBe(
      'WEBP'
    )

    const removed = await api.updateCustomGame(added.label, { image: null })
    expect(removed.iconUrl).toBeNull()
    expect(removed.custom?.image).toBe(false)
    expect(existsSync(path.join(deps.paths.gameDir(added.label), 'cover.webp'))).toBe(false)

    const again = await api.pickCustomGameImage()
    await api.updateCustomGame(added.label, { image: again!.token })
    await api.removeCustomGame(added.label)
    expect(existsSync(path.join(deps.paths.gameDir(added.label), 'cover.webp'))).toBe(false)
  })

  test("a failed add doesn't leave the copied cover behind", async () => {
    const img = path.join(tmp, 'a.png')
    writeFileSync(img, 'PNG')
    deps.dialog.pickFiles = async () => [img]
    const api = createServices(deps)
    const pick = await api.pickCustomGameImage()
    // custom-games.json can't be written: saving the game fails after the image was copied.
    mkdirSync(deps.paths.customGames, { recursive: true })
    await expect(
      api.addCustomGame({
        source: 'steam',
        steamAppId: '3314580',
        loaderChoice: 'none',
        image: pick!.token
      })
    ).rejects.toThrow()
    expect(existsSync(path.join(deps.paths.gameDir('steam-3314580'), 'cover.png'))).toBe(false)
  })

  test('picking a cover can be cancelled and refuses other file types', async () => {
    const api = createServices(deps)
    expect(await api.pickCustomGameImage()).toBeNull()
    const gif = path.join(tmp, 'a.gif')
    writeFileSync(gif, 'GIF')
    deps.dialog.pickFiles = async () => [gif]
    await expect(api.pickCustomGameImage()).rejects.toThrow(/PNG, JPEG or WebP/)
  })

  test('an installed game that is a catalog game is not listed twice', async () => {
    manifest('3241660', 'Trash Repo', 'TrashRepo', true)
    const api = createServices(deps)
    const labels = (await api.searchGames('trash')).map((g) => g.label)
    expect(labels).not.toContain('steam-3241660')
    expect(labels).toContain('steam-3314580')
  })

  describe('a catalog game without a Steam app id (RV There Yet)', () => {
    /** The fixture plus RV There Yet as the catalog lists it: no Steam id, only its folder. */
    function serveRv(loader: string): void {
      const rv = structuredClone(fixture.games.bonelab)
      rv.label = 'rv-there-yet'
      rv.meta.displayName = 'RV There Yet?'
      rv.distributions = []
      Object.assign(rv.r2modman[0], {
        meta: { ...rv.r2modman[0].meta, displayName: 'RV There Yet?' },
        distributions: [],
        steamFolderName: 'Ride',
        dataFolderName: 'Ride',
        exeNames: ['Ride.exe'],
        packageLoader: loader
      })
      const catalog = { ...fixture, games: { ...fixture.games, 'rv-there-yet': rv } }
      deps.fetch = (async () => ({
        ok: true,
        json: async () => catalog
      })) as unknown as typeof fetch
    }
    const addRv = (): void => {
      manifest('3949040', 'RV There Yet?', 'Ride', false)
      writeFileSync(
        deps.paths.customGames,
        JSON.stringify([
          {
            label: 'steam-3949040',
            source: 'steam',
            displayName: 'RV There Yet?',
            steamAppId: '3949040',
            loaderChoice: 'none',
            exeName: 'Ride.exe',
            dataFolderName: '',
            cover: null
          }
        ])
      )
    }
    const rvLabels = async (api: ReturnType<typeof createServices>): Promise<string[]> =>
      (await api.searchGames('rv there')).map((g) => g.label)

    test('its Steam install is matched by folder name, not offered as another game', async () => {
      serveRv('godotml')
      manifest('3949040', 'RV There Yet?', 'Ride', false)
      expect(await rvLabels(createServices(deps))).toEqual(['rv-there-yet'])
    })

    test('an added copy wins over the catalog entry when the catalog loader is unsupported', async () => {
      serveRv('godotml')
      addRv()
      const api = createServices(deps)
      expect(await rvLabels(api)).toEqual(['steam-3949040'])
      expect((await api.searchGames('')).map((g) => g.label)).not.toContain('rv-there-yet')
      // Opened before, it still opens, but lists of used games leave it out.
      expect(await api.getGame('rv-there-yet')).toMatchObject({ hidden: true })
      expect((await api.getGame('steam-3949040'))?.hidden).toBeUndefined()
    })

    test('the catalog entry wins over an added copy when HML supports its loader', async () => {
      serveRv('bepinex')
      addRv()
      expect(await rvLabels(createServices(deps))).toEqual(['rv-there-yet'])
    })

    describe('with unreal_shimloader', () => {
      let bin: string
      beforeEach(() => {
        serveRv('shimloader')
        const dir = manifest('3949040', 'RV There Yet?', 'Ride', false)
        writeFileSync(path.join(dir, 'Ride.exe'), '')
        bin = path.join(dir, 'Ride', 'Binaries', 'Win64')
        mkdirSync(bin, { recursive: true })
      })

      test('it is supported and gets the Steam app id of the install in its folder', async () => {
        const [rv] = await createServices(deps).searchGames('rv there')
        expect(rv).toMatchObject({ label: 'rv-there-yet', steamAppId: '3949040', supported: true })
      })

      test('start modded puts the shim next to the exe and points it at the profile', async () => {
        const api = createServices(deps)
        const profile = await api.createProfile('rv-there-yet', 'Default')
        const dir = deps.paths.profileDir('rv-there-yet', profile.id)
        expect(await api.getLaunchWarnings('rv-there-yet', profile.id)).toContain('no-shimloader')
        await expect(api.launch('rv-there-yet', profile.id, 'modded')).rejects.toThrow(
          /unreal_shimloader/
        )
        writeFileSync(path.join(dir, 'dwmapi.dll'), 'shim')
        writeFileSync(path.join(dir, 'ue4ss.dll'), 'ue4ss')
        const warnings = await api.getLaunchWarnings('rv-there-yet', profile.id)
        expect(warnings).not.toContain('no-shimloader')
        expect(warnings).not.toContain('loader-unsupported')
        expect(warnings).not.toContain('no-bepinex')

        await api.launch('rv-there-yet', profile.id, 'modded')
        expect(readFileSync(path.join(bin, 'dwmapi.dll'), 'utf8')).toBe('shim')
        expect(spawned.at(-1)!.args).toEqual([
          '-applaunch',
          '3949040',
          '--mod-dir',
          `Z:${path.join(dir, 'shimloader', 'mod').replace(/\//g, '\\')}`,
          '--pak-dir',
          `Z:${path.join(dir, 'shimloader', 'pak').replace(/\//g, '\\')}`,
          '--cfg-dir',
          `Z:${path.join(dir, 'shimloader', 'cfg').replace(/\//g, '\\')}`,
          '--overlay-dir',
          `Z:${path.join(dir, 'shimloader', 'overlay').replace(/\//g, '\\')}`
        ])
        expect(existsSync(path.join(dir, 'shimloader', 'cfg'))).toBe(true)

        await api.launch('rv-there-yet', profile.id, 'vanilla')
        expect(existsSync(path.join(bin, 'dwmapi.dll'))).toBe(false)
        expect(spawned.at(-1)!.args).toEqual(['-applaunch', '3949040'])
      })

      test("start modded sets dwmapi up in the game's Proton prefix", async () => {
        const reg = path.join(steamRoot, 'steamapps', 'compatdata', '3949040', 'pfx', 'user.reg')
        mkdirSync(path.dirname(reg), { recursive: true })
        writeFileSync(reg, 'WINE REGISTRY Version 2\n')
        const api = createServices(deps)
        const profile = await api.createProfile('rv-there-yet', 'Default')
        const dir = deps.paths.profileDir('rv-there-yet', profile.id)
        writeFileSync(path.join(dir, 'dwmapi.dll'), 'shim')
        writeFileSync(path.join(dir, 'ue4ss.dll'), 'ue4ss')
        expect(await api.getLaunchWarnings('rv-there-yet', profile.id)).not.toContain(
          'proton-first-run'
        )
        await api.launch('rv-there-yet', profile.id, 'modded')
        expect(readFileSync(reg, 'utf8')).toContain('"dwmapi"="native,builtin"')
        expect(readFileSync(reg, 'utf8')).not.toContain('winhttp')
      })
    })
  })

  test('an empty query lists added custom games but no un-added Steam games', async () => {
    const api = createServices(deps)
    expect((await api.searchGames('')).map((g) => g.label)).not.toContain('steam-3314580')
    await api.addCustomGame({ source: 'steam', steamAppId: '3314580', loaderChoice: 'bepinex5' })
    const labels = (await api.searchGames('')).map((g) => g.label)
    expect(labels).toContain('steam-3314580')
    expect(
      (await api.searchGames('trash')).filter((g) => g.label === 'steam-3314580')
    ).toHaveLength(1)
  })

  test('adding a Steam game stores it with the detected exe and the chosen loader', async () => {
    const api = createServices(deps)
    const added = await api.addCustomGame({
      source: 'steam',
      steamAppId: '3314580',
      loaderChoice: 'bepinex5'
    })
    expect(added).toMatchObject({
      label: 'steam-3314580',
      loader: 'bepinex',
      exeNames: ['Trash.exe'],
      custom: { added: true, loaderChoice: 'bepinex5' }
    })
    expect(await api.getGame('steam-3314580')).toMatchObject({ displayName: 'Trash Day' })
    await expect(
      api.addCustomGame({ source: 'steam', steamAppId: '1', loaderChoice: 'none' })
    ).rejects.toThrow("1 isn't installed through Steam.")
  })

  test('adding BepInEx to a native Linux build is refused', async () => {
    manifest('55', 'Native Thing', 'Native', false)
    const api = createServices(deps)
    await expect(
      api.addCustomGame({ source: 'steam', steamAppId: '55', loaderChoice: 'bepinex5' })
    ).rejects.toThrow(
      "BepInEx needs the Windows version of Native Thing. Force Proton in the game's Steam properties, then add it again."
    )
  })

  test('a Steam game without a loader finds its folder through Steam', async () => {
    const api = createServices(deps)
    const added = await api.addCustomGame({
      source: 'steam',
      steamAppId: '3314580',
      loaderChoice: 'none'
    })
    expect(added).toMatchObject({
      loader: 'deploy',
      installDir: path.join(steamRoot, 'steamapps', 'common', 'Trash Day')
    })
  })

  test('adding a folder game saves its folder and a runner', async () => {
    const proton = path.join(steamRoot, 'steamapps', 'common', 'Proton 9.0')
    mkdirSync(proton, { recursive: true })
    writeFileSync(path.join(proton, 'proton'), '')
    const folder = path.join(tmp, 'My Game')
    mkdirSync(folder)
    const api = createServices(deps)
    const added = await api.addCustomGame({
      source: 'folder',
      folder,
      displayName: ' ',
      loaderChoice: 'none'
    })
    expect(added.label).toMatch(/^custom-/)
    expect(added).toMatchObject({
      installDir: folder,
      displayName: 'My Game',
      custom: { runner: { kind: 'proton', name: 'Proton 9.0' } }
    })
    expect((await api.getSettings()).gamePathOverrides[added.label]).toBe(folder)
    const again = await api.addCustomGame({
      source: 'folder',
      folder,
      displayName: 'My Game',
      loaderChoice: 'none'
    })
    expect(again.label).toBe(added.label)
    await expect(
      api.addCustomGame({
        source: 'folder',
        folder: path.join(tmp, 'nope'),
        displayName: 'x',
        loaderChoice: 'none'
      })
    ).rejects.toThrow('is not a folder')
  })

  test('re-adding a removed Steam game picks its profiles back up', async () => {
    const api = createServices(deps)
    const add = (): Promise<unknown> =>
      api.addCustomGame({ source: 'steam', steamAppId: '3314580', loaderChoice: 'bepinex5' })
    await add()
    const profile = await api.createProfile('steam-3314580', 'p')
    await api.removeCustomGame('steam-3314580')
    expect(await api.getGame('steam-3314580')).toBeNull()
    await add()
    expect((await api.listProfiles('steam-3314580')).map((p) => p.id)).toEqual([profile.id])
  })

  test('removing a custom game clears its settings', async () => {
    const api = createServices(deps)
    const label = 'steam-3314580'
    await api.addCustomGame({ source: 'steam', steamAppId: '3314580', loaderChoice: 'none' })
    const profile = await api.createProfile(label, 'p')
    await api.setGamePath(label, tmp)
    await api.nxSetDomain(label, null)
    const s = await api.getSettings()
    const { updateSettings } = await import('../../../src/main/store/settings')
    await updateSettings(deps.paths, (cur) => ({
      ...cur,
      nexusDomainOverrides: { [label]: 'x', keep: 'y' },
      lastProfile: { [label]: profile.id, keep: 'z' },
      manualLoaderKept: [label, 'keep'],
      lastGame: label
    }))
    expect(s.gamePathOverrides[label]).toBe(tmp)
    await api.removeCustomGame(label)
    const after = await api.getSettings()
    expect(after.gamePathOverrides[label]).toBeUndefined()
    expect(after.nexusDomainOverrides).toEqual({ keep: 'y' })
    expect(after.lastProfile).toEqual({ keep: 'z' })
    expect(after.manualLoaderKept).toEqual(['keep'])
    expect(after.lastGame).toBeNull()
    expect(existsSync(deps.paths.profileDir(label, profile.id))).toBe(true)
    await expect(api.removeCustomGame(label)).rejects.toThrow(`Unknown game: ${label}`)
  })

  test('removing a deployed no-loader game is refused', async () => {
    const api = createServices(deps)
    const label = 'steam-3314580'
    await api.addCustomGame({ source: 'steam', steamAppId: '3314580', loaderChoice: 'none' })
    const profile = await api.createProfile(label, 'p')
    const zip = path.join(tmp, 'm.zip')
    writeFileSync(zip, zipSync({ 'a.txt': strToU8('hi') }))
    await api.installFromPaths(label, profile.id, [zip])
    await api.deployProfile(label, profile.id)
    await expect(api.removeCustomGame(label)).rejects.toThrow(
      'Remove the deployed mods from the game folder first.'
    )
    await api.removeDeployment(label)
    await expect(api.removeCustomGame(label)).resolves.toBeUndefined()
  })

  test('updateCustomGame renames and changes the loader for new profiles only', async () => {
    const api = createServices(deps)
    const label = 'steam-3314580'
    await api.addCustomGame({ source: 'steam', steamAppId: '3314580', loaderChoice: 'bepinex5' })
    const profile = await api.createProfile(label, 'p')
    const before = JSON.stringify(await api.listProfiles(label))
    const updated = await api.updateCustomGame(label, {
      displayName: ' Trash Day (dev) ',
      loaderChoice: 'bepinex6-mono'
    })
    expect(updated).toMatchObject({
      displayName: 'Trash Day (dev)',
      custom: { loaderChoice: 'bepinex6-mono' }
    })
    expect(JSON.stringify(await api.listProfiles(label))).toBe(before)
    expect((await api.listProfiles(label))[0].id).toBe(profile.id)
    await expect(api.updateCustomGame(label, { displayName: ' ' })).rejects.toThrow()
    await expect(api.updateCustomGame(label, { loaderChoice: 'x' as 'none' })).rejects.toThrow()
    await expect(api.updateCustomGame('steam-1', {})).rejects.toThrow('Unknown game: steam-1')
  })

  test('a custom no-loader game can have a Nexus domain override', async () => {
    deps.fetch = (async (url: string) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () =>
        url.includes('graphql')
          ? {
              data: { game: { id: '1704', name: 'Skyrim SE', domainName: 'skyrimspecialedition' } }
            }
          : fixture
    })) as unknown as typeof fetch
    const api = createServices(deps)
    await api.addCustomGame({ source: 'steam', steamAppId: '3314580', loaderChoice: 'none' })
    await api.nxSetDomain('steam-3314580', 'skyrimspecialedition')
    expect((await api.getSettings()).nexusDomainOverrides).toEqual({
      'steam-3314580': 'skyrimspecialedition'
    })
  })

  test('detectCustomGame and pickCustomGameFolder report detection', async () => {
    const api = createServices(deps)
    const found = await api.detectCustomGame('steam-3314580')
    expect(found).toMatchObject({
      displayName: 'Trash Day',
      detection: { exeName: 'Trash.exe', suggested: 'bepinex5' }
    })
    await expect(api.detectCustomGame('steam-12')).rejects.toThrow("isn't installed")
    expect(await api.pickCustomGameFolder()).toBeNull()
    picked = found.folder
    expect(await api.pickCustomGameFolder()).toMatchObject({
      folder: found.folder,
      displayName: 'Trash Day'
    })
  })

  test('listRunners lists Proton builds and Wine on Linux', async () => {
    const proton = path.join(steamRoot, 'steamapps', 'common', 'Proton 9.0')
    mkdirSync(proton, { recursive: true })
    writeFileSync(path.join(proton, 'proton'), '')
    wineWorks = true
    expect(await createServices(deps).listRunners()).toEqual([
      { kind: 'proton', name: 'Proton 9.0', path: proton },
      { kind: 'wine' }
    ])
    deps.platform = 'win32'
    expect(await createServices(deps).listRunners()).toEqual([])
  })

  test('BepInEx is refused for a native Linux folder, on add and on a loader switch', async () => {
    const folder = path.join(tmp, 'Native Folder')
    mkdirSync(folder)
    const api = createServices(deps)
    await expect(
      api.addCustomGame({
        source: 'folder',
        folder,
        displayName: 'Native',
        loaderChoice: 'bepinex5'
      })
    ).rejects.toThrow('BepInEx needs the Windows version of Native.')
    const added = await api.addCustomGame({
      source: 'folder',
      folder,
      displayName: 'Native',
      loaderChoice: 'none'
    })
    await expect(
      api.updateCustomGame(added.label, { loaderChoice: 'bepinex6-mono' })
    ).rejects.toThrow('BepInEx needs the Windows version of Native.')
    expect((await api.getGame(added.label))?.custom?.loaderChoice).toBe('none')
    await expect(api.updateCustomGame(added.label, { loaderChoice: 'none' })).resolves.toBeTruthy()
  })

  test('a catalog game cannot be added from Steam', async () => {
    manifest('3241660', 'Trash Repo', 'TrashRepo', true)
    const api = createServices(deps)
    await expect(
      api.addCustomGame({ source: 'steam', steamAppId: '3241660', loaderChoice: 'none' })
    ).rejects.toThrow("R.E.P.O. is already in HML's game list.")
  })
})

describe('custom game loaders, launches and manual installs', () => {
  const label = 'steam-3314580'
  const trashDir = (): string => path.join(steamRoot, 'steamapps', 'common', 'Trash Day')
  const addTrash = (
    api: ReturnType<typeof createServices>,
    loaderChoice: 'bepinex5' | 'bepinex6-mono' | 'none'
  ): Promise<unknown> => api.addCustomGame({ source: 'steam', steamAppId: '3314580', loaderChoice })

  test('creating a profile for a BepInEx custom game installs BepInEx 5 from GitHub', async () => {
    serveBepInEx()
    const api = createServices(deps)
    await addTrash(api, 'bepinex5')
    const profile = await api.createProfile(label, 'p')
    // The returned manifest already lists the loader, so the renderer shows it without a reload.
    expect(profile.mods).toHaveLength(1)
    const { mods } = (await api.listProfiles(label)).find((p) => p.id === profile.id)!
    expect(mods).toHaveLength(1)
    expect(mods[0].source).toMatchObject({
      kind: 'github',
      owner: 'BepInEx',
      asset: 'BepInEx_win_x64_5.4.23.5.zip'
    })
    expect(mods[0].github?.track).toEqual({ major: 5, prerelease: false })
    expect(
      existsSync(
        path.join(deps.paths.profileDir(label, profile.id), 'BepInEx/core/BepInEx.Preloader.dll')
      )
    ).toBe(true)
  })

  test("the loader gets a readable name and its BepInEx package's Thunderstore icon", async () => {
    serveBepInEx()
    const github = deps.fetch
    const asked: string[] = []
    deps.fetch = (async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://thunderstore.io/api/experimental/package/')) {
        asked.push(url)
        return new Response(
          JSON.stringify({ latest: { icon: 'https://ccdn.thunderstore.io/bep.png' } })
        )
      }
      return github(url, init)
    }) as unknown as typeof fetch
    const api = createServices(deps)
    await addTrash(api, 'bepinex5')
    const profile = await api.createProfile(label, 'p')
    const [loader] = profile.mods
    expect(loader.name).toBe('BepInEx 5 (Mono)')
    // The loader stands in for the catalog's first BepInEx package (bbepis-BepInExPack here).
    expect(loader.provides).toEqual(['bbepis-BepInExPack'])
    expect(await api.getModIcons(label, profile.id)).toEqual({
      [loader.id]: ['https://ccdn.thunderstore.io/bep.png']
    })
    expect(asked).toEqual(['https://thunderstore.io/api/experimental/package/bbepis/BepInExPack/'])
  })

  test('a failed loader download still creates the profile and reports it', async () => {
    serveBepInEx({ zipFails: true })
    const api = createServices(deps)
    await addTrash(api, 'bepinex5')
    const profile = await api.createProfile(label, 'p')
    expect((await api.listProfiles(label)).map((p) => p.id)).toEqual([profile.id])
    expect(
      emitted.some((e) => e.type === 'progress' && e.message.startsWith("Couldn't install BepInEx"))
    ).toBe(true)
    expect(await api.getLaunchWarnings(label, profile.id)).toContain('no-bepinex')
  })

  test('installLoader switches a profile to the newly chosen loader', async () => {
    serveBepInEx()
    const api = createServices(deps)
    await addTrash(api, 'bepinex5')
    const profile = await api.createProfile(label, 'p')
    expect(await api.getLaunchWarnings(label, profile.id)).not.toContain('loader-mismatch')
    await api.updateCustomGame(label, { loaderChoice: 'bepinex6-mono' })
    expect(await api.getLaunchWarnings(label, profile.id)).toContain('loader-mismatch')
    const mod = await api.installLoader(label, profile.id)
    expect(mod.source).toMatchObject({ asset: 'BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip' })
    expect(mod.name).toBe('BepInEx 6 (Mono)')
    const { mods } = (await api.listProfiles(label))[0]
    // Exactly one loader remains: the old one was replaced, not kept beside the new one.
    expect(mods).toHaveLength(1)
    expect(mods.filter((m) => m.source.kind === 'github')).toHaveLength(1)
    expect(mods[0].source).toMatchObject({ asset: 'BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip' })
    expect(await api.getLaunchWarnings(label, profile.id)).not.toContain('loader-mismatch')
    // Already the chosen loader: nothing is reinstalled.
    expect((await api.installLoader(label, profile.id)).installedAt).toBe(mod.installedAt)
  })

  test('installLoader with no matching release file changes nothing', async () => {
    serveBepInEx()
    const api = createServices(deps)
    await addTrash(api, 'bepinex6-mono')
    const profile = await api.createProfile(label, 'p')
    const before = (await api.listProfiles(label))[0].mods
    expect(before).toHaveLength(1)
    await api.updateCustomGame(label, { loaderChoice: 'bepinex5' })
    serveBepInEx({
      releases: [RELEASES[0], release('v5.4.23.5', false, ['BepInEx_linux_x64_5.4.23.5.zip'])]
    })
    await expect(api.installLoader(label, profile.id)).rejects.toThrow(
      'BepInEx/BepInEx v5.4.23.5 has no file like BepInEx_win_x64_{version}.zip.'
    )
    expect((await api.listProfiles(label))[0].mods).toEqual(before)
    expect(
      existsSync(
        path.join(deps.paths.profileDir(label, profile.id), 'BepInEx/core/BepInEx.Preloader.dll')
      )
    ).toBe(true)
  })

  test('installLoader refuses a game without BepInEx', async () => {
    const api = createServices(deps)
    await addTrash(api, 'none')
    const profile = await api.createProfile(label, 'p')
    await expect(api.installLoader(label, profile.id)).rejects.toThrow(
      "Trash Day doesn't use BepInEx."
    )
  })

  test('modded launch of a custom Steam game uses Steam with doorstop arguments', async () => {
    serveBepInEx()
    const api = createServices(deps)
    await addTrash(api, 'bepinex5')
    const profile = await api.createProfile(label, 'p')
    await api.launch(label, profile.id, 'modded')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].args).toEqual(
      expect.arrayContaining(['-applaunch', '3314580', '--doorstop-enable', 'true'])
    )
  })

  test('a no-loader Steam game launches through Steam without doorstop arguments', async () => {
    const api = createServices(deps)
    await addTrash(api, 'none')
    const profile = await api.createProfile(label, 'p')
    await api.launch(label, profile.id, 'modded')
    await api.launch(label, null, 'vanilla')
    expect(spawned).toEqual([
      { cmd: 'steam', args: ['-applaunch', '3314580'] },
      { cmd: 'steam', args: ['-applaunch', '3314580'] }
    ])
  })

  test('a folder game on Linux launches through its Proton runner', async () => {
    serveBepInEx()
    addProton()
    const folder = gameFolder('Trash')
    const api = createServices(deps)
    const game = await api.addCustomGame({
      source: 'folder',
      folder,
      displayName: 'Trash',
      loaderChoice: 'bepinex5'
    })
    const profile = await api.createProfile(game.label, 'p')
    const warnings = await api.getLaunchWarnings(game.label, profile.id)
    expect(warnings).not.toContain('steam-not-found')
    expect(warnings).not.toContain('proton-first-run')
    expect(warnings).not.toContain('native-linux-unsupported')
    expect(warnings).not.toContain('no-runner')
    expect(warnings).not.toContain('no-bepinex')
    await api.launch(game.label, profile.id, 'modded')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].cmd.endsWith('/proton')).toBe(true)
    expect(spawned[0].args.slice(0, 2)).toEqual(['run', path.join(folder, 'Trash.exe')])
    expect(spawned[0].args).toContain('--doorstop-enable')
    expect(existsSync(deps.paths.winePrefix(game.label))).toBe(true)
  })

  test('waitForGame ends with exited when a folder game exits before it is seen', async () => {
    serveBepInEx()
    addProton()
    const folder = gameFolder('Trash')
    const api = createServices({
      ...deps,
      procFs: { readdir: async () => [], readFile: async () => '' }
    })
    const game = await api.addCustomGame({
      source: 'folder',
      folder,
      displayName: 'Trash',
      loaderChoice: 'bepinex5'
    })
    const profile = await api.createProfile(game.label, 'p')
    await api.launch(game.label, profile.id, 'modded')
    const wait = api.waitForGame(game.label)
    await new Promise((r) => setTimeout(r, 10))
    children[0].emit('exit', 1, null)
    expect(await wait).toBe('exited')
  })

  test('a folder game on Linux without a runner warns and refuses to launch', async () => {
    const folder = gameFolder('Trash')
    const api = createServices(deps)
    const game = await api.addCustomGame({
      source: 'folder',
      folder,
      displayName: 'Trash',
      loaderChoice: 'none'
    })
    const profile = await api.createProfile(game.label, 'p')
    expect(await api.getLaunchWarnings(game.label, profile.id)).toContain('no-runner')
    await expect(api.launch(game.label, profile.id, 'modded')).rejects.toThrow(
      'Choose how to run this game (Proton or Wine) from the game menu.'
    )
    expect(spawned).toEqual([])
    rmSync(folder, { recursive: true })
    expect(await api.getLaunchWarnings(game.label, profile.id)).toContain('game-not-found')
  })

  test('getManualLoader finds a hand install and remembers Keep', async () => {
    const api = createServices(deps)
    await addTrash(api, 'bepinex5')
    expect(await api.getManualLoader(label)).toBeNull()
    mkdirSync(path.join(trashDir(), 'BepInEx', 'plugins'), { recursive: true })
    writeFileSync(path.join(trashDir(), 'winhttp.dll'), '')
    expect(await api.getManualLoader(label)).toEqual({
      entries: ['BepInEx', 'winhttp.dll'],
      kept: false
    })
    await api.keepManualLoader(label)
    await api.keepManualLoader(label)
    expect(await api.getManualLoader(label)).toMatchObject({ kept: true })
    expect((await api.getSettings()).manualLoaderKept).toEqual([label])
  })

  test('catalog BepInEx games find and remove a hand install in their folder', async () => {
    const api = createServices(deps)
    const dir = path.join(tmp, 'repo-game')
    mkdirSync(path.join(dir, 'BepInEx', 'plugins'), { recursive: true })
    writeFileSync(path.join(dir, 'winhttp.dll'), '')
    // A path override, as a user sets it; no Steam copy of the game exists.
    await api.setGamePath('repo', dir)
    expect(await api.getManualLoader('repo')).toEqual({
      entries: ['BepInEx', 'winhttp.dll'],
      kept: false
    })
    const backup = await api.removeManualLoader('repo')
    expect(existsSync(path.join(backup, 'winhttp.dll'))).toBe(true)
    expect(existsSync(path.join(dir, 'BepInEx'))).toBe(false)
    expect(await api.getManualLoader('repo')).toBeNull()
  })

  test('removeManualLoader backs up the hand install and clears Keep', async () => {
    const api = createServices(deps)
    await addTrash(api, 'bepinex5')
    await expect(api.removeManualLoader(label)).rejects.toThrow(
      'There is no manual BepInEx install in the game folder.'
    )
    mkdirSync(path.join(trashDir(), 'BepInEx', 'plugins'), { recursive: true })
    writeFileSync(path.join(trashDir(), 'BepInEx', 'plugins', 'Mine.dll'), 'mine')
    await api.keepManualLoader(label)
    const backup = await api.removeManualLoader(label)
    expect(backup.startsWith(path.join(deps.paths.root, 'backups', label) + path.sep)).toBe(true)
    expect(readFileSync(path.join(backup, 'BepInEx', 'plugins', 'Mine.dll'), 'utf8')).toBe('mine')
    expect(existsSync(path.join(trashDir(), 'BepInEx'))).toBe(false)
    expect((await api.getSettings()).manualLoaderKept).toEqual([])
    expect(await api.getManualLoader(label)).toBeNull()
  })

  describe('share codes', () => {
    /** A fresh install: its own data dir, the same fake Steam, and the saved file to import. */
    function freshInstall(file: string, withSteamApp = true): ReturnType<typeof createServices> {
      const data = path.join(tmp, `data-${Math.random().toString(36).slice(2)}`)
      const paths = makePaths(data)
      mkdirSync(paths.root, { recursive: true })
      const root = withSteamApp ? steamRoot : path.join(tmp, 'empty-steam')
      mkdirSync(path.join(root, 'steamapps'), { recursive: true })
      writeFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), '"libraryfolders"\n{\n}\n')
      writeFileSync(paths.settings, JSON.stringify({ steamRootOverride: root }))
      return createServices({
        ...deps,
        paths,
        dialog: { ...deps.dialog, pickFiles: async () => [file] }
      })
    }

    async function exportFrom(
      api: ReturnType<typeof createServices>,
      label: string
    ): Promise<string> {
      const profile = await api.createProfile(label, 'Shared')
      const file = path.join(tmp, `${label}.hml`)
      deps.dialog.saveFile = async () => file
      await api.exportProfileFile(label, profile.id)
      return file
    }

    test('sharing a custom Steam game records it, and importing on a fresh install adds it', async () => {
      const api = createServices(deps)
      await api.addCustomGame({ source: 'steam', steamAppId: '3314580', loaderChoice: 'none' })
      const label = 'steam-3314580'
      // The profile is made while the game has no loader (no download); the export then
      // records the loader the game is set to now.
      const file = await exportFrom(api, label)
      await api.updateCustomGame(label, { loaderChoice: 'bepinex5' })
      const profile = (await api.listProfiles(label))[0]
      const file2 = path.join(tmp, 'again.hml')
      deps.dialog.saveFile = async () => file2
      await api.exportProfileFile(label, profile.id)

      const fresh = freshInstall(file2)
      expect(await fresh.getGame(label)).toBeNull()
      const preview = await fresh.previewShare({ file: true })
      expect(preview).toMatchObject({ game: label, gameName: 'Trash Day' })
      expect(preview!.needsFolder).toBeUndefined()
      const result = await fresh.importShare(preview!.token, '')
      expect(result.game).toBe(label)
      expect(await fresh.getGame(label)).toMatchObject({
        custom: { loaderChoice: 'bepinex5' }
      })
      expect(readFileSync(file)).not.toEqual(readFileSync(file2))
    })

    test('importing a profile with its loader gives no loader-mismatch', async () => {
      serveBepInEx()
      const api = createServices(deps)
      await api.addCustomGame({ source: 'steam', steamAppId: '3314580', loaderChoice: 'bepinex5' })
      const label = 'steam-3314580'
      const file = await exportFrom(api, label)
      const fresh = freshInstall(file)
      const preview = await fresh.previewShare({ file: true })
      const result = await fresh.importShare(preview!.token, '')
      expect(result.unresolved).toEqual([])
      const loader = result.profile.mods.find((m) => m.source.kind === 'github')!
      // Reinstalled from a pinned release URL, so no track was saved.
      expect(loader.github?.track).toBeUndefined()
      expect(await fresh.getLaunchWarnings(result.game, result.profile.id)).not.toContain(
        'loader-mismatch'
      )
    })

    test("importing a Steam custom game that isn't installed is refused", async () => {
      const api = createServices(deps)
      await api.addCustomGame({ source: 'steam', steamAppId: '3314580', loaderChoice: 'none' })
      const file = await exportFrom(api, 'steam-3314580')
      const fresh = freshInstall(file, false)
      await expect(fresh.previewShare({ file: true })).rejects.toThrow(
        "This profile is for Trash Day, which isn't installed through Steam on this PC."
      )
    })

    test('importing a folder game asks for its folder unless a game with that name exists', async () => {
      const api = createServices(deps)
      const folder = gameFolder('My Game')
      const added = await api.addCustomGame({
        source: 'folder',
        folder,
        displayName: 'My Game',
        loaderChoice: 'none'
      })
      const file = await exportFrom(api, added.label)

      const fresh = freshInstall(file)
      const preview = await fresh.previewShare({ file: true })
      expect(preview).toMatchObject({ needsFolder: true, gameName: 'My Game' })
      await expect(fresh.importShare(preview!.token, '')).rejects.toThrow(
        'Choose the game folder to import this profile.'
      )
      const result = await fresh.importShare(preview!.token, '', folder)
      expect(result.game).toMatch(/^custom-/)
      expect((await fresh.listProfiles(result.game)).map((p) => p.name)).toEqual(['Shared'])

      // A second install that already has a game of that name uses it.
      const other = freshInstall(file)
      const mine = await other.addCustomGame({
        source: 'folder',
        folder: gameFolder('Elsewhere'),
        displayName: 'my GAME',
        loaderChoice: 'none'
      })
      const p2 = await other.previewShare({ file: true })
      expect(p2!.needsFolder).toBeUndefined()
      expect((await other.importShare(p2!.token, '')).game).toBe(mine.label)
    })

    test('importing never renames or re-loaders a game that already owns the folder', async () => {
      const api = createServices(deps)
      const file = await exportFrom(
        api,
        (
          await api.addCustomGame({
            source: 'folder',
            folder: gameFolder('My Game'),
            displayName: 'My Game',
            loaderChoice: 'bepinex6-mono'
          })
        ).label
      )
      const other = freshInstall(file)
      const folder = gameFolder('Elsewhere')
      const mine = await other.addCustomGame({
        source: 'folder',
        folder,
        displayName: 'Elsewhere',
        loaderChoice: 'none'
      })
      const p = await other.previewShare({ file: true })
      expect(p!.needsFolder).toBe(true)
      const r = await other.importShare(p!.token, '', folder)
      expect(r.game).toBe(mine.label)
      expect(await other.getGame(mine.label)).toMatchObject({
        displayName: 'Elsewhere',
        custom: { loaderChoice: 'none' }
      })
      expect((await other.listProfiles(mine.label)).map((x) => x.name)).toEqual(['Shared'])
    })

    test('importing a Steam game that is already stored leaves it as it is', async () => {
      const api = createServices(deps)
      await api.addCustomGame({ source: 'steam', steamAppId: '3314580', loaderChoice: 'none' })
      await api.updateCustomGame('steam-3314580', { loaderChoice: 'bepinex6-mono' })
      const file = await exportFrom(api, 'steam-3314580')
      const other = freshInstall(file)
      await other.addCustomGame({ source: 'steam', steamAppId: '3314580', loaderChoice: 'none' })
      await other.updateCustomGame('steam-3314580', { displayName: 'Mine' })
      const p = await other.previewShare({ file: true })
      const r = await other.importShare(p!.token, '')
      expect(r.game).toBe('steam-3314580')
      expect(await other.getGame('steam-3314580')).toMatchObject({
        displayName: 'Mine',
        custom: { loaderChoice: 'none' }
      })
    })
  })
})
