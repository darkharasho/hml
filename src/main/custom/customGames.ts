import type { AppPaths } from '../store/paths'
import { readJson, writeJsonAtomic } from '../store/json'
import type { GameDef, InstallRule, LoaderChoice, Runner } from '../../shared/types'

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
    iconUrl: g.steamAppId
      ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.steamAppId}/library_600x900.jpg`
      : null,
    supported: true,
    custom: {
      source: g.source,
      loaderChoice: g.loaderChoice,
      runner: g.runner ?? null,
      added: true
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
    return Array.isArray(stored) ? stored.filter(valid) : []
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
