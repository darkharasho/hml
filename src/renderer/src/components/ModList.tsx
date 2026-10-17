import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { GhUpdate, InstalledMod, ModSource, ModUpdate, NxUpdate } from '../../../shared/types'
import { api, errorMessage, pathForFile } from '../api'
import { sourcesFor } from '../customView'
import { ghSubline, githubRepoUrl, UPDATE_MODES, updateModeLabel } from '../ghView'
import { nexusModUrl } from '../nxView'
import { useCurrentProfile, useStore } from '../store'
import { initials, UNSUPPORTED_LOADER } from '../tsView'
import { useFallbackSrc } from '../useFallbackSrc'
import { Browse } from './Browse'
import { GithubDialog } from './GithubDialog'
import { ProgressLine } from './PackageDetail'
import { Button, ConfirmDialog, Icon, Menu, type MenuItem } from './ui'

const SOURCE_BADGE: Record<ModSource['kind'], { label: string; className: string }> = {
  thunderstore: { label: 'Thunderstore', className: 'text-[#79b8ff] bg-[#79b8ff]/10' },
  github: { label: 'GitHub', className: 'text-fg bg-fg/10' },
  nexus: { label: 'Nexus', className: 'text-warn bg-warn/10' },
  local: { label: 'Local file', className: 'text-muted bg-muted/10' }
}

const hasFiles = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files')

const NO_ICONS: string[] = []

/**
 * Icon URLs for each installed mod, fetched again when the mod set or a version changes. Empty
 * until main answers (rows show their letter tile meanwhile) or when the lookup fails.
 */
function useModIcons(
  game: string | undefined,
  profileId: string | undefined,
  mods: InstalledMod[] | undefined
): Record<string, string[]> {
  const key = `${game}/${profileId}/${(mods ?? []).map((m) => `${m.id}@${m.version}`).join('|')}`
  const [icons, setIcons] = useState<Record<string, string[]>>({})
  useEffect(() => {
    if (!game || !profileId) return
    let live = true
    api.getModIcons(game, profileId).then(
      (urls) => live && setIcons(urls),
      () => undefined
    )
    return () => {
      live = false
    }
    // key covers game, profileId and the mods.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // The previous answer stands in until the new one arrives, so installing a mod doesn't make
  // every other row flash back to its letter tile.
  return icons
}

export function ModList(): React.JSX.Element | null {
  const profile = useCurrentProfile()
  const busy = useStore((s) => s.busy)
  const installFromFile = useStore((s) => s.installFromFile)
  const installFromPaths = useStore((s) => s.installFromPaths)
  const toast = useStore((s) => s.toast)
  const openProfileFolder = useStore((s) => s.openProfileFolder)
  const game = useStore((s) => s.currentGame)
  const currentDomain = useStore((s) => s.currentDomain)
  const updates = useStore((s) => s.updates)
  const ghUpdates = useStore((s) => s.ghUpdates)
  const nxUpdates = useStore((s) => s.nxUpdates)
  const updateAll = useStore((s) => s.updateAll)
  const updatingAny = useStore(
    (s) => s.tsInstalling.length > 0 || s.ghUpdating.length > 0 || s.nxInstalling.length > 0
  )
  const [githubOpen, setGithubOpen] = useState(false)
  const [tab, setTab] = useState<'installed' | 'online'>('installed')
  // Browse mounts on first visit and then stays mounted, so search and filters survive tab switches.
  const [onlineOpened, setOnlineOpened] = useState(false)
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire for every child element; count depth to know when we truly left.
  const depth = useRef(0)
  const icons = useModIcons(game?.label, profile?.id, profile?.mods)

  if (!profile || !game) return null
  const updateById = new Map(updates.map((u) => [u.modId, u]))
  const ghUpdateById = new Map(ghUpdates.map((u) => [u.modId, u]))
  const nxUpdateById = new Map(nxUpdates.map((u) => [u.modId, u]))
  const updateCount = updates.length + ghUpdates.length + nxUpdates.length
  const openGithub = (): void => setGithubOpen(true)
  const { online, githubPrimary } = sourcesFor(game, currentDomain)
  const hasOnline = online.length > 0
  // The domain can change while the Online tab is open; fall back to Installed if it vanishes.
  const activeTab = hasOnline ? tab : 'installed'
  const custom = !!game.custom
  const fileButton = (
    <Button
      variant={githubPrimary ? 'quiet' : 'ghost'}
      disabled={busy}
      onClick={() => void installFromFile()}
    >
      <Icon name="upload" />
      Install from file
    </Button>
  )
  const githubButton = (
    <Button
      variant={githubPrimary ? 'primary' : 'ghost'}
      disabled={busy || !game.supported}
      title={game.supported ? undefined : UNSUPPORTED_LOADER}
      onClick={openGithub}
    >
      <Icon name="github" />
      Add from GitHub
    </Button>
  )
  const mods = [...profile.mods].sort((a, b) => a.name.localeCompare(b.name))
  const enabledCount = mods.filter((m) => m.enabled).length

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    depth.current = 0
    setDragging(false)
    const paths: string[] = []
    let unreadable = false
    for (const f of Array.from(e.dataTransfer.files)) {
      try {
        const path = pathForFile(f)
        if (path) paths.push(path)
      } catch {
        unreadable = true
      }
    }
    if (unreadable) toast('error', "Couldn't read a dropped file. Use Install from file instead.")
    void installFromPaths(paths)
  }

  return (
    <section
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        depth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <div className="flex items-end justify-between gap-4 border-b border-line px-6">
        <div role="tablist" aria-label="Profile views" className="flex gap-6">
          <TabButton selected={activeTab === 'installed'} onSelect={() => setTab('installed')}>
            Installed
            <span className="ml-2 text-xs font-normal text-muted tabular-nums">{mods.length}</span>
          </TabButton>
          {hasOnline && (
            <TabButton
              selected={activeTab === 'online'}
              onSelect={() => {
                setTab('online')
                setOnlineOpened(true)
              }}
            >
              Online
            </TabButton>
          )}
        </div>
        <div className="flex h-11 items-center gap-2 pb-2">
          {activeTab === 'installed' && (
            <>
              <Button variant="quiet" onClick={() => void openProfileFolder()}>
                <Icon name="folder" />
                Open folder
              </Button>
              {githubPrimary ? (
                <>
                  {githubButton}
                  {fileButton}
                </>
              ) : (
                <>
                  {fileButton}
                  {githubButton}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {onlineOpened && (
        <div className={activeTab === 'online' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <Browse key={game.label} game={game.label} />
        </div>
      )}
      {activeTab === 'online' ? null : mods.length === 0 ? (
        <EmptyState
          onPick={() => void installFromFile()}
          onGithub={openGithub}
          supported={game.supported}
          busy={busy}
          custom={custom}
          githubPrimary={githubPrimary}
        />
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="flex min-h-9 items-center justify-between gap-3 px-2 pb-2">
            <p className="text-xs text-muted">
              {enabledCount} of {mods.length} enabled. Drop .zip files anywhere here to install.
            </p>
            {updateCount > 0 && (
              <Button
                variant="primary"
                disabled={!game.supported || updatingAny}
                title={game.supported ? undefined : UNSUPPORTED_LOADER}
                onClick={() => void updateAll()}
              >
                <Icon name="download" />
                Update all ({updateCount})
              </Button>
            )}
          </div>
          <ul className="flex flex-col">
            {mods.map((m) => (
              <ModRow
                key={m.id}
                mod={m}
                icons={icons[m.id] ?? NO_ICONS}
                update={updateById.get(m.id)}
                ghUpdate={ghUpdateById.get(m.id)}
                nxUpdate={nxUpdateById.get(m.id)}
                supported={game.supported}
              />
            ))}
          </ul>
        </div>
      )}

      {githubOpen && <GithubDialog onClose={() => setGithubOpen(false)} />}

      {dragging && (
        <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-xl border-2 border-dashed border-ember bg-ink/85">
          <div className="text-center">
            <Icon name="upload" className="mx-auto size-8 text-ember" />
            <p className="mt-2 text-base font-semibold">Drop to install into {profile.name}</p>
            <p className="text-sm text-muted">Mod .zip files only</p>
          </div>
        </div>
      )}
    </section>
  )
}

function TabButton({
  selected,
  onSelect,
  children
}: {
  selected: boolean
  onSelect(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`-mb-px border-b-2 pt-4 pb-2.5 text-sm font-semibold transition-colors ${
        selected ? 'border-ember text-fg' : 'border-transparent text-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

/** A mod's icon, trying each URL in turn, with a letter tile when none loads. */
function ModIcon({ name, urls }: { name: string; urls: string[] }): React.JSX.Element {
  const { src, onError } = useFallbackSrc(urls)
  const shape = 'size-12 shrink-0 overflow-hidden rounded-md bg-raised'
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
      className={`${shape} grid place-items-center bg-[linear-gradient(160deg,#1f3a43,#132329)] text-sm font-bold text-muted`}
    >
      {initials(name)}
    </span>
  )
}

function ModRow({
  mod,
  icons,
  update,
  ghUpdate,
  nxUpdate,
  supported
}: {
  mod: InstalledMod
  icons: string[]
  update?: ModUpdate
  ghUpdate?: GhUpdate
  nxUpdate?: NxUpdate
  supported: boolean
}): React.JSX.Element {
  const setModEnabled = useStore((s) => s.setModEnabled)
  const uninstallMod = useStore((s) => s.uninstallMod)
  const tsUpdate = useStore((s) => s.tsUpdate)
  const runGhUpdate = useStore((s) => s.ghUpdate)
  const runNxUpdate = useStore((s) => s.nxUpdate)
  const setUpdateMode = useStore((s) => s.ghSetUpdateMode)
  const toast = useStore((s) => s.toast)
  const updating = useStore((s) =>
    mod.source.kind === 'thunderstore'
      ? s.tsInstalling.includes(mod.source.fullName)
      : mod.source.kind === 'nexus'
        ? s.nxInstalling.includes(mod.source.modId)
        : s.ghUpdating.includes(mod.id)
  )
  const [confirming, setConfirming] = useState(false)
  const badge = SOURCE_BADGE[mod.source.kind]
  const canToggle = mod.disableable.length > 0
  const source = mod.source
  const latest = update?.latest ?? ghUpdate?.latest ?? nxUpdate?.latest
  const runUpdate = (): void =>
    void (update
      ? tsUpdate([update])
      : ghUpdate
        ? runGhUpdate([ghUpdate])
        : nxUpdate && runNxUpdate([nxUpdate]))

  const uninstall: MenuItem = {
    label: 'Uninstall…',
    danger: true,
    onSelect: () => setConfirming(true)
  }
  let menu: MenuItem[] = [uninstall]
  if (source.kind === 'github') {
    const mode = mod.github?.updateMode ?? 'auto'
    menu = [
      {
        label: 'Open on GitHub',
        onSelect: () =>
          void api.openExternal(githubRepoUrl(source)).catch((e) => toast('error', errorMessage(e)))
      },
      ...UPDATE_MODES.map((m, i): MenuItem => ({
        label: updateModeLabel(m),
        checked: m === mode,
        divider: i === 0,
        onSelect: () => void (m !== mode && setUpdateMode(mod.id, m))
      })),
      { ...uninstall, divider: true }
    ]
  } else if (source.kind === 'nexus') {
    menu = [
      {
        label: 'Open on Nexus Mods',
        onSelect: () =>
          void api
            .openExternal(nexusModUrl(source.domain, source.modId))
            .catch((e) => toast('error', errorMessage(e)))
      },
      { ...uninstall, divider: true }
    ]
  }

  return (
    <li className="group flex items-center gap-4 rounded-lg px-2 py-2.5 hover:bg-panel">
      <Toggle
        checked={mod.enabled}
        disabled={!canToggle}
        label={`${mod.enabled ? 'Disable' : 'Enable'} ${mod.name}`}
        title={canToggle ? undefined : 'This mod has no files that can be switched off'}
        onChange={(v) => void setModEnabled(mod.id, v)}
      />
      <div className={mod.enabled ? '' : 'opacity-55'}>
        <ModIcon name={mod.name} urls={icons} />
      </div>
      <div className={`min-w-0 flex-1 ${mod.enabled ? '' : 'opacity-55'}`}>
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium">{mod.name}</span>
          <span className="shrink-0 text-xs text-muted tabular-nums">{mod.version}</span>
        </div>
        {updating ? (
          <ProgressLine className="mt-0.5" />
        ) : source.kind === 'local' ? (
          <p className="truncate text-xs text-muted">{source.fileName}</p>
        ) : source.kind === 'nexus' ? (
          <p className="truncate text-xs text-muted">Nexus Mods · {mod.version}</p>
        ) : (
          source.kind === 'github' && (
            <p className="truncate text-xs text-muted">
              {ghSubline(source, mod.github?.updateMode ?? 'auto')}
            </p>
          )
        )}
      </div>
      {latest && (
        <Button
          className="h-7 px-2.5 text-xs"
          disabled={!supported || updating}
          title={supported ? undefined : UNSUPPORTED_LOADER}
          onClick={runUpdate}
        >
          {updating ? 'Updating…' : `Update to ${latest}`}
        </Button>
      )}
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.className}`}>
        {badge.label}
      </span>
      <Menu label={`Actions for ${mod.name}`} items={menu} />
      {confirming && (
        <ConfirmDialog
          title={`Uninstall ${mod.name}?`}
          body="Its files are removed from this profile. Other profiles are not affected."
          confirmLabel="Uninstall"
          onConfirm={() => void uninstallMod(mod)}
          onClose={() => setConfirming(false)}
        />
      )}
    </li>
  )
}

function Toggle({
  checked,
  disabled,
  label,
  title,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  label: string
  title?: string
  onChange(value: boolean): void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? 'bg-ember' : 'bg-line'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-fg shadow transition-transform ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  )
}

function EmptyState({
  onPick,
  onGithub,
  supported,
  busy,
  custom,
  githubPrimary
}: {
  onPick(): void
  onGithub(): void
  supported: boolean
  busy: boolean
  custom: boolean
  githubPrimary: boolean
}): React.JSX.Element {
  const githubButton = (
    <Button
      variant={githubPrimary ? 'primary' : 'ghost'}
      disabled={busy || !supported}
      title={supported ? undefined : UNSUPPORTED_LOADER}
      onClick={onGithub}
    >
      <Icon name="github" />
      Add from GitHub
    </Button>
  )
  // Catalog games keep zip install as the primary action; for custom games it is the fallback.
  const fileButton = (
    <Button variant={custom ? (githubPrimary ? 'quiet' : 'ghost') : 'primary'} onClick={onPick}>
      Install from file
    </Button>
  )
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="max-w-sm rounded-xl border border-dashed border-line px-8 py-10 text-center">
        <Icon name="upload" className="mx-auto size-7 text-muted" />
        <p className="mt-3 font-semibold">No mods in this profile yet</p>
        <p className="mt-1 text-sm text-muted">
          {custom
            ? 'Add a mod from its GitHub repository, or drop a .zip here.'
            : 'Drag mod .zip files here, pick them from disk, or add a mod from its GitHub repository. Start with BepInExPack if the game needs it.'}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          {githubPrimary ? (
            <>
              {githubButton}
              {fileButton}
            </>
          ) : (
            <>
              {fileButton}
              {githubButton}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
