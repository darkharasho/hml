import { describe, expect, test } from 'vitest'
import type { GameDef, GameDetection } from '../../src/shared/types'
import {
  isNexusOnly,
  isSteamCandidate,
  loaderChoicesFor,
  loaderOptionLabel,
  runnerLabel,
  sourcesFor
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

import { isLinux, runnerIndexOf } from '../../src/renderer/src/customView'
describe('platform and runner helpers', () => {
  test('isLinux reads the given platform and is false without one', () => {
    expect(isLinux('linux')).toBe(true)
    expect(isLinux('win32')).toBe(false)
    expect(isLinux(undefined)).toBe(false)
  })
  test('runnerIndexOf matches kind and path, falling back to the first', () => {
    const list = [
      { kind: 'proton' as const, name: 'A', path: '/a' },
      { kind: 'proton' as const, name: 'B', path: '/b' },
      { kind: 'wine' as const }
    ]
    expect(runnerIndexOf(list, { kind: 'proton', name: 'B', path: '/b' })).toBe(1)
    expect(runnerIndexOf(list, { kind: 'wine' })).toBe(2)
    expect(runnerIndexOf(list, { kind: 'proton', name: 'Z', path: '/z' })).toBe(0)
    expect(runnerIndexOf(list, null)).toBe(0)
  })

  describe('sourcesFor', () => {
    const custom = {
      label: 'custom-x',
      packageIndex: null,
      custom: { source: 'folder', added: true }
    }
    const catalog = {
      label: 'repo',
      packageIndex: 'https://thunderstore.io/c/repo/api/v1/package/'
    }
    const asGame = (o: object): Parameters<typeof sourcesFor>[0] =>
      o as unknown as Parameters<typeof sourcesFor>[0]

    test('a custom game with no Nexus domain makes GitHub the primary source', () => {
      expect(sourcesFor(asGame(custom), null)).toEqual({ online: [], githubPrimary: true })
    })
    test('a catalog game offers Thunderstore and, with a domain, Nexus', () => {
      expect(sourcesFor(asGame(catalog), null)).toEqual({
        online: ['thunderstore'],
        githubPrimary: false
      })
      expect(sourcesFor(asGame(catalog), 'repo')).toEqual({
        online: ['thunderstore', 'nexus'],
        githubPrimary: false
      })
    })
    test('a Nexus-only game offers Nexus before its domain has loaded', () => {
      expect(sourcesFor(asGame({ label: 'nexus-skyrim', packageIndex: null }), null)).toEqual({
        online: ['nexus'],
        githubPrimary: false
      })
    })
    test('a custom game with a Nexus domain offers Nexus only', () => {
      expect(sourcesFor(asGame(custom), 'somegame')).toEqual({
        online: ['nexus'],
        githubPrimary: false
      })
    })
  })
})
