import { useEffect, useRef, useState } from 'react'
import type { GhInstallResult } from '../../../shared/types'
import { errorMessage } from '../api'
import { formatBytes } from '../ghView'
import { useStore } from '../store'
import { ProgressLine } from './PackageDetail'
import { Button, Icon, Modal } from './ui'

type Choice = Extract<GhInstallResult, { kind: 'choose-asset' }>
type PreOnly = Extract<GhInstallResult, { kind: 'prerelease-only' }>

/** Paste a GitHub link and install its release; asks which file when the release has several. */
export function GithubDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const ghInstall = useStore((s) => s.ghInstall)
  const [url, setUrl] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The asset question belongs to the link it came from; editing the link drops it.
  const [choice, setChoice] = useState<Choice | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [prereleases, setPrereleases] = useState(false)
  // Set when the repo only publishes pre-releases and they weren't included.
  const [preOnly, setPreOnly] = useState<PreOnly | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const chooser = useRef<HTMLFieldSetElement>(null)
  // False once this dialog unmounts, so a late result never touches a later dialog.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // The field is disabled while installing, which drops focus; give it back so the link can be fixed.
  useEffect(() => {
    if (error) input.current?.focus()
  }, [error])

  // Move focus to the first file once the release asks for one.
  useEffect(() => {
    chooser.current?.querySelector('input')?.focus()
  }, [choice])

  // An install can't be abandoned halfway, so the dialog stays open until it finishes.
  const close = (): void => {
    if (!running) onClose()
  }

  const link = url.trim()
  const canSubmit = !running && link !== '' && (!choice || picked !== null)

  async function submit(withPrereleases = prereleases): Promise<void> {
    if (!canSubmit) return
    setError(null)
    setPreOnly(null)
    setRunning(true)
    try {
      const result = await ghInstall(link, choice ? (picked ?? undefined) : undefined, {
        prereleases: withPrereleases
      })
      if (!mounted.current) return
      if (result.kind === 'installed') return onClose()
      if (result.kind === 'prerelease-only') return setPreOnly(result)
      setChoice(result)
      setPicked(null)
    } catch (e) {
      if (mounted.current) setError(errorMessage(e))
    } finally {
      if (mounted.current) setRunning(false)
    }
  }

  return (
    <Modal
      title="Add from GitHub"
      onClose={close}
      width="w-[520px]"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          {running ? <ProgressLine /> : <span />}
          <div className="flex shrink-0 gap-2">
            <Button variant="quiet" disabled={running} onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
              <Icon name="download" />
              {running ? 'Installing…' : choice ? 'Install selected' : 'Install'}
            </Button>
          </div>
        </div>
      }
    >
      <label className="block">
        <span className="text-sm font-medium text-fg">Repository link</span>
        <input
          ref={input}
          autoFocus
          value={url}
          disabled={running}
          onChange={(e) => {
            setUrl(e.target.value)
            setChoice(null)
            setPicked(null)
            setPreOnly(null)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="https://github.com/owner/repo"
          spellCheck={false}
          className="mt-1.5 h-9 w-full rounded-md border border-line bg-ink px-3 text-sm text-fg placeholder:text-muted focus:border-ember/70 focus:outline-none disabled:opacity-60"
        />
        <span className="mt-1.5 block text-xs text-muted">
          Paste a repository or release link. HML installs the latest release and keeps it updated.
        </span>
      </label>

      <label className="mt-3 flex w-fit cursor-pointer items-center gap-2 text-sm text-fg has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
        <input
          type="checkbox"
          checked={prereleases}
          disabled={running}
          onChange={(e) => {
            setPrereleases(e.target.checked)
            if (e.target.checked) setPreOnly(null)
          }}
          className="size-4 accent-ember"
        />
        Include prereleases
      </label>

      {preOnly && (
        <div role="alert" className="mt-4 rounded-md border border-warn/40 bg-warn/[0.06] p-3">
          <p className="flex items-start gap-2 text-fg">
            <Icon name="warn" className="mt-0.5 size-4 shrink-0 text-warn" />
            <span className="min-w-0 break-words">
              {preOnly.owner}/{preOnly.repo} only publishes pre-releases.
            </span>
          </p>
          <p className="mt-1 pl-6 text-xs">
            Include prereleases to install its newest pre-release. HML then keeps it updated with
            new pre-releases too.
          </p>
          <div className="mt-3 pl-6">
            <Button
              variant="primary"
              disabled={running}
              onClick={() => {
                setPrereleases(true)
                void submit(true)
              }}
            >
              <Icon name="download" />
              Include prereleases and install
            </Button>
          </div>
        </div>
      )}

      {choice && (
        <fieldset ref={chooser} className="mt-5" disabled={running}>
          <legend className="flex w-full items-baseline gap-2">
            <Icon name="github" className="size-3.5 self-center text-fg" />
            <span className="font-medium text-fg">
              {choice.owner}/{choice.repo}
            </span>
            <span className="text-xs tabular-nums">{choice.tag}</span>
          </legend>
          <p className="mt-1.5 text-xs">
            This release has several files. Pick the one to install. HML will pick the matching file
            for future updates.
          </p>
          <div className="mt-3 flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
            {choice.assets.map((a) => (
              <label
                key={a.name}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-line px-3 py-2 transition-colors hover:bg-raised has-[:checked]:border-ember/60 has-[:checked]:bg-ember/[0.07] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ember"
              >
                <input
                  type="radio"
                  name="gh-asset"
                  value={a.name}
                  checked={picked === a.name}
                  onChange={() => setPicked(a.name)}
                  className="peer sr-only"
                />
                <span className="grid size-4 shrink-0 place-items-center rounded-full border border-muted peer-checked:border-ember after:size-2 after:rounded-full after:bg-ember after:opacity-0 peer-checked:after:opacity-100" />
                <span className="min-w-0 flex-1 truncate text-fg" title={a.name}>
                  {a.name}
                </span>
                <span className="shrink-0 text-xs tabular-nums">{formatBytes(a.size)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {error && (
        <p role="alert" className="mt-4 flex items-start gap-2 text-danger">
          <Icon name="warn" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
    </Modal>
  )
}
