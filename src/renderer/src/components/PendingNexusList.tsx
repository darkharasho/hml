import type { NxTarget } from '../../../shared/types'
import type { PendingNexusRow } from '../nxView'
import { useStore } from '../store'
import { Button, Icon } from './ui'

/**
 * The profile's Nexus mods still to install, drawn as dashed rows inside the installed list. Install
 * opens each file page in HML's Nexus window; the download installs into this profile and its row
 * goes, replaced by the mod's real row.
 */
export function PendingNexusRows({
  rows,
  target
}: {
  rows: PendingNexusRow[]
  target: NxTarget
}): React.JSX.Element {
  const openManualDownloads = useStore((s) => s.openManualDownloads)
  const dismissPendingNexus = useStore((s) => s.dismissPendingNexus)
  return (
    <>
      {rows.map((r) => (
        <li
          key={r.key}
          className="my-0.5 flex items-center gap-4 rounded-lg border border-dashed border-warn/40 px-2 py-2"
        >
          <span
            className="w-9 shrink-0 text-center text-[10px] leading-tight font-medium text-warn"
            title="Not installed yet"
          >
            Not installed
          </span>
          <span className="grid size-12 shrink-0 place-items-center rounded-md border border-dashed border-line text-muted">
            <Icon name="download" className="size-5" />
          </span>
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate font-medium text-fg/80" title={r.name}>
              {r.name}
            </span>
            {r.version && (
              <span className="shrink-0 text-xs text-muted tabular-nums">{r.version}</span>
            )}
          </div>
          <Button
            className="h-7 shrink-0 px-2.5 text-xs"
            title="Opens its page in HML's Nexus Mods window. The download installs here."
            onClick={() => void openManualDownloads([r.url], target)}
          >
            Install
          </Button>
          <span className="shrink-0 rounded bg-warn/10 px-1.5 py-0.5 text-[11px] font-medium text-warn">
            Nexus
          </span>
          {r.modId !== null ? (
            <Button
              variant="quiet"
              className="size-7 shrink-0 px-0"
              title="Remove from this list"
              aria-label={`Remove ${r.name} from this list`}
              onClick={() => void dismissPendingNexus(r.modId!)}
            >
              <Icon name="close" className="size-3.5" />
            </Button>
          ) : (
            <span className="size-7 shrink-0" />
          )}
        </li>
      ))}
    </>
  )
}
