import { useState } from 'react'
import type { InstalledMod } from '../../../shared/types'
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
