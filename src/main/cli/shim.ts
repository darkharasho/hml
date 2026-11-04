import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Where the `hml` command goes, and what it runs. */
export interface ShimTarget {
  platform: NodeJS.Platform
  home: string
  /** %LOCALAPPDATA% on Windows. */
  localAppData?: string
  /** The program and arguments that start HML (an AppImage, the exe, or electron + app dir). */
  command: string[]
  /** PATH, to tell whether the folder is on it. */
  pathEnv: string
}

export interface ShimStatus {
  file: string
  installed: boolean
  /** The file exists but runs another HML (moved or a different build). */
  stale: boolean
  onPath: boolean
}

export function shimFile(t: ShimTarget): string {
  if (t.platform === 'win32') {
    const base = t.localAppData ?? path.join(t.home, 'AppData', 'Local')
    // On PATH for every user by default (it is where Store app aliases live).
    return path.win32.join(base, 'Microsoft', 'WindowsApps', 'hml.cmd')
  }
  return path.join(t.home, '.local', 'bin', 'hml')
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export function shimContents(t: ShimTarget): string {
  if (t.platform === 'win32') {
    const cmd = t.command.map((c) => `"${c}"`).join(' ')
    return `@echo off\r\n${cmd} --cli %*\r\n`
  }
  return `#!/bin/sh\n# HML command line; reinstall it from HML's settings if HML moves.\nexec ${t.command.map(shQuote).join(' ')} --cli "$@"\n`
}

export async function shimStatus(t: ShimTarget): Promise<ShimStatus> {
  const file = shimFile(t)
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  const dir = path.dirname(file)
  const sep = t.platform === 'win32' ? ';' : ':'
  const norm = (p: string): string =>
    t.platform === 'win32' ? p.toLowerCase().replace(/[\\/]+$/, '') : p.replace(/\/+$/, '')
  const onPath = t.pathEnv
    .split(sep)
    .filter(Boolean)
    .some((p) => norm(p) === norm(dir))
  return {
    file,
    installed: text !== null && text === shimContents(t),
    stale: text !== null && text !== shimContents(t),
    onPath
  }
}

export async function installShim(t: ShimTarget): Promise<ShimStatus> {
  const file = shimFile(t)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, shimContents(t), { mode: 0o755 })
  if (t.platform !== 'win32') await fs.chmod(file, 0o755)
  return shimStatus(t)
}
