import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseVdf, vdfGet, type VdfObject } from './vdf'

const FLATPAK_MARKER = '/.var/app/com.valvesoftware.Steam/'

/** Runs a program without a shell and resolves with its stdout (rejects on failure). */
export type ExecFilePort = (file: string, args: string[]) => Promise<{ stdout: string }>

/** Steam's install path from the registry (HKCU\Software\Valve\Steam, SteamPath), or null. */
export async function readWinSteamPath(execFile: ExecFilePort): Promise<string | null> {
  try {
    const { stdout } = await execFile('reg', [
      'query',
      'HKCU\\Software\\Valve\\Steam',
      '/v',
      'SteamPath'
    ])
    const match = /^[ \t]*SteamPath[ \t]+REG_(?:EXPAND_)?SZ[ \t]*(.*)$/im.exec(stdout)
    return match?.[1].trim() || null
  } catch {
    return null
  }
}

export function steamRootCandidates(
  platform: NodeJS.Platform,
  home: string,
  winSteamPath?: string
): string[] {
  if (platform === 'win32') {
    const list = winSteamPath ? [winSteamPath] : []
    list.push('C:\\Program Files (x86)\\Steam')
    return list
  }
  return [
    path.posix.join(home, '.steam', 'steam'),
    path.posix.join(home, '.local', 'share', 'Steam'),
    path.posix.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')
  ]
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readVdf(file: string): Promise<VdfObject | null> {
  try {
    return parseVdf(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p)
  } catch {
    return null
  }
}

export async function findSteamRoot(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const real = await safeRealpath(candidate)
    if (real && (await exists(path.join(real, 'steamapps', 'libraryfolders.vdf')))) return real
  }
  return null
}

export function isFlatpakSteam(root: string): boolean {
  const normalized = root.replace(/\\/g, '/')
  return (normalized.endsWith('/') ? normalized : normalized + '/').includes(FLATPAK_MARKER)
}

/**
 * True when Flatpak Steam's `[Context] filesystems=` override (the text of the system and user
 * override files, system first) grants access to `gamesDir`: through `host`, `home` (when
 * `gamesDir` is under it), or a path (`~/` expanded, `:ro`/`:rw` stripped) equal to or
 * containing it. A `!`-negated entry that would cover `gamesDir` overrides any grant.
 */
export function flatpakGrantsAccess(overrideText: string, gamesDir: string, home: string): boolean {
  const norm = (p: string): string => {
    const n = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return n === '' ? '/' : n
  }
  const within = (dir: string, parent: string): boolean => {
    const d = norm(dir)
    const base = norm(parent)
    return d === base || d.startsWith(base === '/' ? '/' : base + '/')
  }
  const covers = (entry: string): boolean => {
    const token = entry.replace(/:(ro|rw|create)$/i, '')
    if (token === 'host') return true
    if (token === 'home') return within(gamesDir, home)
    if (token === '~') return within(gamesDir, home)
    if (token.startsWith('~/')) return within(gamesDir, norm(home) + token.slice(1))
    if (token.startsWith('/')) return within(gamesDir, token)
    return false
  }
  let inContext = false
  let granted = false
  let denied = false
  for (const raw of overrideText.split(/\r?\n/)) {
    const line = raw.trim()
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      inContext = section[1] === 'Context'
      continue
    }
    const kv = inContext && /^filesystems\s*=(.*)$/.exec(line)
    if (!kv) continue
    for (const part of kv[1].split(';')) {
      const entry = part.trim()
      if (entry.startsWith('!')) denied ||= covers(entry.slice(1).trim())
      else if (entry) granted ||= covers(entry)
    }
  }
  return granted && !denied
}

export async function listLibraries(root: string): Promise<string[]> {
  const rootReal = (await safeRealpath(root)) ?? path.normalize(root)
  const libraries = [rootReal]
  const parsed = await readVdf(path.join(root, 'steamapps', 'libraryfolders.vdf'))
  const folders = parsed && vdfGet(parsed, 'libraryfolders')
  if (folders && typeof folders === 'object') {
    for (const [key, value] of Object.entries(folders)) {
      if (!/^\d+$/.test(key)) continue
      const raw = typeof value === 'string' ? value : vdfGet(value, 'path')
      if (typeof raw !== 'string' || !raw) continue
      const real = await safeRealpath(raw)
      if (real && !libraries.includes(real)) libraries.push(real)
    }
  }
  return libraries
}

export async function findAppInstall(root: string, appId: string): Promise<string | null> {
  for (const lib of await listLibraries(root)) {
    const manifest = await readVdf(path.join(lib, 'steamapps', `appmanifest_${appId}.acf`))
    const installdir = manifest && vdfGet(manifest, 'AppState', 'installdir')
    if (
      typeof installdir === 'string' &&
      installdir &&
      !/[/\\]/.test(installdir) &&
      installdir !== '.' &&
      installdir !== '..'
    ) {
      return path.join(lib, 'steamapps', 'common', installdir)
    }
  }
  return null
}

export async function readLaunchOptions(root: string, appId: string): Promise<string | null> {
  let users: string[]
  try {
    users = (await fs.readdir(path.join(root, 'userdata'))).sort()
  } catch {
    return null
  }
  for (const user of users) {
    const config = await readVdf(path.join(root, 'userdata', user, 'config', 'localconfig.vdf'))
    if (!config) continue
    const value = vdfGet(
      config,
      'UserLocalConfigStore',
      'Software',
      'Valve',
      'Steam',
      'apps',
      appId,
      'LaunchOptions'
    )
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}
