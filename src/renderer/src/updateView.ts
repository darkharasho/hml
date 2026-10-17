import type { UpdateCheckResult, UpdateState } from '../../shared/ipc'

export type UpdatePill =
  { kind: 'downloading'; label: string } | { kind: 'restart'; label: string; version: string }

/**
 * What the titlebar shows for HML's own update: nothing while idle, checking, up to date or after
 * an error (errors only show for a manual check in Settings).
 */
export function updatePill(state: UpdateState): UpdatePill | null {
  if (state.status === 'downloading') {
    return {
      kind: 'downloading',
      label: state.percent === null ? 'Downloading…' : `Downloading ${Math.round(state.percent)}%`
    }
  }
  if (state.status === 'downloaded') {
    return { kind: 'restart', label: 'Restart to update', version: state.version }
  }
  return null
}

/**
 * The line next to Settings' "Check for updates". A download in progress or ready always shows;
 * the rest only once the user has asked (`asked`), with `result` being what their check answered.
 */
export function updateStatusText(
  state: UpdateState,
  asked: boolean,
  result: UpdateCheckResult | null
): string | null {
  const version = (v: string): string => (v ? `v${v}` : 'The update')
  if (state.status === 'downloaded') return `${version(state.version)} is ready. Restart to update.`
  if (state.status === 'downloading') {
    const pct = state.percent === null ? '' : ` (${Math.round(state.percent)}%)`
    return state.version ? `Downloading v${state.version}${pct}…` : `Downloading the update${pct}…`
  }
  if (!asked) return null
  if (result && !result.ok) return result.error
  if (!result) return 'Checking…'
  if (state.status === 'none') return "You're on the latest version."
  if (state.status === 'error') return state.message
  return 'Checking…'
}
