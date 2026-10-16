import { describe, expect, test } from 'vitest'
import { findInstalledMod } from '../../src/shared/modIdentity'
import type { InstalledMod } from '../../src/shared/types'

const mod = (id: string, source: InstalledMod['source'], provides?: string[]): InstalledMod => ({
  id,
  name: id,
  version: '1.0.0',
  source,
  enabled: true,
  files: [],
  disableable: [],
  installedAt: '',
  ...(provides ? { provides } : {})
})
const gh = (provides?: string[]): InstalledMod =>
  mod(
    'o-r',
    { kind: 'github', owner: 'o', repo: 'r', tag: 'v1', asset: 'a.zip', sha256: '' },
    provides
  )

describe('findInstalledMod', () => {
  test('finds a GitHub mod that provides the package', () => {
    expect(findInstalledMod([gh(['O-Lib'])], 'O-Lib', [])?.id).toBe('o-r')
    expect(findInstalledMod([gh()], 'O-Lib', [])).toBeUndefined()
  })

  test('the mod recorded under the id wins over a provider', () => {
    const ts = mod('O-Lib', { kind: 'thunderstore', fullName: 'O-Lib' })
    expect(findInstalledMod([gh(['O-Lib']), ts], 'O-Lib', [])?.id).toBe('O-Lib')
  })

  test('a provided loader package is found too', () => {
    expect(
      findInstalledMod([gh(['BepInEx-BepInExPack'])], 'BepInEx-BepInExPack', [
        'BepInEx-BepInExPack'
      ])?.id
    ).toBe('o-r')
  })
})
