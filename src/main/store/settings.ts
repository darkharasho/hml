import { promises as fs } from 'node:fs'
import type { AppPaths } from './paths'
import { readJson, writeJsonAtomic } from './json'
import { findAppInstall } from '../steam/steam'
import type { GameDef, Settings } from '../../shared/types'

export function defaultSettings(): Settings {
  return {
    gamePathOverrides: {},
    steamRootOverride: null,
    lastGame: null,
    lastProfile: {},
    nexusDomainOverrides: {}
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stringRecord(v: unknown): Record<string, string> | null {
  if (!isPlainObject(v)) return null
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val
  }
  return out
}

/** Coerce untrusted data to the Settings shape: unknown keys and wrongly typed values are dropped. */
export function normalizeSettings(stored: unknown): Settings {
  const defaults = defaultSettings()
  if (!isPlainObject(stored)) return defaults
  return {
    gamePathOverrides: stringRecord(stored.gamePathOverrides) ?? defaults.gamePathOverrides,
    steamRootOverride:
      typeof stored.steamRootOverride === 'string'
        ? stored.steamRootOverride
        : defaults.steamRootOverride,
    lastGame: typeof stored.lastGame === 'string' ? stored.lastGame : defaults.lastGame,
    lastProfile: stringRecord(stored.lastProfile) ?? defaults.lastProfile,
    nexusDomainOverrides: stringRecord(stored.nexusDomainOverrides) ?? defaults.nexusDomainOverrides
  }
}

export async function loadSettings(paths: AppPaths): Promise<Settings> {
  return normalizeSettings(await readJson<unknown>(paths.settings))
}

export async function saveSettings(paths: AppPaths, s: Settings): Promise<void> {
  await writeJsonAtomic(paths.settings, normalizeSettings(s))
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve where a game is installed: a user override (if the directory exists),
 * otherwise Steam library detection via the game's app id.
 */
export async function resolveGameDir(
  game: GameDef,
  settings: Settings,
  steamRoot: string | null
): Promise<string | null> {
  const override = settings.gamePathOverrides[game.label]
  if (override && (await isDirectory(override))) return override
  if (!game.steamAppId || !steamRoot) return null
  return findAppInstall(steamRoot, game.steamAppId)
}
