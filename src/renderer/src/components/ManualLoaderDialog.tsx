import { useState } from 'react'
import { useStore } from '../store'
import { Button, Modal } from './ui'

/** Asks whether to remove a BepInEx someone installed by hand into the game folder. */
export function ManualLoaderDialog(): React.JSX.Element | null {
  const prompt = useStore((s) => s.manualLoader)
  const gameName = useStore((s) => s.currentGame?.displayName)
  const resolve = useStore((s) => s.resolveManualLoader)
  const [working, setWorking] = useState(false)
  if (!prompt) return null

  async function run(action: 'remove' | 'keep'): Promise<void> {
    setWorking(true)
    try {
      await resolve(action)
    } finally {
      setWorking(false)
    }
  }

  return (
    <Modal
      title="BepInEx found in the game folder"
      onClose={() => {
        // Dismissed without choosing: ask again the next time the game is opened.
        if (!working) useStore.setState({ manualLoader: null })
      }}
      width="w-[480px]"
      footer={
        <>
          <Button variant="quiet" disabled={working} onClick={() => void run('keep')}>
            Keep
          </Button>
          <Button variant="primary" disabled={working} onClick={() => void run('remove')}>
            Remove
          </Button>
        </>
      }
    >
      <p>
        {gameName ?? prompt.game} has BepInEx installed in its game folder. HML manages mods per
        profile and only loads them when you launch through HML. Remove the manual install?
      </p>
      {prompt.entries.length > 0 && (
        <ul className="mt-3 max-h-40 overflow-y-auto rounded-md border border-line bg-ink px-3 py-2 font-mono text-xs text-muted">
          {prompt.entries.map((e) => (
            <li key={e} className="truncate" title={e}>
              {e}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
