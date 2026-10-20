import { useState } from 'react'
import type { ProfileManifest } from '../../../shared/types'
import { useStore } from '../store'
import { isOwner } from '../syncView'
import { Button, Icon, Modal } from './ui'

/**
 * Confirms deleting a profile. An owner's sync code is ended first unless the box is unchecked;
 * when that fails the profile is kept (its key would be forgotten with it), so the user can try
 * again or uncheck the box and delete anyway.
 */
export function DeleteProfileDialog({
  profile,
  onClose
}: {
  profile: ProfileManifest
  onClose(): void
}): React.JSX.Element {
  const deleteProfile = useStore((s) => s.deleteProfile)
  const owner = isOwner(profile)
  const [stopSync, setStopSync] = useState(true)
  const [running, setRunning] = useState(false)
  const [kept, setKept] = useState(false)
  const count = profile.mods.length

  async function confirm(): Promise<void> {
    setRunning(true)
    setKept(false)
    const deleted = await deleteProfile(profile.id, { stopSync: owner && stopSync })
    setRunning(false)
    if (deleted) onClose()
    else setKept(true)
  }

  const close = (): void => {
    if (!running) onClose()
  }

  return (
    <Modal
      title={`Delete ${profile.name}?`}
      onClose={close}
      footer={
        <>
          <Button variant="quiet" disabled={running} onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" disabled={running} onClick={() => void confirm()}>
            {running ? 'Deleting…' : 'Delete profile'}
          </Button>
        </>
      }
    >
      This removes the profile and its {count} {count === 1 ? 'mod' : 'mods'} from this PC. The game
      itself is not touched.
      {owner && (
        <label className="mt-4 flex w-fit cursor-pointer items-center gap-2 text-sm text-fg has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
          <input
            type="checkbox"
            checked={stopSync}
            disabled={running}
            onChange={(e) => setStopSync(e.target.checked)}
            className="size-4 accent-ember"
          />
          Also stop syncing for friends
        </label>
      )}
      {kept && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-danger">
          <Icon name="warn" className="mt-0.5 size-4 shrink-0" />
          <span>
            {owner && stopSync
              ? 'The profile was kept. Try again, or uncheck the box to delete it anyway.'
              : 'The profile was kept. Try again.'}
          </span>
        </p>
      )}
    </Modal>
  )
}
