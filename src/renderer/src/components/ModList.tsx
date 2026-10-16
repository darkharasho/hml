import { useRef, useState, type DragEvent } from 'react'
import type { InstalledMod, ModSource, ModUpdate } from '../../../shared/types'
import { pathForFile } from '../api'
import { useCurrentProfile, useStore } from '../store'
import { UNSUPPORTED_LOADER } from '../tsView'
import { Browse } from './Browse'
import { ProgressLine } from './PackageDetail'
import { Button, ConfirmDialog, Icon, Menu } from './ui'

const SOURCE_BADGE: Record<ModSource['kind'], { label: string; className: string }> = {
  thunderstore: { label: 'Thunderstore', className: 'text-[#79b8ff] bg-[#79b8ff]/10' },
  github: { label: 'GitHub', className: 'text-fg bg-fg/10' },
  nexus: { label: 'Nexus', className: 'text-warn bg-warn/10' },
  local: { label: 'Local file', className: 'text-muted bg-muted/10' }
}

const hasFiles = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files')

export function ModList(): React.JSX.Element | null {
  const profile = useCurrentProfile()
  const busy = useStore((s) => s.busy)
  const installFromFile = useStore((s) => s.installFromFile)
  const installFromPaths = useStore((s) => s.installFromPaths)
  const openProfileFolder = useStore((s) => s.openProfileFolder)
  const game = useStore((s) => s.currentGame)
  const updates = useStore((s) => s.updates)
  const tsUpdate = useStore((s) => s.tsUpdate)
  const updatingAny = useStore((s) => s.tsInstalling.length > 0)
  const [selectedTab, setTab] = useState<'installed' | 'online'>('installed')
  // Browse mounts on first visit and then stays mounted, so search and filters survive tab switches.
  const [onlineOpened, setOnlineOpened] = useState(false)
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire for every child element; count depth to know when we truly left.
  const depth = useRef(0)

  if (!profile || !game) return null
  // Games without a Thunderstore listing have nothing to browse, so they get no Online tab.
  const hasListing = !!game.packageIndex
  const tab = hasListing ? selectedTab : 'installed'
  const updateById = new Map(updates.map((u) => [u.modId, u]))
  const mods = [...profile.mods].sort((a, b) => a.name.localeCompare(b.name))
  const enabledCount = mods.filter((m) => m.enabled).length

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    depth.current = 0
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files, pathForFile).filter(Boolean)
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
          <TabButton selected={tab === 'installed'} onSelect={() => setTab('installed')}>
            Installed
            <span className="ml-2 text-xs font-normal text-muted tabular-nums">{mods.length}</span>
          </TabButton>
          {hasListing && (
            <TabButton
              selected={tab === 'online'}
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
          {tab === 'installed' && (
            <>
              <Button variant="quiet" onClick={() => void openProfileFolder()}>
                <Icon name="folder" />
                Open folder
              </Button>
              <Button disabled={busy} onClick={() => void installFromFile()}>
                <Icon name="upload" />
                Install from file
              </Button>
            </>
          )}
        </div>
      </div>

      {onlineOpened && hasListing && (
        <div className={tab === 'online' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <Browse key={game.label} game={game.label} />
        </div>
      )}
      {tab === 'online' ? null : mods.length === 0 ? (
        <EmptyState onPick={() => void installFromFile()} />
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="flex min-h-9 items-center justify-between gap-3 px-2 pb-2">
            <p className="text-xs text-muted">
              {enabledCount} of {mods.length} enabled. Drop .zip files anywhere here to install.
            </p>
            {updates.length > 0 && (
              <Button
                variant="primary"
                disabled={!game.supported || updatingAny}
                title={game.supported ? undefined : UNSUPPORTED_LOADER}
                onClick={() => void tsUpdate(updates)}
              >
                <Icon name="download" />
                Update all ({updates.length})
              </Button>
            )}
          </div>
          <ul className="flex flex-col">
            {mods.map((m) => (
              <ModRow key={m.id} mod={m} update={updateById.get(m.id)} supported={game.supported} />
            ))}
          </ul>
        </div>
      )}

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

function ModRow({
  mod,
  update,
  supported
}: {
  mod: InstalledMod
  update?: ModUpdate
  supported: boolean
}): React.JSX.Element {
  const setModEnabled = useStore((s) => s.setModEnabled)
  const uninstallMod = useStore((s) => s.uninstallMod)
  const tsUpdate = useStore((s) => s.tsUpdate)
  const updating = useStore(
    (s) => mod.source.kind === 'thunderstore' && s.tsInstalling.includes(mod.source.fullName)
  )
  const [confirming, setConfirming] = useState(false)
  const badge = SOURCE_BADGE[mod.source.kind]
  const canToggle = mod.disableable.length > 0

  return (
    <li className="group flex items-center gap-4 rounded-lg px-2 py-2.5 hover:bg-panel">
      <Toggle
        checked={mod.enabled}
        disabled={!canToggle}
        label={`${mod.enabled ? 'Disable' : 'Enable'} ${mod.name}`}
        title={canToggle ? undefined : 'This mod has no files that can be switched off'}
        onChange={(v) => void setModEnabled(mod.id, v)}
      />
      <div className={`min-w-0 flex-1 ${mod.enabled ? '' : 'opacity-55'}`}>
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium">{mod.name}</span>
          <span className="shrink-0 text-xs text-muted tabular-nums">{mod.version}</span>
        </div>
        {updating ? (
          <ProgressLine className="mt-0.5" />
        ) : (
          mod.source.kind === 'local' && (
            <p className="truncate text-xs text-muted">{mod.source.fileName}</p>
          )
        )}
      </div>
      {update && (
        <Button
          className="h-7 px-2.5 text-xs"
          disabled={!supported || updating}
          title={supported ? undefined : UNSUPPORTED_LOADER}
          onClick={() => void tsUpdate([update])}
        >
          {updating ? 'Updating…' : `Update to ${update.latest}`}
        </Button>
      )}
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.className}`}>
        {badge.label}
      </span>
      <Menu
        label={`Actions for ${mod.name}`}
        items={[{ label: 'Uninstall…', danger: true, onSelect: () => setConfirming(true) }]}
      />
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

function EmptyState({ onPick }: { onPick(): void }): React.JSX.Element {
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="max-w-sm rounded-xl border border-dashed border-line px-8 py-10 text-center">
        <Icon name="upload" className="mx-auto size-7 text-muted" />
        <p className="mt-3 font-semibold">No mods in this profile yet</p>
        <p className="mt-1 text-sm text-muted">
          Drag mod .zip files here, or pick them from disk. Start with BepInExPack if the game needs
          it.
        </p>
        <Button variant="primary" className="mt-5" onClick={onPick}>
          Install from file
        </Button>
      </div>
    </div>
  )
}
