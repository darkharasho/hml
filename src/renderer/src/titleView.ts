import type { GameSummary } from '../../shared/ipc'
import type { Settings } from '../../shared/types'

/** How many games the titlebar's game menu and the picker's Your games list. */
export const MAX_MENU_GAMES = 8

/**
 * Labels of the games the user has opened (each remembers its last profile), the current one
 * first. All of them: uniqueGames drops duplicates before keeping MAX_MENU_GAMES.
 */
export function usedGameLabels(settings: Settings | null, current: string | null): string[] {
  const labels = [
    ...(current ? [current] : []),
    ...(settings?.lastGame ? [settings.lastGame] : []),
    ...Object.keys(settings?.lastProfile ?? {})
  ]
  return [...new Set(labels)]
}

/**
 * The user's games once each, at most MAX_MENU_GAMES (the first ones in `games`, which is in the
 * order used), by name. Entries another one stands in for are left out and, should two entries
 * still share a name, the current game, then an installed one, then a non-Nexus one is kept. The
 * current game is kept even when its lookup is missing or hidden.
 */
export function uniqueGames(
  games: (GameSummary | null)[],
  current: GameSummary | null
): GameSummary[] {
  const found = games
    .filter((g): g is GameSummary => g !== null && (!g.hidden || g.label === current?.label))
    .map((g) => (current && g.label === current.label ? current : g))
  if (current && !found.some((g) => g.label === current.label)) found.unshift(current)
  const score = (g: GameSummary): number =>
    (g.label === current?.label ? 4 : 0) +
    (g.installDir ? 2 : 0) +
    (g.label.startsWith('nexus-') ? 0 : 1)
  const byName = new Map<string, GameSummary>()
  for (const g of found) {
    const key = g.displayName.trim().toLowerCase()
    const had = byName.get(key)
    if (!had || score(g) > score(had)) byName.set(key, g)
  }
  return [...byName.values()]
    .slice(0, MAX_MENU_GAMES)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}
