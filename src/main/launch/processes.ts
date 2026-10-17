import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LaunchWatchResult } from '../../shared/types'
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
const STEAM_PROCESSES = new Set(['steam', 'steam.sh', 'steamwebhelper'])

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

/** Reads Linux's /proc; injectable so tests need no real processes. */
export interface ProcFsPort {
  readdir(dir: string): Promise<string[]>
  readFile(file: string): Promise<string>
}

const nodeProcFs: ProcFsPort = {
  readdir: (dir) => fs.readdir(dir),
  readFile: (file) => fs.readFile(file, 'utf8')
}

/** Linux keeps only the first 15 bytes of a program's name in /proc/<pid>/comm. */
const COMM_MAX = 15
/** How many processes the /proc scan reads at once. */
export const PROC_SCAN_CONCURRENCY = 16

/** True when a lower-cased program name is one of the game's exes (a 15-char comm may be cut). */
export function matchesGameExe(name: string, exeNames: string[]): boolean {
  return exeNames
    .map(baseName)
    .some(
      (w) => name === w || (name.length === COMM_MAX && w.length > COMM_MAX && w.startsWith(name))
    )
}

/** Comm and state from /proc/<pid>/stat ("pid (comm) S …"); the comm may hold spaces and parens. */
function parseStat(stat: string): { comm: string; state: string } | null {
  const open = stat.indexOf('(')
  const close = stat.lastIndexOf(')')
  if (open < 0 || close < open) return null
  return { comm: stat.slice(open + 1, close), state: stat.slice(close + 2, close + 3) }
}

/**
 * Whether a live process is one of the game's exes: its comm first, then (only when that doesn't
 * match) the basename of argv[0], so a Proton or Wine game shows up as its Windows exe
 * (`Z:\…\REPO.exe`). Zombies are skipped; a few processes are read at a time, stopping once found.
 */
async function linuxGameRunning(procFs: ProcFsPort, exeNames: string[]): Promise<boolean> {
  const pids = (await procFs.readdir('/proc')).filter((d) => /^\d+$/.test(d))
  let next = 0
  let found = false
  async function worker(): Promise<void> {
    while (!found && next < pids.length) {
      const pid = pids[next++]
      // A process can exit between readdir and these reads; it's simply skipped.
      const stat = parseStat(await procFs.readFile(`/proc/${pid}/stat`).catch(() => ''))
      if (!stat || stat.state === 'Z') continue
      if (matchesGameExe(stat.comm.toLowerCase(), exeNames)) {
        found = true
        return
      }
      const cmdline = await procFs.readFile(`/proc/${pid}/cmdline`).catch(() => '')
      const argv0 = cmdline.split('\0')[0]
      if (argv0 && matchesGameExe(baseName(argv0), exeNames)) found = true
    }
  }
  await Promise.all(Array.from({ length: PROC_SCAN_CONCURRENCY }, worker))
  return found
}

/**
 * Whether one of the game's exes is running, for confirming a launch on any platform (unlike
 * isGameRunning). Null when HML can't tell: no exe names, or a platform it can't list.
 */
export async function isGameProcessRunning(
  platform: NodeJS.Platform,
  execFile: ExecFilePort,
  exeNames: string[],
  procFs: ProcFsPort = nodeProcFs
): Promise<boolean | null> {
  if (exeNames.length === 0) return null
  if (platform === 'win32') {
    const { stdout } = await execFile('tasklist', ['/FO', 'CSV', '/NH'])
    return parseTasklist(stdout).some((n) => matchesGameExe(n.toLowerCase(), exeNames))
  }
  if (platform !== 'linux') return null
  return linuxGameRunning(procFs, exeNames)
}

export const LAUNCH_POLL_MS = 1000
export const LAUNCH_TIMEOUT_MS = 120_000

/**
 * Polls `check` until the game is running or `timeoutMs` passes. A null answer means it can't
 * be detected at all ('unknown'); a failed check counts as not running yet. Aborting `signal`
 * ends it with 'cancelled'. When `exited` (the program HML started) settles first, one last
 * check decides between 'running' and 'exited'.
 */
export async function waitForGameStart(opts: {
  check(): Promise<boolean | null>
  intervalMs?: number
  timeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
  exited?: Promise<void>
}): Promise<LaunchWatchResult> {
  const intervalMs = opts.intervalMs ?? LAUNCH_POLL_MS
  const timeoutMs = opts.timeoutMs ?? LAUNCH_TIMEOUT_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const { signal, exited } = opts
  let hasExited = false
  const markExited = (): void => {
    hasExited = true
  }
  exited?.then(markExited, markExited)
  // Settles when the wait is cancelled or the launched program exits, cutting a sleep short.
  const interrupt = new Promise<void>((resolve) => {
    signal?.addEventListener('abort', () => resolve(), { once: true })
    exited?.then(resolve, resolve)
  })
  const deadline = now() + timeoutMs
  for (;;) {
    if (signal?.aborted) return 'cancelled'
    const exitedBefore = hasExited
    const running = await opts.check().catch(() => false)
    if (signal?.aborted) return 'cancelled'
    if (running === null) return 'unknown'
    if (running) return 'running'
    // The check after the exit was the last one.
    if (exitedBefore) return 'exited'
    if (hasExited) continue
    const left = deadline - now()
    if (left <= 0) return 'timeout'
    await Promise.race([sleep(Math.min(intervalMs, left)), interrupt])
  }
}
