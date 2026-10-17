import { promises as fs } from 'node:fs'
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

/**
 * Lower-cased program names of every running process, or null when this platform can't be
 * listed. On Linux each process gives its comm and the basename of argv[0]; a game under
 * Proton or Wine shows up as its Windows exe (argv[0] like `Z:\…\REPO.exe`).
 */
export async function runningProgramNames(
  platform: NodeJS.Platform,
  execFile: ExecFilePort,
  procFs: ProcFsPort = nodeProcFs
): Promise<string[] | null> {
  if (platform === 'win32') {
    const { stdout } = await execFile('tasklist', ['/FO', 'CSV', '/NH'])
    return parseTasklist(stdout).map((n) => n.toLowerCase())
  }
  if (platform !== 'linux') return null
  const pids = (await procFs.readdir('/proc')).filter((d) => /^\d+$/.test(d))
  const names: string[] = []
  await Promise.all(
    pids.map(async (pid) => {
      // A process can exit between readdir and these reads; it's simply skipped.
      const [comm, cmdline] = await Promise.all([
        procFs.readFile(`/proc/${pid}/comm`).catch(() => ''),
        procFs.readFile(`/proc/${pid}/cmdline`).catch(() => '')
      ])
      const name = comm.trim()
      if (name) names.push(name.toLowerCase())
      const argv0 = cmdline.split('\0')[0]
      if (argv0) names.push(baseName(argv0))
    })
  )
  return names
}

/** True when a running program name is one of the game's exes (a 15-char comm may be cut short). */
export function matchesGameExe(names: string[], exeNames: string[]): boolean {
  const wanted = exeNames.map(baseName)
  return names.some((n) =>
    wanted.some((w) => n === w || (n.length === COMM_MAX && w.length > COMM_MAX && w.startsWith(n)))
  )
}

/**
 * Whether one of the game's exes is running, for confirming a launch on any platform (unlike
 * isGameRunning). Null when HML can't tell: no exe names, or a platform it can't list.
 */
export async function isGameProcessRunning(
  platform: NodeJS.Platform,
  execFile: ExecFilePort,
  exeNames: string[],
  procFs?: ProcFsPort
): Promise<boolean | null> {
  if (exeNames.length === 0) return null
  const names = await runningProgramNames(platform, execFile, procFs)
  return names === null ? null : matchesGameExe(names, exeNames)
}

export const LAUNCH_POLL_MS = 1000
export const LAUNCH_TIMEOUT_MS = 120_000

/**
 * Polls `check` until the game is running or `timeoutMs` passes. A null answer means it can't
 * be detected at all ('unknown'); a failed check counts as not running yet.
 */
export async function waitForGameStart(opts: {
  check(): Promise<boolean | null>
  intervalMs?: number
  timeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<LaunchWatchResult> {
  const intervalMs = opts.intervalMs ?? LAUNCH_POLL_MS
  const timeoutMs = opts.timeoutMs ?? LAUNCH_TIMEOUT_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = now() + timeoutMs
  for (;;) {
    const running = await opts.check().catch(() => false)
    if (running === null) return 'unknown'
    if (running) return 'running'
    const left = deadline - now()
    if (left <= 0) return 'timeout'
    await sleep(Math.min(intervalMs, left))
  }
}
