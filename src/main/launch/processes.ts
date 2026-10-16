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
