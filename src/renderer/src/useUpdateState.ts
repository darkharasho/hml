import { useEffect, useState } from 'react'
import type { UpdateState } from '../../shared/ipc'

/** HML's own update state from main, kept current. */
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  useEffect(() => {
    let live = true
    let pushed = false
    const off = window.hmlUpdate.onState((s) => {
      pushed = true
      setState(s)
    })
    // The launch check may have started before this window subscribed.
    window.hmlUpdate.getState().then(
      (s) => live && !pushed && setState(s),
      () => undefined
    )
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}
