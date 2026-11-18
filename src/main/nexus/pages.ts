import { parseNxm } from './nxm'

/**
 * HML's own window for Nexus Mods file pages. A free account's download needs the one-time key
 * the "Mod Manager Download" button makes, so the user clicks it on the real page; HML catches the
 * `nxm://` link that click opens instead of the operating system, so no browser or registered
 * link handler is needed. Pages queue up and open one after another in the same window.
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

export const isNxmUrl = (raw: string): boolean => /^nxm:/i.test(raw)

export interface PageWindow {
  load(url: string): void
  setTitle(title: string): void
  focus(): void
  close(): void
}

export interface NexusPages {
  /** Queues the pages (non-Nexus links are dropped) and shows the window. */
  open(urls: string[]): number
  /**
   * Called for every navigation and popup the window's pages start. True when it was an `nxm://`
   * link, which the window must not follow: a valid one goes to `onLink` and the next page loads.
   */
  take(url: string): boolean
}

export function createNexusPages(opts: {
  openWindow(onClosed: () => void): PageWindow
  onLink(raw: string): void
}): NexusPages {
  let win: PageWindow | null = null
  let queue: string[] = []
  let done = 0
  let total = 0
  // One click can reach more than one hook (navigation, then the external-link request).
  const handled = new Set<string>()

  const title = (): string =>
    total > 1 ? `Nexus Mods download ${done + 1} of ${total}` : 'Nexus Mods download'

  function open(urls: string[]): number {
    const fresh = urls.filter(isNexusPage).filter((u, i, all) => all.indexOf(u) === i)
    if (fresh.length === 0) return 0
    if (!win) {
      queue = []
      done = 0
      total = 0
      const opened = opts.openWindow(() => {
        if (win === opened) {
          win = null
          queue = []
        }
      })
      win = opened
      const [first, ...rest] = fresh
      queue.push(...rest)
      total = fresh.length
      win.load(first)
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
    opts.onLink(url)
    done += 1
    const next = queue.shift()
    if (win && next) {
      win.load(next)
      win.setTitle(title())
    } else win?.close()
    return true
  }

  return { open, take }
}
