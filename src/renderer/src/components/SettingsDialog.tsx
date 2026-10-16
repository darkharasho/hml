import { useEffect, useState } from 'react'
import { api, errorMessage } from '../api'
import { useStore } from '../store'
import { Button, Modal } from './ui'

export function SettingsDialog(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const settings = useStore((s) => s.settings)
  if (!open || !settings) return null
  // Keyed by the saved values so the form resets whenever they change underneath it.
  return (
    <SettingsForm
      key={`${settings.steamRootOverride}`}
      initialSteam={settings.steamRootOverride ?? ''}
      onClose={() => setOpen(false)}
    />
  )
}

function SettingsForm({
  initialSteam,
  onClose
}: {
  initialSteam: string
  onClose(): void
}): React.JSX.Element {
  const game = useStore((s) => s.currentGame)
  const override = useStore((s) => (game ? s.settings?.gamePathOverrides[game.label] : undefined))
  const busy = useStore((s) => s.busy)
  const saveSteamPath = useStore((s) => s.saveSteamPath)
  const setGamePath = useStore((s) => s.setGamePath)
  const pickGamePath = useStore((s) => s.pickGamePath)
  const [steam, setSteam] = useState(initialSteam)
  const [gameDir, setGameDir] = useState(override ?? '')
  const steamDirty = steam.trim() !== initialSteam
  const gameDirty = gameDir.trim() !== (override ?? '')

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
        <Field
          label="Steam folder"
          hint="Leave empty to detect Steam automatically, including Flatpak installs."
          value={steam}
          onChange={setSteam}
          placeholder="Detected automatically"
        >
          <Button
            variant={steamDirty ? 'primary' : 'ghost'}
            disabled={busy || !steamDirty}
            onClick={() => void saveSteamPath(steam.trim() || null)}
          >
            Save
          </Button>
        </Field>

        {game && (
          <Field
            label={`${game.displayName} folder`}
            hint={
              game.installDir
                ? `Using ${game.installDir}`
                : 'Not found in your Steam libraries. Set the folder that contains the game.'
            }
            value={gameDir}
            onChange={setGameDir}
            placeholder="Detected from Steam"
          >
            <Button
              disabled={busy}
              onClick={() => void pickGamePath(game.label).then((dir) => dir && setGameDir(dir))}
            >
              Browse…
            </Button>
            <Button
              variant={gameDirty ? 'primary' : 'ghost'}
              disabled={busy || !gameDirty}
              onClick={() => void setGamePath(gameDir.trim() || null)}
            >
              Save
            </Button>
          </Field>
        )}

        <GithubTokenField />
      </div>
    </Modal>
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
      ? "Secure storage isn't available on this system, so HML can't save a GitHub token."
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
        Save token
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
  hint: string
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
      <span className="mt-1.5 block text-xs break-all text-muted">{hint}</span>
    </label>
  )
}
