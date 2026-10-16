import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listInstalledApps } from '../../../src/main/steam/installedApps'

let tmp: string
let root: string
let lib2: string

async function manifest(
  lib: string,
  appId: string,
  name: string,
  installdir: string,
  opts: { flags?: string; folder?: boolean } = {}
): Promise<void> {
  const apps = path.join(lib, 'steamapps')
  await fs.mkdir(apps, { recursive: true })
  await fs.writeFile(
    path.join(apps, `appmanifest_${appId}.acf`),
    `"AppState"\n{\n"appid" "${appId}"\n"name" "${name}"\n"installdir" "${installdir}"\n"StateFlags" "${opts.flags ?? '4'}"\n}\n`
  )
  if (opts.folder !== false && !installdir.includes('..')) {
    await fs.mkdir(path.join(apps, 'common', installdir), { recursive: true })
  }
}

async function writeLibraries(paths: string[]): Promise<void> {
  const body = paths.map((p, i) => `"${i}" { "path" "${p}" }`).join('\n')
  await fs.mkdir(path.join(root, 'steamapps'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n${body}\n}\n`
  )
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hml-apps-')))
  root = path.join(tmp, 'steam')
  lib2 = path.join(tmp, 'lib2')
  await fs.mkdir(lib2, { recursive: true })
  await writeLibraries([root, lib2])
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('listInstalledApps', () => {
  it('lists installed games from every library, sorted by name', async () => {
    await manifest(lib2, '3314580', 'Trash Day', 'TrashDay')
    await manifest(root, '10', 'Alpha', 'Alpha')
    expect(await listInstalledApps(root)).toEqual([
      { appId: '10', name: 'Alpha', installDir: path.join(root, 'steamapps', 'common', 'Alpha') },
      {
        appId: '3314580',
        name: 'Trash Day',
        installDir: path.join(lib2, 'steamapps', 'common', 'TrashDay')
      }
    ])
  })

  it('drops tools, runtimes, soundtracks and demos', async () => {
    await manifest(root, '2348590', 'Proton 9.0', 'Proton 9.0')
    await manifest(root, '1628350', 'Steam Linux Runtime 3.0', 'SLR')
    await manifest(root, '20', 'Foo Soundtrack', 'Foo')
    await manifest(root, '30', 'Bar Demo', 'Bar')
    expect(await listInstalledApps(root)).toEqual([])
  })

  it('drops apps that are not fully installed or whose folder is missing', async () => {
    await manifest(root, '40', 'Updating', 'Updating', { flags: '1026' })
    await manifest(root, '50', 'Ghost', 'Ghost', { folder: false })
    expect(await listInstalledApps(root)).toEqual([])
  })

  it('rejects unsafe installdir values', async () => {
    await manifest(root, '60', 'Evil', '../evil')
    // The traversal target exists, so only the installdir safety check can reject it.
    await fs.mkdir(path.join(root, 'steamapps', 'evil'), { recursive: true })
    expect(await listInstalledApps(root)).toEqual([])
  })

  it('skips a library that is listed but missing', async () => {
    await writeLibraries([root, '/nonexistent/lib'])
    await manifest(root, '10', 'Alpha', 'Alpha')
    const apps = await listInstalledApps(root)
    expect(apps.map((a) => a.name)).toEqual(['Alpha'])
  })
})
