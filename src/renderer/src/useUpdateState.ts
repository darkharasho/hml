import { useEffect, useState } from 'react'
import type { UpdateApi, UpdateState } from '../../shared/ipc'

type UpdateBridge = Pick<UpdateApi, 'getState'> & {
  onState(cb: (state: UpdateState) => void): () => void
}

/**
 * Follows main's update state: pushed states, plus the current one asked for once, since the
 * launch check may have started before this window subscribed. A pushed state is newer than
 * the answer, so a late answer never overwrites it. Returns the unsubscribe.
 */
export function followUpdateState(
  bridge: UpdateBridge,
  set: (state: UpdateState) => void
): () => void {
  let live = true
  let pushed = false
  const off = bridge.onState((s) => {
    pushed = true
    set(s)
  })
  bridge.getState().then(
    (s) => {
      if (live && !pushed) set(s)
    },
    () => undefined
  )
  return () => {
    live = false
    off()
  }
}

/** HML's own update state from main, kept current. */
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  useEffect(() => followUpdateState(window.hmlUpdate, setState), [])
  return state
}
