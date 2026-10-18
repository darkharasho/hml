import type { InstalledMod } from './types'

/** BepInEx's log levels, most severe first. UE4SS lines have no level and count as Info. */
export type LogLevel = 'fatal' | 'error' | 'warning' | 'message' | 'info' | 'debug'

export interface LogEntry {
  /** Index of the entry's first line in the log, unique and increasing. */
  line: number
  level: LogLevel
  /** The logger: a plugin name, `BepInEx`, `Unity Log`, ...; empty when the line has none. */
  source: string
  /** The message, with the stack trace or other lines that follow it. */
  text: string
}

// [Error  :   Unity Log] message
const BEPINEX = /^\[(Fatal|Error|Warning|Message|Info|Debug)\s*:\s*([^\]]*?)\s*\]\s?(.*)$/i
// UE4SS: [12:34:56.789] message, or [12:34:56] [Lua] message
const UE4SS = /^\[\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\]\s?(.*)$/

function ue4ssLevel(text: string): LogLevel {
  if (/\b(error|exception|failed)\b/i.test(text)) return 'error'
  if (/\bwarn(ing)?\b/i.test(text)) return 'warning'
  return 'info'
}

/**
 * Splits a log into entries. A line that doesn't start an entry (a stack trace, a wrapped
 * message) belongs to the entry above it; lines before the first entry form one Info entry.
 * `firstLine` numbers the lines when the text is a later part of the file.
 */
export function parseLog(text: string, firstLine = 0): LogEntry[] {
  const out: LogEntry[] = []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  lines.forEach((raw, i) => {
    const line = firstLine + i
    const b = BEPINEX.exec(raw)
    if (b) {
      out.push({ line, level: b[1].toLowerCase() as LogLevel, source: b[2], text: b[3] })
      return
    }
    const u = UE4SS.exec(raw)
    if (u) {
      out.push({ line, level: ue4ssLevel(u[1]), source: '', text: u[1] })
      return
    }
    const last = out[out.length - 1]
    if (last) last.text += `\n${raw}`
    else out.push({ line, level: 'info', source: '', text: raw })
  })
  return out
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * The installed mod an entry came from: the one its logger is named after, else for a Unity or
 * BepInEx error the one whose name its stack trace mentions. Names under 4 letters never match
 * by trace, so short names don't claim every error.
 */
export function modForEntry(entry: LogEntry, mods: InstalledMod[]): InstalledMod | null {
  const source = squash(entry.source)
  if (source) {
    const named = mods.find((m) => squash(m.name) === source)
    if (named) return named
  }
  if (entry.level !== 'error' && entry.level !== 'fatal' && entry.level !== 'warning') return null
  const text = squash(entry.text)
  let best: InstalledMod | null = null
  for (const m of mods) {
    const name = squash(m.name)
    if (
      name.length >= 4 &&
      text.includes(name) &&
      (!best || name.length > squash(best.name).length)
    )
      best = m
  }
  return best
}

export const isProblem = (level: LogLevel): boolean =>
  level === 'fatal' || level === 'error' || level === 'warning'
