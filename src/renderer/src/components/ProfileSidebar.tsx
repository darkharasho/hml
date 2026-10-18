import { useEffect, useRef, useState } from 'react'
import type { ProfileManifest } from '../../../shared/types'
import { api, errorMessage } from '../api'
import { isLinux, isNexusOnly } from '../customView'
import { useStore } from '../store'
import { EditGameDialog } from './AddGameDialog'
import { GameCover } from './GameCover'
import { ImportDialog } from './ImportDialog'
import { ShareDialog } from './ShareDialog'
import { Button, ConfirmDialog, Icon, Menu, Modal, type MenuItem } from './ui'

export function ProfileSidebar(): React.JSX.Element | null {
  const game = useStore((s) => s.currentGame)
  const profiles = useStore((s) => s.profiles)
  const currentProfile = useStore((s) => s.currentProfile)
  const selectProfile = useStore((s) => s.selectProfile)
  const createProfile = useStore((s) => s.createProfile)
  const renameProfile = useStore((s) => s.renameProfile)
  const duplicateProfile = useStore((s) => s.duplicateProfile)
  const deleteProfile = useStore((s) => s.deleteProfile)
  const openProfileFolder = useStore((s) => s.openProfileFolder)
  const leaveGame = useStore((s) => s.leaveGame)
  const updateCounts = useStore((s) => (game ? s.updateSummary[game.label] : undefined))
  const removeCustomGame = useStore((s) => s.removeCustomGame)
  const toast = useStore((s) => s.toast)
  const openSettings = useStore((s) => s.setSettingsOpen)
  const pickGamePath = useStore((s) => s.pickGamePath)
  // Also opened by "New profile…" in the titlebar.
  const creating = useStore((s) => s.creatingProfile)
  const setCreating = useStore((s) => s.setCreatingProfile)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ProfileManifest | null>(null)
  const [domainOpen, setDomainOpen] = useState(false)
  const [sharing, setSharing] = useState<ProfileManifest | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [removingGame, setRemovingGame] = useState(false)
  const [removingManual, setRemovingManual] = useState(false)
  // A hand-installed BepInEx in the game folder; a failed lookup counts as none.
  const [manualFor, setManualFor] = useState<string | null>(null)
  const gameLabel = game?.label
  const manualPrompt = useStore((s) => s.manualLoader)
  const hasManual = !!gameLabel && game?.loader === 'bepinex' && manualFor === gameLabel
  const isBepinex = game?.loader === 'bepinex'
  useEffect(() => {
    if (!gameLabel || !isBepinex) return
    let live = true
    api.getManualLoader(gameLabel).then(
      (found) => live && setManualFor(found ? gameLabel : null),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [gameLabel, isBepinex, manualPrompt])

  if (!game) return null
  const activeProfile = profiles.find((p) => p.id === currentProfile) ?? null

  // Nexus-only games always use their own domain; catalog and custom games can set one.
  const menuItems: MenuItem[] = []
  const manualItem: MenuItem = {
    label: 'Remove manual BepInEx install…',
    onSelect: () => setRemovingManual(true)
  }
  // Custom games set their folder when they're added.
  if (!game.custom)
    menuItems.push({ label: 'Game folder…', onSelect: () => void pickGamePath(game.label) })
  if (!isNexusOnly(game))
    menuItems.push({ label: 'Nexus Mods page…', onSelect: () => setDomainOpen(true) })
  if (game.custom) {
    menuItems.push({ label: 'Rename…', onSelect: () => setEditOpen(true) })
    menuItems.push({ label: 'Change loader…', onSelect: () => setEditOpen(true) })
    if (isLinux() && game.custom.source === 'folder')
      menuItems.push({ label: 'Change runner…', onSelect: () => setEditOpen(true) })
    if (hasManual) menuItems.push(manualItem)
    menuItems.push({
      label: 'Remove from HML…',
      danger: true,
      onSelect: () => setRemovingGame(true)
    })
  }
  // Catalog BepInEx games have no custom block above, so the item goes last.
  if (hasManual && !game.custom) menuItems.push(manualItem)

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div className="relative">
        <div className="relative overflow-hidden border-b border-line">
          {/* The game's own cover, blurred, gives each game's workspace its own color. */}
          <div className="absolute inset-0 scale-125 opacity-45 blur-2xl" aria-hidden="true">
            <GameCover game={game} />
          </div>
          <div
            className="absolute inset-0 bg-gradient-to-b from-panel/30 to-panel"
            aria-hidden="true"
          />
          <div className="relative flex items-center gap-3 py-4 pr-10 pl-4">
            <div className="h-16 w-12 shrink-0 overflow-hidden rounded-md shadow-lg ring-1 ring-white/10 [:root[data-game-colors]_&]:shadow-[0_8px_22px_-8px_var(--color-ember)]">
              <GameCover game={game} className="text-base" />
            </div>
            <div className="min-w-0">
              <h1 className="line-clamp-2 text-[15px] leading-tight font-semibold tracking-tight">
                {game.displayName}
              </h1>
              <button
                type="button"
                onClick={leaveGame}
                className="mt-1 inline-flex items-center gap-1 text-xs text-muted hover:text-ember"
              >
                <Icon name="grid" className="size-3" />
                Switch game
              </button>
            </div>
          </div>
        </div>
        {menuItems.length > 0 && (
          <Menu
            label={`Actions for ${game.displayName}`}
            position="absolute"
            className="top-2 right-2"
            items={menuItems}
          />
        )}
      </div>

      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold text-muted">Profiles</h2>
        <button
          type="button"
          aria-label="New profile"
          title="New profile"
          onClick={() => setCreating(true)}
          className="grid size-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"
        >
          <Icon name="plus" />
        </button>
      </div>

      <ul className="flex-1 overflow-y-auto px-2 pb-2">
        {creating && (
          <li>
            <NameInput
              placeholder="Profile name"
              onSubmit={(name) => {
                setCreating(false)
                void createProfile(name)
              }}
              onCancel={() => setCreating(false)}
            />
          </li>
        )}
        {profiles.map((p) => {
          const active = p.id === currentProfile
          if (renaming === p.id) {
            return (
              <li key={p.id}>
                <NameInput
                  initial={p.name}
                  onSubmit={(name) => {
                    setRenaming(null)
                    if (name !== p.name) void renameProfile(p.id, name)
                  }}
                  onCancel={() => setRenaming(null)}
                />
              </li>
            )
          }
          return (
            <li key={p.id} className="group relative">
              <button
                type="button"
                onClick={() => void selectProfile(p.id)}
                aria-current={active ? 'true' : undefined}
                className={`flex w-full items-center gap-2 rounded-md py-2 pr-10 pl-3 text-left text-sm transition-colors ${
                  active ? 'bg-raised text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg'
                }`}
              >
                <span
                  className={`h-4 w-0.5 rounded-full ${active ? 'bg-ember' : 'bg-transparent'}`}
                  aria-hidden="true"
                />
                <span className="flex-1 truncate">{p.name}</span>
                {(updateCounts?.[p.id] ?? 0) > 0 && (
                  <span
                    className="rounded-full bg-ember/15 px-1.5 text-[10px] font-semibold text-ember tabular-nums"
                    title={`${updateCounts![p.id]} mod ${updateCounts![p.id] === 1 ? 'update' : 'updates'}`}
                  >
                    {updateCounts![p.id]}↑
                  </span>
                )}
                <span className="text-xs text-muted tabular-nums">{p.mods.length}</span>
              </button>
              <Menu
                label={`Actions for ${p.name}`}
                position="absolute"
                className="top-1 right-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [&[open]]:opacity-100"
                items={[
                  { label: 'Share…', onSelect: () => setSharing(p) },
                  { label: 'Rename', onSelect: () => setRenaming(p.id) },
                  { label: 'Duplicate', onSelect: () => void duplicateProfile(p.id) },
                  {
                    label: 'Open folder',
                    onSelect: () => void selectProfile(p.id).then(() => openProfileFolder())
                  },
                  { label: 'Delete…', danger: true, onSelect: () => setDeleting(p) }
                ]}
              />
            </li>
          )
        })}
      </ul>

      <div className="flex flex-col gap-1 border-t border-line p-2">
        {/* Sharing is a headline feature, so it sits in plain view rather than only in a menu. */}
        <div className="grid grid-cols-2 gap-1">
          <Button
            variant="quiet"
            className="justify-start"
            disabled={!activeProfile}
            title={activeProfile ? `Share ${activeProfile.name} as a code or file` : undefined}
            onClick={() => activeProfile && setSharing(activeProfile)}
          >
            <Icon name="upload" />
            Share
          </Button>
          <Button
            variant="quiet"
            className="justify-start"
            title="Import a profile from a share code or file, including r2modman"
            onClick={() => setImportOpen(true)}
          >
            <Icon name="download" />
            Import
          </Button>
        </div>
        <Button variant="quiet" className="w-full justify-start" onClick={() => openSettings(true)}>
          <Icon name="gear" />
          Settings
        </Button>
      </div>

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          body={
            <>
              This removes the profile and its {deleting.mods.length}{' '}
              {deleting.mods.length === 1 ? 'mod' : 'mods'} from this PC. The game itself is not
              touched.
            </>
          }
          confirmLabel="Delete profile"
          onConfirm={() => void deleteProfile(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
      {sharing && (
        <ShareDialog game={game.label} profile={sharing} onClose={() => setSharing(null)} />
      )}
      {editOpen && <EditGameDialog game={game} onClose={() => setEditOpen(false)} />}
      {removingGame && (
        <ConfirmDialog
          title={`Remove ${game.displayName}?`}
          body={`Remove ${game.displayName} from HML? Its profiles stay on disk and come back if you add the game again.`}
          confirmLabel="Remove from HML"
          onConfirm={() => void removeCustomGame()}
          onClose={() => setRemovingGame(false)}
        />
      )}
      {removingManual && (
        <ConfirmDialog
          title="Remove manual BepInEx install?"
          body={`${game.displayName} has BepInEx installed in its game folder. HML manages mods per profile and only loads them when you launch through HML. Remove the manual install?`}
          confirmLabel="Remove"
          onConfirm={() =>
            void api.removeManualLoader(game.label).then(
              (backup) => {
                setManualFor(null)
                toast('success', `Moved the manual BepInEx install to ${backup}`)
              },
              (e) => toast('error', errorMessage(e))
            )
          }
          onClose={() => setRemovingManual(false)}
        />
      )}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
      {domainOpen && <NexusDomainDialog game={game.label} onClose={() => setDomainOpen(false)} />}
    </aside>
  )
}

function NameInput({
  initial = '',
  placeholder,
  onSubmit,
  onCancel
}: {
  initial?: string
  placeholder?: string
  onSubmit(name: string): void
  onCancel(): void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  // Enter/Escape unmount the input, which can also fire blur; finish only once.
  const done = useRef(false)
  const finish = (name: string | null): void => {
    if (done.current) return
    done.current = true
    if (name) onSubmit(name)
    else onCancel()
  }
  const submit = (): void => finish(value.trim() || null)
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label={placeholder ?? 'Profile name'}
      maxLength={64}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') finish(null)
      }}
      className="my-0.5 h-9 w-full rounded-md border border-ember/60 bg-ink px-3 text-sm text-fg placeholder:text-muted focus:outline-none"
    />
  )
}

/** Sets which Nexus Mods game a catalog game browses and updates from. */
function NexusDomainDialog({
  game,
  onClose
}: {
  game: string
  onClose(): void
}): React.JSX.Element {
  const busy = useStore((s) => s.busy)
  const displayName = useStore((s) => s.currentGame?.displayName ?? game)
  const setDomain = useStore((s) => s.nxSetDomain)
  // undefined while looking it up; null when the game isn't on Nexus Mods.
  const [current, setCurrent] = useState<string | null | undefined>(undefined)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const domain = value.trim()

  useEffect(() => {
    let live = true
    api.nxGetDomain(game).then(
      (d) => live && setCurrent(d),
      (e) => {
        if (!live) return
        setCurrent(null)
        setLookupError(errorMessage(e))
      }
    )
    return () => {
      live = false
    }
  }, [game])

  const status =
    current === undefined
      ? 'Looking up this game on Nexus Mods…'
      : lookupError
        ? `Couldn't look up the game on Nexus Mods: ${lookupError}`
        : current
          ? `Using nexusmods.com/${current}`
          : "HML didn't find this game on Nexus Mods."

  async function save(next: string | null): Promise<void> {
    setSaveError(null)
    try {
      await setDomain(next)
      onClose()
    } catch (e) {
      // Toasts sit under the modal, so the reason is shown here.
      setSaveError(errorMessage(e))
    }
  }

  return (
    <Modal
      title={`Nexus Mods page for ${displayName}`}
      onClose={onClose}
      width="w-[480px]"
      footer={
        <>
          <Button
            variant="quiet"
            className="mr-auto"
            disabled={busy}
            onClick={() => void save(null)}
          >
            Clear
          </Button>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !domain} onClick={() => void save(domain)}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (domain && !busy) void save(domain)
        }}
      >
        <p className={lookupError ? 'text-danger select-text' : 'text-fg'}>{status}</p>
        <p className="mt-1">
          Enter the name from the game&apos;s address, like skyrimspecialedition in
          nexusmods.com/skyrimspecialedition. Clear goes back to finding it automatically.
        </p>
        <label className="mt-4 block">
          <span className="sr-only">Nexus Mods page name</span>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={current ?? 'Page name'}
            spellCheck={false}
            autoComplete="off"
            className="h-9 w-full rounded-md border border-line bg-ink px-3 text-sm text-fg placeholder:text-muted focus:border-ember/70 focus:outline-none"
          />
        </label>
        {saveError && <p className="mt-2 text-xs text-danger select-text">{saveError}</p>}
      </form>
    </Modal>
  )
}
