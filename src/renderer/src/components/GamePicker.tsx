import { useEffect, useState } from 'react'
import type { GameSummary } from '../../../shared/ipc'
import type { GameDetection } from '../../../shared/types'
import { api, errorMessage } from '../api'
import { isNexusOnly, isSteamCandidate } from '../customView'
import { formatCount } from '../nxView'
import { useStore } from '../store'
import { MAX_YOUR_GAMES, uniqueGames, usedGameLabels } from '../titleView'
import { AddGameDialog } from './AddGameDialog'
import { GameCover } from './GameCover'
import { Button, Icon } from './ui'

const SEARCH_DEBOUNCE_MS = 150
const NEXUS_LABEL_PREFIX = 'nexus-'

interface AddRequest {
  mode: 'steam' | 'folder'
  game?: GameSummary
  detection: GameDetection
  folder: string
  initialName: string
}

export function GamePicker(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [games, setGames] = useState<GameSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const selectGame = useStore((s) => s.selectGame)
  const pickGamePath = useStore((s) => s.pickGamePath)
  const openSettings = useStore((s) => s.setSettingsOpen)
  const toast = useStore((s) => s.toast)
  const [adding, setAdding] = useState<string | null>(null)
  const [addRequest, setAddRequest] = useState<AddRequest | null>(null)
  // Re-run the search when the Steam folder changes, since install dirs depend on it.
  const steamRoot = useStore((s) => s.settings?.steamRootOverride)
  const yourGames = useYourGames(reload)
  // The game the user just left, so they can go straight back to it.
  const lastGame = useStore((s) => s.settings?.lastGame)
  const backTo = yourGames?.find((g) => g.label === lastGame) ?? null

  useEffect(() => {
    if (!backTo) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
      // Escape in a filled search box clears it first; a dialog takes its own Escape.
      if (query || document.querySelector('dialog[open]')) return
      e.preventDefault()
      void selectGame(backTo)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [backTo, query, selectGame])

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

  /** A Nexus-only game is saved to HML's game list before it can be opened or given a folder. */
  async function resolve(game: GameSummary): Promise<GameSummary | null> {
    if (!isNexusOnly(game)) return game
    setAdding(game.label)
    try {
      return await api.addNexusGame(game.label.slice(NEXUS_LABEL_PREFIX.length))
    } catch (e) {
      toast('error', errorMessage(e))
      return null
    } finally {
      setAdding(null)
    }
  }

  async function chooseCandidate(game: GameSummary): Promise<void> {
    setAdding(game.label)
    try {
      const found = await api.detectCustomGame(game.label)
      setAddRequest({
        mode: 'steam',
        game,
        detection: found.detection,
        folder: found.folder,
        initialName: found.displayName
      })
    } catch (e) {
      toast('error', errorMessage(e))
    } finally {
      setAdding(null)
    }
  }

  async function addByFolder(): Promise<void> {
    try {
      const picked = await api.pickCustomGameFolder()
      if (picked)
        setAddRequest({
          mode: 'folder',
          detection: picked.detection,
          folder: picked.folder,
          initialName: picked.displayName
        })
    } catch (e) {
      toast('error', errorMessage(e))
    }
  }

  async function choose(game: GameSummary): Promise<void> {
    if (isSteamCandidate(game)) return chooseCandidate(game)
    const resolved = await resolve(game)
    if (resolved) await selectGame(resolved)
  }

  async function setFolder(game: GameSummary): Promise<void> {
    const resolved = await resolve(game)
    if (resolved && (await pickGamePath(resolved.label))) setReload((n) => n + 1)
  }

  // Every game appears once, so this is the cards badged Installed or On Steam.
  const installedCount = games?.filter((g) => g.installDir).length ?? 0
  // Nexus-only games sit with the rest, badged Nexus; Steam games HML has no entry for yet follow.
  const catalogGames = games?.filter((g) => !isSteamCandidate(g)) ?? []
  const steamGames = games?.filter(isSteamCandidate) ?? []
  const card = (g: GameSummary): React.JSX.Element => (
    <GameCard
      key={g.label}
      game={g}
      disabled={adding !== null}
      onSelect={() => void choose(g)}
      onSetFolder={() => void setFolder(g)}
    />
  )
  // Games the user has opened, above the full list while not searching.
  const showYours = !query && yourGames !== null && yourGames.length > 0
  const grid = 'grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-x-4 gap-y-6'

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-line px-6 py-4">
        {/* The HML logo and name are in the titlebar above. */}
        {backTo && (
          <Button
            variant="quiet"
            className="-ml-2 shrink-0"
            title="Back (Esc)"
            onClick={() => void selectGame(backTo)}
          >
            <Icon name="back" />
            {backTo.displayName}
          </Button>
        )}
        <h1 className="shrink-0 text-base font-semibold tracking-tight">Choose a game</h1>
        <label className="relative flex-1">
          <span className="sr-only">Search games</span>
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <input
            autoFocus
            type="search"
            data-find
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search games"
            className="h-10 w-full max-w-xl rounded-lg border border-line bg-panel pr-3 pl-9 text-sm text-fg placeholder:text-muted focus:border-ember/70 focus:outline-none"
          />
        </label>
        <Button variant="ghost" onClick={() => void addByFolder()}>
          Add a game by folder…
        </Button>
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
            No games match “{query}”. Installed Steam games show up here too; for anything else use
            Add a game by folder….
          </p>
        )}
        {games && games.length > 0 && (
          <>
            <p className="mb-4 text-sm text-muted">
              {games.length} {games.length === 1 ? 'game' : 'games'}
              {installedCount > 0 && `, ${installedCount} installed on this PC`}
            </p>
            {showYours && (
              <section aria-labelledby="your-games" className="mb-8">
                <SectionHeading id="your-games">Your games</SectionHeading>
                <ul className={grid}>{yourGames.map(card)}</ul>
              </section>
            )}
            {catalogGames.length > 0 && (
              <section aria-labelledby="all-games">
                {showYours && <SectionHeading id="all-games">All games</SectionHeading>}
                <ul className={grid}>{catalogGames.map(card)}</ul>
              </section>
            )}
            {steamGames.length > 0 && (
              <section aria-labelledby="on-steam" className={catalogGames.length ? 'mt-8' : ''}>
                <SectionHeading id="on-steam">Installed on Steam</SectionHeading>
                <ul className={grid}>{steamGames.map(card)}</ul>
              </section>
            )}
          </>
        )}
      </main>
      {addRequest && (
        <AddGameDialog
          mode={addRequest.mode}
          game={addRequest.game}
          detection={addRequest.detection}
          folder={addRequest.folder}
          initialName={addRequest.initialName}
          onClose={() => {
            setAddRequest(null)
            setReload((n) => n + 1)
          }}
        />
      )}
    </div>
  )
}

function SectionHeading({ id, children }: { id: string; children: string }): React.JSX.Element {
  return (
    <div className="mb-4 flex items-center gap-3">
      <h2 id={id} className="shrink-0 text-sm font-semibold text-muted">
        {children}
      </h2>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
    </div>
  )
}

/** The games the user has opened before, by name; null while loading. */
function useYourGames(reload: number): GameSummary[] | null {
  const settings = useStore((s) => s.settings)
  const key = usedGameLabels(settings, null).join('\n')
  const [games, setGames] = useState<GameSummary[] | null>(null)
  useEffect(() => {
    let live = true
    const labels = key ? key.split('\n') : []
    // A game that can't be looked up (a removed custom game) is left out, and each game shows
    // once.
    void Promise.all(labels.map((l) => api.getGame(l).catch(() => null))).then((found) => {
      if (live) setGames(uniqueGames(found, null, MAX_YOUR_GAMES))
    })
    return () => {
      live = false
    }
  }, [key, reload])
  return games
}

function GameCard({
  game,
  disabled,
  onSelect,
  onSetFolder
}: {
  game: GameSummary
  disabled: boolean
  onSelect(): void
  onSetFolder(): void
}): React.JSX.Element {
  const installed = game.installDir !== null
  const nexus = isNexusOnly(game)
  const candidate = isSteamCandidate(game)
  const updates = useStore((s) =>
    Object.values(s.updateSummary[game.label] ?? {}).reduce((n, c) => n + c, 0)
  )
  return (
    <li className="group flex flex-col">
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        className="relative block aspect-[3/4] overflow-hidden rounded-lg bg-raised ring-1 ring-line group-hover:ring-2 group-hover:ring-ember/70"
      >
        <GameCover game={game} />
        {updates > 0 && (
          <span
            className="absolute top-2 right-2 rounded-full bg-ember px-2 py-0.5 text-[11px] font-semibold text-ink tabular-nums shadow"
            title={`${updates} mod ${updates === 1 ? 'update' : 'updates'} in your profiles`}
          >
            {updates} {updates === 1 ? 'update' : 'updates'}
          </span>
        )}
        <span className="absolute inset-x-2 bottom-2 flex flex-wrap gap-1">
          {nexus && (
            <span className="rounded bg-ink/85 px-1.5 py-0.5 text-[11px] font-medium text-warn backdrop-blur-sm">
              Nexus
            </span>
          )}
          {candidate && (
            <span className="rounded bg-ink/85 px-1.5 py-0.5 text-[11px] font-medium text-teal backdrop-blur-sm">
              On Steam
            </span>
          )}
          {installed && !candidate && (
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
      {nexus && game.nexusModCount !== undefined && (
        <span className="text-xs text-muted tabular-nums">
          {formatCount(game.nexusModCount)} {game.nexusModCount === 1 ? 'mod' : 'mods'}
        </span>
      )}
      {!installed && !candidate && (
        <button
          type="button"
          disabled={disabled}
          onClick={onSetFolder}
          // Shown on hover or focus: almost every card has no folder, and few need one set by hand.
          className="mt-0.5 self-start text-xs text-muted underline-offset-2 opacity-0 group-hover:opacity-100 hover:text-ember hover:underline focus-visible:opacity-100"
        >
          Set folder…
        </button>
      )}
    </li>
  )
}
