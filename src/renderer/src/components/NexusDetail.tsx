import { useEffect, useState } from 'react'
import type { NxFile, NxMod } from '../../../shared/types'
import { api, errorMessage } from '../api'
import { formatBytes } from '../ghView'
import {
  fileCategoryLabel,
  formatCount,
  installedNexusMod,
  nexusModUrl,
  NX_NO_KEY,
  relativeDate
} from '../nxView'
import { useCurrentProfile, useStore, useSyncLocked } from '../store'
import { SYNC_LOCKED_NOTE } from '../syncView'
import { relativeTime, UNSUPPORTED_LOADER } from '../tsView'
import { AdultBadge, NexusThumb } from './NexusBrowse'
import { Button, Icon, Modal } from './ui'

type Files = { files: NxFile[] } | { error: string } | null

export function NexusDetail({
  game,
  domain,
  mod: initial,
  onClose
}: {
  game: string
  domain: string
  mod: NxMod
  onClose(): void
}): React.JSX.Element {
  const profile = useCurrentProfile()
  const supported = useStore((s) => s.currentGame?.supported ?? false)
  const installing = useStore((s) => s.nxInstalling.includes(initial.modId))
  const nxInstall = useStore((s) => s.nxInstall)
  const locked = useSyncLocked()
  const toast = useStore((s) => s.toast)
  const openSettings = useStore((s) => s.setSettingsOpen)
  const [needsKey, setNeedsKey] = useState(false)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const [mod, setMod] = useState(initial)
  const [files, setFiles] = useState<Files>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    api.nxGetMod(game, initial.modId).then(
      (d) => {
        if (!live) return
        setMod(d.mod)
        setFiles({ files: d.files })
      },
      (e) => live && setFiles({ error: errorMessage(e) })
    )
    return () => {
      live = false
    }
  }, [game, initial.modId, nonce])

  // The notice sends the user to Settings; once a key is saved there, it has done its job.
  useEffect(() => {
    if (!needsKey || settingsOpen) return
    let live = true
    api.nxStatus().then(
      (s) => live && s.set && setNeedsKey(false),
      () => {}
    )
    return () => {
      live = false
    }
  }, [needsKey, settingsOpen])

  const installed = installedNexusMod(profile?.mods ?? [], mod.modId)
  const installedFileId = installed?.source.kind === 'nexus' ? installed.source.fileId : null
  const [now] = useState(() => Date.now())

  return (
    <Modal
      title={mod.name}
      onClose={onClose}
      width="w-[600px]"
      footer={
        <Button variant="quiet" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="-mt-1 flex gap-4">
        <NexusThumb
          url={mod.pictureUrl ?? mod.thumbnailUrl}
          name={mod.name}
          className="h-24 w-40"
        />
        <div className="min-w-0 flex-1">
          <p>
            by <span className="text-fg">{mod.author}</span>
            {mod.version && (
              <span className="ml-2 text-xs tabular-nums">Version {mod.version}</span>
            )}
          </p>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
            <span className="inline-flex items-center gap-1" title="Downloads">
              <Icon name="download" className="size-3.5" />
              {formatCount(mod.downloads)}
            </span>
            <span className="inline-flex items-center gap-1" title="Endorsements">
              <Icon name="thumb" className="size-3.5" />
              {formatCount(mod.endorsements)}
            </span>
            {mod.updatedAt && <span>Updated {relativeTime(mod.updatedAt, now)}</span>}
          </p>
          {mod.adultContent && (
            <div className="mt-2 flex">
              <AdultBadge />
            </div>
          )}
          <Button
            variant="ghost"
            className="mt-3"
            onClick={() =>
              api
                .openExternal(nexusModUrl(domain, mod.modId))
                .catch((e) => toast('error', errorMessage(e)))
            }
          >
            <Icon name="external" />
            Open on Nexus Mods
          </Button>
        </div>
      </div>

      <p className="mt-4 text-fg/90 select-text">{mod.summary || 'No description.'}</p>

      {needsKey && (
        <div className="mt-4 flex items-center gap-3 rounded-md border border-warn/30 bg-warn/10 py-1.5 pr-1.5 pl-3 text-xs text-warn">
          <Icon name="warn" className="size-3.5 shrink-0" />
          <span className="flex-1">{NX_NO_KEY}</span>
          <Button variant="ghost" className="h-7" onClick={() => openSettings(true)}>
            Settings
          </Button>
        </div>
      )}

      <h3 className="mt-5 border-t border-line pt-4 font-medium text-fg">
        Files
        {files && 'files' in files && (
          <span className="ml-2 text-xs font-normal text-muted tabular-nums">
            {files.files.length}
          </span>
        )}
      </h3>
      {!files ? (
        <p className="mt-1">Loading files…</p>
      ) : 'error' in files ? (
        <p className="mt-1 text-danger select-text">
          {files.error}{' '}
          <button
            type="button"
            className="underline hover:text-fg"
            onClick={() => {
              setFiles(null)
              setNonce((n) => n + 1)
            }}
          >
            Retry
          </button>
        </p>
      ) : files.files.length === 0 ? (
        <p className="mt-1">This mod has no files to install.</p>
      ) : (
        <ul className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-line">
          {files.files.map((f) => (
            <li
              key={f.fileId}
              className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-fg" title={f.name}>
                  {f.name}
                </p>
                <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs tabular-nums">
                  {f.version && <span>{f.version}</span>}
                  <span className={f.category === 'MAIN' ? 'text-ember' : undefined}>
                    {fileCategoryLabel(f.category)}
                  </span>
                  <span>{formatBytes(f.sizeBytes)}</span>
                  <span>{relativeDate(f.date, now)}</span>
                </p>
              </div>
              <div className="flex w-24 shrink-0 justify-end">
                {f.fileId === installedFileId ? (
                  <span className="text-xs text-teal">Installed</span>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={!supported || installing || locked}
                    title={locked ? SYNC_LOCKED_NOTE : supported ? undefined : UNSUPPORTED_LOADER}
                    aria-label={`Install ${f.name}`}
                    onClick={() =>
                      void nxInstall(mod, f.fileId, { inlineNoKey: true }).then((r) =>
                        setNeedsKey(r === 'needs-key')
                      )
                    }
                  >
                    {installing ? 'Installing…' : 'Install'}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
