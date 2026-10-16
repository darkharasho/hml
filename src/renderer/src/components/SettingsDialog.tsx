import { useState } from 'react'
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
      </div>
    </Modal>
  )
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  children
}: {
  label: string
  hint: string
  value: string
  onChange(v: string): void
  placeholder: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="text-sm font-medium text-fg">{label}</span>
      <div className="mt-1.5 flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="h-9 min-w-0 flex-1 rounded-md border border-line bg-ink px-3 text-sm text-fg placeholder:text-muted focus:border-ember/70 focus:outline-none"
        />
        {children}
      </div>
      <span className="mt-1.5 block text-xs break-all text-muted">{hint}</span>
    </label>
  )
}
