import { useEffect, useState } from 'react'
import type { GameSummary } from '../../../shared/ipc'
import { api } from '../api'
import { useCurrentProfile, useStore } from '../store'
import { sortMenuGames, usedGameLabels } from '../titleView'
import { GameCover } from './GameCover'
import { Menu, type MenuItem } from './ui'

/** Keep in step with TITLEBAR_HEIGHT in src/main/windowFrame.ts (macOS centers its lights on it). */
const HEIGHT = 'h-[38px]'
const NO_DRAG = '[-webkit-app-region:no-drag]'
const isMac = window.hmlPlatform === 'darwin'

/** HML's titlebar: logo, game and profile dropdowns, and (off macOS) the window buttons. */
export function TitleBar(): React.JSX.Element {
  const game = useStore((s) => s.currentGame)
  const maximized = useMaximized()

  return (
    <header
      // The whole bar moves the window; a double-click on it maximizes natively (windowFrame.ts).
      // Above the modal backdrop (z-[55] in ui.tsx), so the window can be moved, minimized,
      // maximized and closed while a dialog is open.
      className={`relative z-[60] flex ${HEIGHT} shrink-0 items-center border-b border-line bg-ink text-[13px] [-webkit-app-region:drag] ${
        isMac ? 'pl-[78px]' : 'pl-3'
      }`}
    >
      <div className="pointer-events-none flex shrink-0 items-center gap-2">
        <Logo />
        <span className="font-bold tracking-tight text-ember">HML</span>
      </div>
      {game && <Crumbs game={game} />}
      <div className="h-full min-w-4 flex-1" />
      {!isMac && <WindowButtons maximized={maximized} />}
    </header>
  )
}

function Separator(): React.JSX.Element {
  return (
    <span className="pointer-events-none px-1.5 text-line" aria-hidden="true">
      /
    </span>
  )
}

const CRUMB = `flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-muted hover:bg-raised hover:text-fg [[open]>&]:bg-raised [[open]>&]:text-fg`

function Crumbs({ game }: { game: GameSummary }): React.JSX.Element {
  const profiles = useStore((s) => s.profiles)
  const currentProfile = useStore((s) => s.currentProfile)
  const profile = useCurrentProfile()
  const selectGame = useStore((s) => s.selectGame)
  const leaveGame = useStore((s) => s.leaveGame)
  const selectProfile = useStore((s) => s.selectProfile)
  const setCreatingProfile = useStore((s) => s.setCreatingProfile)
  const games = useUsedGames(game)

  const gameItems: MenuItem[] = [
    ...games.map((g) => ({
      id: g.label,
      label: g.displayName,
      checked: g.label === game.label,
      icon: <SmallCover game={g} />,
      onSelect: () => {
        if (g.label !== game.label) void selectGame(g)
      }
    })),
    { id: '__all', label: 'All games…', divider: games.length > 0, onSelect: leaveGame }
  ]
  const profileItems: MenuItem[] = [
    ...profiles.map((p) => ({
      id: p.id,
      label: p.name,
      checked: p.id === currentProfile,
      onSelect: () => {
        if (p.id !== currentProfile) void selectProfile(p.id)
      }
    })),
    {
      id: '__new',
      label: 'New profile…',
      divider: profiles.length > 0,
      onSelect: () => setCreatingProfile(true)
    }
  ]
  return (
    // Switching game or profile under an open dialog could leave it acting on the old one.
    <div className="flex min-w-0 items-center" data-inert-under-modal>
      <Separator />
      <Menu
        label={`Switch game (${game.displayName})`}
        items={gameItems}
        align="left"
        className={`min-w-0 ${NO_DRAG}`}
        triggerClassName={CRUMB}
        trigger={
          <>
            <SmallCover game={game} />
            <span className="truncate font-medium text-fg">{game.displayName}</span>
            <Chevron />
          </>
        }
      />
      <Separator />
      <Menu
        label="Switch profile"
        items={profileItems}
        align="left"
        className={`min-w-0 ${NO_DRAG}`}
        triggerClassName={CRUMB}
        trigger={
          <>
            <span>Profile</span>
            <span className="truncate font-medium text-fg">{profile?.name ?? 'none'}</span>
            <Chevron />
          </>
        }
      />
    </div>
  )
}

/** The games the user has opened, looked up again when the remembered list changes. */
function useUsedGames(current: GameSummary): GameSummary[] {
  const settings = useStore((s) => s.settings)
  const key = usedGameLabels(settings, current.label).join('\n')
  const [found, setFound] = useState<(GameSummary | null)[]>([])
  useEffect(() => {
    let live = true
    const labels = key.split('\n')
    // A game that can't be looked up (a removed custom game) is left out.
    void Promise.all(labels.map((l) => api.getGame(l).catch(() => null))).then(
      (games) => live && setFound(games)
    )
    return () => {
      live = false
    }
  }, [key])
  return sortMenuGames(found, current)
}

function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (isMac) return
    let live = true
    window.hmlWindow.isMaximized().then(
      (m) => live && setMaximized(m),
      () => undefined
    )
    const off = window.hmlWindow.onMaximizedChange(setMaximized)
    return () => {
      live = false
      off()
    }
  }, [])
  return maximized
}

function SmallCover({ game }: { game: GameSummary }): React.JSX.Element {
  return (
    <span className="size-5 shrink-0 overflow-hidden rounded-[4px] ring-1 ring-white/10">
      <GameCover game={game} className="text-[8px]" />
    </span>
  )
}

function Chevron(): React.JSX.Element {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" className="size-2.5 shrink-0 opacity-70">
      <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/** The app icon (build/icon-small.svg), drawn at 20px. */
function Logo(): React.JSX.Element {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true" className="size-5 shrink-0">
      <rect width="1024" height="1024" rx="200" fill="#0f191d" />
      <path
        d="M512 120 856 318v388L512 904 168 706V318z"
        fill="none"
        stroke="#ff9a3c"
        strokeWidth="112"
        strokeLinejoin="round"
      />
      <path d="M340 320h120v136h104V320h120v384H564V560H460v144H340z" fill="#e3ece9" />
    </svg>
  )
}

const WINDOW_BUTTON = `grid h-full w-[46px] place-items-center text-muted transition-colors ${NO_DRAG}`

function WindowButtons({ maximized }: { maximized: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full shrink-0">
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void window.hmlWindow.minimize()}
        className={`${WINDOW_BUTTON} hover:bg-raised hover:text-fg`}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true" className="size-2.5">
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void window.hmlWindow.toggleMaximize()}
        className={`${WINDOW_BUTTON} hover:bg-raised hover:text-fg`}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden="true" className="size-2.5">
            <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden="true" className="size-2.5">
            <path d="M.5.5h9v9h-9z" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button
        type="button"
        aria-label="Close"
        title="Close"
        onClick={() => void window.hmlWindow.close()}
        className={`${WINDOW_BUTTON} hover:bg-danger hover:text-white`}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true" className="size-2.5">
          <path d="m.5.5 9 9m0-9-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  )
}
