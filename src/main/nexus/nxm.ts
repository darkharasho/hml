/** A parsed `nxm://` download link ("Mod Manager Download" on nexusmods.com). */
export interface NxmLink {
  domain: string
  modId: number
  fileId: number
  key: string
  expires: number
  userId: number | null
}

/** Whether HML is the operating system's handler for `nxm://` links, and how to make it so. */
export interface HandlerPort {
  status(): Promise<'registered' | 'not-registered' | 'unavailable'>
  register(): Promise<void>
}

const PATH = /^\/mods\/(\d+)\/files\/(\d+)$/
const DIGITS = /^\d+$/

/** Parses an `nxm://<domain>/mods/<id>/files/<id>?key=&expires=[&user_id=]` link; null if it isn't one. */
export function parseNxm(raw: string): NxmLink | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'nxm:' || !/^[a-z0-9]+$/.test(u.hostname)) return null
  const m = PATH.exec(u.pathname)
  if (!m) return null
  const key = u.searchParams.get('key') ?? ''
  const expires = u.searchParams.get('expires') ?? ''
  const user = u.searchParams.get('user_id')
  if (key === '' || !DIGITS.test(expires)) return null
  const modId = Number(m[1])
  const fileId = Number(m[2])
  const expiresN = Number(expires)
  if (![modId, fileId, expiresN].every(Number.isSafeInteger)) return null
  const userId =
    user !== null && DIGITS.test(user) && Number.isSafeInteger(Number(user)) ? Number(user) : null
  return { domain: u.hostname, modId, fileId, key, expires: expiresN, userId }
}

/** The `nxm://` argument of a command line; it isn't always last (Chromium appends flags). */
export function findNxmArg(argv: string[]): string | null {
  return argv.find((a) => a.toLowerCase().startsWith('nxm://')) ?? null
}

/** The desktop entry that makes `xdg-mime` route `nxm://` links to HML. */
export function linuxDesktopEntry(execPath: string): string {
  const quoted = execPath.replace(/[\\"`$]/g, (c) => `\\${c}`)
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=HML (Nexus download links)',
    `Exec="${quoted}" %u`,
    'MimeType=x-scheme-handler/nxm;',
    'NoDisplay=true',
    'Terminal=false',
    ''
  ].join('\n')
}
