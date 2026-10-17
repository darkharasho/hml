import { app, shell, dialog, BrowserWindow, protocol, safeStorage } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir, release as osRelease, type as osType } from 'node:os'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { isAllowedNavigation, parseAllowedExternalUrl } from './security'
import { registerIpc } from './ipc'
import { registerWindowIpc, reportMaximized, titlebarOptions } from './window'
import { createServices } from './services'
import { findNxmArg, linuxDesktopEntry, type HandlerPort } from './nexus/nxm'
import { GH_CHECK_INTERVAL_MS } from './github/service'
import { makePaths } from './store/paths'
import { resolveSnapshotPath } from './snapshotPath'
import { ART_SCHEME } from './art/protocol'
import icon from '../../resources/icon.png?asset'
import devSnapshotPath from '../../resources/ecosystem-snapshot.json?asset'

const execFileAsync = promisify(execFile)
const indexHtml = join(__dirname, '../renderer/index.html')

let mainWindowRef: BrowserWindow | null = null

const NXM_DESKTOP = 'hml-nxm.desktop'
const NXM_DEV_REFUSAL = 'Nexus download links can only be handled by an installed build of HML.'

/** Registers HML for `nxm://` links, only when the user asks (Vortex may own them). */
const nxmHandler: HandlerPort = {
  async status() {
    if (!app.isPackaged) return 'unavailable'
    if (process.platform === 'win32') {
      return app.isDefaultProtocolClient('nxm') ? 'registered' : 'not-registered'
    }
    if (process.platform !== 'linux') return 'unavailable'
    try {
      const { stdout } = await execFileAsync('xdg-mime', [
        'query',
        'default',
        'x-scheme-handler/nxm'
      ])
      return stdout.trim() === NXM_DESKTOP ? 'registered' : 'not-registered'
    } catch {
      return 'not-registered'
    }
  },
  async register() {
    if (!app.isPackaged) throw new Error(NXM_DEV_REFUSAL)
    if (process.platform === 'win32') {
      if (!app.setAsDefaultProtocolClient('nxm')) {
        throw new Error("Windows wouldn't let HML handle Nexus download links.")
      }
      return
    }
    if (process.platform !== 'linux') throw new Error(NXM_DEV_REFUSAL)
    const dir = join(homedir(), '.local', 'share', 'applications')
    await mkdir(dir, { recursive: true })
    // An AppImage's real path is APPIMAGE; execPath points into its temporary mount.
    await writeFile(
      join(dir, NXM_DESKTOP),
      linuxDesktopEntry(process.env['APPIMAGE'] ?? process.execPath)
    )
    await execFileAsync('xdg-mime', ['default', NXM_DESKTOP, 'x-scheme-handler/nxm'])
  }
}

// Local art (Steam's cached covers, custom game images, mod icons) reaches the renderer through
// hml-art://, which main answers from files it looks up itself. Must be registered before ready.
protocol.registerSchemesAsPrivileged([
  { scheme: ART_SCHEME, privileges: { standard: true, secure: true } }
])

// One running HML receives every nxm:// link; a second launch hands its argv over and exits.
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()

let services: ReturnType<typeof createServices> | null = null
let rendererLoaded = false
/** nxm:// links that arrived before services existed or the window could receive events. */
const pendingNxm: string[] = []

function drainNxm(): void {
  if (!services || !rendererLoaded) return
  for (const link of pendingNxm.splice(0)) void services.handleNxm(link)
}

// Registered at top level so a link from a second launch during startup isn't lost.
if (hasLock) {
  app.on('second-instance', (_event, argv) => {
    const win = mainWindowRef
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    const link = findNxmArg(argv)
    if (!link) return
    pendingNxm.push(link)
    drainNxm()
  })
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0f191d',
    show: false,
    autoHideMenuBar: true,
    // HML draws its own titlebar (TitleBar.tsx).
    ...titlebarOptions(process.platform),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindowRef = mainWindow
  rendererLoaded = false
  reportMaximized(mainWindow)
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindowRef !== mainWindow) return
    rendererLoaded = true
    drainNxm()
  })
  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) {
      mainWindowRef = null
      rendererLoaded = false
    }
  })
  // A reloaded, crashed or closed renderer no longer waits for a launched game.
  const stopLaunchWatches = (): void => services?.cancelLaunchWatches()
  mainWindow.webContents.on('did-start-loading', stopLaunchWatches)
  mainWindow.webContents.on('render-process-gone', stopLaunchWatches)
  mainWindow.on('closed', stopLaunchWatches)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    const url = parseAllowedExternalUrl(details.url)
    if (url) void shell.openExternal(url.href)
    return { action: 'deny' }
  })

  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, devUrl, pathToFileURL(indexHtml).href)) event.preventDefault()
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(indexHtml)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
if (hasLock)
  app.whenReady().then(() => {
    // Set app user model id for windows
    electronApp.setAppUserModelId('com.darkharasho.hml')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    services = createServices({
      paths: makePaths(app.getPath('userData')),
      fetch: globalThis.fetch,
      appVersion: app.getVersion(),
      os: { type: osType(), release: osRelease(), arch: process.arch },
      snapshotPath: resolveSnapshotPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        devPath: devSnapshotPath
      }),
      platform: process.platform,
      emit: (e) => {
        const win = mainWindowRef
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
          try {
            win.webContents.send('hml:event', e)
          } catch {
            // A closing window must never abort the operation that emitted.
          }
        }
      },
      secrets: {
        isAvailable: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' ||
            safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encrypt: (plain) => safeStorage.encryptString(plain),
        decrypt: (data) => safeStorage.decryptString(data)
      },
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
        },
        async saveFile(opts) {
          const win = BrowserWindow.getFocusedWindow()
          const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
          return r.canceled || !r.filePath ? null : r.filePath
        }
      },
      shell,
      spawn,
      execFile: (file, args) => execFileAsync(file, args, { windowsHide: true, shell: false }),
      nxmHandler,
      shareBaseUrl: process.env.HML_SHARE_URL ?? 'https://hml-share.project96.workers.dev'
    })
    const ready = services
    registerIpc(ready)
    registerWindowIpc()
    protocol.handle(ART_SCHEME, (request) => ready.serveArt(request.url))

    // A link that launched HML is handled once the renderer can receive the event.
    const launchLink = findNxmArg(process.argv)
    if (launchLink) pendingNxm.push(launchLink)
    createWindow()

    // Check GitHub mods for updates shortly after startup and then periodically.
    const runGhUpdates = (): void => {
      ready.ghAutoUpdateAll().catch((e) => {
        console.warn(`GitHub auto-update failed: ${e instanceof Error ? e.message : String(e)}`)
      })
    }
    setTimeout(() => {
      runGhUpdates()
      setInterval(runGhUpdates, GH_CHECK_INTERVAL_MS)
    }, 10_000)

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
