import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  linkProxyLoader,
  proxyDlls,
  proxyLoaderFor,
  unlinkProxyLoader
} from '../../../src/main/launch/proxyLoaders'

let tmp: string
let profile: string
let game: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-proxy-'))
  profile = path.join(tmp, 'profile')
  game = path.join(tmp, 'game')
  mkdirSync(profile)
  mkdirSync(game)
  writeFileSync(path.join(game, 'Game.exe'), 'exe')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const lovely = proxyLoaderFor('lovely')!
const rom = proxyLoaderFor('return-of-modding')!

describe('proxyLoaderFor', () => {
  test('knows the proxy loaders and nothing else', () => {
    expect(proxyLoaderFor('melonloader')?.name).toBe('MelonLoader')
    expect(proxyLoaderFor('recursive-melonloader')?.name).toBe('MelonLoader')
    expect(lovely.name).toBe('lovely')
    expect(rom.name).toBe('Return of Modding')
    expect(proxyLoaderFor('bepinex')).toBeNull()
    expect(proxyLoaderFor('shimloader')).toBeNull()
  })
})

describe('lovely', () => {
  test('is installed when the profile has either of its DLLs', async () => {
    expect(await lovely.has(profile)).toBe(false)
    writeFileSync(path.join(profile, 'version.dll'), 'old lovely')
    expect(await lovely.has(profile)).toBe(true)
  })

  test('args point at the profile mods folder, or ask for vanilla', async () => {
    expect(await lovely.args({ mode: 'modded', profileDir: profile, proton: false })).toEqual([
      '--mod-dir',
      path.join(profile, 'mods')
    ])
    expect(await lovely.args({ mode: 'vanilla', profileDir: profile, proton: false })).toEqual([
      '--vanilla'
    ])
  })

  test('the log is the newest one lovely wrote', async () => {
    expect(await lovely.logFile(profile)).toBeNull()
    const logs = path.join(profile, 'mods', 'lovely', 'log')
    mkdirSync(logs, { recursive: true })
    writeFileSync(path.join(logs, 'lovely-old.log'), 'old')
    writeFileSync(path.join(logs, 'lovely-new.log'), 'new')
    writeFileSync(path.join(logs, 'notes.txt'), 'x')
    utimesSync(path.join(logs, 'lovely-old.log'), 1000, 1000)
    utimesSync(path.join(logs, 'lovely-new.log'), 2000, 2000)
    expect(await lovely.logFile(profile)).toBe(path.join(logs, 'lovely-new.log'))
  })

  test('link copies its DLL next to the exe and unlink restores a hand install', async () => {
    writeFileSync(path.join(profile, 'winmm.dll'), 'profile lovely')
    writeFileSync(path.join(game, 'winmm.dll'), 'hand lovely')
    await linkProxyLoader(lovely, profile, game)
    expect(readFileSync(path.join(game, 'winmm.dll'), 'utf8')).toBe('profile lovely')
    await unlinkProxyLoader(lovely, game)
    expect(readFileSync(path.join(game, 'winmm.dll'), 'utf8')).toBe('hand lovely')
    expect(readdirSync(game).sort()).toEqual(['Game.exe', 'winmm.dll'])
  })
})

describe('Return of Modding', () => {
  test('args point at the profile, or turn it off', async () => {
    expect(await rom.args({ mode: 'modded', profileDir: profile, proton: false })).toEqual([
      '--rom_modding_root_folder',
      profile
    ])
    expect(await rom.args({ mode: 'vanilla', profileDir: profile, proton: false })).toEqual([
      '--rom_enabled',
      'false'
    ])
  })

  test('logs to ReturnOfModding/LogOutput.log in the profile', async () => {
    expect(await rom.logFile(profile)).toBe(path.join(profile, 'ReturnOfModding', 'LogOutput.log'))
  })
})

describe('proxyDlls', () => {
  test('the proxies the profile has, or the current one before it has any', async () => {
    expect(await proxyDlls(rom, profile)).toEqual(['version'])
    writeFileSync(path.join(profile, 'd3d12.dll'), 'h2m')
    expect(await proxyDlls(rom, profile)).toEqual(['d3d12'])
    expect(await proxyDlls(lovely, profile)).toEqual(['winmm'])
  })
})
