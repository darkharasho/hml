import { matchesAssetPattern } from '../github/assets'
import type { GhTrack, InstalledMod, LoaderChoice, ModSource } from '../../shared/types'

export interface LoaderSpec {
  choice: Exclude<LoaderChoice, 'none'>
  owner: 'BepInEx'
  repo: 'BepInEx'
  assetPattern: string
  track: GhTrack
  /** Short name for buttons: "BepInEx 5 (Mono)". */
  label: string
}

export const LOADER_SPECS: Record<Exclude<LoaderChoice, 'none'>, LoaderSpec> = {
  bepinex5: {
    choice: 'bepinex5',
    owner: 'BepInEx',
    repo: 'BepInEx',
    assetPattern: 'BepInEx_win_x64_{version}.zip',
    track: { major: 5, prerelease: false },
    label: 'BepInEx 5 (Mono)'
  },
  'bepinex6-mono': {
    choice: 'bepinex6-mono',
    owner: 'BepInEx',
    repo: 'BepInEx',
    assetPattern: 'BepInEx-Unity.Mono-win-x64-{version}.zip',
    track: { major: 6, prerelease: true },
    label: 'BepInEx 6 (Mono)'
  },
  'bepinex6-il2cpp': {
    choice: 'bepinex6-il2cpp',
    owner: 'BepInEx',
    repo: 'BepInEx',
    assetPattern: 'BepInEx-Unity.IL2CPP-win-x64-{version}.zip',
    track: { major: 6, prerelease: true },
    label: 'BepInEx 6 (IL2CPP)'
  }
}

export function loaderSpec(choice: LoaderChoice): LoaderSpec | null {
  return choice === 'none' ? null : LOADER_SPECS[choice]
}

const isLoaderSource = (s: ModSource): s is Extract<ModSource, { kind: 'github' }> =>
  s.kind === 'github' && s.owner.toLowerCase() === 'bepinex' && s.repo.toLowerCase() === 'bepinex'

/** The loader GitHub mod in a profile (BepInEx/BepInEx, case-insensitive), if any. */
export function findLoaderMod(mods: InstalledMod[]): InstalledMod | undefined {
  return mods.find((m) => isLoaderSource(m.source))
}

/**
 * The name the BepInEx loader mod is shown by: its build's label ("BepInEx 5 (Mono)"), judged by
 * the installed asset, or plain "BepInEx" for another build. Null for any other mod. Its zip has
 * no manifest, so without this it would be named by its id, "BepInEx-BepInEx".
 */
export function loaderModName(source: ModSource): string | null {
  if (!isLoaderSource(source)) return null
  const spec = Object.values(LOADER_SPECS).find((s) =>
    matchesAssetPattern(s.assetPattern, source.asset)
  )
  return spec?.label ?? 'BepInEx'
}

/**
 * The mod with the loader's readable name when it still has its raw `<owner>-<repo>` name, as
 * loaders installed before HML named them do. Other mods come back unchanged.
 */
export function withReadableName(mod: InstalledMod): InstalledMod {
  const name = loaderModName(mod.source)
  if (!name || mod.source.kind !== 'github') return mod
  const raw = `${mod.source.owner}-${mod.source.repo}`.toLowerCase()
  return mod.name.toLowerCase() === raw ? { ...mod, name } : mod
}

/**
 * True when the installed loader mod is the build `spec` describes. Judged by the installed asset's
 * name, which tells 5, 6-Mono and 6-IL2CPP apart and survives pinned or hand-pasted installs that
 * save no track or pattern.
 */
export function loaderMatches(mod: InstalledMod, spec: LoaderSpec): boolean {
  return mod.source.kind === 'github' && matchesAssetPattern(spec.assetPattern, mod.source.asset)
}
