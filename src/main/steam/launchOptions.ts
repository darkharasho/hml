import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'
import { parseVdf, tokenizeVdf, vdfGet, type TokenWithValue, type VdfObject } from './vdf'

/** The DLL override Proton needs to load BepInEx's doorstop `winhttp.dll`. */
const OVERRIDE = 'winhttp=n,b'
const ENV_PREFIX = `WINEDLLOVERRIDES="${OVERRIDE}"`
/** Steam launch options for a game that has none. */
export const PROTON_LAUNCH_OPTIONS = `${ENV_PREFIX} %command%`

/** Keeps every DLL override but winhttp, then adds `winhttp=n,b`. */
function mergeOverrides(raw: string): string {
  const kept = raw
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const eq = entry.indexOf('=')
      const dlls = (eq < 0 ? entry : entry.slice(0, eq))
        .split(',')
        .map((d) => d.trim())
        .filter((d) => d && d.toLowerCase() !== 'winhttp')
      if (dlls.length === 0) return []
      return [eq < 0 ? dlls.join(',') : `${dlls.join(',')}=${entry.slice(eq + 1)}`]
    })
  return [...kept, OVERRIDE].join(';')
}

/**
 * The user's Steam launch options with `WINEDLLOVERRIDES="winhttp=n,b"` added, keeping
 * everything else. Options that already have `winhttp=n,b` come back unchanged.
 */
export function mergeProtonLaunchOptions(existing: string): string {
  if (existing.includes(OVERRIDE)) return existing
  const s = existing.trim()
  if (!s) return PROTON_LAUNCH_OPTIONS
  const at = s.indexOf('%command%')
  // Without %command%, Steam passes the options to the game as arguments.
  if (at < 0) return `${PROTON_LAUNCH_OPTIONS} ${s}`
  const env = s.slice(0, at)
  const re = /(^|\s)(WINEDLLOVERRIDES=)("([^"]*)"|'([^']*)'|(\S*))/g
  let last: RegExpExecArray | null = null
  for (let m = re.exec(env); m; m = re.exec(env)) last = m
  if (!last) return `${ENV_PREFIX} ${s}`
  const valueStart = last.index + last[1].length + last[2].length
  const valueEnd = last.index + last[0].length
  const quote = last[5] !== undefined ? "'" : '"'
  const raw = last[4] ?? last[5] ?? last[6] ?? ''
  return s.slice(0, valueStart) + quote + mergeOverrides(raw) + quote + s.slice(valueEnd)
}

interface Pair {
  key: TokenWithValue
  value: TokenWithValue | Block
}
interface Block {
  open: TokenWithValue
  close: TokenWithValue
  pairs: Pair[]
}

const isBlock = (v: TokenWithValue | Block): v is Block => 'pairs' in v

/** Key/value pairs with their token spans; the text must already have parsed. */
function buildTree(tokens: TokenWithValue[]): Pair[] {
  let pos = 0
  function body(): Pair[] {
    const pairs: Pair[] = []
    while (pos < tokens.length && tokens[pos].type !== 'close') {
      const key = tokens[pos++]
      const tok = tokens[pos++]
      if (tok.type === 'open') {
        const pairsInside = body()
        pairs.push({ key, value: { open: tok, pairs: pairsInside, close: tokens[pos++] } })
      } else {
        pairs.push({ key, value: tok })
      }
    }
    return pairs
  }
  return body()
}

/** The last pair with this key (case-insensitive), as vdfGet reads it. */
function findPair(pairs: Pair[], key: string): Pair | undefined {
  const wanted = key.toLowerCase()
  return pairs.findLast((p) => p.key.value.toLowerCase() === wanted)
}

function escapeVdf(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
}

/** Text for `segments` nested blocks ending in the LaunchOptions pair. */
function renderLines(
  segments: string[],
  value: string,
  indent: string,
  unit: string,
  nl: string
): string {
  if (segments.length === 0) return `${indent}"LaunchOptions"\t\t"${escapeVdf(value)}"${nl}`
  const [head, ...rest] = segments
  return (
    `${indent}"${escapeVdf(head)}"${nl}${indent}{${nl}` +
    renderLines(rest, value, indent + unit, unit, nl) +
    `${indent}}${nl}`
  )
}

function renderInline(segments: string[], value: string): string {
  if (segments.length === 0) return `"LaunchOptions" "${escapeVdf(value)}"`
  const [head, ...rest] = segments
  return `"${escapeVdf(head)}" { ${renderInline(rest, value)} }`
}

/** Whitespace before `offset` on its line, or null when other text precedes it there. */
function lineIndent(text: string, offset: number): { start: number; indent: string } | null {
  const start = text.lastIndexOf('\n', offset - 1) + 1
  const indent = text.slice(start, offset)
  return /^[ \t]*$/.test(indent) ? { start, indent } : null
}

/** Adds `segments` blocks ending in LaunchOptions as the last entry of `block`. */
function insertInto(text: string, block: Block, segments: string[], value: string): string {
  const close = lineIndent(text, block.close.start)
  if (close) {
    const first = block.pairs[0] && lineIndent(text, block.pairs[0].key.start)
    const child =
      first && first.indent.length > close.indent.length && first.indent.startsWith(close.indent)
        ? first.indent
        : close.indent + '\t'
    const unit = child.slice(close.indent.length)
    const nl = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = renderLines(segments, value, child, unit, nl)
    return text.slice(0, close.start) + lines + text.slice(close.start)
  }
  const at = block.close.start
  const pad = /\s/.test(text[at - 1] ?? '') ? '' : ' '
  return text.slice(0, at) + pad + renderInline(segments, value) + ' ' + text.slice(at)
}

/**
 * Sets `UserLocalConfigStore/Software/Valve/Steam/apps/<appId>/LaunchOptions` in the text of a
 * localconfig.vdf, creating missing blocks. Everything else stays byte-identical. Throws when
 * the text doesn't parse or has no UserLocalConfigStore block.
 */
export function setVdfLaunchOptions(text: string, appId: string, value: string): string {
  if (!/^\d+$/.test(appId)) throw new Error(`Invalid Steam app id: ${appId}`)
  parseVdf(text)
  const store = findPair(buildTree(tokenizeVdf(text)), 'UserLocalConfigStore')
  if (!store || !isBlock(store.value))
    throw new Error('localconfig.vdf has no UserLocalConfigStore')
  const segments = ['Software', 'Valve', 'Steam', 'apps', appId]
  let block = store.value
  while (segments.length > 0) {
    const next = findPair(block.pairs, segments[0])
    if (!next || !isBlock(next.value)) break
    block = next.value
    segments.shift()
  }
  if (segments.length === 0) {
    const existing = findPair(block.pairs, 'LaunchOptions')
    if (existing && !isBlock(existing.value)) {
      const { start, end } = existing.value
      return text.slice(0, start) + `"${escapeVdf(value)}"` + text.slice(end)
    }
  }
  return insertInto(text, block, segments, value)
}

const APP_PATH = ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps']

/** SteamID64 of an individual account minus this is its account id (the userdata folder). */
const STEAMID64_BASE = 76561197960265728n

/** The account id (userdata folder name) of the most recent user in loginusers.vdf, or null. */
export function mostRecentAccountId(loginusers: string): string | null {
  let users: ReturnType<typeof vdfGet>
  try {
    users = vdfGet(parseVdf(loginusers), 'users')
  } catch {
    return null
  }
  if (!users || typeof users !== 'object') return null
  let best: { id: bigint; recent: boolean; time: number } | null = null
  for (const [key, entry] of Object.entries(users)) {
    if (!/^\d+$/.test(key) || typeof entry !== 'object') continue
    const id = BigInt(key) - STEAMID64_BASE
    if (id <= 0n) continue
    const recent = vdfGet(entry, 'MostRecent') === '1'
    const time = Number(vdfGet(entry, 'Timestamp')) || 0
    if (!best || (recent && !best.recent) || (recent === best.recent && time > best.time)) {
      best = { id, recent, time }
    }
  }
  return best ? best.id.toString() : null
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

function parseOrNull(text: string): VdfObject | null {
  try {
    return parseVdf(text)
  } catch {
    return null
  }
}

/**
 * The localconfig.vdf files to write: every user's that has the app block, or else the most
 * recent user's (from loginusers.vdf), or else the only user's.
 */
async function targetFiles(root: string, appId: string): Promise<string[]> {
  let users: string[]
  try {
    users = (await fs.readdir(path.join(root, 'userdata'))).sort()
  } catch {
    users = []
  }
  const configs: { user: string; file: string }[] = []
  const withApp: string[] = []
  for (const user of users) {
    const file = path.join(root, 'userdata', user, 'config', 'localconfig.vdf')
    const text = await readText(file)
    const parsed = text === null ? null : parseOrNull(text)
    if (!parsed) continue
    configs.push({ user, file })
    if (typeof vdfGet(parsed, ...APP_PATH, appId) === 'object') withApp.push(file)
  }
  if (withApp.length > 0) return withApp
  const loginusers = await readText(path.join(root, 'config', 'loginusers.vdf'))
  const recent = loginusers === null ? null : mostRecentAccountId(loginusers)
  const match = configs.find((c) => c.user === recent)
  if (match) return [match.file]
  if (configs.length === 1) return [configs[0].file]
  throw new Error(
    "HML couldn't tell which Steam account to set the launch options for. Add them in Steam instead."
  )
}

/** Replaces `file` through a temporary file in the same folder, keeping its permissions. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.hml-tmp`
  const { mode } = await fs.stat(file)
  await fs.rm(tmp, { force: true })
  await fs.writeFile(tmp, text, { mode: mode & 0o777 })
  try {
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}

/** Copies `file` to `<file>.hml-backup` unless a backup is already there. */
async function backupOnce(file: string): Promise<void> {
  try {
    await fs.copyFile(file, `${file}.hml-backup`, fsConstants.COPYFILE_EXCL)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
}

/**
 * Adds `WINEDLLOVERRIDES="winhttp=n,b"` to the game's Steam launch options in the user's
 * localconfig.vdf (see targetFiles), merged with what is there. Steam must not be running: it
 * rewrites the file when it exits. Resolves with the files changed (none when already set).
 */
export async function writeProtonLaunchOptions(root: string, appId: string): Promise<string[]> {
  if (!/^\d+$/.test(appId)) throw new Error(`Invalid Steam app id: ${appId}`)
  const changed: string[] = []
  for (const file of await targetFiles(root, appId)) {
    const text = await fs.readFile(file, 'utf8')
    const current = vdfGet(parseVdf(text), ...APP_PATH, appId, 'LaunchOptions')
    const before = typeof current === 'string' ? current : ''
    const merged = mergeProtonLaunchOptions(before)
    if (merged === before) continue
    const next = setVdfLaunchOptions(text, appId, merged)
    if (vdfGet(parseVdf(next), ...APP_PATH, appId, 'LaunchOptions') !== merged) {
      throw new Error(`Could not update ${file}: the edit did not read back.`)
    }
    await backupOnce(file)
    await writeAtomic(file, next)
    changed.push(file)
  }
  return changed
}
