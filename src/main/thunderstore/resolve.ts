import type { InstalledMod, ModUpdate, TsPackage, TsVersion } from '../../shared/types'

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

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0)
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
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
        const depPkg = parsed && index.get(parsed.fullName)
        if (!parsed || !depPkg) {
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
        const pick = pickVersion(depPkg, min)
        if (!pick) {
          missing.add(dep)
          continue
        }
        visited.add(fullName)
        const have = installed.get(fullName)
        if (have !== undefined && compareVersions(have, min) >= 0) {
          skipped.add(fullName)
          continue
        }
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

  const same = (a: Map<string, string>, b: Map<string, string>): boolean =>
    a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

  let pass = walk(new Map())
  for (let i = 0; i < 50; i++) {
    const next = walk(pass.req)
    const done = same(next.req, pass.req)
    pass = next
    if (done) break
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
