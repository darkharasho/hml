import type { GameSummary } from '../../shared/ipc'
import type { Settings } from '../../shared/types'

/** How many games the titlebar's game menu lists. */
export const MAX_MENU_GAMES = 8

/**
 * Labels of the games the user has opened (each remembers its last profile), the current one
 * first, at most MAX_MENU_GAMES.
 */
export function usedGameLabels(settings: Settings | null, current: string | null): string[] {
  const labels = [
    ...(current ? [current] : []),
    ...(settings?.lastGame ? [settings.lastGame] : []),
    ...Object.keys(settings?.lastProfile ?? {})
  ]
  return [...new Set(labels)].slice(0, MAX_MENU_GAMES)
}

/** The game menu's games by name; the current game is kept even when its lookup is missing. */
export function sortMenuGames(
  games: (GameSummary | null)[],
  current: GameSummary | null
): GameSummary[] {
  const found = games
    .filter((g): g is GameSummary => g !== null)
    .map((g) => (current && g.label === current.label ? current : g))
  if (current && !found.some((g) => g.label === current.label)) found.push(current)
  return found.sort((a, b) => a.displayName.localeCompare(b.displayName))
}
