import type { GhTrack, InstalledMod, LoaderChoice } from '../../shared/types'

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

/** The loader GitHub mod in a profile (BepInEx/BepInEx, case-insensitive), if any. */
export function findLoaderMod(mods: InstalledMod[]): InstalledMod | undefined {
  return mods.find(
    (m) =>
      m.source.kind === 'github' &&
      m.source.owner.toLowerCase() === 'bepinex' &&
      m.source.repo.toLowerCase() === 'bepinex'
  )
}

/** True when the installed loader mod is the build `spec` describes. */
export function loaderMatches(mod: InstalledMod, spec: LoaderSpec): boolean {
  return (
    mod.github?.track?.major === spec.track.major && mod.github?.assetPattern === spec.assetPattern
  )
}
