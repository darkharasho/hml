import type { GameSummary } from '../../shared/ipc'
import type { GameDef, GameDetection, InstalledMod, LoaderChoice, Runner } from '../../shared/types'

/** Nexus-only games come from a Nexus Mods search; their label says so (a loader of `deploy` can also be a folder game's). */
export const isNexusOnly = (g: GameDef): boolean => g.label.startsWith('nexus-')

/** An installed Steam game from search that hasn't been added to HML yet. */
export const isSteamCandidate = (g: GameDef): boolean => g.custom?.added === false

const LOADER_LABELS: Record<LoaderChoice, string> = {
  bepinex5: 'Unity (Mono) — BepInEx 5',
  'bepinex6-mono': 'Unity (Mono) — BepInEx 6 (pre-release)',
  'bepinex6-il2cpp': 'Unity (IL2CPP) — BepInEx 6 (GitHub pre-release)',
  none: 'No loader (copy mods into the game folder)'
}

/** "Unity (Mono) — BepInEx 5, recommended" for the suggested choice; plain labels otherwise. */
export function loaderOptionLabel(choice: LoaderChoice, detection: GameDetection): string {
  const label = LOADER_LABELS[choice]
  return choice === detection.suggested ? `${label}, recommended` : label
}

/** Native Linux builds can't take BepInEx, so they only get No loader. */
export function loaderChoicesFor(detection: GameDetection): LoaderChoice[] {
  return detection.nativeLinux ? ['none'] : ['bepinex5', 'bepinex6-mono', 'bepinex6-il2cpp', 'none']
}

export const runnerLabel = (r: Runner): string => (r.kind === 'proton' ? r.name : 'Wine')

/** True on Linux. Reads the platform the preload exposes; false when it is absent (tests). */
export function isLinux(platform: string | undefined = globalThis.window?.hmlPlatform): boolean {
  return platform === 'linux'
}

/** Index of the runner in the list that matches `current` (same kind and path/name); 0 if none does. */
export function runnerIndexOf(runners: Runner[], current: Runner | null | undefined): number {
  if (!current) return 0
  const i = runners.findIndex((r) =>
    r.kind === 'wine'
      ? current.kind === 'wine'
      : current.kind === 'proton' && r.path === current.path && r.name === current.name
  )
  return i < 0 ? 0 : i
}

/** Which online catalogues a game can browse. With none, GitHub is the primary way to add mods. */
export function sourcesFor(
  game: Pick<GameSummary, 'packageIndex' | 'label'>,
  nexusDomain: string | null
): { online: ('thunderstore' | 'nexus')[]; githubPrimary: boolean } {
  const online: ('thunderstore' | 'nexus')[] = []
  if (game.packageIndex) online.push('thunderstore')
  // Nexus-only games always have a domain; don't wait for the lookup to show it.
  if (nexusDomain || game.label.startsWith('nexus-')) online.push('nexus')
  return { online, githubPrimary: online.length === 0 }
}

const SHORT_LOADER_LABELS: Record<Exclude<LoaderChoice, 'none'>, string> = {
  bepinex5: 'BepInEx 5 (Mono)',
  'bepinex6-mono': 'BepInEx 6 (Mono)',
  'bepinex6-il2cpp': 'BepInEx 6 (IL2CPP)'
}
const ASSET_CHOICES: [string, Exclude<LoaderChoice, 'none'>][] = [
  ['BepInEx_win_x64_', 'bepinex5'],
  ['BepInEx-Unity.Mono-', 'bepinex6-mono'],
  ['BepInEx-Unity.IL2CPP-', 'bepinex6-il2cpp']
]

/** Short loader name for buttons and warnings: "BepInEx 5 (Mono)"; "No loader" for none. */
export const shortLoaderLabel = (choice: LoaderChoice): string =>
  choice === 'none' ? 'No loader' : SHORT_LOADER_LABELS[choice]

/** Names the BepInEx build installed in a profile from its GitHub mod; a generic name if unknown. */
export function installedLoaderLabel(mods: InstalledMod[]): string {
  const mod = mods.find(
    (m) =>
      m.source.kind === 'github' &&
      m.source.owner.toLowerCase() === 'bepinex' &&
      m.source.repo.toLowerCase() === 'bepinex'
  )
  const pattern = mod?.github?.assetPattern ?? ''
  const hit = ASSET_CHOICES.find(([prefix]) => pattern.startsWith(prefix))
  return hit ? SHORT_LOADER_LABELS[hit[1]] : 'a different BepInEx'
}
