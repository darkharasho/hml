import type { NxTarget } from '../../../shared/types'
import { pendingNexusHeading, type PendingNexusRow } from '../nxView'
import { useStore } from '../store'
import { Button, Icon } from './ui'

/**
 * The profile's Nexus mods still to install, drawn as dashed placeholder rows. Install opens each
 * file page in HML's Nexus window; the download installs into this profile and its row goes.
 */
export function PendingNexusList({
  rows,
  target
}: {
  rows: PendingNexusRow[]
  target: NxTarget
}): React.JSX.Element | null {
  const openManualDownloads = useStore((s) => s.openManualDownloads)
  const dismissPendingNexus = useStore((s) => s.dismissPendingNexus)
  if (rows.length === 0) return null
  const install = (urls: string[]): void => void openManualDownloads(urls, target)
  return (
    <section aria-label="Nexus mods to install" className="mx-6 mt-3">
      <div className="flex items-center gap-2 pb-1.5">
        <Icon name="download" className="size-4 shrink-0 text-warn" />
        <h3 className="flex-1 text-sm font-medium text-fg">{pendingNexusHeading(rows.length)}</h3>
        {rows.length > 1 && (
          <Button variant="ghost" className="h-7" onClick={() => install(rows.map((r) => r.url))}>
            Install all
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li
            key={r.key}
            className="flex items-center gap-3 rounded-lg border border-dashed border-warn/40 px-3 py-2"
          >
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="truncate text-sm text-fg" title={r.name}>
                {r.name}
              </span>
              {r.version && (
                <span className="shrink-0 text-xs text-muted tabular-nums">{r.version}</span>
              )}
            </div>
            <span className="shrink-0 rounded bg-warn/10 px-1.5 py-0.5 text-[11px] font-medium text-warn">
              Nexus
            </span>
            <Button
              variant="ghost"
              className="h-7 shrink-0 px-2.5 text-xs"
              title="Opens its page in HML's Nexus Mods window. The download installs here."
              onClick={() => install([r.url])}
            >
              <Icon name="download" className="size-3.5" />
              Install
            </Button>
            {r.modId !== null && (
              <Button
                variant="quiet"
                className="h-7 w-7 shrink-0 px-0"
                title="Remove from this list"
                aria-label={`Remove ${r.name} from this list`}
                onClick={() => void dismissPendingNexus(r.modId!)}
              >
                <Icon name="close" className="size-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
