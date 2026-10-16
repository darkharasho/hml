import { useEffect, useRef, useState } from 'react'
import type { GameSummary } from '../../../shared/ipc'
import type { GameDetection, LoaderChoice, Runner } from '../../../shared/types'
import { api, errorMessage } from '../api'
import {
  isLinux,
  loaderChoicesFor,
  loaderOptionLabel,
  runnerIndexOf,
  runnerLabel
} from '../customView'
import { useStore } from '../store'
import { Button, Modal } from './ui'

const NATIVE_LINUX_NOTE = "Force Proton in the game's Steam properties, then add it again"
const NO_RUNNER_NOTE = 'Install Proton through Steam or Wine to run this game.'

/** Adds an installed Steam game or a game folder, or edits an added custom game. */
export function AddGameDialog({
  mode,
  game,
  detection,
  folder,
  initialName,
  onClose
}: {
  mode: 'steam' | 'folder' | 'edit'
  game?: GameSummary
  detection: GameDetection
  folder?: string
  initialName: string
  onClose(): void
}): React.JSX.Element {
  const addCustomGame = useStore((s) => s.addCustomGame)
  const updateCustomGame = useStore((s) => s.updateCustomGame)
  const choices = loaderChoicesFor(detection)
  const initialChoice = game?.custom?.loaderChoice
  const [name, setName] = useState(initialName)
  const [loader, setLoader] = useState<LoaderChoice>(
    mode === 'edit' && initialChoice && choices.includes(initialChoice)
      ? initialChoice
      : choices.includes(detection.suggested)
        ? detection.suggested
        : choices[0]
  )
  const [runners, setRunners] = useState<Runner[] | null>(null)
  const [runnerIndex, setRunnerIndex] = useState(0)
  // Edit mode keeps the stored runner unless the user picks another one.
  const [runnerChanged, setRunnerChanged] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const showRunner =
    isLinux() && (mode === 'folder' || (mode === 'edit' && game?.custom?.source === 'folder'))
  const showName = mode !== 'steam'

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!showRunner) return
    let stale = false
    api.listRunners().then(
      (list) => {
        if (stale) return
        setRunners(list)
        if (mode === 'edit') setRunnerIndex(runnerIndexOf(list, game?.custom?.runner))
      },
      (e) => {
        if (!stale) {
          setRunners([])
          setError(errorMessage(e))
        }
      }
    )
    return () => {
      stale = true
    }
    // mode and game only seed the initial selection; re-running would reset the user's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRunner])

  const close = (): void => {
    if (!running) onClose()
  }
  const trimmed = name.trim()
  const canSave = !running && (!showName || trimmed.length > 0)

  async function confirm(): Promise<void> {
    setError(null)
    setRunning(true)
    try {
      if (mode === 'steam') {
        const label = game?.label ?? ''
        await addCustomGame({
          source: 'steam',
          steamAppId: label.replace(/^steam-/, ''),
          loaderChoice: loader
        })
      } else if (mode === 'folder') {
        await addCustomGame({
          source: 'folder',
          folder: folder ?? '',
          displayName: trimmed,
          loaderChoice: loader,
          runner: showRunner ? (runners?.[runnerIndex] ?? null) : null
        })
      } else if (game) {
        const patch = {
          displayName: trimmed,
          loaderChoice: loader,
          ...(showRunner && runnerChanged && runners?.[runnerIndex]
            ? { runner: runners[runnerIndex] }
            : {})
        }
        // The edit dialog only opens for the current game; the store updates it and its warnings.
        await updateCustomGame(patch)
      }
      onClose()
    } catch (e) {
      if (mounted.current) setError(errorMessage(e))
    } finally {
      if (mounted.current) setRunning(false)
    }
  }

  return (
    <Modal
      title={mode === 'edit' ? `Edit ${initialName}` : `Add ${initialName}`}
      onClose={close}
      width="w-[480px]"
      footer={
        <>
          <Button variant="quiet" disabled={running} onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={() => void confirm()}>
            {mode === 'edit' ? 'Save' : 'Add game'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {showName && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 rounded-lg border border-line bg-ink px-3 text-sm text-fg focus:border-ember/70 focus:outline-none"
            />
          </label>
        )}

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-xs font-medium text-fg">Mod loader</legend>
          {choices.map((choice) => (
            <label key={choice} className="flex items-start gap-2 text-fg">
              <input
                type="radio"
                name="loader"
                className="mt-1"
                checked={loader === choice}
                onChange={() => setLoader(choice)}
              />
              <span>{loaderOptionLabel(choice, detection)}</span>
            </label>
          ))}
          {detection.nativeLinux && <p className="mt-1 text-xs text-warn">{NATIVE_LINUX_NOTE}</p>}
        </fieldset>

        {showRunner && runners !== null && (
          <div className="flex flex-col gap-1.5">
            {runners.length > 0 ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-fg">Run with</span>
                <select
                  value={runnerIndex}
                  onChange={(e) => {
                    setRunnerIndex(Number(e.target.value))
                    setRunnerChanged(true)
                  }}
                  className="h-9 rounded-lg border border-line bg-ink px-2 text-sm text-fg focus:border-ember/70 focus:outline-none"
                >
                  {runners.map((r, i) => (
                    <option key={i} value={i}>
                      {runnerLabel(r)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="text-xs text-warn">{NO_RUNNER_NOTE}</p>
            )}
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}

/** Loads a custom game's detection, then opens the dialog in edit mode (rename, loader, runner). */
export function EditGameDialog({
  game,
  onClose
}: {
  game: GameSummary
  onClose(): void
}): React.JSX.Element | null {
  const toast = useStore((s) => s.toast)
  const [loaded, setLoaded] = useState<{ detection: GameDetection } | null>(null)
  useEffect(() => {
    let live = true
    api.detectCustomGame(game.label).then(
      (d) => live && setLoaded({ detection: d.detection }),
      (e) => {
        if (!live) return
        toast('error', errorMessage(e))
        onClose()
      }
    )
    return () => {
      live = false
    }
    // Detection is read once per open; onClose identity changes must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.label])
  if (!loaded) return null
  return (
    <AddGameDialog
      mode="edit"
      game={game}
      detection={loaded.detection}
      initialName={game.displayName}
      onClose={onClose}
    />
  )
}
