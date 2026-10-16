import { useEffect, useRef, useState } from 'react'
import type { ProfileManifest } from '../../../shared/types'
import { formatCode } from '../../../shared/shareCode'
import { api, errorMessage } from '../api'
import { COPY_FAILED, fileNameOf, localModsNote } from '../shareView'
import { useStore } from '../store'
import { Button, Icon, Modal } from './ui'

/** Uploads a profile for a share code, or saves it as a .hml file. */
export function ShareDialog({
  game,
  profile,
  onClose
}: {
  game: string
  profile: ProfileManifest
  onClose(): void
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [running, setRunning] = useState<'code' | 'file' | null>(null)
  const [shared, setShared] = useState<{ code: string; localMods: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // An upload can't be called back, so the dialog stays open until it answers.
  const close = (): void => {
    if (!running) onClose()
  }

  async function run<T>(kind: 'code' | 'file', fn: () => Promise<T>): Promise<T | undefined> {
    setError(null)
    setRunning(kind)
    try {
      return await fn()
    } catch (e) {
      if (mounted.current) setError(errorMessage(e))
      return undefined
    } finally {
      if (mounted.current) setRunning(null)
    }
  }

  async function createCode(): Promise<void> {
    const result = await run('code', () => api.shareProfile(game, profile.id))
    if (result && mounted.current) {
      setShared(result)
      setCopied(false)
    }
  }

  async function exportFile(): Promise<void> {
    const saved = await run('file', () => api.exportProfileFile(game, profile.id))
    if (saved) toast('success', `Saved ${fileNameOf(saved)}`)
  }

  async function copy(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code)
      toast('success', 'Copied')
      if (!mounted.current) return
      setCopied(true)
      setError(null)
    } catch {
      if (mounted.current) setError(COPY_FAILED)
    }
  }

  const note = shared ? localModsNote(shared.localMods) : null
  const display = shared ? formatCode(shared.code) : null
  const [head, tail] = display?.split('-') ?? []

  return (
    <Modal
      title={`Share ${profile.name}`}
      onClose={close}
      width="w-[480px]"
      footer={
        <>
          <Button
            variant="quiet"
            className="mr-auto"
            disabled={running !== null}
            onClick={() => void exportFile()}
          >
            <Icon name="download" />
            {running === 'file' ? 'Exporting…' : 'Export file…'}
          </Button>
          {shared ? (
            <Button variant="primary" disabled={running !== null} onClick={close}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="quiet" disabled={running !== null} onClick={close}>
                Cancel
              </Button>
              <Button
                variant="primary"
                autoFocus
                disabled={running !== null}
                onClick={() => void createCode()}
              >
                <Icon name="upload" />
                {running === 'code' ? 'Creating…' : 'Create code'}
              </Button>
            </>
          )}
        </>
      }
    >
      <p>Anyone with the code can download this profile&apos;s mod list and config files.</p>

      {shared && display && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-line bg-ink py-3 pr-3 pl-5">
          <output
            aria-label="Share code"
            className="flex-1 text-[28px] leading-none font-semibold tracking-[0.14em] text-fg tabular-nums select-text"
          >
            {head}
            <span className="text-muted/60" aria-hidden="true">
              -
            </span>
            {tail}
          </output>
          <Button variant="ghost" autoFocus onClick={() => void copy(display)}>
            <Icon
              name={copied ? 'check' : 'copy'}
              className={copied ? 'size-4 text-teal' : 'size-4'}
            />
            Copy
          </Button>
        </div>
      )}

      {note && (
        <p className="mt-3 flex items-start gap-2 text-warn">
          <Icon name="warn" className="mt-0.5 size-4 shrink-0" />
          <span>{note}</span>
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 flex items-start gap-2 text-danger">
          <Icon name="warn" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words select-text">{error}</span>
        </p>
      )}
    </Modal>
  )
}
