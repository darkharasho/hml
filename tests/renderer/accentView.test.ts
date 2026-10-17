import { describe, expect, it } from 'vitest'
import { accentVars, rememberedAccent } from '../../src/renderer/src/accentView'

describe('accentVars', () => {
  it('sets the accent and derives its hover and pressed shades', () => {
    expect(accentVars('#ff4d3d')).toEqual({
      '--color-ember': '#ff4d3d',
      '--color-ember-hover': 'color-mix(in oklab, #ff4d3d 82%, white)',
      '--color-ember-deep': 'color-mix(in oklab, #ff4d3d 80%, black)'
    })
  })
})

describe('rememberedAccent', () => {
  const storage = (v: string | null): Pick<Storage, 'getItem'> => ({ getItem: () => v })
  it('returns a stored hex colour only', () => {
    expect(rememberedAccent(storage('#7fd3e6'), 'valheim')).toBe('#7fd3e6')
    expect(rememberedAccent(storage('red; x: y'), 'valheim')).toBeNull()
    expect(rememberedAccent(storage(null), 'valheim')).toBeNull()
  })
  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      }
    }
    expect(rememberedAccent(broken, 'valheim')).toBeNull()
  })
})
