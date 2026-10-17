import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ExecFilePort } from '../steam/steam'

/** Image names from `tasklist /FO CSV /NH` output (the first quoted field of each row). */
export function parseTasklist(stdout: string): string[] {
  const names: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]*)"/.exec(line.trim())
    if (m) names.push(m[1])
  }
  return names
}

const baseName = (p: string): string => p.split(/[\\/]/).pop()!.toLowerCase()

/**
 * True when one of the game's executables is running. Only Windows is checked: it locks files a
 * running program has open, while Linux and macOS let them be replaced. When tasklist fails the
 * answer is `ifUnknown`.
 */
export async function isGameRunning(
  platform: NodeJS.Platform,
  execFile: ExecFilePort,
  exeNames: string[],
  ifUnknown = true
): Promise<boolean> {
  if (platform !== 'win32' || exeNames.length === 0) return false
  let stdout: string
  try {
    stdout = (await execFile('tasklist', ['/FO', 'CSV', '/NH'])).stdout
  } catch {
    return ifUnknown
  }
  const wanted = new Set(exeNames.map(baseName))
  return parseTasklist(stdout).some((n) => wanted.has(n.toLowerCase()))
}

/** Process names (`/proc/<pid>/comm`) of a running Steam client, native or Flatpak. */
const STEAM_PROCESSES = new Set(['steam', 'steam.sh', 'steamwebhelper', 'reaper'])

export const isSteamProcess = (name: string): boolean => STEAM_PROCESSES.has(name)

/** Names of the running processes on Linux, from `<procDir>/<pid>/comm`. */
export async function linuxProcessNames(procDir = '/proc'): Promise<string[]> {
  const pids = (await fs.readdir(procDir)).filter((p) => /^\d+$/.test(p))
  const names = await Promise.all(
    pids.map((pid) =>
      fs.readFile(path.join(procDir, pid, 'comm'), 'utf8').then(
        (s) => s.trim(),
        () => null
      )
    )
  )
  return names.filter((n): n is string => !!n)
}

/** The command that asks a running Steam to exit. */
export function steamShutdownCommand(flatpak: boolean): { command: string; args: string[] } {
  return flatpak
    ? { command: 'flatpak', args: ['run', 'com.valvesoftware.Steam', '-shutdown'] }
    : { command: 'steam', args: ['-shutdown'] }
}

/** Polls until `isRunning` answers false (true) or `timeoutMs` passes (false). */
export async function waitForSteamExit(
  isRunning: () => Promise<boolean>,
  opts: {
    timeoutMs: number
    intervalMs: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  }
): Promise<boolean> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = now() + opts.timeoutMs
  while (await isRunning()) {
    if (now() >= deadline) return false
    await sleep(opts.intervalMs)
  }
  return true
}
