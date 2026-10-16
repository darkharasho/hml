import { ipcMain } from 'electron'
import { HML_METHODS, channel, type HmlApi } from '../shared/ipc'

export function registerIpc(api: HmlApi): void {
  for (const k of HML_METHODS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel(k), (_e, ...a: any[]) => (api[k] as (...args: any[]) => unknown)(...a))
  }
}
