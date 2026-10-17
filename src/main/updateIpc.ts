import { app, ipcMain, type BrowserWindow } from 'electron'
import { UPDATE_METHODS, UPDATE_STATE_EVENT, updateChannel } from '../shared/ipc'
import { createUpdater, type AutoUpdaterLike, type Updater } from './updater'
import { isMainFrameRequest } from './windowFrame'

/** Creates HML's updater, answers its channels and forwards its state to the window. */
export function registerUpdates(getWindow: () => BrowserWindow | null): Updater {
  const updater = createUpdater({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    // Imported here, not at the top: electron-updater reads Electron state when it loads.
    load: async () => {
      const m = await import('electron-updater')
      // CommonJS: depending on the bundler's interop the exports may sit under default.
      const mod = m.default ?? m
      return mod.autoUpdater as unknown as AutoUpdaterLike
    },
    onState: (state) => {
      const win = getWindow()
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      try {
        win.webContents.send(UPDATE_STATE_EVENT, state)
      } catch {
        // A closing window must not break the updater.
      }
    }
  })
  for (const m of UPDATE_METHODS) {
    ipcMain.handle(updateChannel(m), (e) => {
      if (!isMainFrameRequest(e)) throw new Error('Updates are only for the HML page.')
      return updater[m]()
    })
  }
  return updater
}
