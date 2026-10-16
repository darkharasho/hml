import { useEffect, useState } from 'react'
import type { GameSummary } from '../../../shared/ipc'
import { api, errorMessage } from '../api'
import { useStore } from '../store'
import { GameCover } from './GameCover'
import { Button, Icon } from './ui'

const SEARCH_DEBOUNCE_MS = 150

export function GamePicker(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [games, setGames] = useState<GameSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const selectGame = useStore((s) => s.selectGame)
  const pickGamePath = useStore((s) => s.pickGamePath)
  const openSettings = useStore((s) => s.setSettingsOpen)
  // Re-run the search when the Steam folder changes, since install dirs depend on it.
  const steamRoot = useStore((s) => s.settings?.steamRootOverride)

  useEffect(() => {
    let stale = false
    const timer = setTimeout(() => {
      api.searchGames(query).then(
        (result) => {
          if (stale) return
          setGames(result)
          setError(null)
        },
        (e) => {
          if (!stale) setError(errorMessage(e))
        }
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query, reload, steamRoot])

  async function setFolder(game: GameSummary): Promise<void> {
    if (await pickGamePath(game.label)) setReload((n) => n + 1)
  }

  const installedCount = games?.filter((g) => g.installDir).length ?? 0

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-line px-6 py-4">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold tracking-tight text-ember">HML</span>
          <span className="hidden text-sm text-muted sm:inline">Choose a game</span>
        </div>
        <label className="relative flex-1">
          <span className="sr-only">Search games</span>
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search games"
            className="h-10 w-full max-w-xl rounded-lg border border-line bg-panel pr-3 pl-9 text-sm text-fg placeholder:text-muted focus:border-ember/70 focus:outline-none"
          />
        </label>
        <Button
          variant="quiet"
          aria-label="Settings"
          title="Settings"
          onClick={() => openSettings(true)}
        >
          <Icon name="gear" />
        </Button>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-5">
        {error && <p className="text-sm text-danger">Could not load games: {error}</p>}
        {!error && games === null && <p className="text-sm text-muted">Loading games…</p>}
        {games && games.length === 0 && (
          <p className="text-sm text-muted">
            No games match “{query}”. Try the name as it appears on Thunderstore.
          </p>
        )}
        {games && games.length > 0 && (
          <>
            <p className="mb-4 text-sm text-muted">
              {games.length} {games.length === 1 ? 'game' : 'games'}
              {installedCount > 0 && `, ${installedCount} installed on this PC`}
            </p>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-x-4 gap-y-6">
              {games.map((g) => (
                <GameCard
                  key={g.label}
                  game={g}
                  onSelect={() => void selectGame(g)}
                  onSetFolder={() => void setFolder(g)}
                />
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  )
}

function GameCard({
  game,
  onSelect,
  onSetFolder
}: {
  game: GameSummary
  onSelect(): void
  onSetFolder(): void
}): React.JSX.Element {
  const installed = game.installDir !== null
  return (
    <li className="group flex flex-col">
      <button
        type="button"
        onClick={onSelect}
        className="relative block aspect-[3/4] overflow-hidden rounded-lg bg-raised ring-1 ring-line transition-[transform,box-shadow] duration-150 group-hover:-translate-y-0.5 group-hover:ring-ember/60 group-hover:shadow-[0_14px_30px_-12px_rgba(255,154,60,0.35)]"
      >
        <GameCover game={game} />
        <span className="absolute inset-x-2 bottom-2 flex flex-wrap gap-1">
          {installed && (
            <span className="rounded bg-ink/85 px-1.5 py-0.5 text-[11px] font-medium text-teal backdrop-blur-sm">
              Installed
            </span>
          )}
          {!game.supported && (
            <span className="rounded bg-ink/85 px-1.5 py-0.5 text-[11px] font-medium text-warn backdrop-blur-sm">
              Not supported yet
            </span>
          )}
        </span>
      </button>
      <span className="mt-2 line-clamp-2 text-sm leading-snug font-medium" title={game.displayName}>
        {game.displayName}
      </span>
      {!installed && (
        <button
          type="button"
          onClick={onSetFolder}
          className="mt-0.5 self-start text-xs text-muted underline-offset-2 hover:text-ember hover:underline"
        >
          Set folder…
        </button>
      )}
    </li>
  )
}
