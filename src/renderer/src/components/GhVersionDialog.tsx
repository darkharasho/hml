import { useEffect, useState } from 'react'
import type { GhReleaseChoice, InstalledMod } from '../../../shared/types'
import { api, errorMessage } from '../api'
import { useStore } from '../store'
import { Button, Modal, Spinner } from './ui'

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const dateOf = (iso: string): string => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? DATE.format(t) : ''
}

/** Lists a GitHub mod's releases and installs the one picked. */
export function GhVersionDialog({
  mod,
  onClose
}: {
  mod: InstalledMod
  onClose(): void
}): React.JSX.Element {
  const game = useStore((s) => s.currentGame?.label ?? '')
  const profileId = useStore((s) => s.currentProfile ?? '')
  const install = useStore((s) => s.ghInstallRelease)
  const [releases, setReleases] = useState<GhReleaseChoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.ghListReleases(game, profileId, mod.id).then(
      (r) => {
        if (!live) return
        setReleases(r)
        setPicked(r.find((x) => x.installed)?.tag ?? null)
      },
      (e) => live && setError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [game, profileId, mod.id])

  const choice = releases?.find((r) => r.tag === picked)
  // The release HML would update to: pre-releases count only when the mod follows them.
  const follows = mod.github?.prereleases === true
  const newest = releases?.find((r) => r.hasAsset && (follows || !r.prerelease))
  return (
    <Modal
      title={`Change version of ${mod.name}`}
      onClose={onClose}
      width="w-[520px]"
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!choice || choice.installed || !choice.hasAsset}
            onClick={() => {
              if (!choice) return
              void install(mod.id, choice.tag)
              onClose()
            }}
          >
            {choice && !choice.installed ? `Install ${choice.tag}` : 'Install'}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="text-danger">{error}</p>
      ) : !releases ? (
        <div className="flex items-center gap-2">
          <Spinner />
          Loading releases…
        </div>
      ) : (
        <>
          <p>
            Picking an older release keeps the mod on it: HML stops updating it until you pick the
            newest one or change its updates.
          </p>
          <ul className="mt-3 max-h-80 overflow-y-auto rounded-md border border-line">
            {releases.map((r) => (
              <li key={r.tag} className="border-b border-line last:border-b-0">
                <label
                  className={`flex items-center gap-3 px-3 py-2 ${
                    r.hasAsset ? 'cursor-pointer hover:bg-raised/60' : 'opacity-50'
                  }`}
                  title={r.hasAsset ? undefined : `This release has no file like ${mod.name}'s`}
                >
                  <input
                    type="radio"
                    name="gh-release"
                    checked={picked === r.tag}
                    disabled={!r.hasAsset}
                    onChange={() => setPicked(r.tag)}
                    className="size-4 accent-ember"
                  />
                  <span className="flex-1 truncate font-medium text-fg tabular-nums">{r.tag}</span>
                  {r.prerelease && (
                    <span className="rounded bg-warn/10 px-1.5 py-px text-[10px] font-medium text-warn">
                      Pre-release
                    </span>
                  )}
                  {r === newest && <span className="text-xs text-ember">Newest</span>}
                  {r.installed && <span className="text-xs text-muted">Installed</span>}
                  <span className="w-24 shrink-0 text-right text-xs text-muted">
                    {dateOf(r.publishedAt)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  )
}
