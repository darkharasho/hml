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
    nexusDomainOverrides: {},
    manualLoaderKept: [],
    gameColors: true,
    updateNotifications: true
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
    nexusDomainOverrides:
      stringRecord(stored.nexusDomainOverrides) ?? defaults.nexusDomainOverrides,
    manualLoaderKept: Array.isArray(stored.manualLoaderKept)
      ? stored.manualLoaderKept.filter((x): x is string => typeof x === 'string')
      : defaults.manualLoaderKept,
    gameColors: typeof stored.gameColors === 'boolean' ? stored.gameColors : defaults.gameColors,
    updateNotifications:
      typeof stored.updateNotifications === 'boolean'
        ? stored.updateNotifications
        : defaults.updateNotifications
  }
}

export async function loadSettings(paths: AppPaths): Promise<Settings> {
  return normalizeSettings(await readJson<unknown>(paths.settings))
}

export async function saveSettings(paths: AppPaths, s: Settings): Promise<void> {
  await writeJsonAtomic(paths.settings, normalizeSettings(s))
}

let settingsTail: Promise<unknown> = Promise.resolve()

/**
 * Read-modify-write of the settings file, one at a time, so concurrent changes to different
 * keys all land. `fn` gets the current settings and returns the new ones; it must not wait on
 * other queued work or the network.
 */
export function updateSettings(
  paths: AppPaths,
  fn: (current: Settings) => Settings | Promise<Settings>
): Promise<void> {
  const run = settingsTail.then(async () => {
    await saveSettings(paths, await fn(await loadSettings(paths)))
  })
  settingsTail = run.catch(() => undefined)
  return run
}

/** True when p exists and is a folder. */
export async function isDirectory(p: string): Promise<boolean> {
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
