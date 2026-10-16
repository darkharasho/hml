import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createServices, type ServiceDeps } from '../../../src/main/services'
import { makePaths } from '../../../src/main/store/paths'

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '../../fixtures/ecosystem-min.json'), 'utf8')
)

let tmp: string
let steamRoot: string
let deps: ServiceDeps
let wineWorks: boolean
let picked: string | null

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
  const paths = makePaths(path.join(tmp, 'data'))
  mkdirSync(paths.root, { recursive: true })
  writeFileSync(paths.settings, JSON.stringify({ steamRootOverride: steamRoot }))
  deps = {
    paths,
    appVersion: '1.0.0',
    os: { type: 'Linux', release: '6', arch: 'x64' },
    emit: () => undefined,
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
    spawn: (() => {
      const child = new EventEmitter() as EventEmitter & { unref(): void }
      child.unref = () => undefined
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

  test('an installed game that is a catalog game is not listed twice', async () => {
    manifest('3241660', 'Trash Repo', 'TrashRepo', true)
    const api = createServices(deps)
    const labels = (await api.searchGames('trash')).map((g) => g.label)
    expect(labels).not.toContain('steam-3241660')
    expect(labels).toContain('steam-3314580')
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
