export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * In-window navigation is allowed only within the app itself: the dev server origin, or in
 * production the app's own index.html file URL (query and hash ignored).
 */
export function isAllowedNavigation(
  url: string,
  devUrl: string | undefined,
  indexUrl: string
): boolean {
  try {
    const target = new URL(url)
    if (devUrl) return target.origin === new URL(devUrl).origin
    const index = new URL(indexUrl)
    return (
      target.protocol === 'file:' &&
      target.host === index.host &&
      target.pathname === index.pathname
    )
  } catch {
    return false
  }
}
