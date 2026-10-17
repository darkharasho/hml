import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTsIcons,
  modIconCandidates,
  modIconFile,
  modIconPath,
  parseTsPackageIcon
} from '../../../src/main/art/modIcons'
import type { InstalledMod } from '../../../src/shared/types'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-modicons-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const mod = (over: Partial<InstalledMod> = {}): InstalledMod => ({
  id: 'Owner-Mod',
  name: 'Mod',
  version: '1.0.0',
  source: { kind: 'local', fileName: 'Mod.zip', sha256: 'x' },
  enabled: true,
  files: [],
  disableable: [],
  installedAt: '2026-01-01T00:00:00Z',
  ...over
})

describe('modIconFile', () => {
  it('picks the shallowest icon.png, case-insensitively', () => {
    expect(
      modIconFile({
        files: [
          'BepInEx/plugins/Owner-Mod/assets/icon.png',
          'BepInEx/plugins/Owner-Mod/ICON.PNG',
          'BepInEx/plugins/Owner-Mod/Mod.dll'
        ]
      })
    ).toBe('BepInEx/plugins/Owner-Mod/ICON.PNG')
    expect(modIconFile({ files: ['a/myicon.png', 'b/icon.png.bak'] })).toBeNull()
  })
})

describe('modIconPath', () => {
  const profile = (): string => path.join(tmp, 'profile')
  const put = (rel: string): string => {
    const file = path.join(profile(), rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, 'png')
    return file
  }
  it('returns the icon, or its .old copy when disabled', async () => {
    const file = put('BepInEx/plugins/A/icon.png')
    expect(await modIconPath(profile(), { files: ['BepInEx/plugins/A/icon.png'] })).toBe(file)
    const old = put('BepInEx/plugins/B/icon.png.old')
    expect(await modIconPath(profile(), { files: ['BepInEx/plugins/B/icon.png'] })).toBe(old)
  })
  it('never leaves the profile', async () => {
    writeFileSync(path.join(tmp, 'icon.png'), 'x')
    expect(await modIconPath(profile(), { files: ['../icon.png'] })).toBeNull()
    expect(await modIconPath(profile(), { files: [path.join(tmp, 'icon.png')] })).toBeNull()
  })
  it('returns null when missing', async () => {
    expect(await modIconPath(profile(), { files: ['x/icon.png'] })).toBeNull()
    expect(await modIconPath(profile(), { files: [] })).toBeNull()
  })
})

describe('modIconCandidates', () => {
  const ts = (n: string): string | null =>
    n === 'BepInEx-BepInExPack'
      ? 'https://ts/bep.png'
      : n === 'Owner-Mod'
        ? 'https://ts/mod.png'
        : null
  it('puts the installed icon before the Thunderstore icon', () => {
    const m = mod({
      source: { kind: 'thunderstore', fullName: 'Owner-Mod' },
      files: ['BepInEx/plugins/Owner-Mod/icon.png']
    })
    expect(modIconCandidates('repo', 'default', m, ts)).toEqual([
      'hml-art://mod/repo/default/Owner-Mod?v=1.0.0',
      'https://ts/mod.png'
    ])
  })
  it("uses a provided package's icon for a GitHub mod", () => {
    const m = mod({
      id: 'BepInEx-BepInEx',
      source: {
        kind: 'github',
        owner: 'BepInEx',
        repo: 'BepInEx',
        tag: 'v5',
        asset: 'BepInEx_win_x64_5.4.23.5.zip',
        sha256: 'x'
      },
      provides: ['BepInEx-BepInExPack']
    })
    expect(modIconCandidates('g', 'p', m, ts)).toEqual(['https://ts/bep.png'])
  })
  it('has nothing for a Nexus or local mod without an icon', () => {
    expect(
      modIconCandidates(
        'g',
        'p',
        mod({ source: { kind: 'nexus', domain: 'x', modId: 1, fileId: 2 } }),
        ts
      )
    ).toEqual([])
    expect(modIconCandidates('g', 'p', mod(), ts)).toEqual([])
  })
})

describe('createTsIcons', () => {
  it('parses the package API', () => {
    expect(parseTsPackageIcon({ latest: { icon: 'https://ccdn.thunderstore.io/i.png' } })).toBe(
      'https://ccdn.thunderstore.io/i.png'
    )
    expect(parseTsPackageIcon({ latest: { icon: 'javascript:x' } })).toBeNull()
    expect(parseTsPackageIcon(null)).toBeNull()
  })
  it('fetches each package once, caches to disk, and backs off on failure', async () => {
    const calls: string[] = []
    let fail = false
    let t = 1_000_000
    const fetch = (async (url: string) => {
      calls.push(url)
      if (fail) throw new Error('offline')
      if (url.includes('/Nobody/')) return new Response('{}', { status: 404 })
      return new Response(
        JSON.stringify({ latest: { icon: 'https://ccdn.thunderstore.io/b.png' } })
      )
    }) as unknown as typeof globalThis.fetch
    const cacheFile = path.join(tmp, 'ts-icons.json')
    const icons = createTsIcons({ fetch, cacheFile, now: () => t })
    const first = await icons.icons(['BepInEx-BepInExPack', 'Nobody-Here', 'bad name'])
    expect([...first]).toEqual([['BepInEx-BepInExPack', 'https://ccdn.thunderstore.io/b.png']])
    expect(calls).toEqual([
      'https://thunderstore.io/api/experimental/package/BepInEx/BepInExPack/',
      'https://thunderstore.io/api/experimental/package/Nobody/Here/'
    ])
    await icons.icons(['BepInEx-BepInExPack', 'Nobody-Here'])
    expect(calls.length).toBe(2)

    const again = createTsIcons({ fetch, cacheFile, now: () => t })
    expect((await again.icons(['BepInEx-BepInExPack'])).size).toBe(1)
    expect(calls.length).toBe(2)

    fail = true
    expect((await again.icons(['Other-Pack'])).size).toBe(0)
    await again.icons(['Other-Pack'])
    expect(calls.length).toBe(3)
    t += 120_000
    await again.icons(['Other-Pack'])
    expect(calls.length).toBe(4)
  })
})
