import { describe, expect, test } from 'vitest'
import type { GameSummary } from '../../src/shared/ipc'
import type { Settings } from '../../src/shared/types'
import { MAX_MENU_GAMES, uniqueGames, usedGameLabels } from '../../src/renderer/src/titleView'

const settings = (lastGame: string | null, used: string[]): Settings => ({
  gamePathOverrides: {},
  steamRootOverride: null,
  lastGame,
  lastProfile: Object.fromEntries(used.map((g) => [g, 'p'])),
  nexusDomainOverrides: {},
  manualLoaderKept: [],
  gameColors: true
})
const game = (label: string, displayName: string): GameSummary =>
  ({ label, displayName }) as GameSummary

describe('usedGameLabels', () => {
  test('the current game first, then the games that remember a profile, once each', () => {
    expect(usedGameLabels(settings('b', ['a', 'b', 'c']), 'c')).toEqual(['c', 'b', 'a'])
  })

  test('works before settings load and without a current game', () => {
    expect(usedGameLabels(null, null)).toEqual([])
    expect(usedGameLabels(null, 'x')).toEqual(['x'])
  })

  test('lists every used game; uniqueGames applies the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => `g${i}`)
    expect(usedGameLabels(settings(null, many), 'cur')).toHaveLength(21)
    expect(usedGameLabels(settings(null, many), 'cur')[0]).toBe('cur')
  })
})

describe('uniqueGames', () => {
  test('sorts by name and drops games that could not be looked up', () => {
    const r = uniqueGames([game('v', 'Valheim'), null, game('r', 'R.E.P.O.')], null)
    expect(r.map((g) => g.label)).toEqual(['r', 'v'])
  })

  test('drops hidden twins unless one is the current game', () => {
    const twin = { ...game('rv', 'RV There Yet?'), hidden: true }
    expect(uniqueGames([twin, game('v', 'Valheim')], null).map((g) => g.label)).toEqual(['v'])
    expect(uniqueGames([twin], twin).map((g) => g.label)).toEqual(['rv'])
  })

  test('keeps one entry per name: current, then installed, then not from Nexus', () => {
    const nexus = { ...game('nexus-valheim', 'Valheim'), installDir: '/v' }
    const catalog = game('valheim', 'Valheim')
    const installed = { ...catalog, installDir: '/v' }
    expect(uniqueGames([nexus, catalog], null).map((g) => g.label)).toEqual(['nexus-valheim'])
    expect(uniqueGames([nexus, installed], null).map((g) => g.label)).toEqual(['valheim'])
    expect(uniqueGames([installed, nexus], nexus).map((g) => g.label)).toEqual(['nexus-valheim'])
  })

  test(`keeps the ${MAX_MENU_GAMES} most recently used, counting a duplicate once`, () => {
    const used = Array.from({ length: 12 }, (_, i) => game(`g${i}`, `Game ${i}`))
    const twin = { ...game('nexus-g0', 'Game 0'), hidden: true }
    const r = uniqueGames([used[0], twin, ...used.slice(1)], null).map((g) => g.label)
    expect(r).toHaveLength(MAX_MENU_GAMES)
    expect(r).toContain(`g${MAX_MENU_GAMES - 1}`)
    expect(r).not.toContain(`g${MAX_MENU_GAMES}`)
  })

  test('uses the store copy of the current game and adds it when missing', () => {
    const current = game('r', 'R.E.P.O.')
    expect(uniqueGames([game('r', 'stale')], current)[0]).toBe(current)
    expect(uniqueGames([game('v', 'Valheim')], current).map((g) => g.label)).toEqual(['r', 'v'])
  })
})
