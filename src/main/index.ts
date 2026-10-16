import { app, shell, dialog, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { isAllowedNavigation, isSafeExternalUrl } from './security'
import { registerIpc } from './ipc'
import { createServices } from './services'
import { makePaths } from './store/paths'
import icon from '../../resources/icon.png?asset'
import snapshotPath from '../../resources/ecosystem-snapshot.json?asset'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, devUrl)) event.preventDefault()
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.darkharasho.hml')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc(
    createServices({
      paths: makePaths(app.getPath('userData')),
      fetch: globalThis.fetch,
      snapshotPath,
      platform: process.platform,
      home: homedir(),
      dialog: {
        async pickFiles({ title, filters }) {
          const win = BrowserWindow.getFocusedWindow()
          const opts = { title, filters, properties: ['openFile', 'multiSelections'] as const }
          const r = win
            ? await dialog.showOpenDialog(win, { ...opts, properties: [...opts.properties] })
            : await dialog.showOpenDialog({ ...opts, properties: [...opts.properties] })
          return r.canceled ? [] : r.filePaths
        },
        async pickFolder(title) {
          const win = BrowserWindow.getFocusedWindow()
          const opts = { title, properties: ['openDirectory' as const] }
          const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
          return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
        }
      },
      shell,
      spawn
    })
  )

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
