import path from 'node:path'
import type { AppPaths } from '../store/paths'
import { readJson, writeJsonAtomic } from '../store/json'
import type { GameDef, InstallRule, LoaderChoice, Runner } from '../../shared/types'
import { customArtUrl } from '../art/protocol'
import { steamCdnCover } from '../art/steamArt'
import { isCoverRef, type CoverRef } from './cover'

export const STEAM_PREFIX = 'steam-'
export const CUSTOM_PREFIX = 'custom-'

export interface StoredCustomGame {
  label: string
  source: 'steam' | 'folder'
  displayName: string
  steamAppId: string | null
  loaderChoice: LoaderChoice
  exeName: string | null
  dataFolderName: string
  runner?: Runner | null
  /** The cover image the user chose, in the game's data dir. */
  cover?: CoverRef | null
}

const rule = (
  route: string,
  defaultFileExtensions: string[],
  trackingMethod: string,
  isDefaultLocation = false
): InstallRule => ({
  route,
  defaultFileExtensions,
  trackingMethod,
  subRoutes: [],
  isDefaultLocation
})

/** The standard BepInEx rule set, identical to the catalog's for `repo`. */
export const BEPINEX_INSTALL_RULES: InstallRule[] = [
  rule('BepInEx/plugins', ['.dll'], 'subdir', true),
  rule('BepInEx/core', [], 'subdir'),
  rule('BepInEx/patchers', [], 'subdir'),
  rule('BepInEx/monomod', ['.mm.dll'], 'subdir'),
  rule('BepInEx/config', [], 'none')
]

export function folderLabel(folderName: string, taken: Set<string>): string {
  const slug =
    folderName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || 'game'
  const base = `${CUSTOM_PREFIX}${slug}`
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }
}

/**
 * The catalog game an installed Steam app is: the one with its app id or, since the catalog
 * leaves many games' ids out (RV There Yet has only its folder name), its install folder.
 */
export function catalogTwin(
  games: GameDef[],
  app: { appId: string; installDir: string }
): GameDef | undefined {
  const folder = path.basename(app.installDir).toLowerCase()
  return games.find(
    (g) =>
      !g.custom &&
      (g.steamAppId === app.appId ||
        (!g.steamAppId && !!g.steamFolderName && g.steamFolderName.toLowerCase() === folder))
  )
}

const looseName = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * The games with the app id of their installed Steam app filled in, so HML can find, launch and
 * show Steam art for them: catalog games the catalog lists without one by their install folder,
 * and Nexus-only games (which know only a name) by a Steam app with the same name. A name two
 * installed apps share is left alone.
 */
export function withInstalledSteamIds(
  games: GameDef[],
  apps: { appId: string; installDir: string; name?: string }[]
): GameDef[] {
  if (apps.length === 0) return games
  const byFolder = new Map(apps.map((a) => [path.basename(a.installDir).toLowerCase(), a.appId]))
  const byName = new Map<string, string | null>()
  for (const a of apps) {
    const n = a.name ? looseName(a.name) : ''
    if (n) byName.set(n, byName.has(n) ? null : a.appId)
  }
  return games.map((g) => {
    if (g.custom || g.steamAppId) return g
    if (g.label.startsWith('nexus-')) {
      const id = byName.get(looseName(g.displayName))
      return id ? { ...g, steamAppId: id } : g
    }
    if (!g.steamFolderName) return g
    const id = byFolder.get(g.steamFolderName.toLowerCase())
    return id ? { ...g, steamAppId: id } : g
  })
}

export function customGameDef(g: StoredCustomGame): GameDef {
  const none = g.loaderChoice === 'none'
  return {
    label: g.label,
    displayName: g.displayName,
    steamAppId: g.steamAppId,
    steamFolderName: '',
    exeNames: g.exeName ? [g.exeName] : [],
    dataFolderName: g.dataFolderName,
    loader: none ? 'deploy' : 'bepinex',
    installRules: none ? [] : BEPINEX_INSTALL_RULES,
    packageIndex: null,
    searchStrings: [g.displayName],
    // A chosen image comes first; services.ts adds the better Steam art after summarizing.
    iconUrl: g.cover
      ? customArtUrl(g.label, g.cover.at)
      : g.steamAppId
        ? steamCdnCover(g.steamAppId)
        : null,
    ...(g.cover && g.steamAppId ? { iconFallbacks: [steamCdnCover(g.steamAppId)] } : {}),
    supported: true,
    custom: {
      source: g.source,
      loaderChoice: g.loaderChoice,
      runner: g.runner ?? null,
      added: true,
      image: !!g.cover
    }
  }
}

export interface CustomGames {
  list(): Promise<StoredCustomGame[]>
  get(label: string): Promise<StoredCustomGame | null>
  /** Adds or replaces by label. */
  put(g: StoredCustomGame): Promise<void>
  remove(label: string): Promise<void>
}

const CHOICES = new Set<string>(['bepinex5', 'bepinex6-mono', 'bepinex6-il2cpp', 'none'])

function valid(g: unknown): g is StoredCustomGame {
  if (!g || typeof g !== 'object') return false
  const o = g as Record<string, unknown>
  return (
    typeof o.label === 'string' &&
    (o.label.startsWith(STEAM_PREFIX) || o.label.startsWith(CUSTOM_PREFIX)) &&
    (o.source === 'steam' || o.source === 'folder') &&
    typeof o.displayName === 'string' &&
    (o.steamAppId === null || typeof o.steamAppId === 'string') &&
    typeof o.loaderChoice === 'string' &&
    CHOICES.has(o.loaderChoice) &&
    (o.exeName === null || typeof o.exeName === 'string') &&
    typeof o.dataFolderName === 'string'
  )
}

export function createCustomGames(paths: AppPaths): CustomGames {
  let tail: Promise<unknown> = Promise.resolve()
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn)
    tail = run.catch(() => undefined)
    return run
  }
  const read = async (): Promise<StoredCustomGame[]> => {
    const stored = await readJson<unknown>(paths.customGames)
    if (!Array.isArray(stored)) return []
    // A bad cover record loses the cover, not the game.
    return stored
      .filter(valid)
      .map((g) => (g.cover == null || isCoverRef(g.cover) ? g : { ...g, cover: undefined }))
  }
  return {
    list: () => locked(read),
    get: (label) => locked(async () => (await read()).find((g) => g.label === label) ?? null),
    put: (g) =>
      locked(async () => {
        const list = (await read()).filter((x) => x.label !== g.label)
        list.push(g)
        await writeJsonAtomic(paths.customGames, list)
      }),
    remove: (label) =>
      locked(async () => {
        const list = await read()
        await writeJsonAtomic(
          paths.customGames,
          list.filter((x) => x.label !== label)
        )
      })
  }
}
