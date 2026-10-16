import { contextBridge, ipcRenderer } from 'electron'
import { HML_METHODS, channel, type HmlApi } from '../shared/ipc'

const api = Object.fromEntries(
  HML_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(channel(m), ...args)])
) as unknown as HmlApi

contextBridge.exposeInMainWorld('hml', api)
