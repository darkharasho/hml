// Pure display helpers for the Thunderstore views. No DOM, no store, so they unit-test in node.
import type {
  HmlEvent,
  InstalledMod,
  TsInstallResult,
  TsPackage,
  TsVersion
} from '../../shared/types'
import { compareVersions } from '../../shared/version'
import { findInstalledMod, loaderAlias } from '../../shared/modIdentity'

export const UNSUPPORTED_LOADER = 'Mod loader not supported yet'

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

/** 950 -> "950", 1234 -> "1.2K", 1_250_000 -> "1.3M". */
export function compactCount(n: number): string {
  return compact.format(Math.max(0, Math.round(n)))
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60]
]

/** "just now", "5 minutes ago", "yesterday", "3 months ago". Future times read as "just now". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'an unknown time'
  const seconds = Math.max(0, (now - then) / 1000)
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return relative.format(-Math.floor(seconds / size), unit)
  }
  return 'just now'
}

export function newestVersion(pkg: TsPackage): TsVersion | undefined {
  return pkg.versions.reduce<TsVersion | undefined>(
    (best, v) => (!best || compareVersions(v.version, best.version) > 0 ? v : best),
    undefined
  )
}

export type InstallState =
  | { kind: 'install' }
  /** `providedBy`: the package is stood in for by a mod from that source (its `provides`). */
  | { kind: 'installed'; version: string; providedBy?: string }
  | { kind: 'update'; installed: string; latest: string }

const PROVIDER_NAMES: Partial<Record<InstalledMod['source']['kind'], string>> = {
  github: 'GitHub',
  nexus: 'Nexus Mods'
}

/**
 * Thunderstore mods are recorded with id `Owner-Name`, which equals the package's fullName. A
 * loader package (one of `loaderPackageIds`) also matches a local install under its alias. A
 * GitHub (or Nexus) mod that provides the package shows as installed, never as an update: its
 * versions don't follow Thunderstore's, and replacing it is a deliberate pick of a version.
 */
export function installState(
  pkg: TsPackage,
  mods: InstalledMod[],
  loaderPackageIds: readonly string[] = []
): InstallState {
  const mod = findInstalledMod(mods, pkg.fullName, loaderPackageIds)
  if (!mod) return { kind: 'install' }
  const providedBy = PROVIDER_NAMES[mod.source.kind]
  if (providedBy) return { kind: 'installed', version: mod.version, providedBy }
  const latest = newestVersion(pkg)?.version
  if (latest && compareVersions(mod.version, latest) < 0)
    return { kind: 'update', installed: mod.version, latest }
  return { kind: 'installed', version: mod.version }
}

/**
 * The installed version of the package's own copy: a Thunderstore mod, or a local loader under its
 * alias. Null for none, and for a mod that only provides the package (a GitHub stand-in), so the
 * Thunderstore package can be installed over it at any version.
 */
export function ownInstalledVersion(
  pkg: TsPackage,
  mods: InstalledMod[],
  loaderPackageIds: readonly string[] = []
): string | null {
  const mod = findInstalledMod(mods, pkg.fullName, loaderPackageIds)
  if (!mod) return null
  const own =
    mod.source.kind === 'thunderstore' ||
    (mod.source.kind === 'local' && mod.id === loaderAlias(pkg.fullName))
  return own ? mod.version : null
}

/**
 * The toast after a Thunderstore install or update. `done` is the success line ("Installed X");
 * with `alreadyName`, an install that installed nothing says "<alreadyName> is already installed".
 */
export function installToast(
  done: string,
  r: TsInstallResult,
  alreadyName?: string
): { kind: 'success' | 'info'; message: string } {
  if (alreadyName !== undefined && r.installed.length === 0)
    return { kind: 'info', message: `${alreadyName} is already installed` }
  const replaced = r.replaced && r.replaced.length > 0 ? ` — replaced ${r.replaced.join(', ')}` : ''
  const missing = r.missing.length > 0 ? ` — missing dependencies: ${r.missing.join(', ')}` : ''
  return { kind: missing ? 'info' : 'success', message: `${done}${replaced}${missing}` }
}

/** "Installing BepInExPack 5.4.2100 (1/3)"; null once the run is finished. */
export function progressLabel(e: Extract<HmlEvent, { type: 'progress' }>): string | null {
  if (e.total <= 0 || e.done >= e.total) return null
  return `${e.message} (${e.done + 1}/${e.total})`
}

/** Splits a dependency string "Owner-Name-1.2.3" for display. */
export function splitDependency(dep: string): {
  fullName: string
  owner: string
  name: string
  version: string
} {
  const v = dep.lastIndexOf('-')
  const fullName = v > 0 ? dep.slice(0, v) : dep
  const version = v > 0 ? dep.slice(v + 1) : ''
  const n = fullName.lastIndexOf('-')
  return {
    fullName,
    owner: n > 0 ? fullName.slice(0, n) : '',
    name: n > 0 ? fullName.slice(n + 1) : fullName,
    version
  }
}

/** Up to two initials for an icon fallback ("More_Upgrades" -> "MU"). */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return (
    words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)
  ).toUpperCase()
}

/** Thunderstore names use underscores for spaces ("More_Upgrades" -> "More Upgrades"). */
export function displayName(name: string): string {
  return name.replace(/_/g, ' ')
}
