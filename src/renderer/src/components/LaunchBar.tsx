import { useState } from 'react'
import { useCurrentProfile, useStore } from '../store'
import { Button, Icon, Modal } from './ui'

const PROTON_LAUNCH_OPTIONS = 'WINEDLLOVERRIDES="winhttp=n,b" %command%'

type WarningAction = 'settings' | 'proton' | null

const WARNINGS: Record<string, { label: string; detail: string; action: WarningAction }> = {
  'game-not-found': {
    label: 'Game folder not found',
    detail: 'HML could not find the game install. Set its folder in settings.',
    action: 'settings'
  },
  'steam-not-found': {
    label: 'Steam not found',
    detail: 'HML could not find Steam. Set the Steam folder in settings.',
    action: 'settings'
  },
  'loader-unsupported': {
    label: 'Mod loader not supported yet',
    detail: 'This game uses a mod loader HML cannot launch yet. Vanilla launches still work.',
    action: null
  },
  'no-bepinex': {
    label: 'BepInEx not installed',
    detail: 'Install BepInExPack into this profile so mods can load.',
    action: null
  },
  'proton-launch-options': {
    label: 'Steam launch options needed',
    detail: 'This game runs through Proton and needs a launch option so mods load.',
    action: 'proton'
  }
}

export function LaunchBar(): React.JSX.Element | null {
  const game = useStore((s) => s.currentGame)
  const profile = useCurrentProfile()
  const warnings = useStore((s) => s.warnings)
  const busy = useStore((s) => s.busy)
  const launch = useStore((s) => s.launch)
  const openSettings = useStore((s) => s.setSettingsOpen)
  const [protonOpen, setProtonOpen] = useState(false)

  if (!game) return null

  function runAction(action: WarningAction): void {
    if (action === 'settings') openSettings(true)
    if (action === 'proton') setProtonOpen(true)
  }

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-line bg-panel/60 px-6 py-3">
      <div className="mr-auto flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate text-sm text-muted">
          Profile <span className="font-semibold text-fg">{profile?.name ?? 'none'}</span>
        </span>
        {warnings.map((code) => {
          const w = WARNINGS[code] ?? { label: code, detail: code, action: null }
          const chip =
            'inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-2.5 py-1 text-xs font-medium text-warn'
          return w.action ? (
            <button
              key={code}
              type="button"
              title={w.detail}
              onClick={() => runAction(w.action)}
              className={`${chip} hover:bg-warn/20`}
            >
              <Icon name="warn" className="size-3" />
              {w.label}
            </button>
          ) : (
            <span key={code} title={w.detail} className={chip}>
              <Icon name="warn" className="size-3" />
              {w.label}
            </span>
          )
        })}
      </div>
      <Button disabled={busy} onClick={() => void launch('vanilla')}>
        Start vanilla
      </Button>
      <Button
        variant="primary"
        disabled={busy || !profile}
        onClick={() => void launch('modded')}
        className="px-4"
      >
        <Icon name="play" />
        Start modded
      </Button>

      {protonOpen && <ProtonDialog onClose={() => setProtonOpen(false)} />}
    </header>
  )
}

function ProtonDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const toast = useStore((s) => s.toast)
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(PROTON_LAUNCH_OPTIONS)
      setCopied(true)
    } catch {
      toast('error', 'Could not copy. Select the text and copy it manually.')
    }
  }
  return (
    <Modal
      title="Add Steam launch options"
      onClose={onClose}
      width="w-[520px]"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p>
        This game runs through Proton, which ignores the mod loader unless Steam tells it to. In
        Steam, right-click the game, open Properties, and paste this into Launch options:
      </p>
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-line bg-ink p-1.5 pl-3">
        <code className="flex-1 overflow-x-auto text-[13px] whitespace-nowrap text-fg select-all">
          {PROTON_LAUNCH_OPTIONS}
        </code>
        <Button variant={copied ? 'ghost' : 'primary'} onClick={() => void copy()} className="h-8">
          <Icon name="copy" className="size-3.5" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="mt-3">Vanilla launches keep working with this option set.</p>
    </Modal>
  )
}
