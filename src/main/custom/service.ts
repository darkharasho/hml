import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  AddCustomGameInput,
  Catalog,
  CustomGameUpdate,
  GameDef,
  GameDetection,
  LoaderChoice,
  Runner
} from '../../shared/types'
import type { GameSummary, HmlApi } from '../../shared/ipc'
import type { ServiceDeps } from '../services'
import type { NexusGames } from '../nexus/games'
import { deployedProfileId } from '../deploy/deploy'
import { defaultRunner, findProtonVersions, wineAvailable } from '../launch/runners'
import { findAppInstall, listLibraries } from '../steam/steam'
import { listInstalledApps } from '../steam/installedApps'
import { loadSettings, updateSettings } from '../store/settings'
import { detectGameFolder } from './detect'
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
}

type CustomApi = Pick<
  HmlApi,
  | 'detectCustomGame'
  | 'pickCustomGameFolder'
  | 'addCustomGame'
  | 'updateCustomGame'
  | 'removeCustomGame'
  | 'listRunners'
>

const CHOICES: LoaderChoice[] = ['bepinex5', 'bepinex6-mono', 'bepinex6-il2cpp', 'none']

function checkChoice(choice: unknown): LoaderChoice {
  if (!CHOICES.includes(choice as LoaderChoice)) throw new Error('Unknown loader choice.')
  return choice as LoaderChoice
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
    steamCandidates
  }
}
