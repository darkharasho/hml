/**
 * The one policy for opening links outside the app (openExternal and window.open): https only, on
 * Thunderstore or GitHub. Returns the parsed URL, whose normalized `href` is what gets opened.
 */
export function parseAllowedExternalUrl(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  const h = u.hostname
  const ok =
    h === 'thunderstore.io' ||
    h.endsWith('.thunderstore.io') ||
    h === 'github.com' ||
    h === 'www.github.com' ||
    h === 'nexusmods.com' ||
    h === 'www.nexusmods.com'
  return ok ? u : null
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
