import { useEffect } from 'react'
import { GamePicker } from './components/GamePicker'
import { LaunchBar } from './components/LaunchBar'
import { ManualLoaderDialog } from './components/ManualLoaderDialog'
import { ModList } from './components/ModList'
import { ProfileSidebar } from './components/ProfileSidebar'
import { SettingsDialog } from './components/SettingsDialog'
import { TitleBar } from './components/TitleBar'
import { Toasts } from './components/Toast'
import { useStore } from './store'

function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const game = useStore((s) => s.currentGame)

  useEffect(() => {
    void useStore.getState().init()
    const offEvents = window.hmlEvents.on((e) => useStore.getState().handleEvent(e))
    // Files dropped outside the mod list must not navigate the window to file://.
    const block = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      offEvents()
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
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
    </>
  )
}

export default App
