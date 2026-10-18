import { describe, expect, it } from 'vitest'
import {
  dependentsOf,
  disabledDependencies,
  orphanedBy,
  type ModDeps
} from '../../src/shared/modDeps'
import type { InstalledMod } from '../../src/shared/types'

function mod(id: string, enabled = true): InstalledMod {
  return {
    id,
    name: id,
    version: '1.0.0',
    source: { kind: 'thunderstore', fullName: id },
    enabled,
    files: [],
    disableable: [],
    installedAt: ''
  }
}

// app -> lib -> core, other -> core, everything -> loader
const deps: ModDeps = {
  deps: {
    app: ['lib', 'loader'],
    lib: ['core', 'loader'],
    other: ['core', 'loader'],
    core: ['loader']
  },
  loaders: ['loader']
}
const mods = [mod('app'), mod('lib'), mod('core'), mod('other'), mod('loader')]

describe('dependentsOf', () => {
  it('lists enabled mods that need the mod, directly or through others', () => {
    expect(dependentsOf(deps, mods, 'core').sort()).toEqual(['app', 'lib', 'other'])
    expect(dependentsOf(deps, mods, 'lib')).toEqual(['app'])
    expect(dependentsOf(deps, mods, 'app')).toEqual([])
  })

  it('skips disabled dependents', () => {
    const some = mods.map((m) => (m.id === 'app' ? mod('app', false) : m))
    expect(dependentsOf(deps, some, 'lib')).toEqual([])
  })

  it('survives a dependency cycle', () => {
    const cyclic: ModDeps = { deps: { a: ['b'], b: ['a'] }, loaders: [] }
    expect(dependentsOf(cyclic, [mod('a'), mod('b')], 'a')).toEqual(['b'])
  })
})

describe('disabledDependencies', () => {
  it('lists disabled mods the mod needs, directly or through others', () => {
    const some = mods.map((m) => (m.id === 'core' || m.id === 'lib' ? mod(m.id, false) : m))
    expect(disabledDependencies(deps, some, 'app').sort()).toEqual(['core', 'lib'])
    expect(disabledDependencies(deps, mods, 'app')).toEqual([])
  })
})

describe('orphanedBy', () => {
  it('lists dependencies nothing else needs, never the loader', () => {
    const solo = [mod('app'), mod('lib'), mod('core'), mod('loader')]
    expect(orphanedBy(deps, solo, 'app').sort()).toEqual(['core', 'lib'])
  })

  it('keeps a dependency another mod still needs, and what it needs', () => {
    expect(orphanedBy(deps, mods, 'app')).toEqual(['lib'])
  })

  it('counts disabled mods as still needing their dependencies', () => {
    const some = mods.map((m) => (m.id === 'other' ? mod('other', false) : m))
    expect(orphanedBy(deps, some, 'app')).toEqual(['lib'])
  })

  it('ignores ids that are not installed', () => {
    expect(orphanedBy({ deps: { app: ['gone'] }, loaders: [] }, [mod('app')], 'app')).toEqual([])
  })
})
