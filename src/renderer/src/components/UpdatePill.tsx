import { updatePill } from '../updateView'
import { useUpdateState } from '../useUpdateState'
import { Icon, Spinner } from './ui'

const PILL = 'flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium'

/** The titlebar's update pill: download progress, then "Restart to update". */
export function UpdatePill({ className = '' }: { className?: string }): React.JSX.Element | null {
  const pill = updatePill(useUpdateState())
  if (!pill) return null
  if (pill.kind === 'downloading') {
    return (
      <span
        className={`${PILL} border border-line text-muted ${className}`}
        title="Downloading an HML update"
        aria-live="polite"
      >
        <Spinner className="size-3" />
        {pill.label}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={() => void window.hmlUpdate.restart()}
      className={`${PILL} bg-ember text-ink hover:bg-ember-hover active:bg-ember-deep ${className}`}
      title={pill.version ? `Restart HML to install v${pill.version}` : 'Restart HML to install'}
    >
      <Icon name="download" className="size-3.5" />
      {pill.label}
    </button>
  )
}
