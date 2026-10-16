export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** In-window navigation is allowed only within the app's own origin (dev server, or file:// in prod). */
export function isAllowedNavigation(url: string, devUrl?: string): boolean {
  try {
    const target = new URL(url)
    if (devUrl) return target.origin === new URL(devUrl).origin
    return target.protocol === 'file:'
  } catch {
    return false
  }
}
