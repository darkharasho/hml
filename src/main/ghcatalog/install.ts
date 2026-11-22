import type { CatalogEntry, CatListResult } from '../../shared/ghCatalog'
import { parseDependency } from '../../shared/ghCatalog'
import { normPrefix, samePrefix, tagPrefix } from '../../shared/ghTag'
import type { HmlApi } from '../../shared/ipc'
import type {
  CatInstallPlan,
  CatInstallResult,
  InstalledMod,
  TsInstallResult
} from '../../shared/types'
import type { GhInstallOptions } from '../github/service'

export interface CatalogInstallDeps {
  /** The game's catalog index (cached; never forced). */
  catList(game: string): Promise<CatListResult>
  blockedReason(owner: string, repo: string): Promise<string | null>
  installedMods(game: string, profileId: string): Promise<InstalledMod[]>
  /** Lowercase owners the user already agreed to install from. */
  trustedOwners(): Promise<string[]>
  /** Adds lowercase owners to the trusted ones. */
  trustOwners(owners: string[]): Promise<void>
  ghInstallWith(
    game: string,
    profileId: string,
    url: string,
    asset: undefined,
    opts: GhInstallOptions
  ): ReturnType<HmlApi['ghInstall']>
  /** The Thunderstore install with its dependencies (tsInstall). */
  tsInstall(game: string, profileId: string, fullName: string): Promise<TsInstallResult>
}

export interface CatalogInstaller {
  catPlanInstall(game: string, profileId: string, key: string): Promise<CatInstallPlan>
  catInstall(
    game: string,
    profileId: string,
    key: string,
    confirmedOwners: string[]
  ): Promise<CatInstallResult>
}

const lower = (s: string): string => s.toLowerCase()
/** The resolver's identity of an entry: `owner/repo/id`, owner and repo lowercased. */
const idOf = (e: CatalogEntry): string => `${lower(e.owner)}/${lower(e.repo)}/${String(e.id)}`
/** The entry's tag prefix as installed tags give it ('' for a repo of one mod). */
const prefixOf = (e: CatalogEntry): string =>
  typeof e.tagPrefix === 'string' ? normPrefix(e.tagPrefix) : ''
const depsOf = (e: CatalogEntry): string[] =>
  Array.isArray(e.dependencies)
    ? e.dependencies.filter((d): d is string => typeof d === 'string')
    : []
const isInstalled = (mods: InstalledMod[], e: CatalogEntry): boolean =>
  mods.some(
    (m) =>
      m.source.kind === 'github' &&
      lower(m.source.owner) === lower(e.owner) &&
      lower(m.source.repo) === lower(e.repo) &&
      samePrefix(tagPrefix(m.source.tag), prefixOf(e))
  )
/** `Owner-Name-1.2.3` → `Owner-Name`. */
const tsFullName = (dep: string): string => dep.replace(/-\d+\.\d+\.\d+$/, '')

export function createCatalogInstaller(deps: CatalogInstallDeps): CatalogInstaller {
  async function findTarget(
    game: string,
    key: string
  ): Promise<{
    index: CatalogEntry[]
    target: CatalogEntry
  }> {
    const { mods: index } = await deps.catList(game)
    const target = index.find((m) => m.key === key)
    if (!target) throw new Error("That mod isn't in the GitHub catalog for this game.")
    return { index, target }
  }

  /**
   * Resolves the target's dependencies breadth-first from the cached index (cycles and
   * self-dependencies ignored, each mod once), then orders the GitHub mods so every dependency
   * comes before the mods that need it, the target last.
   */
  async function resolve(
    game: string,
    profileId: string,
    index: CatalogEntry[],
    target: CatalogEntry
  ): Promise<CatInstallPlan> {
    const visited = new Map<string, CatalogEntry>([[idOf(target), target]])
    const edges = new Map<string, string[]>()
    const thunderstore = new Set<string>()
    const unavailable = new Set<string>()
    const queue = [target]
    while (queue.length > 0) {
      const e = queue.shift()!
      const kids: string[] = []
      for (const s of depsOf(e)) {
        const d = parseDependency(s)
        if (!d) {
          unavailable.add(s)
          continue
        }
        if (d.kind === 'thunderstore') {
          thunderstore.add(s)
          continue
        }
        const same = index.filter(
          (m) => lower(m.owner) === lower(d.owner) && lower(m.repo) === lower(d.repo)
        )
        // Without an id the repo must list exactly one mod.
        const found =
          d.id !== undefined ? same.find((m) => m.id === d.id) : same.length === 1 ? same[0] : null
        if (!found) {
          unavailable.add(s)
          continue
        }
        const k = idOf(found)
        if (k === idOf(e)) continue
        if (!visited.has(k)) {
          if (await deps.blockedReason(found.owner, found.repo)) {
            unavailable.add(s)
            continue
          }
          visited.set(k, found)
          queue.push(found)
        }
        kids.push(k)
      }
      edges.set(idOf(e), kids)
    }

    // Post-order from the target: dependencies first. Marking before descending ends cycles.
    const ordered: CatalogEntry[] = []
    const seen = new Set<string>()
    const visit = (k: string): void => {
      if (seen.has(k)) return
      seen.add(k)
      for (const c of edges.get(k) ?? []) visit(c)
      ordered.push(visited.get(k)!)
    }
    visit(idOf(target))

    const installed = await deps.installedMods(game, profileId)
    const mods = ordered.filter((e) => !isInstalled(installed, e))
    const trusted = new Set((await deps.trustedOwners()).map(lower))
    const untrusted = new Map<string, string>()
    for (const m of mods) {
      if (!trusted.has(lower(m.owner)) && !untrusted.has(lower(m.owner)))
        untrusted.set(lower(m.owner), m.owner)
    }
    return {
      mods,
      thunderstore: [...thunderstore],
      unavailable: [...unavailable],
      untrustedOwners: [...untrusted.values()]
    }
  }

  return {
    async catPlanInstall(game, profileId, key) {
      const { index, target } = await findTarget(game, String(key))
      const reason = await deps.blockedReason(target.owner, target.repo)
      if (reason) throw new Error(`Blocked by HML: ${reason}`)
      return resolve(game, profileId, index, target)
    },

    async catInstall(game, profileId, key, confirmedOwners) {
      const { index, target } = await findTarget(game, String(key))
      const reason = await deps.blockedReason(target.owner, target.repo)
      if (reason) return { kind: 'blocked', reason }
      const plan = await resolve(game, profileId, index, target)
      const confirmed = new Set(
        (Array.isArray(confirmedOwners) ? confirmedOwners : [])
          .filter((o): o is string => typeof o === 'string')
          .map(lower)
      )
      const owners = plan.untrustedOwners.filter((o) => !confirmed.has(lower(o)))
      if (owners.length > 0) return { kind: 'needs-confirm', owners }
      if (plan.untrustedOwners.length > 0) await deps.trustOwners(plan.untrustedOwners.map(lower))

      const installed: InstalledMod[] = []
      for (const m of plan.mods) {
        const prefix = prefixOf(m)
        const r = await deps.ghInstallWith(
          game,
          profileId,
          `https://github.com/${m.owner}/${m.repo}`,
          undefined,
          {
            tagPrefix: prefix || undefined,
            assetPattern: typeof m.assetPattern === 'string' ? m.assetPattern : undefined,
            followNewestTag: true
          }
        )
        if (r.kind !== 'installed') {
          throw new Error(
            r.kind === 'prerelease-only'
              ? `${m.owner}/${m.repo} only publishes pre-releases, so it can't be installed from the catalog.`
              : `${m.owner}/${m.repo} couldn't be installed from the catalog. Add it from its GitHub link instead.`
          )
        }
        installed.push(r.mod)
      }

      const have = await deps.installedMods(game, profileId)
      for (const dep of plan.thunderstore) {
        const fullName = tsFullName(dep)
        const present = have.some(
          (m) =>
            (m.source.kind === 'thunderstore' && m.source.fullName === fullName) ||
            m.provides?.includes(fullName)
        )
        if (present) continue
        installed.push(...(await deps.tsInstall(game, profileId, fullName)).installed)
      }
      return { kind: 'installed', installed }
    }
  }
}
