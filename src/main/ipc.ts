import { ipcMain } from 'electron'
import { channel, type HmlApi } from '../shared/ipc'

export function registerIpc(api: HmlApi): void {
  for (const k of Object.keys(api) as (keyof HmlApi)[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel(k), (_e, ...a: any[]) => (api[k] as (...args: any[]) => unknown)(...a))
  }
}
