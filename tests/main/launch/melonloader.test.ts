import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { hasMelonLoader, melonLoaderArgs, melonLogFile } from '../../../src/main/launch/melonloader'
import {
  linkProxyLoader,
  proxyLoaderFor,
  unlinkProxyLoader
} from '../../../src/main/launch/proxyLoaders'

let tmp: string
let profile: string
let game: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-melon-'))
  profile = path.join(tmp, 'profile')
  mkdirSync(path.join(profile, 'MelonLoader'), { recursive: true })
  writeFileSync(path.join(profile, 'version.dll'), 'profile version.dll')
  game = path.join(tmp, 'Schedule I')
  mkdirSync(game)
  writeFileSync(path.join(game, 'Schedule I.exe'), 'exe')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const read = (f: string): string => readFileSync(path.join(game, f), 'utf8')

describe('hasMelonLoader', () => {
  test('needs the MelonLoader folder and a proxy DLL', async () => {
    expect(await hasMelonLoader(profile)).toBe(true)
    rmSync(path.join(profile, 'version.dll'))
    expect(await hasMelonLoader(profile)).toBe(false)
    writeFileSync(path.join(profile, 'winhttp.dll'), 'x')
    expect(await hasMelonLoader(profile)).toBe(true)
    rmSync(path.join(profile, 'MelonLoader'), { recursive: true })
    expect(await hasMelonLoader(profile)).toBe(false)
  })
})

describe('melonLoaderArgs', () => {
  test('modded points MelonLoader at the profile and regenerates until assemblies exist', async () => {
    expect(await melonLoaderArgs({ mode: 'modded', profileDir: profile, proton: false })).toEqual([
      '--melonloader.basedir',
      profile,
      '--melonloader.agfregenerate'
    ])
    const il2cpp = path.join(profile, 'MelonLoader', 'Il2CppAssemblies')
    mkdirSync(il2cpp)
    writeFileSync(path.join(il2cpp, 'Assembly-CSharp.dll'), 'x')
    expect(await melonLoaderArgs({ mode: 'modded', profileDir: profile, proton: false })).toEqual([
      '--melonloader.basedir',
      profile
    ])
  })

  test('Proton gets a Windows path', async () => {
    const args = await melonLoaderArgs({ mode: 'modded', profileDir: '/home/u/p', proton: true })
    expect(args.slice(0, 2)).toEqual(['--melonloader.basedir', 'Z:\\home\\u\\p'])
  })

  test('vanilla turns mods off', async () => {
    expect(await melonLoaderArgs({ mode: 'vanilla', profileDir: profile, proton: true })).toEqual([
      '--no-mods'
    ])
  })

  test('logs to MelonLoader/Latest.log in the profile', () => {
    expect(melonLogFile(profile)).toBe(path.join(profile, 'MelonLoader', 'Latest.log'))
  })
})

describe('linking MelonLoader', () => {
  const melon = proxyLoaderFor('recursive-melonloader')!

  test('copies the proxy in and takes it back out', async () => {
    await linkProxyLoader(melon, profile, game)
    expect(read('version.dll')).toBe('profile version.dll')
    expect(existsSync(path.join(game, 'winhttp.dll'))).toBe(false)
    await unlinkProxyLoader(melon, game)
    expect(readdirSync(game)).toEqual(['Schedule I.exe'])
  })

  test('moves a hand-installed proxy aside and restores it', async () => {
    writeFileSync(path.join(game, 'version.dll'), 'hand version.dll')
    await linkProxyLoader(melon, profile, game)
    expect(read('version.dll')).toBe('profile version.dll')
    // A second modded launch replaces HML's own copy and keeps the backup.
    await linkProxyLoader(melon, profile, game)
    expect(read('version.dll.hml-backup')).toBe('hand version.dll')
    await unlinkProxyLoader(melon, game)
    expect(read('version.dll')).toBe('hand version.dll')
    expect(readdirSync(game).sort()).toEqual(['Schedule I.exe', 'version.dll'])
  })

  test('unlink without a link leaves the game alone', async () => {
    writeFileSync(path.join(game, 'version.dll'), 'hand version.dll')
    await unlinkProxyLoader(melon, game)
    expect(read('version.dll')).toBe('hand version.dll')
  })
})
