import { BrowserWindow, ipcMain } from 'electron'
import { WINDOW_MAXIMIZED_EVENT, WINDOW_METHODS, windowChannel } from '../shared/ipc'
import { windowControls } from './windowFrame'

export { titlebarOptions } from './windowFrame'

/** Answers the window-control channels for whichever window sent the request. */
export function registerWindowIpc(): void {
  for (const m of WINDOW_METHODS) {
    ipcMain.handle(windowChannel(m), (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win || win.isDestroyed()) return m === 'isMaximized' ? false : undefined
      return windowControls(win)[m]()
    })
  }
}

/** Tells the window's renderer when it is maximized or restored, so the button icon follows. */
export function reportMaximized(win: BrowserWindow): void {
  const send = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(WINDOW_MAXIMIZED_EVENT, win.isMaximized())
  }
  win.on('maximize', send)
  win.on('unmaximize', send)
  // Entering or leaving full screen can change it too.
  win.on('enter-full-screen', send)
  win.on('leave-full-screen', send)
}
