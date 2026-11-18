import { app, BrowserWindow, session, type Session, type WebContents } from 'electron'
import { browserUserAgent, createNexusPages, type NexusPages, type PageWindow } from './pages'

/** Kept between runs so the user stays signed in to Nexus Mods. */
const PARTITION = 'persist:nexus'

const isHttps = (raw: string): boolean => {
  try {
    return new URL(raw).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Pages here are ordinary websites: no preload, sandboxed, and only https. Sign-in can pass
 * through other sites and their popups, so those are allowed; `nxm://` links never leave HML.
 */
function guard(wc: WebContents, take: (url: string) => boolean): void {
  wc.on('will-frame-navigate', (e) => {
    if (take(e.url) || !isHttps(e.url)) e.preventDefault()
  })
  wc.on('will-redirect', (e) => {
    if (take(e.url) || !isHttps(e.url)) e.preventDefault()
  })
  wc.setWindowOpenHandler(({ url }) => {
    if (take(url) || !isHttps(url)) return { action: 'deny' }
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
  })
  wc.on('did-create-window', (child) => guard(child.webContents, take))
}

let prepared: Session | null = null
function nexusSession(take: (url: string) => boolean): Session {
  if (prepared) return prepared
  const s = session.fromPartition(PARTITION)
  s.setUserAgent(browserUserAgent(s.getUserAgent(), app.getName()))
  // No camera, notifications or the like for websites; an external link that is an nxm:// one
  // (a path the navigation hooks didn't see) comes to HML instead.
  s.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'openExternal' && 'externalURL' in details && details.externalURL) {
      take(details.externalURL)
    }
    callback(false)
  })
  s.setPermissionCheckHandler(() => false)
  prepared = s
  return s
}

/** HML's Nexus Mods window; links it catches go to `onLink` like ones from the OS would. */
export function createNexusPagesWindow(opts: {
  parent: () => BrowserWindow | null
  icon?: string
  onLink(raw: string): void
}): NexusPages {
  const pages: NexusPages = createNexusPages({
    onLink: opts.onLink,
    openWindow(onClosed): PageWindow {
      const take = (url: string): boolean => pages.take(url)
      nexusSession(take)
      const parent = opts.parent()
      const win = new BrowserWindow({
        width: 1100,
        height: 820,
        minWidth: 600,
        minHeight: 400,
        backgroundColor: '#0f191d',
        autoHideMenuBar: true,
        ...(parent && !parent.isDestroyed() ? { parent } : {}),
        ...(opts.icon ? { icon: opts.icon } : {}),
        webPreferences: {
          partition: PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          spellcheck: false
        }
      })
      guard(win.webContents, take)
      // The window's title says which download it is, not the page's.
      win.on('page-title-updated', (e) => e.preventDefault())
      win.on('closed', onClosed)
      return {
        load: (url) => void win.loadURL(url).catch(() => undefined),
        setTitle: (t) => !win.isDestroyed() && win.setTitle(t),
        focus: () => {
          if (win.isDestroyed()) return
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        },
        close: () => !win.isDestroyed() && win.close()
      }
    }
  })
  return pages
}
