import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { HmlEvent } from '../shared/types'
import { HML_METHODS, channel, stripIpcErrorPrefix, type HmlApi } from '../shared/ipc'

const api = Object.fromEntries(
  HML_METHODS.map((m) => [
    m,
    async (...args: unknown[]) => {
      try {
        return await ipcRenderer.invoke(channel(m), ...args)
      } catch (e) {
        throw new Error(stripIpcErrorPrefix(e instanceof Error ? e.message : String(e)), {
          cause: e
        })
      }
    }
  ])
) as unknown as HmlApi

contextBridge.exposeInMainWorld('hml', api)

// Dropped File objects carry no path under contextIsolation; Electron resolves it here.
contextBridge.exposeInMainWorld('hmlFiles', {
  getPathForFile: (f: File) => webUtils.getPathForFile(f)
})

// Main can emit before the renderer subscribes (an nxm:// link that launched HML is handled on
// did-finish-load, before React's first effect runs). Events from then are held for the first
// subscriber instead of being lost.
const MAX_EARLY_EVENTS = 50
let early: HmlEvent[] | null = []
const holdEarly = (_ev: unknown, e: HmlEvent): void => {
  if (early && early.length < MAX_EARLY_EVENTS) early.push(e)
}
ipcRenderer.on('hml:event', holdEarly)

contextBridge.exposeInMainWorld('hmlEvents', {
  on(cb: (e: HmlEvent) => void): () => void {
    const listener = (_ev: unknown, e: HmlEvent): void => cb(e)
    ipcRenderer.on('hml:event', listener)
    if (early) {
      const held = early
      early = null
      ipcRenderer.removeListener('hml:event', holdEarly)
      for (const e of held) {
        try {
          cb(e)
        } catch (err) {
          console.error('HML event handler failed', err)
        }
      }
    }
    return () => {
      ipcRenderer.removeListener('hml:event', listener)
    }
  }
})
