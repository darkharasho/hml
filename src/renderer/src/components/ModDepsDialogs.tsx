import { useState } from 'react'
import type { InstalledMod, ProfileManifest } from '../../../shared/types'
import { displayName } from '../tsView'
import { Button, Modal } from './ui'

function NameList({ mods }: { mods: InstalledMod[] }): React.JSX.Element {
  return (
    <ul className="mt-2 max-h-40 list-disc overflow-y-auto pl-5 text-fg">
      {mods.map((m) => (
        <li key={m.id}>{displayName(m.name)}</li>
      ))}
    </ul>
  )
}

/** Turning off a mod that enabled mods need: turn them off too, or just this one. */
export function DisableDialog({
  mod,
  dependents,
  onDisable,
  onClose
}: {
  mod: InstalledMod
  dependents: InstalledMod[]
  onDisable(also: InstalledMod[]): void
  onClose(): void
}): React.JSX.Element {
  const name = displayName(mod.name)
  const run = (also: InstalledMod[]): void => {
    onDisable(also)
    onClose()
  }
  return (
    <Modal
      title={`Turn off ${name}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => run([])}>Turn off {name} only</Button>
          <Button variant="primary" onClick={() => run(dependents)}>
            Turn off all {dependents.length + 1}
          </Button>
        </>
      }
    >
      {dependents.length === 1 ? 'This mod needs' : 'These mods need'} {name}, and may not work
      without it:
      <NameList mods={dependents} />
    </Modal>
  )
}

/**
 * Uninstalling a mod: warns about enabled mods that need it, and offers to remove the
 * dependencies nothing else needs (unticked, since one may have been installed on purpose).
 */
export function UninstallDialog({
  mod,
  dependents,
  orphans,
  onUninstall,
  onClose
}: {
  mod: InstalledMod
  dependents: InstalledMod[]
  orphans: InstalledMod[]
  onUninstall(also: InstalledMod[]): void
  onClose(): void
}): React.JSX.Element {
  const [picked, setPicked] = useState<string[]>([])
  const also = orphans.filter((m) => picked.includes(m.id))
  return (
    <Modal
      title={`Uninstall ${displayName(mod.name)}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              onUninstall(also)
              onClose()
            }}
          >
            {also.length > 0 ? `Uninstall ${also.length + 1} mods` : 'Uninstall'}
          </Button>
        </>
      }
    >
      <p>Its files are removed from this profile. Other profiles are not affected.</p>
      {dependents.length > 0 && (
        <div className="mt-4 rounded-md border border-warn/30 bg-warn/5 px-3 py-2.5">
          <p className="font-medium text-warn">
            {dependents.length === 1 ? 'This mod needs it' : 'These mods need it'} and may stop
            working:
          </p>
          <NameList mods={dependents} />
        </div>
      )}
      {orphans.length > 0 && (
        <div className="mt-4">
          <p>
            Nothing else uses {orphans.length === 1 ? 'this dependency' : 'these dependencies'}.
            Remove {orphans.length === 1 ? 'it' : 'them'} too?
          </p>
          <ul className="mt-2 max-h-48 overflow-y-auto">
            {orphans.map((m) => (
              <li key={m.id}>
                <label className="flex cursor-pointer items-center gap-2 py-1 text-fg">
                  <input
                    type="checkbox"
                    checked={picked.includes(m.id)}
                    onChange={(e) =>
                      setPicked((p) =>
                        e.target.checked ? [...p, m.id] : p.filter((id) => id !== m.id)
                      )
                    }
                    className="size-4 accent-ember"
                  />
                  {displayName(m.name)}
                  <span className="text-xs text-muted tabular-nums">{m.version}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

/**
 * Copying a mod to another profile of the game: pick the profile, and which of the mod's
 * dependencies that profile lacks go along (all, by default). Followed profiles can't be picked.
 */
export function CopyToProfileDialog({
  mod,
  profiles,
  dependencies,
  onCopy,
  onClose
}: {
  mod: InstalledMod
  /** The game's other profiles. */
  profiles: ProfileManifest[]
  /** The mod's dependencies installed in this profile. */
  dependencies: InstalledMod[]
  onCopy(toProfileId: string, also: string[]): void
  onClose(): void
}): React.JSX.Element {
  const name = displayName(mod.name)
  const open = profiles.filter((p) => p.sync?.role !== 'follower')
  const [to, setTo] = useState<string | null>(open.length === 1 ? open[0].id : null)
  const [skipped, setSkipped] = useState<string[]>([])
  const target = profiles.find((p) => p.id === to)
  const has = new Set(target?.mods.map((m) => m.id) ?? [])
  const existing = target?.mods.find((m) => m.id === mod.id)
  const missing = target ? dependencies.filter((d) => !has.has(d.id)) : []
  const also = missing.filter((d) => !skipped.includes(d.id))
  return (
    <Modal
      title={`Copy ${name} to…`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!to}
            onClick={() => {
              if (!to) return
              onCopy(
                to,
                also.map((d) => d.id)
              )
              onClose()
            }}
          >
            {also.length > 0 ? `Copy ${also.length + 1} mods` : 'Copy'}
          </Button>
        </>
      }
    >
      {profiles.length === 0 ? (
        <p>This game has no other profiles. Create one first.</p>
      ) : (
        <>
          <p>
            The copy has the same version, files and settings. Settings the other profile already
            has for it are kept.
          </p>
          <ul className="mt-3 max-h-60 overflow-y-auto rounded-md border border-line">
            {profiles.map((p) => {
              const followed = p.sync?.role === 'follower'
              return (
                <li key={p.id} className="border-b border-line last:border-b-0">
                  <label
                    className={`flex items-center gap-3 px-3 py-2 ${
                      followed ? 'opacity-50' : 'cursor-pointer hover:bg-raised/60'
                    }`}
                    title={
                      followed ? 'Synced from a friend: its mods come from their list' : undefined
                    }
                  >
                    <input
                      type="radio"
                      name="copy-to-profile"
                      checked={to === p.id}
                      disabled={followed}
                      onChange={() => setTo(p.id)}
                      className="size-4 accent-ember"
                    />
                    <span className="flex-1 truncate font-medium text-fg">{p.name}</span>
                    <span className="text-xs text-muted">
                      {followed
                        ? 'Synced from a friend'
                        : `${p.mods.length} ${p.mods.length === 1 ? 'mod' : 'mods'}`}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          {existing && (
            <p className="mt-3 text-warn">
              {target?.name} already has {name} {existing.version}. Copying replaces it with{' '}
              {mod.version}.
            </p>
          )}
          {missing.length > 0 && (
            <div className="mt-4">
              <p>
                {target?.name} doesn&apos;t have{' '}
                {missing.length === 1 ? 'this dependency' : 'these dependencies'}. Copy{' '}
                {missing.length === 1 ? 'it' : 'them'} too:
              </p>
              <ul className="mt-2 max-h-48 overflow-y-auto">
                {missing.map((m) => (
                  <li key={m.id}>
                    <label className="flex cursor-pointer items-center gap-2 py-1 text-fg">
                      <input
                        type="checkbox"
                        checked={!skipped.includes(m.id)}
                        onChange={(e) =>
                          setSkipped((s) =>
                            e.target.checked ? s.filter((id) => id !== m.id) : [...s, m.id]
                          )
                        }
                        className="size-4 accent-ember"
                      />
                      {displayName(m.name)}
                      <span className="text-xs text-muted tabular-nums">{m.version}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
