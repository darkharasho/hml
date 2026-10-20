import type { GameSummary } from '../../shared/ipc'
import type { Settings } from '../../shared/types'

/** How many games the titlebar's game menu lists. */
export const MAX_MENU_GAMES = 8
/** How many games the picker's Your games lists: two rows at the default window width. */
export const MAX_YOUR_GAMES = 14

/**
 * Labels of the games the user has opened (each remembers its last profile) or starred, the
 * current one first and favorites next, so a limit keeps them. All of them: uniqueGames drops
 * duplicates before applying a limit.
 */
export function usedGameLabels(settings: Settings | null, current: string | null): string[] {
  const labels = [
    ...(current ? [current] : []),
    ...(settings?.favoriteGames ?? []),
    ...(settings?.lastGame ? [settings.lastGame] : []),
    ...Object.keys(settings?.lastProfile ?? {})
  ]
  return [...new Set(labels)]
}

/** The starred games' labels; empty before settings load. */
export function favoriteLabels(settings: Settings | null): string[] {
  return settings?.favoriteGames ?? []
}

/** Stars a game, or unstars it if it already is. */
export function toggleFavorite(favorites: string[], label: string): string[] {
  return favorites.includes(label) ? favorites.filter((l) => l !== label) : [...favorites, label]
}

/**
 * The user's games once each, at most `limit` (the first ones in `games`, which is in the order
 * used), by name. Entries another one stands in for are left out and, should two entries
 * still share a name, the current game, then an installed one, then a non-Nexus one is kept. The
 * current game is kept even when its lookup is missing or hidden.
 */
export function uniqueGames(
  games: (GameSummary | null)[],
  current: GameSummary | null,
  limit = MAX_MENU_GAMES
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
    .slice(0, limit)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}
