import type { InstalledMod } from './types'

/**
 * The id a loader package gets when installed from a local zip: its manifest name, which is the
 * part of the Thunderstore id after the first dash ("BepInEx-BepInExPack" -> "BepInExPack").
 */
export function loaderAlias(loaderPackageId: string): string {
  return loaderPackageId.slice(loaderPackageId.indexOf('-') + 1)
}

/**
 * The installed mod that stands for Thunderstore package `fullName`: the mod recorded under that
 * id, else a mod that `provides` it, else for a loader package a mod recorded under its local
 * alias.
 */
export function findInstalledMod(
  mods: InstalledMod[],
  fullName: string,
  loaderPackageIds: readonly string[]
): InstalledMod | undefined {
  const exact =
    mods.find((m) => m.id === fullName) ?? mods.find((m) => m.provides?.includes(fullName))
  if (exact || !loaderPackageIds.includes(fullName)) return exact
  const alias = loaderAlias(fullName)
  return mods.find((m) => m.id === alias)
}
