import type { InstalledMod, ModUpdate, TsPackage, TsVersion } from '../../shared/types'
import { compareVersions } from '../../shared/version'
import { loaderAlias, providesPackage } from '../../shared/modIdentity'

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

/** A dependency an installed GitHub mod stands in for, to record in that mod's `provides`. */
export interface StandIn {
  modId: string
  fullName: string
}

interface Pass {
  req: Map<string, string>
  plan: PlannedPackage[]
  skipped: string[]
  missing: string[]
  standIns: StandIn[]
}

/**
 * Installed GitHub mods by manifest name, for names exactly one GitHub mod has (two are
 * ambiguous and stand in for nothing).
 */
export function githubByName(mods: InstalledMod[]): Map<string, string> {
  const out = new Map<string, string>()
  const seen = new Set<string>()
  for (const m of mods) {
    if (m.source.kind !== 'github') continue
    if (seen.has(m.name)) out.delete(m.name)
    else out.set(m.name, m.id)
    seen.add(m.name)
  }
  return out
}

/**
 * Resolves `target` and its dependencies against what is installed. A dependency in `provided`
 * (stood in for by another mod, see `providedPackages`) counts as satisfied at any version. So
 * does one with no installed copy whose package name is in `ghByName` (see `githubByName`); it
 * comes back in `standIns` so the caller can record it on that mod.
 */
export function resolveInstall(
  index: Map<string, TsPackage>,
  target: { fullName: string; version?: string },
  installed: Map<string, string>,
  provided: ReadonlySet<string> = new Set(),
  ghByName: ReadonlyMap<string, string> = new Map()
): { plan: PlannedPackage[]; skipped: string[]; missing: string[]; standIns: StandIn[] } {
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
    const standIns: StandIn[] = []
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
        if (provided.has(fullName) || (have !== undefined && compareVersions(have, min) >= 0)) {
          visited.add(fullName)
          skipped.add(fullName)
          continue
        }
        const depPkg = index.get(fullName)
        if (!depPkg) {
          missing.add(dep)
          continue
        }
        const standIn = have === undefined ? ghByName.get(depPkg.name) : undefined
        if (standIn !== undefined) {
          visited.add(fullName)
          skipped.add(fullName)
          standIns.push({ modId: standIn, fullName })
          continue
        }
        // No version meets the minimum: install the newest anyway, and still warn.
        let pick = pickVersion(depPkg, min)
        if (!pick) {
          pick = newest(depPkg)
          missing.add(`${fullName}-${min}`)
        }
        if (!pick) {
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
    return { req, plan, skipped: [...skipped], missing: [...missing], standIns }
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
  return { plan: pass.plan, skipped: pass.skipped, missing: pass.missing, standIns: pass.standIns }
}

/**
 * Merges several plans into one: each package once, at the highest planned version, ordered so
 * that every package comes after the planned packages its chosen version depends on. Otherwise
 * the order of first appearance in the concatenated plans is kept.
 */
export function mergePlans(
  plans: PlannedPackage[][],
  index: Map<string, TsPackage>
): PlannedPackage[] {
  const best = new Map<string, PlannedPackage>()
  for (const p of plans.flat()) {
    const cur = best.get(p.fullName)
    if (!cur || compareVersions(p.version, cur.version) > 0) best.set(p.fullName, p)
  }
  const out: PlannedPackage[] = []
  const seen = new Set<string>()
  const place = (p: PlannedPackage): void => {
    if (seen.has(p.fullName)) return
    seen.add(p.fullName)
    const v = index.get(p.fullName)?.versions.find((x) => x.version === p.version)
    for (const dep of v?.dependencies ?? []) {
      const d = parseDependency(dep)
      const planned = d && best.get(d.fullName)
      if (planned) place(planned)
    }
    out.push(p)
  }
  for (const p of plans.flat()) place(best.get(p.fullName)!)
  return out
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

/**
 * Thunderstore packages that installed mods stand in for (their `provides`). A mod providing one
 * loader package provides every one of `loaderPackageIds`.
 */
export function providedPackages(
  mods: InstalledMod[],
  loaderPackageIds: readonly string[] = []
): Set<string> {
  const out = new Set(mods.flatMap((m) => m.provides ?? []))
  if (loaderPackageIds.some((id) => out.has(id))) for (const id of loaderPackageIds) out.add(id)
  return out
}

export function installedVersions(
  mods: InstalledMod[],
  loaderPackageIds: string[]
): Map<string, string> {
  const out = new Map<string, string>()
  for (const mod of mods) {
    for (const fullName of mod.provides ?? []) out.set(fullName, mod.version)
  }
  for (const mod of mods) {
    if (mod.source.kind === 'thunderstore') out.set(mod.source.fullName, mod.version)
  }
  for (const loaderId of loaderPackageIds) {
    const short = loaderAlias(loaderId)
    const mod =
      mods.find((m) => m.id === loaderId) ??
      mods.find((m) => m.id === short) ??
      mods.find((m) => providesPackage(m, loaderId, loaderPackageIds))
    if (mod) out.set(loaderId, mod.version)
  }
  return out
}
