import { load as parseYaml } from 'js-yaml'
import type { HmlExport } from '../../shared/types'
import { readZipEntries, TOO_LARGE } from '../install/zipEntries'
import { IMPORT_TOO_BIG, isSafeConfigPath, MAX_HML_BYTES } from './hmlFile'

/** r2modman profile codes are Thunderstore legacy profile keys, which are UUIDs. */
const R2_CODE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const R2_PREFIX = '#r2modman'
const R2_API = 'https://thunderstore.io/api/experimental/legacyprofile/get/'
const TIMEOUT_MS = 30_000

const UNAVAILABLE = "Couldn't reach Thunderstore to open that r2modman code. Try again later."
const NOT_FOUND = 'No r2modman profile has that code. It may have expired.'
const DAMAGED = 'This r2modman profile is damaged or in a format HML doesn’t know.'
const NOT_PROFILE = "This isn't an r2modman or HML profile file."

// r2modman puts BepInEx/config in the zip as `config/`; HML keeps the BepInEx/ path. Other
// settings, such as MelonLoader's UserData, keep their profile path in both.
const R2_CONFIG = 'config/'
const HML_CONFIG = 'BepInEx/config/'
const FULL_NAME_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/

/** Whether a typed code is an r2modman one (a UUID) rather than an HML code. */
export function isR2modmanCode(input: string): boolean {
  return R2_CODE_RE.test(input.trim())
}

/** Downloads an r2modman profile code from Thunderstore and returns the .r2z zip bytes. */
export async function downloadR2modman(
  o: { fetch: typeof fetch; timeoutMs?: number },
  code: string
): Promise<Uint8Array> {
  const key = code.trim().toLowerCase()
  if (!isR2modmanCode(key)) throw new Error("That isn't a valid r2modman code.")
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? TIMEOUT_MS)
  let text: string
  try {
    const res = await o.fetch(`${R2_API}${key}/`, {
      headers: { 'user-agent': 'HML' },
      signal: ctl.signal
    })
    if (res.status === 404) throw new Error(NOT_FOUND)
    if (!res.ok) throw new Error(UNAVAILABLE)
    text = await res.text()
  } catch (e) {
    if (e instanceof Error && e.message === NOT_FOUND) throw e
    throw new Error(UNAVAILABLE, { cause: e })
  } finally {
    clearTimeout(timer)
  }
  if (!text.startsWith(R2_PREFIX)) throw new Error(DAMAGED)
  const b64 = text.slice(R2_PREFIX.length).replace(/\s+/g, '')
  // Base64 is 4 characters per 3 bytes; checked before decoding so a huge reply is never held twice.
  if ((b64.length / 4) * 3 > MAX_HML_BYTES) throw new Error(IMPORT_TOO_BIG)
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/** A version written as `{major, minor, patch}` (r2modman) or as a string. */
function versionOf(v: unknown): string | null {
  if (typeof v === 'string') return /^\d+\.\d+\.\d+$/.test(v) ? v : null
  if (!v || typeof v !== 'object') return null
  const { major, minor, patch } = v as Record<string, unknown>
  const ok = [major, minor, patch].every((n) => Number.isInteger(n) && (n as number) >= 0)
  return ok ? `${major}.${minor}.${patch}` : null
}

function isSafeRelative(rel: string): boolean {
  if (!rel || rel.includes('\\') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false
  return !rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
}

/**
 * Reads an r2modman export (.r2z) as an HML export for `game`. r2modman profiles don't name their
 * game, so the caller says which one. Only BepInEx/config and UserData files are kept, as in HML's
 * own files.
 */
export function readR2modman(
  data: Uint8Array,
  game: string
): { export: HmlExport; configs: Map<string, Uint8Array> } {
  let zip
  try {
    zip = readZipEntries(data, { maxBytes: MAX_HML_BYTES })
  } catch (e) {
    if (e instanceof Error && e.message === TOO_LARGE) throw new Error(IMPORT_TOO_BIG, { cause: e })
    throw new Error(NOT_PROFILE, { cause: e })
  }
  if (!zip.names.includes('export.r2x')) throw new Error(NOT_PROFILE)
  let doc: unknown
  try {
    doc = parseYaml(new TextDecoder().decode(zip.read('export.r2x')))
  } catch (e) {
    throw new Error(DAMAGED, { cause: e })
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as { mods?: unknown }).mods)) {
    throw new Error(DAMAGED)
  }
  const { profileName, mods } = doc as { profileName?: unknown; mods: unknown[] }
  const out: HmlExport['mods'] = []
  for (const m of mods) {
    if (!m || typeof m !== 'object') throw new Error(DAMAGED)
    const { name, version, enabled } = m as Record<string, unknown>
    const v = versionOf(version)
    if (typeof name !== 'string' || !FULL_NAME_RE.test(name) || !v) throw new Error(DAMAGED)
    out.push({
      source: { kind: 'thunderstore', fullName: name },
      version: v,
      enabled: enabled !== false
    })
  }
  const configs = new Map<string, Uint8Array>()
  for (const entry of zip.names) {
    const rel = entry.startsWith(R2_CONFIG)
      ? entry.slice(R2_CONFIG.length)
      : entry.startsWith(HML_CONFIG)
        ? entry.slice(HML_CONFIG.length)
        : null
    if (rel !== null) {
      if (isSafeRelative(rel)) configs.set(`${HML_CONFIG}${rel}`, zip.read(entry))
    } else if (isSafeConfigPath(entry)) configs.set(entry, zip.read(entry))
  }
  return {
    export: {
      formatVersion: 1,
      game,
      profileName:
        typeof profileName === 'string' && profileName.trim()
          ? profileName.trim()
          : 'r2modman profile',
      mods: out
    },
    configs
  }
}
