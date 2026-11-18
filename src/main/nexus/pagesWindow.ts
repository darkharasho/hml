import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, session, type Session, type WebContents } from 'electron'
import { NX_MAX_DOWNLOAD } from './api'
import type { NxTarget } from '../../shared/types'
import type { NexusFileRef } from './nxm'
import { createNexusPages, filePageRef, type NexusPages, type PageWindow } from './pages'

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

interface Handlers {
  take(url: string): boolean
  /** A file downloaded from its file page (a mod with no mod manager download). */
  file(ref: NexusFileRef, data: Uint8Array): void
}

/**
 * Some mods offer only the file itself. A download that starts on a file page goes to a temporary
 * folder, then to HML as that page's mod and file; any other download gets Electron's save dialog.
 */
function catchDownloads(s: Session, h: Handlers): void {
  s.on('will-download', (_e, item, wc) => {
    const ref = wc && !wc.isDestroyed() ? filePageRef(wc.getURL()) : null
    if (!ref) return
    const total = item.getTotalBytes()
    if (total > NX_MAX_DOWNLOAD) return
    // The save path must be set before this handler returns, or Electron asks the user instead.
    const dir = mkdtempSync(join(app.getPath('temp'), 'hml-nexus-'))
    const path = join(dir, 'download')
    item.setSavePath(path)
    item.once('done', (_ev, state) => {
      void (async () => {
        try {
          if (state !== 'completed') return
          const data = await readFile(path)
          if (data.byteLength <= NX_MAX_DOWNLOAD) h.file(ref, data)
        } catch (e) {
          console.warn('Reading a Nexus Mods download failed:', e)
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      })()
    })
  })
}

let prepared: Session | null = null
let handlers: Handlers | null = null
function nexusSession(h: Handlers): Session {
  handlers = h
  if (prepared) return prepared
  const s = session.fromPartition(PARTITION)
  // The user agent stays Electron's own: Cloudflare's check on the sign-in page fails when it
  // claims to be plain Chrome, since the rest of the browser doesn't match.
  // No camera, notifications or the like for websites; an external link that is an nxm:// one
  // (a path the navigation hooks didn't see) comes to HML instead.
  s.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'openExternal' && 'externalURL' in details && details.externalURL) {
      handlers?.take(details.externalURL)
    }
    callback(false)
  })
  s.setPermissionCheckHandler(() => false)
  catchDownloads(s, {
    take: (url) => handlers?.take(url) ?? false,
    file: (ref, data) => handlers?.file(ref, data)
  })
  prepared = s
  return s
}

/** HML's Nexus Mods window; links it catches go to `onLink` like ones from the OS would. */
export function createNexusPagesWindow(opts: {
  parent: () => BrowserWindow | null
  icon?: string
  /** `target` is the profile the page was opened for, if any. */
  onLink(raw: string, target?: NxTarget): void
  /** A file downloaded from its Nexus page instead of a link (a mod with only manual downloads). */
  onFile(ref: NexusFileRef, data: Uint8Array, target?: NxTarget): void
}): NexusPages {
  const pages: NexusPages = createNexusPages({
    onLink: opts.onLink,
    onFile: opts.onFile,
    openWindow(onClosed): PageWindow {
      const take = (url: string): boolean => pages.take(url)
      nexusSession({ take, file: (ref, data) => pages.downloaded(ref, data) })
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
