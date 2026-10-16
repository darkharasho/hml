import { useRef, useState } from 'react'
import type { ProfileManifest } from '../../../shared/types'
import { useStore } from '../store'
import { GameCover } from './GameCover'
import { Button, ConfirmDialog, Icon, Menu } from './ui'

export function ProfileSidebar(): React.JSX.Element | null {
  const game = useStore((s) => s.currentGame)
  const profiles = useStore((s) => s.profiles)
  const currentProfile = useStore((s) => s.currentProfile)
  const selectProfile = useStore((s) => s.selectProfile)
  const createProfile = useStore((s) => s.createProfile)
  const renameProfile = useStore((s) => s.renameProfile)
  const deleteProfile = useStore((s) => s.deleteProfile)
  const openProfileFolder = useStore((s) => s.openProfileFolder)
  const leaveGame = useStore((s) => s.leaveGame)
  const openSettings = useStore((s) => s.setSettingsOpen)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ProfileManifest | null>(null)

  if (!game) return null

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div className="relative overflow-hidden border-b border-line">
        {/* The game's own cover, blurred, gives each game's workspace its own color. */}
        <div className="absolute inset-0 scale-125 opacity-45 blur-2xl" aria-hidden="true">
          <GameCover game={game} />
        </div>
        <div
          className="absolute inset-0 bg-gradient-to-b from-panel/30 to-panel"
          aria-hidden="true"
        />
        <div className="relative flex items-center gap-3 p-4">
          <div className="h-16 w-12 shrink-0 overflow-hidden rounded-md shadow-lg ring-1 ring-white/10">
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
                <span className="text-xs text-muted tabular-nums">{p.mods.length}</span>
              </button>
              <Menu
                label={`Actions for ${p.name}`}
                className="absolute top-1 right-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [&[open]]:opacity-100"
                items={[
                  { label: 'Rename', onSelect: () => setRenaming(p.id) },
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

      <div className="border-t border-line p-2">
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
