import { useCallback, useEffect, useState } from 'react'
import type { UpdateCheckResult } from '../../../shared/ipc'
import type { NxStatus } from '../../../shared/types'
import { noSecureStorage } from '../../../shared/messages'
import { api, errorMessage } from '../api'
import { NX_API_KEY_PAGE } from '../nxView'
import { useStore } from '../store'
import { updateStatusText } from '../updateView'
import { Button, Modal, Spinner } from './ui'
import { useUpdateState } from '../useUpdateState'

export function SettingsDialog(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const settings = useStore((s) => s.settings)
  if (!open || !settings) return null
  return <SettingsForm onClose={() => setOpen(false)} />
}

function SettingsForm({ onClose }: { onClose(): void }): React.JSX.Element {
  const game = useStore((s) => s.currentGame)
  const steamOverride = useStore((s) => s.settings?.steamRootOverride ?? null)
  const gameOverride = useStore((s) =>
    game ? (s.settings?.gamePathOverrides[game.label] ?? null) : null
  )

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      width="w-[560px]"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {/* Each field is keyed by its own saved value, so saving one never resets the other. */}
        <SteamField key={`steam:${steamOverride}`} initial={steamOverride ?? ''} />

        <GithubTokenField />

        <NexusSection />

        {game && (
          <div className="flex flex-col gap-4 border-t border-line pt-5">
            <h3 className="text-sm font-semibold text-fg">{game.displayName}</h3>
            <GameDirField
              key={`${game.label}:${gameOverride}`}
              game={game}
              initial={gameOverride ?? ''}
            />
          </div>
        )}

        <UpdateSection />
      </div>
    </Modal>
  )
}

function SteamField({ initial }: { initial: string }): React.JSX.Element {
  const busy = useStore((s) => s.busy)
  const saveSteamPath = useStore((s) => s.saveSteamPath)
  const [steam, setSteam] = useState(initial)
  const dirty = steam.trim() !== initial
  return (
    <Field
      label="Steam folder"
      hint="Leave empty to detect Steam automatically, including Flatpak installs."
      value={steam}
      onChange={setSteam}
      placeholder="Detected automatically"
    >
      <Button
        variant={dirty ? 'primary' : 'ghost'}
        disabled={busy || !dirty}
        onClick={() => void saveSteamPath(steam.trim() || null)}
      >
        Save
      </Button>
    </Field>
  )
}

function GameDirField({
  game,
  initial
}: {
  game: NonNullable<ReturnType<typeof useStore.getState>['currentGame']>
  initial: string
}): React.JSX.Element {
  const busy = useStore((s) => s.busy)
  const setGamePath = useStore((s) => s.setGamePath)
  const pickGamePath = useStore((s) => s.pickGamePath)
  const [gameDir, setGameDir] = useState(initial)
  const dirty = gameDir.trim() !== initial
  return (
    <Field
      label="Game folder"
      hint={
        game.installDir
          ? `Using ${game.installDir}`
          : game.loader === 'deploy'
            ? 'Set the folder that contains the game. Deploy mods copies them into it.'
            : 'Not found in your Steam libraries. Set the folder that contains the game.'
      }
      value={gameDir}
      onChange={setGameDir}
      placeholder={game.loader === 'deploy' ? 'Game folder' : 'Detected from Steam'}
    >
      <Button
        disabled={busy}
        onClick={() => void pickGamePath(game.label).then((dir) => dir && setGameDir(dir))}
      >
        Browse…
      </Button>
      <Button
        variant={dirty ? 'primary' : 'ghost'}
        disabled={busy || !dirty}
        onClick={() => void setGamePath(gameDir.trim() || null)}
      >
        Save
      </Button>
    </Field>
  )
}

function GithubTokenField(): React.JSX.Element {
  const busy = useStore((s) => s.busy)
  const login = useStore((s) => s.ghLogin)
  const setToken = useStore((s) => s.ghSetToken)
  const toast = useStore((s) => s.toast)
  const [status, setStatus] = useState<{ set: boolean; encryptionAvailable: boolean } | null>(null)
  const [token, setTokenText] = useState('')

  useEffect(() => {
    let live = true
    api
      .ghTokenStatus()
      .then((s) => live && setStatus(s))
      .catch((e) => toast('error', errorMessage(e)))
    return () => {
      live = false
    }
  }, [toast])

  const unavailable = status?.encryptionAvailable === false
  const hint = !status
    ? 'Checking for a saved token…'
    : unavailable
      ? noSecureStorage('a GitHub token')
      : status.set && login
        ? `Signed in as ${login}`
        : status.set
          ? 'A token is saved.'
          : 'No token saved. Without one, GitHub allows 60 update checks per hour.'

  async function save(): Promise<void> {
    if (await setToken(token.trim())) {
      setTokenText('')
      setStatus((s) => s && { ...s, set: true })
    }
  }

  async function remove(): Promise<void> {
    if (await setToken(null)) setStatus((s) => s && { ...s, set: false })
  }

  return (
    <Field
      label="GitHub token"
      hint={hint}
      type="password"
      value={token}
      onChange={setTokenText}
      placeholder={status?.set ? 'Paste a new token to replace it' : 'Personal access token'}
      disabled={!status || unavailable}
    >
      <Button
        variant={token.trim() ? 'primary' : 'ghost'}
        disabled={busy || unavailable || !token.trim()}
        onClick={() => void save()}
      >
        Save
      </Button>
      <Button
        variant="quiet"
        disabled={busy || unavailable || !status?.set}
        onClick={() => void remove()}
      >
        Remove
      </Button>
    </Field>
  )
}

const HANDLER_STATUS: Record<NxStatus['handler'], string> = {
  registered: 'HML handles Nexus "Mod Manager Download" links.',
  'not-registered': 'Another app handles Nexus download links.',
  unavailable: 'Available in installed builds of HML.'
}

function NexusSection(): React.JSX.Element {
  const busy = useStore((s) => s.busy)
  const setKey = useStore((s) => s.nxSetKey)
  const toast = useStore((s) => s.toast)
  const [status, setStatus] = useState<NxStatus | null>(null)
  const [key, setKeyText] = useState('')
  const [registering, setRegistering] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.nxStatus())
    } catch (e) {
      toast('error', errorMessage(e))
    }
  }, [toast])

  useEffect(() => {
    let live = true
    api
      .nxStatus()
      .then((s) => live && setStatus(s))
      .catch((e) => toast('error', errorMessage(e)))
    return () => {
      live = false
    }
  }, [toast])

  const unavailable = status?.encryptionAvailable === false
  const statusLine = !status
    ? 'Checking for a saved key…'
    : unavailable
      ? noSecureStorage('a Nexus Mods API key')
      : status.user
        ? `Signed in as ${status.user.name} (${status.user.isPremium ? 'Premium' : 'Free'})`
        : status.set
          ? "A key is saved, but Nexus Mods didn't confirm it."
          : 'No API key saved.'

  async function save(): Promise<void> {
    if (await setKey(key.trim())) {
      setKeyText('')
      await refresh()
    }
  }

  async function remove(): Promise<void> {
    if (await setKey(null)) await refresh()
  }

  async function register(): Promise<void> {
    setRegistering(true)
    try {
      await api.nxRegisterHandler()
      toast('success', 'HML now handles Nexus download links')
    } catch (e) {
      toast('error', errorMessage(e))
    } finally {
      setRegistering(false)
      await refresh()
    }
  }

  return (
    <div className="flex flex-col gap-4 border-t border-line pt-5">
      <h3 className="text-sm font-semibold text-fg">Nexus Mods</h3>
      <Field
        label="Personal API key"
        hint={
          <>
            <span className="block">{statusLine}</span>
            <span className="mt-0.5 block">
              <button
                type="button"
                className="underline hover:text-fg"
                onClick={() =>
                  api.openExternal(NX_API_KEY_PAGE).catch((e) => toast('error', errorMessage(e)))
                }
              >
                Find it at the bottom of your Nexus Mods API page.
              </button>
            </span>
          </>
        }
        type="password"
        value={key}
        onChange={setKeyText}
        placeholder={status?.set ? 'Paste a new key to replace it' : 'Nexus Mods API key'}
        disabled={!status || unavailable}
      >
        <Button
          variant={key.trim() ? 'primary' : 'ghost'}
          disabled={busy || unavailable || !key.trim()}
          onClick={() => void save()}
        >
          Save
        </Button>
        <Button
          variant="quiet"
          disabled={busy || unavailable || !status?.set}
          onClick={() => void remove()}
        >
          Remove
        </Button>
      </Field>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">Nexus download links</p>
          <p className="mt-0.5 text-xs text-muted">
            {status ? HANDLER_STATUS[status.handler] : 'Checking…'}
          </p>
        </div>
        <Button
          disabled={!status || status.handler !== 'not-registered' || registering}
          onClick={() => void register()}
        >
          Use HML for Nexus downloads
        </Button>
      </div>
    </div>
  )
}

function UpdateSection(): React.JSX.Element {
  const state = useUpdateState()
  const [version, setVersion] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)

  useEffect(() => {
    let live = true
    window.hmlUpdate.getVersion().then(
      (v) => live && setVersion(v),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [])

  async function check(): Promise<void> {
    setAsked(true)
    setResult(null)
    try {
      setResult(await window.hmlUpdate.check())
    } catch (e) {
      setResult({ ok: false, error: errorMessage(e) })
    }
  }

  const checking = asked && result === null
  const status = updateStatusText(state, asked, result)
  return (
    <div className="flex items-center justify-between gap-4 border-t border-line pt-5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">HML {version ? `v${version}` : ''}</p>
        <p className="mt-0.5 text-xs break-words text-muted" aria-live="polite">
          {status ?? 'Updates download in the background and install when HML restarts.'}
        </p>
      </div>
      {state.status === 'downloaded' ? (
        <Button variant="primary" onClick={() => void window.hmlUpdate.restart()}>
          Restart to update
        </Button>
      ) : (
        <Button disabled={checking || state.status === 'downloading'} onClick={() => void check()}>
          {checking && <Spinner className="size-3.5" />}
          Check for updates
        </Button>
      )}
    </div>
  )
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  children
}: {
  label: string
  hint: React.ReactNode
  value: string
  onChange(v: string): void
  placeholder: string
  type?: 'text' | 'password'
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="text-sm font-medium text-fg">{label}</span>
      <div className="mt-1.5 flex gap-2">
        <input
          type={type}
          disabled={disabled}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="h-9 min-w-0 flex-1 rounded-md border border-line bg-ink px-3 text-sm text-fg placeholder:text-muted focus:border-ember/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        {children}
      </div>
      <span className="mt-1.5 block text-xs [overflow-wrap:anywhere] text-muted">{hint}</span>
    </label>
  )
}
