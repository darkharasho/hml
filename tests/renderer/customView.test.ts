import { describe, expect, test } from 'vitest'
import type { GameDef, GameDetection } from '../../src/shared/types'
import {
  isNexusOnly,
  isSteamCandidate,
  loaderChoicesFor,
  loaderOptionLabel,
  runnerLabel
} from '../../src/renderer/src/customView'

const mono: GameDetection = {
  exeName: 'Game.exe',
  dataFolderName: 'Game_Data',
  engine: 'unity-mono',
  nativeLinux: false,
  suggested: 'bepinex5'
}
const g = (o: object): GameDef => o as unknown as GameDef

describe('customView', () => {
  test('loaderOptionLabel marks the suggested choice', () => {
    expect(loaderOptionLabel('bepinex5', mono)).toBe('Unity (Mono) — BepInEx 5, recommended')
    expect(loaderOptionLabel('bepinex6-mono', mono)).toBe('Unity (Mono) — BepInEx 6 (pre-release)')
    expect(loaderOptionLabel('bepinex6-il2cpp', mono)).toBe(
      'Unity (IL2CPP) — BepInEx 6 (GitHub pre-release)'
    )
    expect(loaderOptionLabel('none', mono)).toBe('No loader (copy mods into the game folder)')
    expect(loaderOptionLabel('none', { ...mono, suggested: 'none' })).toBe(
      'No loader (copy mods into the game folder), recommended'
    )
  })

  test('loaderChoicesFor offers only No loader for native Linux builds', () => {
    expect(loaderChoicesFor({ ...mono, nativeLinux: true })).toEqual(['none'])
    expect(loaderChoicesFor(mono)).toEqual(['bepinex5', 'bepinex6-mono', 'bepinex6-il2cpp', 'none'])
  })

  test('isNexusOnly uses the label, not the loader', () => {
    expect(isNexusOnly(g({ label: 'steam-1', loader: 'deploy' }))).toBe(false)
    expect(isNexusOnly(g({ label: 'nexus-x', loader: 'deploy' }))).toBe(true)
  })

  test('isSteamCandidate is true only for un-added games', () => {
    expect(isSteamCandidate(g({ custom: { added: false } }))).toBe(true)
    expect(isSteamCandidate(g({ custom: { added: true } }))).toBe(false)
    expect(isSteamCandidate(g({}))).toBe(false)
  })

  test('runnerLabel', () => {
    expect(runnerLabel({ kind: 'proton', name: 'Proton 9', path: '/p' })).toBe('Proton 9')
    expect(runnerLabel({ kind: 'wine' })).toBe('Wine')
  })
})
