import type { InstalledMod, ModUpdate, TsPackage, TsVersion } from '../../shared/types'
import { compareVersions } from '../../shared/version'

export { compareVersions }

export interface PlannedPackage {
  fullName: string
  name: string
  version: string
  downloadUrl: string
}

const VERSION_RE = /^\d+(\.\d+)*$/

/** Splits "Owner-Name-1.2.3" on the last dash. Owners may contain dashes. */
export function parseDependency(dep: string): { fullName: string; version: string } | null {
  const i = dep.lastIndexOf('-')
  if (i <= 0) return null
  const fullName = dep.slice(0, i)
  const version = dep.slice(i + 1)
  if (!VERSION_RE.test(version)) return null
  return { fullName, version }
}

function newest(pkg: TsPackage): TsVersion | undefined {
  return pkg.versions.reduce<TsVersion | undefined>(
    (best, v) => (!best || compareVersions(v.version, best.version) > 0 ? v : best),
    undefined
  )
}

/** The exact required version if present, else the newest version >= required. */
function pickVersion(pkg: TsPackage, required: string): TsVersion | undefined {
  const exact = pkg.versions.find((v) => compareVersions(v.version, required) === 0)
  if (exact) return exact
  const top = newest(pkg)
  return top && compareVersions(top.version, required) >= 0 ? top : undefined
}

interface Pass {
  req: Map<string, string>
  plan: PlannedPackage[]
  skipped: string[]
  missing: string[]
}

export function resolveInstall(
  index: Map<string, TsPackage>,
  target: { fullName: string; version?: string },
  installed: Map<string, string>
): { plan: PlannedPackage[]; skipped: string[]; missing: string[] } {
  const targetPkg = index.get(target.fullName)
  if (!targetPkg) throw new Error(`${target.fullName} isn't on Thunderstore for this game.`)
  const targetVersion = target.version
    ? targetPkg.versions.find((v) => compareVersions(v.version, target.version!) === 0)
    : newest(targetPkg)
  if (!targetVersion) throw new Error(`${target.fullName} ${target.version} isn't available.`)

  // One walk, with each dependency's minimum raised to at least `floor` (the highest
  // minimum seen in the previous walk). Repeats until the minimums stop changing, so a
  // package required at several versions is planned once at the highest.
  const walk = (floor: Map<string, string>): Pass => {
    const req = new Map<string, string>()
    const plan: PlannedPackage[] = []
    const skipped = new Set<string>()
    const missing = new Set<string>()
    const visited = new Set<string>([target.fullName])

    const visit = (version: TsVersion): void => {
      for (const dep of version.dependencies) {
        const parsed = parseDependency(dep)
        if (!parsed) {
          missing.add(dep)
          continue
        }
        const { fullName } = parsed
        let min = parsed.version
        for (const prior of [req.get(fullName), floor.get(fullName)]) {
          if (prior && compareVersions(prior, min) > 0) min = prior
        }
        req.set(fullName, min)
        if (visited.has(fullName)) continue
        // An installed version that satisfies the minimum is enough; the index is
        // only consulted when something has to be downloaded.
        const have = installed.get(fullName)
        if (have !== undefined && compareVersions(have, min) >= 0) {
          visited.add(fullName)
          skipped.add(fullName)
          continue
        }
        const depPkg = index.get(fullName)
        const pick = depPkg && pickVersion(depPkg, min)
        if (!depPkg || !pick) {
          missing.add(dep)
          continue
        }
        visited.add(fullName)
        visit(pick)
        plan.push({
          fullName,
          name: depPkg.name,
          version: pick.version,
          downloadUrl: pick.downloadUrl
        })
      }
    }

    const have = installed.get(target.fullName)
    if (have !== undefined && compareVersions(have, targetVersion.version) === 0) {
      skipped.add(target.fullName)
    } else {
      visit(targetVersion)
      plan.push({
        fullName: targetPkg.fullName,
        name: targetPkg.name,
        version: targetVersion.version,
        downloadUrl: targetVersion.downloadUrl
      })
    }
    return { req, plan, skipped: [...skipped], missing: [...missing] }
  }

  // Floors only ever rise (max over every pass), and each is a version string taken from
  // the index, so this reaches a fixed point; the final walk then runs with a stable floor
  // and is deterministic. The bound is only a guard.
  let floor = new Map<string, string>()
  let pass = walk(floor)
  for (let i = 0; i < 1000; i++) {
    const merged = new Map(floor)
    for (const [k, v] of pass.req) {
      const cur = merged.get(k)
      if (!cur || compareVersions(v, cur) > 0) merged.set(k, v)
    }
    if (merged.size === floor.size && [...merged].every(([k, v]) => floor.get(k) === v)) break
    floor = merged
    pass = walk(floor)
  }
  return { plan: pass.plan, skipped: pass.skipped, missing: pass.missing }
}

export function findUpdates(mods: InstalledMod[], index: Map<string, TsPackage>): ModUpdate[] {
  const updates: ModUpdate[] = []
  for (const mod of mods) {
    if (mod.source.kind !== 'thunderstore') continue
    const pkg = index.get(mod.source.fullName)
    const latest = pkg && newest(pkg)
    if (latest && compareVersions(latest.version, mod.version) > 0) {
      updates.push({
        modId: mod.id,
        fullName: mod.source.fullName,
        current: mod.version,
        latest: latest.version
      })
    }
  }
  return updates
}

export function installedVersions(
  mods: InstalledMod[],
  loaderPackageIds: string[]
): Map<string, string> {
  const out = new Map<string, string>()
  for (const mod of mods) {
    if (mod.source.kind === 'thunderstore') out.set(mod.source.fullName, mod.version)
  }
  for (const loaderId of loaderPackageIds) {
    const short = loaderId.slice(loaderId.indexOf('-') + 1)
    const mod = mods.find((m) => m.id === loaderId || m.id === short)
    if (mod) out.set(loaderId, mod.version)
  }
  return out
}
