import type { InstalledMod, TsPackage } from '../../shared/types'
import type { ModDeps } from '../../shared/modDeps'
import { findInstalledMod } from '../../shared/modIdentity'
import { compareVersions, parseDependency } from './resolve'

/**
 * The profile's dependency graph, from the installed version of each Thunderstore mod in the
 * package index (its newest version when the installed one is gone). Other sources don't say
 * what they depend on, so they have no edges of their own.
 */
export function buildModDeps(
  mods: InstalledMod[],
  index: Map<string, TsPackage>,
  loaderPackageIds: readonly string[]
): ModDeps {
  const deps: Record<string, string[]> = {}
  for (const mod of mods) {
    if (mod.source.kind !== 'thunderstore') continue
    const versions = index.get(mod.source.fullName)?.versions ?? []
    const version =
      versions.find((v) => compareVersions(v.version, mod.version) === 0) ?? versions[0]
    const out = new Set<string>()
    for (const dep of version?.dependencies ?? []) {
      const parsed = parseDependency(dep)
      const found = parsed && findInstalledMod(mods, parsed.fullName, loaderPackageIds)
      if (found && found.id !== mod.id) out.add(found.id)
    }
    if (out.size > 0) deps[mod.id] = [...out]
  }
  const loaders = new Set<string>()
  for (const id of loaderPackageIds) {
    const found = findInstalledMod(mods, id, loaderPackageIds)
    if (found) loaders.add(found.id)
  }
  return { deps, loaders: [...loaders] }
}
