import { useEffect, useState } from 'react'
import type { LaunchWarning } from '../../../shared/types'
import { api, errorMessage } from '../api'
import { installedLoaderLabel, shortLoaderLabel } from '../customView'
import { deploymentLabel } from '../nxView'
import { useCurrentProfile, useStore } from '../store'
import { useFallbackSrc } from '../useFallbackSrc'
import { EditGameDialog } from './AddGameDialog'
import { Button, Icon, Modal, Spinner } from './ui'

/** Single-quotes a path for the shell only when it needs it. */
function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

function flatpakOverrideCommand(gamesDir: string): string {
  return `flatpak override --user --filesystem=${shellQuote(gamesDir)} com.valvesoftware.Steam`
}

type WarningAction = 'settings' | 'flatpak' | null

const WARNINGS: Record<LaunchWarning, { label: string; detail: string; action: WarningAction }> = {
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
  'no-shimloader': {
    label: 'Shimloader not installed',
    detail:
      'Install unreal_shimloader into this profile so mods can load. Installing a mod that needs it adds it too.',
    action: null
  },
  'no-melonloader': {
    label: 'MelonLoader not installed',
    detail:
      'Install MelonLoader into this profile so mods can load. Installing a mod that needs it adds it too.',
    action: null
  },
  'no-lovely': {
    label: 'lovely not installed',
    detail:
      'Install lovely into this profile so mods can load. Installing a mod that needs it adds it too.',
    action: null
  },
  'no-returnofmodding': {
    label: 'Return of Modding not installed',
    detail:
      'Install Return of Modding (Hell2Modding for Hades II) into this profile so mods can load. Installing a mod that needs it adds it too.',
    action: null
  },
  'proton-first-run': {
    label: 'Start the game once first',
    detail:
      'Proton sets this game up the first time it starts. Start it once (vanilla is fine), then HML can load mods.',
    action: null
  },
  'native-linux-unsupported': {
    label: 'Native Linux game',
    detail:
      "Native Linux games aren't supported for modded launch yet. Force Proton for this game in Steam (Properties → Compatibility). Vanilla launches still work.",
    action: null
  },
  'loader-mismatch': {
    label: 'Different BepInEx',
    detail: 'This profile has a different BepInEx than the game is set to.',
    action: null
  },
  'no-runner': {
    label: 'No runner chosen',
    detail: 'Choose how to run this game (Proton or Wine) from the game menu.',
    action: null
  },
  'flatpak-filesystem': {
    label: 'Flatpak Steam needs access',
    detail: 'Flatpak Steam cannot read HML profiles until you grant it access to the HML folder.',
    action: 'flatpak'
  }
}

export function LaunchBar(): React.JSX.Element | null {
  const game = useStore((s) => s.currentGame)
  const profile = useCurrentProfile()
  const warnings = useStore((s) => s.warnings)
  const busy = useStore((s) => s.busy)
  const launch = useStore((s) => s.launch)
  const launching = useStore((s) => (s.currentGame ? s.launching[s.currentGame.label] : undefined))
  const deployment = useStore((s) => s.deployment)
  const deploy = useStore((s) => s.deploy)
  const installLoader = useStore((s) => s.installLoader)
  const removeDeployment = useStore((s) => s.removeDeployment)
  const openSettings = useStore((s) => s.setSettingsOpen)
  const [flatpakOpen, setFlatpakOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const gameColors = useStore((s) => s.settings?.gameColors ?? true)
  const hero = useFallbackSrc(gameColors ? (game?.heroUrls ?? []) : [])

  if (!game) return null
  // HML doesn't start deploy games: it copies the mods into the game folder and the user starts it.
  const deploys = game.loader === 'deploy'
  const chosen = game.custom?.loaderChoice
  const customBepinex = !!game.custom && game.loader === 'bepinex' && chosen !== 'none'

  /** Warning copy and button that depend on the custom game; null keeps the stock warning. */
  function customWarning(
    code: LaunchWarning
  ): { detail: string; button?: { label: string; onClick(): void } } | null {
    if (!game?.custom) return null
    if (code === 'no-bepinex' && customBepinex)
      return {
        detail: 'Install BepInEx into this profile so mods can load.',
        button: { label: 'Install BepInEx', onClick: () => void installLoader() }
      }
    if (code === 'loader-mismatch' && chosen)
      return {
        detail: `This profile has ${installedLoaderLabel(profile?.mods ?? [])}; ${game.displayName} is set to ${shortLoaderLabel(chosen)}.`,
        button: {
          label: `Switch to ${shortLoaderLabel(chosen)}`,
          onClick: () => void installLoader()
        }
      }
    if (code === 'no-runner')
      return {
        detail: 'Choose how to run this game (Proton or Wine).',
        button: { label: 'Choose runner…', onClick: () => setEditOpen(true) }
      }
    return null
  }

  function runAction(action: WarningAction): void {
    if (action === 'settings') openSettings(true)
    if (action === 'flatpak') setFlatpakOpen(true)
  }

  const status = (
    <>
      {warnings.map((code) => {
        const base = WARNINGS[code] ?? { label: code, detail: code, action: null }
        const extra = customWarning(code)
        const w = extra ? { ...base, detail: extra.detail } : base
        const chip =
          'inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-2.5 py-1 text-xs font-medium text-warn'
        if (extra?.button)
          return (
            <span key={code} className={chip}>
              <Icon name="warn" className="size-3" />
              <span>{w.detail}</span>
              <Button
                variant="quiet"
                disabled={busy}
                onClick={extra.button.onClick}
                className="h-6 px-2 text-xs"
              >
                {extra.button.label}
              </Button>
            </span>
          )
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
      {deploys && (
        <span className="truncate text-sm text-muted">
          {deploymentLabel(deployment, profile?.id ?? null)}
        </span>
      )}
    </>
  )
  const actions = (
    <>
      {deploys ? (
        <>
          {game.custom &&
            (launching ? (
              <LaunchingButton game={game.label} />
            ) : (
              <Button
                disabled={busy || warnings.includes('no-runner')}
                title={
                  warnings.includes('no-runner')
                    ? 'Choose a runner first (Choose runner…).'
                    : undefined
                }
                onClick={() => void launch('vanilla')}
              >
                <Icon name="play" />
                Play
              </Button>
            ))}
          <Button disabled={busy || !deployment} onClick={() => void removeDeployment()}>
            Remove mods
          </Button>
          <Button
            variant="primary"
            disabled={busy || !profile || !game.installDir}
            title={game.installDir ? undefined : 'Set the game folder first.'}
            onClick={() => void deploy()}
            className="px-4"
          >
            <Icon name="download" />
            Deploy mods
          </Button>
        </>
      ) : (
        <>
          {launching === 'vanilla' ? (
            <LaunchingButton game={game.label} />
          ) : (
            <Button disabled={busy || !!launching} onClick={() => void launch('vanilla')}>
              Start vanilla
            </Button>
          )}
          {launching === 'modded' ? (
            <LaunchingButton game={game.label} variant="primary" className="px-4" />
          ) : (
            <Button
              variant="primary"
              disabled={busy || !!launching || !profile}
              onClick={() => void launch('modded')}
              className="px-4"
            >
              <Icon name="play" />
              Start modded
            </Button>
          )}
        </>
      )}
    </>
  )

  if (!hero.src)
    return (
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-panel/60 px-6 py-3">
        <div className="mr-auto flex min-w-0 flex-wrap items-center gap-2">{status}</div>
        {actions}
        {editOpen && <EditGameDialog game={game} onClose={() => setEditOpen(false)} />}
        {flatpakOpen && <FlatpakDialog onClose={() => setFlatpakOpen(false)} />}
      </header>
    )

  return (
    // The game's banner art, fading into the background behind its name and start buttons.
    <header className="relative isolate flex min-h-32 shrink-0 items-end overflow-hidden border-b border-line px-6 pt-6 pb-4">
      <img
        key={hero.src}
        src={hero.src}
        alt=""
        draggable={false}
        onError={hero.onError}
        className="absolute inset-0 -z-10 size-full object-cover object-[center_35%]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,var(--color-ink)_0%,color-mix(in_srgb,var(--color-ink)_65%,transparent)_45%,transparent_90%),linear-gradient(0deg,var(--color-ink)_0%,transparent_75%)]"
      />
      <div className="flex w-full items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-2xl font-bold tracking-tight [text-shadow:0_2px_14px_rgb(0_0_0/0.7)]">
            {game.displayName}
          </h2>
          <p className="truncate text-xs text-muted">
            {profile
              ? `${profile.name} profile, ${profile.mods.length} ${profile.mods.length === 1 ? 'mod' : 'mods'}`
              : 'No profile'}
          </p>
          {(warnings.length > 0 || deploys) && (
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">{status}</div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>
      </div>
      {editOpen && <EditGameDialog game={game} onClose={() => setEditOpen(false)} />}
      {flatpakOpen && <FlatpakDialog onClose={() => setFlatpakOpen(false)} />}
    </header>
  )
}

/** The pressed start button while its game starts; clicking it stops waiting (Cancel on hover). */
function LaunchingButton({
  game,
  variant,
  className = ''
}: {
  game: string
  variant?: 'primary'
  className?: string
}): React.JSX.Element {
  const cancel = useStore((s) => s.cancelLaunch)
  return (
    <Button
      variant={variant}
      aria-label="Launching… Cancel"
      title="Stop waiting for the game. A game that is already starting keeps starting."
      onClick={() => cancel(game)}
      className={`group ${className}`}
    >
      <Spinner />
      {/* Both labels share one cell so the button keeps its width on hover. */}
      <span className="grid">
        <span className="[grid-area:1/1] group-hover:invisible group-focus-visible:invisible">
          Launching…
        </span>
        <span className="invisible [grid-area:1/1] group-hover:visible group-focus-visible:visible">
          Cancel
        </span>
      </span>
    </Button>
  )
}

function CopyField({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const toast = useStore((s) => s.toast)
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      toast('error', 'Could not copy. Select the text and copy it manually.')
    }
  }
  return (
    <div className="mt-4 flex items-center gap-2 rounded-lg border border-line bg-ink p-1.5 pl-3">
      <code className="flex-1 overflow-x-auto text-[13px] whitespace-nowrap text-fg select-all">
        {text}
      </code>
      <Button variant={copied ? 'ghost' : 'primary'} onClick={() => void copy()} className="h-8">
        <Icon name="copy" className="size-3.5" />
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

function FlatpakDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const [gamesDir, setGamesDir] = useState<string | null>(null)
  const toast = useStore((s) => s.toast)
  useEffect(() => {
    api.getGamesDataDir().then(setGamesDir, (e) => toast('error', errorMessage(e)))
  }, [toast])
  return (
    <Modal
      title="Let Flatpak Steam read HML profiles"
      onClose={onClose}
      width="w-[560px]"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p>
        Steam is installed as a Flatpak, which is sandboxed and cannot see the folder where HML
        keeps its profiles, so mods will not load. Run this once in a terminal, then restart Steam:
      </p>
      {gamesDir ? (
        <CopyField text={flatpakOverrideCommand(gamesDir)} />
      ) : (
        <p className="mt-4 text-muted">Loading the HML folder path...</p>
      )}
      <p className="mt-3">This only grants access to HML&apos;s game folders.</p>
    </Modal>
  )
}
