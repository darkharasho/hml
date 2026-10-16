import type { GameDef, GameDetection, LoaderChoice, Runner } from '../../shared/types'

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
