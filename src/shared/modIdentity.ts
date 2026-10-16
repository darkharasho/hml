import type { InstalledMod } from './types'

/**
 * The id a loader package gets when installed from a local zip: its manifest name, which is the
 * part of the Thunderstore id after the first dash ("BepInEx-BepInExPack" -> "BepInExPack").
 */
export function loaderAlias(loaderPackageId: string): string {
  return loaderPackageId.slice(loaderPackageId.indexOf('-') + 1)
}

/**
 * True when `mod` stands in for Thunderstore package `fullName` through its `provides`. Like a
 * local loader alias, providing one loader package provides them all.
 */
export function providesPackage(
  mod: InstalledMod,
  fullName: string,
  loaderPackageIds: readonly string[]
): boolean {
  const provides = mod.provides ?? []
  if (provides.includes(fullName)) return true
  return loaderPackageIds.includes(fullName) && provides.some((p) => loaderPackageIds.includes(p))
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
    mods.find((m) => m.id === fullName) ??
    mods.find((m) => providesPackage(m, fullName, loaderPackageIds))
  if (exact || !loaderPackageIds.includes(fullName)) return exact
  const alias = loaderAlias(fullName)
  return mods.find((m) => m.id === alias)
}
