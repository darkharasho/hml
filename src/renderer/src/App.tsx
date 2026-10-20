import { useEffect } from 'react'
import { ContextMenuHost } from './components/ContextMenu'
import { GamePicker } from './components/GamePicker'
import { LaunchBar } from './components/LaunchBar'
import { ManualLoaderDialog } from './components/ManualLoaderDialog'
import { ModList } from './components/ModList'
import { ProfileSidebar } from './components/ProfileSidebar'
import { SettingsDialog } from './components/SettingsDialog'
import { TitleBar } from './components/TitleBar'
import { Toasts } from './components/Toast'
import { useGameAccent } from './gameTheme'
import { useStore } from './store'

/** Ctrl+F (Cmd+F on macOS) or / focuses the search box on screen, outside dialogs. */
function focusSearch(e: KeyboardEvent): void {
  const find = (e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey) && !e.altKey
  const target = e.target as HTMLElement | null
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable
  const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing
  if ((!find && !slash) || e.defaultPrevented || document.querySelector('dialog[open]')) return
  // Hidden tabs stay mounted, so pick the search box that is actually showing.
  const box = [...document.querySelectorAll<HTMLInputElement>('input[data-find]')].find(
    (el) => el.offsetParent !== null
  )
  if (!box) return
  e.preventDefault()
  box.focus()
  box.select()
}

function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const game = useStore((s) => s.currentGame)
  const gameColors = useStore((s) => s.settings?.gameColors ?? true)
  useGameAccent(game?.label ?? null, gameColors)

  useEffect(() => {
    void useStore.getState().init()
    const offEvents = window.hmlEvents.on((e) => useStore.getState().handleEvent(e))
    // Files dropped outside the mod list must not navigate the window to file://.
    const block = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', block)
    window.addEventListener('keydown', focusSearch)
    window.addEventListener('drop', block)
    return () => {
      offEvents()
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
      window.removeEventListener('keydown', focusSearch)
    }
  }, [])

  return (
    <>
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="min-h-0 flex-1" data-inert-under-modal>
          {!ready ? (
            <div className="grid h-full place-items-center text-sm text-muted">Loading…</div>
          ) : game ? (
            <div className="flex h-full">
              <ProfileSidebar />
              <div className="flex min-w-0 flex-1 flex-col">
                <LaunchBar />
                <ModList />
              </div>
            </div>
          ) : (
            <GamePicker />
          )}
        </div>
      </div>
      <ManualLoaderDialog />
      <SettingsDialog />
      <Toasts />
      <ContextMenuHost />
    </>
  )
}

export default App
