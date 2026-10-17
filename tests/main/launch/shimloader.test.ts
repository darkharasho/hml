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
import {
  hasShimloader,
  linkShimloader,
  shimBinDir,
  shimloaderArgs,
  unlinkShimloader
} from '../../../src/main/launch/shimloader'

let tmp: string
let profile: string
let bin: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hml-shim-'))
  profile = path.join(tmp, 'profile')
  mkdirSync(profile)
  for (const f of ['dwmapi.dll', 'ue4ss.dll', 'UE4SS-settings.ini']) {
    writeFileSync(path.join(profile, f), `profile ${f}`)
  }
  bin = shimBinDir(path.join(tmp, 'Ride'), 'Ride')
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, 'Ride-Win64-Shipping.exe'), 'exe')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const read = (f: string): string => readFileSync(path.join(bin, f), 'utf8')

describe('shimloader launch files', () => {
  test('the exe folder is <data folder>/Binaries/Win64', () => {
    expect(shimBinDir('/g/Ride', 'Ride')).toBe('/g/Ride/Ride/Binaries/Win64')
  })

  test('a profile has shimloader once it has the shim and UE4SS', async () => {
    expect(await hasShimloader(profile)).toBe(true)
    rmSync(path.join(profile, 'ue4ss.dll'))
    expect(await hasShimloader(profile)).toBe(false)
  })

  test('args point at the profile, as Windows paths under Proton', () => {
    expect(shimloaderArgs({ profileDir: '/p', platform: 'linux', proton: true })).toEqual([
      '--mod-dir',
      'Z:\\p\\shimloader\\mod',
      '--pak-dir',
      'Z:\\p\\shimloader\\pak',
      '--cfg-dir',
      'Z:\\p\\shimloader\\cfg',
      '--overlay-dir',
      'Z:\\p\\shimloader\\overlay'
    ])
    expect(shimloaderArgs({ profileDir: 'C:\\p', platform: 'win32', proton: false })[1]).toBe(
      'C:\\p\\shimloader\\mod'
    )
  })

  test('link copies the files next to the exe and creates the folders shimloader wants', async () => {
    await linkShimloader(profile, bin)
    expect(read('dwmapi.dll')).toBe('profile dwmapi.dll')
    expect(read('ue4ss.dll')).toBe('profile ue4ss.dll')
    for (const d of ['mod', 'pak', 'cfg', 'overlay']) {
      expect(existsSync(path.join(profile, 'shimloader', d))).toBe(true)
    }
  })

  test('unlink takes them out again, leaving the game as it was', async () => {
    await linkShimloader(profile, bin)
    await linkShimloader(profile, bin)
    await unlinkShimloader(bin)
    expect(readdirSync(bin)).toEqual(['Ride-Win64-Shipping.exe'])
  })

  test('a hand install of UE4SS is moved aside and put back, in any case', async () => {
    writeFileSync(path.join(bin, 'dwmapi.dll'), 'hand dwmapi')
    writeFileSync(path.join(bin, 'UE4SS.dll'), 'hand ue4ss')
    await linkShimloader(profile, bin)
    expect(read('dwmapi.dll')).toBe('profile dwmapi.dll')
    expect(readdirSync(bin)).not.toContain('UE4SS.dll')
    // A second modded launch keeps the backup of the hand install, not HML's copy.
    await linkShimloader(profile, bin)
    await unlinkShimloader(bin)
    expect(read('dwmapi.dll')).toBe('hand dwmapi')
    expect(read('UE4SS.dll')).toBe('hand ue4ss')
    expect(readdirSync(bin).sort()).toEqual(['Ride-Win64-Shipping.exe', 'UE4SS.dll', 'dwmapi.dll'])
  })

  test('unlink leaves a hand install alone when HML never linked', async () => {
    writeFileSync(path.join(bin, 'dwmapi.dll'), 'hand dwmapi')
    await unlinkShimloader(bin)
    expect(read('dwmapi.dll')).toBe('hand dwmapi')
    await unlinkShimloader(path.join(tmp, 'missing'))
  })

  test('link fails clearly when the exe folder is missing', async () => {
    await expect(linkShimloader(profile, path.join(tmp, 'nope'))).rejects.toThrow(/Binaries\/Win64/)
  })
})
