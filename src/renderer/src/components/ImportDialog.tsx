import { useEffect, useRef, useState } from 'react'
import type { ImportResult, ShareModDetail, SharePreview } from '../../../shared/types'
import { api, errorMessage } from '../api'
import { SHARE_SOURCE_BADGE, gameMismatchNote, importProgress, importSummary } from '../shareView'
import { useStore } from '../store'
import { ALREADY_FOLLOWING } from '../syncView'
import { initials } from '../tsView'
import { useFallbackSrc } from '../useFallbackSrc'
import { Button, Icon, Modal } from './ui'

type Progress = NonNullable<ReturnType<typeof importProgress>>

const FIELD =
  'h-9 w-full rounded-md border border-line bg-ink px-3 text-sm text-fg placeholder:text-muted focus:border-ember/70 focus:outline-none disabled:opacity-60'

/** Opens a share code or .hml file, previews it, and rebuilds it as a new profile. */
export function ImportDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const currentGame = useStore((s) => s.currentGame?.label ?? null)
  const openImported = useStore((s) => s.openImportedProfile)
  const toast = useStore((s) => s.toast)
  const [code, setCode] = useState('')
  const [opening, setOpening] = useState<'code' | 'file' | null>(null)
  const [preview, setPreview] = useState<SharePreview | null>(null)
  const [name, setName] = useState('')
  // The folder picked for a shared custom game HML doesn't know yet.
  const [folder, setFolder] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Icons and descriptions arrive after the preview; rows show without them meanwhile.
  const [details, setDetails] = useState<{
    token: string
    list: (ShareModDetail | null)[]
  } | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Only the import's own events move the line; each mod's install reports on the same channel.
  // Subscribed once on mount, so no event slips by between the import starting and an effect
  // re-subscribing; the ref says whether an import is running.
  const importingRef = useRef(false)
  useEffect(() => {
    return window.hmlEvents.on((e) => {
      if (!importingRef.current) return
      const p = importProgress(e)
      if (p) setProgress(p)
    })
  }, [])

  const token = preview?.token
  useEffect(() => {
    if (!token) return
    let live = true
    api.shareModDetails(token).then(
      (list) => live && setDetails({ token, list }),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [token])
  const shownDetails = details && details.token === token ? details.list : []

  const busy = opening !== null || importing
  const done = (): void => {
    if (!result) return
    onClose()
    void openImported(result.game, result.profile.id)
  }
  // The profile exists once the import ran, so closing the result goes to it like Done does.
  const close = (): void => {
    if (busy) return
    if (result) done()
    else onClose()
  }

  async function open(input: { code: string } | { file: true }): Promise<void> {
    if (busy) return
    setError(null)
    setOpening('code' in input ? 'code' : 'file')
    try {
      const p = await api.previewShare({ ...input, game: currentGame ?? undefined })
      if (!mounted.current || !p) return
      // A sync code this HML already follows opens that profile instead of making a second one.
      if (p.existing) {
        const { game, profileId } = p.existing
        onClose()
        toast('info', ALREADY_FOLLOWING)
        void openImported(game, profileId)
        return
      }
      setPreview(p)
      setName(p.profileName)
      setFolder(null)
    } catch (e) {
      if (mounted.current) setError(errorMessage(e))
    } finally {
      if (mounted.current) setOpening(null)
    }
  }

  async function runImport(): Promise<void> {
    if (!preview || busy) return
    if (preview.needsFolder && !folder) return
    setError(null)
    setProgress(null)
    importingRef.current = true
    setImporting(true)
    try {
      const r = await api.importShare(
        preview.token,
        name.trim(),
        preview.needsFolder ? (folder ?? undefined) : undefined
      )
      if (mounted.current) setResult(r)
    } catch (e) {
      if (mounted.current) setError(errorMessage(e))
    } finally {
      importingRef.current = false
      if (mounted.current) setImporting(false)
    }
  }

  const trimmed = code.trim()
  const mismatch = preview && !preview.needsFolder ? gameMismatchNote(preview, currentGame) : null

  async function chooseFolder(): Promise<void> {
    if (busy) return
    setError(null)
    try {
      const picked = await api.pickCustomGameFolder()
      if (mounted.current && picked) setFolder(picked.folder)
    } catch (e) {
      if (mounted.current) setError(errorMessage(e))
    }
  }

  const footer = result ? (
    <Button variant="primary" autoFocus onClick={done}>
      Done
    </Button>
  ) : preview ? (
    <div className="flex w-full items-center justify-between gap-3">
      {importing ? <ImportProgress progress={progress} /> : <span />}
      <div className="flex shrink-0 gap-2">
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => {
            setPreview(null)
            setError(null)
          }}
        >
          Back
        </Button>
        <Button
          variant="primary"
          disabled={busy || (!!preview.needsFolder && !folder)}
          onClick={() => void runImport()}
        >
          <Icon name="download" />
          {importing ? 'Importing…' : preview.sync ? 'Import and follow' : 'Import'}
        </Button>
      </div>
    </div>
  ) : (
    <Button variant="quiet" disabled={busy} onClick={close}>
      Cancel
    </Button>
  )

  return (
    <Modal
      title={preview?.sync && !result ? 'Synced profile' : 'Import profile'}
      onClose={close}
      width="w-[560px]"
      footer={footer}
    >
      {result ? (
        <ImportResultView result={result} />
      ) : preview ? (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate font-medium text-fg">{preview.gameName}</span>
            <span className="shrink-0 text-xs tabular-nums">
              {preview.mods.length} {preview.mods.length === 1 ? 'mod' : 'mods'}
            </span>
          </div>
          {preview.sync && (
            <p className="mt-1.5 text-xs">
              Your copy gets its owner&apos;s changes automatically. Detach it any time to make it
              your own.
            </p>
          )}
          {preview.fromR2modman && (
            <p className="mt-1.5 text-xs">
              From r2modman. Its codes don&apos;t say which game they&apos;re for, so it imports
              into the game you have open.
            </p>
          )}
          {mismatch && (
            <p className="mt-1.5 flex items-start gap-2 text-warn">
              <Icon name="warn" className="mt-0.5 size-4 shrink-0" />
              <span>{mismatch}</span>
            </p>
          )}
          {preview.needsFolder && (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-fg">
                This profile is for {preview.gameName}, which HML doesn&apos;t know yet. Choose its
                folder to add it.
              </p>
              <div className="flex items-center gap-2">
                <Button disabled={busy} onClick={() => void chooseFolder()}>
                  <Icon name="folder" />
                  Choose folder…
                </Button>
                {folder && (
                  <span className="min-w-0 truncate text-xs text-muted" title={folder}>
                    {folder}
                  </span>
                )}
              </div>
            </div>
          )}
          <label className="mt-4 block">
            <span className="text-sm font-medium text-fg">Profile name</span>
            <input
              autoFocus
              value={name}
              disabled={busy}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void runImport()
                }
              }}
              placeholder={preview.profileName}
              spellCheck={false}
              className={`mt-1.5 ${FIELD}`}
            />
          </label>
          <ul className="mt-4 flex max-h-80 flex-col overflow-y-auto rounded-md border border-line">
            {preview.mods.length === 0 && (
              <li className="px-3 py-2 text-xs">This profile has no mods.</li>
            )}
            {preview.mods.map((m, i) => {
              const badge = SHARE_SOURCE_BADGE[m.kind]
              const detail = shownDetails[i] ?? null
              return (
                <li
                  key={`${m.name}-${i}`}
                  className="flex items-center gap-3 border-line px-3 py-2 not-last:border-b"
                >
                  <ShareModIcon name={m.name} url={detail?.iconUrl ?? null} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate text-fg" title={m.name}>
                        {m.name}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums">{m.version}</span>
                    </p>
                    {detail?.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs" title={detail.description}>
                        {detail.description}
                      </p>
                    )}
                  </div>
                  <span
                    className={`w-[84px] shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-medium ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (trimmed) void open({ code: trimmed })
            }}
          >
            <label className="min-w-0 flex-1">
              <span className="sr-only">Share code</span>
              <input
                autoFocus
                value={code}
                disabled={busy}
                onChange={(e) => {
                  setCode(e.target.value)
                  setError(null)
                }}
                placeholder="HML or r2modman code"
                spellCheck={false}
                autoComplete="off"
                className={`${FIELD} tracking-wider uppercase placeholder:tracking-normal placeholder:normal-case`}
              />
            </label>
            <Button type="submit" variant="primary" disabled={busy || !trimmed}>
              {opening === 'code' ? 'Opening…' : 'Open'}
            </Button>
          </form>
          <div className="mt-4 flex items-center gap-3 border-t border-line pt-4">
            <span className="flex-1 text-xs">
              Or open a .hml or r2modman .r2z file someone sent you.
            </span>
            <Button variant="ghost" disabled={busy} onClick={() => void open({ file: true })}>
              <Icon name="folder" />
              {opening === 'file' ? 'Opening…' : 'Choose file…'}
            </Button>
          </div>
        </>
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

/** A shared mod's icon, with a letter tile until it loads or when it has none. */
function ShareModIcon({ name, url }: { name: string; url: string | null }): React.JSX.Element {
  const { src, onError } = useFallbackSrc([url])
  const shape = 'size-9 shrink-0 overflow-hidden rounded bg-raised'
  if (src) {
    return (
      <img
        key={src}
        src={src}
        alt=""
        loading="lazy"
        draggable={false}
        onError={onError}
        className={`${shape} object-cover`}
      />
    )
  }
  return (
    <span
      className={`${shape} grid place-items-center bg-[linear-gradient(160deg,#1f3a43,#132329)] text-[11px] font-bold text-muted`}
    >
      {initials(name)}
    </span>
  )
}

function ImportProgress({ progress }: { progress: Progress | null }): React.JSX.Element {
  const share = progress && progress.total > 0 ? progress.done / progress.total : 0
  return (
    <div role="status" className="min-w-0 flex-1">
      <p className="flex min-w-0 items-center gap-2 text-xs text-ember">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-ember" />
        <span className="truncate">{progress?.label ?? 'Preparing import…'}</span>
      </p>
      <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full bg-ember transition-[width] duration-300"
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  )
}

function ImportResultView({ result }: { result: ImportResult }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const openPage = (url: string): void =>
    void api.openExternal(url).catch((e) => toast('error', errorMessage(e)))
  return (
    <>
      <p className="flex items-center gap-2 font-medium text-fg">
        <Icon
          name={result.unresolved.length === 0 ? 'check' : 'warn'}
          className={`size-4 shrink-0 ${result.unresolved.length === 0 ? 'text-teal' : 'text-warn'}`}
        />
        {importSummary(result)}
      </p>
      {result.unresolved.length > 0 && (
        <ul className="mt-3 flex max-h-56 flex-col overflow-y-auto rounded-md border border-line">
          {result.unresolved.map((m, i) => (
            <li
              key={`${m.name}-${i}`}
              className="flex items-center gap-3 border-line px-3 py-2 not-last:border-b"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2">
                  <span className="truncate text-fg" title={m.name}>
                    {m.name}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums">{m.version}</span>
                </p>
                <p className="mt-0.5 text-xs break-words select-text">{m.reason}</p>
              </div>
              {m.url && (
                <Button
                  variant="ghost"
                  className="h-7 shrink-0 px-2"
                  onClick={() => openPage(m.url!)}
                >
                  <Icon name="external" className="size-3.5" />
                  Open
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {result.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-warn">
              <Icon name="warn" className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 break-words select-text">{w}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
