import { describe, expect, test } from 'vitest'
import type { GameSummary } from '../../src/shared/ipc'
import type { Settings } from '../../src/shared/types'
import { MAX_MENU_GAMES, sortMenuGames, usedGameLabels } from '../../src/renderer/src/titleView'

const settings = (lastGame: string | null, used: string[]): Settings => ({
  gamePathOverrides: {},
  steamRootOverride: null,
  lastGame,
  lastProfile: Object.fromEntries(used.map((g) => [g, 'p'])),
  nexusDomainOverrides: {},
  manualLoaderKept: []
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

  test(`keeps at most ${MAX_MENU_GAMES}`, () => {
    const many = Array.from({ length: 20 }, (_, i) => `g${i}`)
    expect(usedGameLabels(settings(null, many), 'cur')).toHaveLength(MAX_MENU_GAMES)
    expect(usedGameLabels(settings(null, many), 'cur')[0]).toBe('cur')
  })
})

describe('sortMenuGames', () => {
  test('sorts by name and drops games that could not be looked up', () => {
    const r = sortMenuGames([game('v', 'Valheim'), null, game('r', 'R.E.P.O.')], null)
    expect(r.map((g) => g.label)).toEqual(['r', 'v'])
  })

  test('uses the store copy of the current game and adds it when missing', () => {
    const current = game('r', 'R.E.P.O.')
    expect(sortMenuGames([game('r', 'stale')], current)[0]).toBe(current)
    expect(sortMenuGames([game('v', 'Valheim')], current).map((g) => g.label)).toEqual(['r', 'v'])
  })
})
