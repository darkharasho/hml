import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
