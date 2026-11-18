import type { NxTarget } from '../../shared/types'
import { parseNxm, type NexusFileRef } from './nxm'

/**
 * HML's own window for Nexus Mods file pages. A free account's download needs the one-time key
 * the "Mod Manager Download" button makes, so the user clicks it on the real page; HML catches the
 * `nxm://` link that click opens instead of the operating system, so no browser or registered
 * link handler is needed. Some mods offer no mod manager download, only the file itself; when the
 * page hands that out instead, HML installs the downloaded file as the page's mod and file. Pages
 * queue up and open one after another in the same window. Each remembers the profile it was opened
 * for, so switching profiles meanwhile doesn't send its download elsewhere.
 */

/** Whether HML's Nexus window may open this page itself: https on nexusmods.com. */
export function isNexusPage(raw: string): boolean {
  try {
    const u = new URL(raw)
    const h = u.hostname
    return (
      u.protocol === 'https:' &&
      u.port === '' &&
      (h === 'nexusmods.com' || h.endsWith('.nexusmods.com'))
    )
  } catch {
    return false
  }
}

/**
 * A file page (`?file_id=`) gets `nxm=1`, Nexus's own "Mod Manager Download" link: without it the
 * page's download button hands out the zip itself, which HML can't catch, instead of an nxm link.
 */
export function modManagerPage(raw: string): string {
  const u = new URL(raw)
  if (!u.searchParams.has('file_id') || u.searchParams.get('nxm') === '1') return raw
  u.searchParams.set('nxm', '1')
  return u.toString()
}

/** The mod and file a Nexus file page (`/<domain>/mods/<id>?file_id=<id>`) is for. */
export function filePageRef(raw: string): NexusFileRef | null {
  if (!isNexusPage(raw)) return null
  const u = new URL(raw)
  const m = /^\/([^/]+)\/mods\/(\d+)\/?$/.exec(u.pathname)
  const fileId = Number(u.searchParams.get('file_id'))
  if (!m || !Number.isSafeInteger(fileId) || fileId <= 0) return null
  return { domain: m[1].toLowerCase(), modId: Number(m[2]), fileId }
}

export const isNxmUrl = (raw: string): boolean => /^nxm:/i.test(raw)

export interface PageWindow {
  load(url: string): void
  setTitle(title: string): void
  focus(): void
  close(): void
}

export interface NexusPages {
  /** Queues the pages (non-Nexus links are dropped) for `target` and shows the window. */
  open(urls: string[], target?: NxTarget): number
  /**
   * Called for every navigation and popup the window's pages start. True when it was an `nxm://`
   * link, which the window must not follow: a valid one goes to `onLink` and the next page loads.
   */
  take(url: string): boolean
  /** A file downloaded from the page goes to `onFile`; the next page loads. */
  downloaded(ref: NexusFileRef, data: Uint8Array): void
}

interface Page {
  url: string
  target?: NxTarget
}

export function createNexusPages(opts: {
  openWindow(onClosed: () => void): PageWindow
  /** `target` is the profile the showing page was opened for, if any. */
  onLink(raw: string, target?: NxTarget): void
  onFile(ref: NexusFileRef, data: Uint8Array, target?: NxTarget): void
}): NexusPages {
  let win: PageWindow | null = null
  let queue: Page[] = []
  let current: Page | null = null
  let done = 0
  let total = 0
  // One click can reach more than one hook (navigation, then the external-link request).
  const handled = new Set<string>()

  const title = (): string =>
    total > 1 ? `Nexus Mods download ${done + 1} of ${total}` : 'Nexus Mods download'

  function show(page: Page): void {
    current = page
    win?.load(page.url)
  }

  function open(urls: string[], target?: NxTarget): number {
    const fresh: Page[] = urls
      .filter(isNexusPage)
      .map(modManagerPage)
      .filter((u, i, all) => all.indexOf(u) === i)
      .map((url) => (target ? { url, target } : { url }))
    if (fresh.length === 0) return 0
    if (!win) {
      queue = []
      done = 0
      total = 0
      const opened = opts.openWindow(() => {
        if (win === opened) {
          win = null
          queue = []
          current = null
        }
      })
      win = opened
      const [first, ...rest] = fresh
      queue.push(...rest)
      total = fresh.length
      show(first)
    } else {
      queue.push(...fresh)
      total += fresh.length
    }
    win.setTitle(title())
    win.focus()
    return fresh.length
  }

  function take(url: string): boolean {
    if (!isNxmUrl(url)) return false
    if (!parseNxm(url) || handled.has(url)) return true
    handled.add(url)
    opts.onLink(url, current?.target)
    next()
    return true
  }

  function downloaded(ref: NexusFileRef, data: Uint8Array): void {
    opts.onFile(ref, data, current?.target)
    next()
  }

  function next(): void {
    if (!win) return
    done += 1
    const page = queue.shift()
    if (page) {
      show(page)
      win.setTitle(title())
    } else win.close()
  }

  return { open, take, downloaded }
}
