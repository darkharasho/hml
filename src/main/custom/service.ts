import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  AddCustomGameInput,
  Catalog,
  CustomGameUpdate,
  GameDef,
  GameDetection,
  InstalledMod,
  LoaderChoice,
  Runner
} from '../../shared/types'
import type { GameSummary, HmlApi } from '../../shared/ipc'
import type { ServiceDeps } from '../services'
import type { NexusGames } from '../nexus/games'
import type { GhInstallOptions } from '../github/service'
import { deployedProfileId } from '../deploy/deploy'
import { getProfile } from '../profiles/profiles'
import { defaultRunner, findProtonVersions, wineAvailable } from '../launch/runners'
import { findAppInstall, listLibraries } from '../steam/steam'
import { listInstalledApps } from '../steam/installedApps'
import { loadSettings, resolveGameDir, updateSettings } from '../store/settings'
import { detectGameFolder } from './detect'
import { findLoaderMod, loaderMatches, loaderSpec, type LoaderSpec } from './loaders'
import { backupStamp, findManualLoader, moveToBackup } from './manualInstall'
import {
  customGameDef,
  folderLabel,
  STEAM_PREFIX,
  type CustomGames,
  type StoredCustomGame
} from './customGames'

export interface CustomGameContext {
  deps: ServiceDeps
  customGames: CustomGames
  getCatalog(): Promise<Catalog>
  getBaseCatalog(): Promise<Catalog>
  getSteamRoot(): Promise<string | null>
  summarize(def: GameDef): Promise<GameSummary>
  nexus: NexusGames
  requireGame(label: string): Promise<GameDef>
  serialize<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T>
  assertGameClosed(def: GameDef): Promise<void>
  /** The internal GitHub install (services.ts). */
  ghInstallWith(
    game: string,
    profileId: string,
    url: string,
    asset: string | undefined,
    opts: GhInstallOptions
  ): ReturnType<HmlApi['ghInstall']>
}

type CustomApi = Pick<
  HmlApi,
  | 'detectCustomGame'
  | 'pickCustomGameFolder'
  | 'addCustomGame'
  | 'updateCustomGame'
  | 'removeCustomGame'
  | 'listRunners'
  | 'installLoader'
  | 'getManualLoader'
  | 'removeManualLoader'
  | 'keepManualLoader'
>

const CHOICES: LoaderChoice[] = ['bepinex5', 'bepinex6-mono', 'bepinex6-il2cpp', 'none']

function checkChoice(choice: unknown): LoaderChoice {
  if (!CHOICES.includes(choice as LoaderChoice)) throw new Error('Unknown loader choice.')
  return choice as LoaderChoice
}

/** The BepInEx build a custom game is set to; null for catalog games and "No loader". */
export function customLoaderSpec(def: GameDef): LoaderSpec | null {
  return def.custom && def.loader === 'bepinex' ? loaderSpec(def.custom.loaderChoice) : null
}

/** True when a custom BepInEx game's profile has a loader other than the one the game is set to. */
export function loaderMismatch(def: GameDef, mods: InstalledMod[]): boolean {
  const spec = customLoaderSpec(def)
  const mod = spec ? findLoaderMod(mods) : undefined
  return spec !== null && mod !== undefined && !loaderMatches(mod, spec)
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export function createCustomGameServices(ctx: CustomGameContext): CustomApi & {
  steamCandidates(
    query: string,
    catalog: Catalog,
    steamRoot?: string | null
  ): Promise<GameSummary[]>
} {
  const { deps, customGames, nexus } = ctx
  const { paths } = deps

  async function listRunners(): Promise<Runner[]> {
    if (deps.platform === 'win32') return []
    const root = await ctx.getSteamRoot().catch(() => null)
    const libraries = root ? await listLibraries(root).catch(() => []) : []
    const protons = await findProtonVersions(root, libraries)
    const wine = await wineAvailable(deps.execFile)
    return [...protons, ...(wine ? [{ kind: 'wine' } as const] : [])]
  }

  async function steamFolder(appId: string): Promise<string | null> {
    const root = await ctx.getSteamRoot()
    const dir = root ? await findAppInstall(root, appId) : null
    return dir && (await isDir(dir)) ? dir : null
  }

  async function installedName(appId: string): Promise<string | null> {
    const root = await ctx.getSteamRoot()
    if (!root) return null
    return (await listInstalledApps(root)).find((a) => a.appId === appId)?.name ?? null
  }

  async function detectCustomGame(
    label: string
  ): Promise<{ displayName: string; folder: string; detection: GameDetection }> {
    const stored = await customGames.get(label)
    const appId = stored
      ? stored.steamAppId
      : label.startsWith(STEAM_PREFIX)
        ? label.slice(6)
        : null
    let folder: string | null = null
    if (stored?.source === 'folder' || (stored && !appId)) {
      folder = (await loadSettings(paths)).gamePathOverrides[label] ?? null
    } else if (appId && /^\d+$/.test(appId)) {
      folder = await steamFolder(appId)
    }
    if (!folder) {
      const name = stored?.displayName ?? appId ?? label
      throw new Error(`${name} isn't installed through Steam.`)
    }
    const displayName =
      stored?.displayName ?? (appId ? await installedName(appId) : null) ?? path.basename(folder)
    return { displayName, folder, detection: await detectGameFolder(folder) }
  }

  async function pickCustomGameFolder(): Promise<{
    folder: string
    displayName: string
    detection: GameDetection
  } | null> {
    const folder = await deps.dialog.pickFolder('Choose the game folder')
    if (!folder) return null
    return {
      folder,
      displayName: path.basename(folder),
      detection: await detectGameFolder(folder)
    }
  }

  async function addSteam(
    input: Extract<AddCustomGameInput, { source: 'steam' }>
  ): Promise<StoredCustomGame> {
    const appId = String(input.steamAppId)
    const given = input.displayName?.trim()
    const inCatalog = (await ctx.getBaseCatalog()).games.find((g) => g.steamAppId === appId)
    if (inCatalog) throw new Error(`${inCatalog.displayName} is already in HML's game list.`)
    const folder = /^\d+$/.test(appId) ? await steamFolder(appId) : null
    if (!folder) throw new Error(`${given || appId} isn't installed through Steam.`)
    const displayName = given || (await installedName(appId)) || appId
    const detection = await detectGameFolder(folder)
    if (input.loaderChoice !== 'none' && detection.nativeLinux) {
      throw new Error(
        `BepInEx needs the Windows version of ${displayName}. Force Proton in the game's Steam properties, then add it again.`
      )
    }
    return {
      label: `${STEAM_PREFIX}${appId}`,
      source: 'steam',
      displayName,
      steamAppId: appId,
      loaderChoice: input.loaderChoice,
      exeName: detection.exeName,
      dataFolderName: detection.dataFolderName
    }
  }

  async function addFolder(
    input: Extract<AddCustomGameInput, { source: 'folder' }>
  ): Promise<StoredCustomGame> {
    const folder = input.folder
    if (!path.isAbsolute(folder) || !(await isDir(folder))) {
      throw new Error(`${folder} is not a folder.`)
    }
    const stored = await customGames.list()
    const settings = await loadSettings(paths)
    const existing = stored.find(
      (g) => g.source === 'folder' && settings.gamePathOverrides[g.label] === folder
    )
    const label =
      existing?.label ??
      folderLabel(
        path.basename(folder),
        new Set([
          ...(await ctx.getBaseCatalog()).games.map((g) => g.label),
          ...stored.map((g) => g.label)
        ])
      )
    const detection = await detectGameFolder(folder)
    const name = input.displayName?.trim() || path.basename(folder)
    if (input.loaderChoice !== 'none' && detection.nativeLinux) {
      throw new Error(`BepInEx needs the Windows version of ${name}.`)
    }
    let runner: Runner | null = null
    if (deps.platform !== 'win32') {
      runner =
        input.runner !== undefined
          ? input.runner
          : defaultRunner(await listRunners(), await wineAvailable(deps.execFile))
    }
    return {
      label,
      source: 'folder',
      displayName: input.displayName?.trim() || path.basename(folder),
      steamAppId: null,
      loaderChoice: input.loaderChoice,
      exeName: detection.exeName,
      dataFolderName: detection.dataFolderName,
      runner
    }
  }

  async function addCustomGame(input: AddCustomGameInput): Promise<GameSummary> {
    checkChoice(input.loaderChoice)
    const game = input.source === 'steam' ? await addSteam(input) : await addFolder(input)
    if (input.source === 'folder') {
      await updateSettings(paths, (s) => ({
        ...s,
        gamePathOverrides: { ...s.gamePathOverrides, [game.label]: input.folder }
      }))
    }
    await customGames.put(game)
    return ctx.summarize(customGameDef(game))
  }

  async function updateCustomGame(label: string, patch: CustomGameUpdate): Promise<GameSummary> {
    const game = await customGames.get(label)
    if (!game) throw new Error(`Unknown game: ${label}`)
    const next: StoredCustomGame = { ...game }
    if (patch.loaderChoice !== undefined) {
      next.loaderChoice = checkChoice(patch.loaderChoice)
      if (next.loaderChoice !== 'none') {
        const { detection } = await detectCustomGame(label)
        if (detection.nativeLinux) {
          throw new Error(`BepInEx needs the Windows version of ${game.displayName}.`)
        }
      }
    }
    if (patch.displayName !== undefined) {
      const name = patch.displayName.trim()
      if (!name) throw new Error('The game needs a name.')
      next.displayName = name
    }
    if (patch.runner !== undefined) next.runner = patch.runner
    await customGames.put(next)
    return ctx.summarize(customGameDef(next))
  }

  async function removeCustomGame(label: string): Promise<void> {
    const game = await customGames.get(label)
    if (!game) throw new Error(`Unknown game: ${label}`)
    if ((await deployedProfileId(paths, customGameDef(game))) !== null) {
      throw new Error('Remove the deployed mods from the game folder first.')
    }
    await customGames.remove(label)
    await updateSettings(paths, (s) => {
      const gamePathOverrides = { ...s.gamePathOverrides }
      const nexusDomainOverrides = { ...s.nexusDomainOverrides }
      const lastProfile = { ...s.lastProfile }
      delete gamePathOverrides[label]
      delete nexusDomainOverrides[label]
      delete lastProfile[label]
      return {
        ...s,
        gamePathOverrides,
        nexusDomainOverrides,
        lastProfile,
        manualLoaderKept: s.manualLoaderKept.filter((l) => l !== label),
        lastGame: s.lastGame === label ? null : s.lastGame
      }
    })
    await nexus.forgetDomain(label)
  }

  async function installLoader(game: string, profileId: string): Promise<InstalledMod> {
    const def = await ctx.requireGame(game)
    const spec = customLoaderSpec(def)
    if (!spec) throw new Error(`${def.displayName} doesn't use BepInEx.`)
    await ctx.assertGameClosed(def)
    const current = findLoaderMod((await getProfile(paths, game, profileId)).mods)
    if (current && loaderMatches(current, spec)) return current
    const result = await ctx.ghInstallWith(
      game,
      profileId,
      `https://github.com/${spec.owner}/${spec.repo}`,
      undefined,
      {
        track: spec.track,
        assetPattern: spec.assetPattern
      }
    )
    if (result.kind !== 'installed') throw new Error(`Couldn't pick a ${spec.label} file.`)
    return result.mod
  }

  /** A BepInEx game's folder, or null when it can't be found. */
  async function bepinexGameDir(def: GameDef): Promise<string | null> {
    if (def.loader !== 'bepinex') return null
    const root = await ctx.getSteamRoot().catch(() => null)
    return resolveGameDir(def, await loadSettings(paths), root).catch(() => null)
  }

  async function getManualLoader(
    game: string
  ): Promise<{ entries: string[]; kept: boolean } | null> {
    const def = await ctx.requireGame(game)
    const gameDir = await bepinexGameDir(def)
    const entries = gameDir ? await findManualLoader(gameDir) : null
    if (!entries) return null
    return { entries, kept: (await loadSettings(paths)).manualLoaderKept.includes(def.label) }
  }

  async function removeManualLoader(game: string): Promise<string> {
    const def = await ctx.requireGame(game)
    await ctx.assertGameClosed(def)
    const gameDir = await bepinexGameDir(def)
    const entries = gameDir ? await findManualLoader(gameDir) : null
    if (!gameDir || !entries)
      throw new Error('There is no manual BepInEx install in the game folder.')
    const now = deps.now ?? Date.now
    const backup = await moveToBackup(
      gameDir,
      entries,
      paths.loaderBackup(def.label, backupStamp(new Date(now())))
    )
    await updateSettings(paths, (s) => ({
      ...s,
      manualLoaderKept: s.manualLoaderKept.filter((l) => l !== def.label)
    }))
    return backup
  }

  async function keepManualLoader(game: string): Promise<void> {
    const def = await ctx.requireGame(game)
    await updateSettings(paths, (s) =>
      s.manualLoaderKept.includes(def.label)
        ? s
        : { ...s, manualLoaderKept: [...s.manualLoaderKept, def.label] }
    )
  }

  async function steamCandidates(
    query: string,
    catalog: Catalog,
    knownRoot?: string | null
  ): Promise<GameSummary[]> {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    try {
      const root = knownRoot !== undefined ? knownRoot : await ctx.getSteamRoot()
      if (!root) return []
      const known = new Set(catalog.games.map((g) => g.steamAppId).filter((id) => id !== null))
      const labels = new Set(catalog.games.map((g) => g.label))
      return (await listInstalledApps(root))
        .filter(
          (a) =>
            a.name.toLowerCase().includes(q) &&
            !known.has(a.appId) &&
            !labels.has(`${STEAM_PREFIX}${a.appId}`)
        )
        .map((a) => ({
          label: `${STEAM_PREFIX}${a.appId}`,
          displayName: a.name,
          steamAppId: a.appId,
          steamFolderName: '',
          exeNames: [],
          dataFolderName: '',
          installDir: a.installDir,
          loader: 'deploy',
          installRules: [],
          packageIndex: null,
          searchStrings: [],
          iconUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${a.appId}/library_600x900.jpg`,
          supported: true,
          loaderPackageIds: [],
          custom: { source: 'steam' as const, loaderChoice: 'none' as const, added: false }
        }))
    } catch {
      return []
    }
  }

  return {
    detectCustomGame,
    pickCustomGameFolder,
    addCustomGame,
    updateCustomGame,
    removeCustomGame,
    listRunners,
    installLoader,
    getManualLoader,
    removeManualLoader,
    keepManualLoader,
    steamCandidates
  }
}
