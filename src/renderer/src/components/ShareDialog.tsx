import { useEffect, useRef, useState } from 'react'
import type { ProfileManifest } from '../../../shared/types'
import { formatCode, formatSyncCode } from '../../../shared/shareCode'
import { api, errorMessage } from '../api'
import { COPY_FAILED, fileNameOf, localModsNote } from '../shareView'
import { useStore } from '../store'
import { CREATE_SYNC_NOTE, STOP_SYNC_CONFIRM, isFollower } from '../syncView'
import { Button, ConfirmDialog, Icon, Modal } from './ui'

type Running = 'code' | 'file' | 'sync' | 'stop'

/** Uploads a profile for a share code, or saves it as a .hml file. */
export function ShareDialog({
  game,
  profile: opened,
  onClose
}: {
  game: string
  profile: ProfileManifest
  onClose(): void
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  // The live manifest, so creating or stopping a sync code shows here right away.
  const profile = useStore((s) => s.profiles.find((p) => p.id === opened.id)) ?? opened
  const createSyncCode = useStore((s) => s.createSyncCode)
  const stopSync = useStore((s) => s.stopSync)
  const [running, setRunning] = useState<Running | null>(null)
  const [shared, setShared] = useState<{ code: string; localMods: number } | null>(null)
  const [copied, setCopied] = useState<'share' | 'sync' | null>(null)
  // Local mods the new sync code left out, from its answer.
  const [syncLocal, setSyncLocal] = useState<number | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)
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

  async function run<T>(kind: Running, fn: () => Promise<T>): Promise<T | undefined> {
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
      setCopied(null)
    }
  }

  async function createSync(): Promise<void> {
    const result = await run('sync', () => createSyncCode(profile.id))
    if (result && mounted.current) {
      setSyncLocal(result.localMods)
      setCopied(null)
    }
  }

  async function stopSyncing(): Promise<void> {
    await run('stop', async () => {
      await stopSync(profile.id)
      return true
    })
    if (mounted.current) setSyncLocal(null)
  }

  async function exportFile(): Promise<void> {
    const saved = await run('file', () => api.exportProfileFile(game, profile.id))
    if (saved) toast('success', `Saved ${fileNameOf(saved)}`)
  }

  async function copy(code: string, which: 'share' | 'sync'): Promise<void> {
    try {
      await navigator.clipboard.writeText(code)
      toast('success', 'Copied')
      if (!mounted.current) return
      setCopied(which)
      setError(null)
    } catch {
      if (mounted.current) setError(COPY_FAILED)
    }
  }

  const note = shared ? localModsNote(shared.localMods) : null
  const display = shared ? formatCode(shared.code) : null
  const [head, tail] = display?.split('-') ?? []
  const sync = profile.sync
  const syncDisplay = sync?.role === 'owner' ? formatSyncCode(sync.code) : null
  // Before a code exists the count comes from the profile; afterwards from the server's answer.
  const localCount = profile.mods.filter((m) => m.source.kind === 'local').length
  const syncNote = syncDisplay
    ? syncLocal !== null
      ? localModsNote(syncLocal)
      : null
    : localModsNote(localCount)

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
          <Button variant="ghost" autoFocus onClick={() => void copy(display, 'share')}>
            <Icon
              name={copied === 'share' ? 'check' : 'copy'}
              className={copied === 'share' ? 'size-4 text-teal' : 'size-4'}
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

      {!isFollower(profile) && (
        <section aria-label="Sync code" className="mt-5 border-t border-line pt-4">
          <h3 className="font-medium text-fg">Sync code</h3>
          {syncDisplay ? (
            <>
              <p className="mt-1">Friends who imported this code get your changes automatically.</p>
              <div className="mt-3 flex items-center gap-3 rounded-lg border border-line bg-ink py-2.5 pr-3 pl-5">
                <output
                  aria-label="Sync code"
                  className="flex-1 text-xl leading-none font-semibold tracking-[0.12em] text-fg tabular-nums select-text"
                >
                  {syncDisplay}
                </output>
                <Button variant="ghost" onClick={() => void copy(syncDisplay, 'sync')}>
                  <Icon
                    name={copied === 'sync' ? 'check' : 'copy'}
                    className={copied === 'sync' ? 'size-4 text-teal' : 'size-4'}
                  />
                  Copy
                </Button>
              </div>
              <Button
                variant="quiet"
                className="mt-2 -ml-3"
                disabled={running !== null}
                onClick={() => setConfirmStop(true)}
              >
                {running === 'stop' ? 'Stopping…' : 'Stop syncing'}
              </Button>
            </>
          ) : (
            <div className="mt-1 flex items-center gap-3">
              <p className="flex-1">{CREATE_SYNC_NOTE}</p>
              <Button
                variant="ghost"
                className="shrink-0"
                disabled={running !== null}
                onClick={() => void createSync()}
              >
                <Icon name="refresh" />
                {running === 'sync' ? 'Creating…' : 'Create sync code'}
              </Button>
            </div>
          )}
          {syncNote && (
            <p className="mt-3 flex items-start gap-2 text-warn">
              <Icon name="warn" className="mt-0.5 size-4 shrink-0" />
              <span>{syncNote}</span>
            </p>
          )}
        </section>
      )}

      {confirmStop && (
        <ConfirmDialog
          title={`Stop syncing ${profile.name}?`}
          body={STOP_SYNC_CONFIRM}
          confirmLabel="Stop syncing"
          onConfirm={() => void stopSyncing()}
          onClose={() => setConfirmStop(false)}
        />
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
