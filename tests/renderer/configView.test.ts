import { describe, expect, it } from 'vitest'
import {
  configsForMod,
  controlFor,
  splitConfigPath,
  splitFlags
} from '../../src/renderer/src/configView'
import type { ConfigFile, InstalledMod } from '../../src/shared/types'

const file = (path: string): ConfigFile => ({ path, size: 1, modifiedAt: '' })
const mod = (name: string, files: string[] = []): InstalledMod => ({
  id: name,
  name,
  version: '1',
  source: { kind: 'thunderstore', fullName: `a-${name}` },
  enabled: true,
  files,
  disableable: [],
  installedAt: ''
})

describe('configsForMod', () => {
  const files = [
    file('BepInEx/config/com.author.more_company.cfg'),
    file('BepInEx/config/BepInEx.cfg'),
    file('BepInEx/config/shipped.json')
  ]
  it('puts the files the mod installed first, then ones named after it', () => {
    expect(
      configsForMod(mod('MoreCompany', ['BepInEx/config/shipped.json']), files).map((f) => f.path)
    ).toEqual(['BepInEx/config/shipped.json', 'BepInEx/config/com.author.more_company.cfg'])
  })
  it('does not match on very short names', () => {
    expect(configsForMod(mod('A'), files)).toEqual([])
  })
})

describe('config view helpers', () => {
  it('splits a path into folder and name', () => {
    expect(splitConfigPath('BepInEx/config/a.cfg')).toEqual({
      dir: 'BepInEx/config',
      name: 'a.cfg'
    })
    expect(splitConfigPath('a.cfg')).toEqual({ dir: '', name: 'a.cfg' })
  })
  it('picks a control from the setting type', () => {
    const e = { type: null, acceptable: null, flags: false }
    expect(controlFor({ ...e, type: 'Boolean' })).toBe('toggle')
    expect(controlFor({ ...e, type: 'KeyCode', acceptable: ['A'] })).toBe('select')
    expect(controlFor({ ...e, type: 'LogLevel', acceptable: ['A'], flags: true })).toBe('flags')
    expect(controlFor({ ...e, type: 'Int32' })).toBe('number')
    expect(controlFor({ ...e, type: 'Single' })).toBe('number')
    expect(controlFor({ ...e, type: 'String' })).toBe('text')
    expect(controlFor(e)).toBe('text')
  })
  it('splits flags', () => {
    expect(splitFlags('Error, Warning,')).toEqual(['Error', 'Warning'])
  })
})
