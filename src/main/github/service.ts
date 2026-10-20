import { promises as fs } from 'node:fs'
import { zipSync } from 'fflate'
import type {
  Catalog,
  GameDef,
  GhModConfig,
  GhPrereleaseResult,
  GhReleaseChoice,
  GhTrack,
  GhUpdate,
  GhUpdateMode,
  InstalledMod
} from '../../shared/types'
import type { HmlApi } from '../../shared/ipc'
import type { ServiceDeps } from '../services'
import {
  detectPackageMeta,
  installedModsReplaced,
  installZipReporting,
  readZipEntries
} from '../install/installer'
import { getProfile, listProfiles, saveProfile } from '../profiles/profiles'
import { parseGithubUrl } from './url'
import { assetPattern, chooseAsset, matchesAssetPattern, type GhReleaseAsset } from './assets'
import {
  downloadAsset,
  fetchLogin,
  fetchRelease,
  fetchReleaseList,
  GH_RELEASE_MEMO_MS,
  GhPrereleaseOnlyError,
  isNewerRelease,
  isNewerTag,
  type GhRelease
} from './api'
import { loadToken, NO_SECURE_STORAGE, saveToken } from './token'
import { isGhAccessError } from '../../shared/messages'
import { loaderModName } from '../custom/loaders'

export const GH_CHECK_INTERVAL_MS = 21_600_000

export interface GhContext {
  deps: ServiceDeps
  getCatalog(): Promise<Catalog>
  requireGame(label: string): Promise<GameDef>
  serialize<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T>
  /** True while the game runs (or can't be told); the background auto-update skips it. */
  isGameRunning(def: GameDef): Promise<boolean>
}

export const unsupportedLoaderMessage = (def: GameDef): string =>
  `${def.displayName} uses a mod loader HML doesn't support yet.`

const MODES: readonly GhUpdateMode[] = ['auto', 'notify', 'pinned']
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const stripV = (tag: string): string => tag.replace(/^v/i, '')

type GhMod = InstalledMod & { source: Extract<InstalledMod['source'], { kind: 'github' }> }
const isGhMod = (m: InstalledMod): m is GhMod => m.source.kind === 'github'
const configOf = (m: InstalledMod): GhModConfig =>
  m.github ?? { updateMode: 'auto', assetPattern: null }
/** The saved asset pattern, else one derived from the installed file's name. */
const patternOf = (m: GhMod): string =>
  configOf(m).assetPattern ?? assetPattern(m.source.asset, m.source.tag)
type LatestOf = (owner: string, repo: string, follow?: Follow) => Promise<GhRelease>
type ModeCheck = (mode: GhUpdateMode) => boolean
const manualAllows: ModeCheck = (mode) => mode !== 'pinned'
const autoAllows: ModeCheck = (mode) => mode === 'auto'
/** What a release lookup for the mod follows: its loader track, else stable or any release. */
const followOf = (m: InstalledMod): Follow => {
  const { track, prereleases } = configOf(m)
  return track ? { track } : { prereleases: prereleases === true }
}
type Follow = { track?: GhTrack; prereleases?: boolean }

/** The config with the installed release's pre-release fields set from `release`. */
function withInstalled(config: GhModConfig, release: GhRelease): GhModConfig {
  const rest = { ...config }
  delete rest.installedPrerelease
  delete rest.installedPublishedAt
  if (!release.prerelease || config.track) return rest
  return { ...rest, installedPrerelease: true, installedPublishedAt: release.publishedAt }
}

interface Chosen {
  asset: GhReleaseAsset
  data: Uint8Array
  sha256: string
}

const BAD_TOKEN = "That doesn't look like a GitHub token."

/** True for a non-empty token without whitespace or control characters, at most 255 long. */
function looksLikeToken(t: string): boolean {
  if (t.length > 255) return false
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) return false
  }
  return true
}

/** Options of an in-process GitHub install (not reachable over IPC). */
export interface GhInstallOptions {
  /** Thunderstore packages to record as provided by the installed mod (a share import). */
  provides?: string[]
  /**
   * Called before installing, outside the profile's queue, when the install would replace an
   * installed mod; it throws to refuse (the running-game check).
   */
  beforeReplacing?: (def: GameDef) => Promise<void>
  /** Follow only this release track (a loader mod); saved in the mod's config. */
  track?: GhTrack
  /** Pick the one asset matching this pattern (`{version}` allowed); saved in the config. */
  assetPattern?: string
  /** Follow pre-releases (saved in the config); a reinstall keeps a saved true. */
  prereleases?: boolean
}

export function createGithubServices(ctx: GhContext): Pick<
  HmlApi,
  | 'ghInstall'
  | 'ghCheckUpdates'
  | 'ghUpdate'
  | 'ghSetUpdateMode'
  | 'ghSetPrereleases'
  | 'ghListReleases'
  | 'ghInstallRelease'
  | 'ghSetToken'
  | 'ghTokenStatus'
> & {
  ghAutoUpdateAll(): Promise<void>
  ghInstallWith(
    game: string,
    profileId: string,
    url: string,
    asset: string | undefined,
    opts: GhInstallOptions
  ): ReturnType<HmlApi['ghInstall']>
} {
  const { deps, serialize } = ctx
  const { paths } = deps

  const lookup = (
    token: string | null,
    owner: string,
    repo: string,
    opts: { tag?: string; maxAgeMs?: number; track?: GhTrack; prereleases?: boolean } = {}
  ): Promise<GhRelease> =>
    fetchRelease({
      fetch: deps.fetch,
      token,
      cacheFile: paths.ghCache,
      now: deps.now,
      owner,
      repo,
      ...opts
    })

  /**
   * One release lookup per owner/repo (case-insensitive) and followed releases (track, or stable
   * vs pre-releases) for the life of the returned function.
   */
  function memoLookup(token: string | null, maxAgeMs?: number): LatestOf {
    const seen = new Map<string, Promise<GhRelease>>()
    return (owner, repo, { track, prereleases } = {}) => {
      const follows = track
        ? `#${track.major}/${track.prerelease}`
        : prereleases
          ? '#prereleases'
          : ''
      const key = `${owner}/${repo}${follows}`.toLowerCase()
      let p = seen.get(key)
      if (!p) {
        p = lookup(token, owner, repo, { maxAgeMs, track, prereleases })
        seen.set(key, p)
      }
      return p
    }
  }

  async function download(
    token: string | null,
    asset: GhReleaseAsset,
    onDownload?: (a: GhReleaseAsset) => void
  ): Promise<Chosen> {
    onDownload?.(asset)
    const { data, sha256 } = await downloadAsset({ fetch: deps.fetch, token, asset })
    return { asset, data, sha256 }
  }

  /** Picks the asset by saved pattern; `ask` when it can't be decided. */
  async function chooseByPattern(
    token: string | null,
    release: GhRelease,
    pattern: string | null,
    onDownload?: (a: GhReleaseAsset) => void
  ): Promise<Chosen | { ask: GhReleaseAsset[] }> {
    const downloaded = new Map<GhReleaseAsset, Chosen>()
    const r = await chooseAsset(release.assets, pattern, async (a) => {
      const c = await download(token, a, onDownload)
      downloaded.set(a, c)
      return c.data
    })
    if ('ask' in r) return r
    const known = downloaded.get(r.asset) ?? (await download(token, r.asset, onDownload))
    return known
  }

  /** The asset as a zip (a bare .dll is wrapped in one). */
  const zipData = (chosen: Chosen): Uint8Array =>
    /\.dll$/i.test(chosen.asset.name) ? zipSync({ [chosen.asset.name]: chosen.data }) : chosen.data

  /**
   * The installed mods an install of `data` under `packageId` replaces besides the mod under that
   * id: a local copy with its manifest name, the repo's mod under another id, and the one
   * Thunderstore mod with its manifest name (two or more are ambiguous and none is replaced).
   */
  function supersededBy(
    mods: InstalledMod[],
    name: string,
    owner: string,
    repo: string,
    packageId: string
  ): { local: InstalledMod[]; sameRepoMods: InstalledMod[]; tsCopy: InstalledMod | undefined } {
    const local = mods.filter((m) => m.source.kind === 'local' && m.id === name)
    const sameRepoMods = mods.filter(
      (m) =>
        isGhMod(m) &&
        sameRepo(m.source.owner, owner) &&
        sameRepo(m.source.repo, repo) &&
        m.id !== packageId
    )
    const tsNamed = mods.filter((m) => m.source.kind === 'thunderstore' && m.name === name)
    const tsCopy = tsNamed.length === 1 ? tsNamed[0] : undefined
    return { local, sameRepoMods, tsCopy }
  }

  const replacesOf = (s: ReturnType<typeof supersededBy>, packageId: string): string[] =>
    [...s.local, ...s.sameRepoMods, ...(s.tsCopy ? [s.tsCopy] : [])]
      .map((m) => m.id)
      .filter((id) => id !== packageId)

  /** True when installing `chosen` under `packageId` would replace a mod the profile has now. */
  async function replacesInstalled(
    def: GameDef,
    catalog: Catalog,
    profileId: string,
    chosen: Chosen,
    o: { owner: string; repo: string; packageId: string }
  ): Promise<boolean> {
    const zip = readZipEntries(zipData(chosen))
    const name = detectPackageMeta(zip, o.packageId)?.name ?? o.packageId
    const { mods } = await getProfile(paths, def.label, profileId)
    const s = supersededBy(mods, name, o.owner, o.repo, o.packageId)
    const ids = installedModsReplaced(
      mods,
      def,
      catalog,
      zip,
      o.packageId,
      replacesOf(s, o.packageId)
    )
    return ids.length > 0
  }

  /**
   * Installs a downloaded release asset and records the github config. Runs inside the profile's
   * queue; `replaces` is computed from the profile as it is then.
   */
  async function installChosen(
    def: GameDef,
    catalog: Catalog,
    profileId: string,
    o: {
      owner: string
      repo: string
      release: GhRelease
      chosen: Chosen
      packageId: string
      config: (previous: InstalledMod | undefined) => GhModConfig
      onInstalling?: (name: string, version: string) => void
      provides?: string[]
    }
  ): Promise<{ mod: InstalledMod; replaced: string[] }> {
    const { owner, repo, release, chosen, packageId } = o
    const data = zipData(chosen)
    const meta = detectPackageMeta(readZipEntries(data), packageId)
    const name = meta?.name ?? packageId
    const version = meta && meta.version !== '0.0.0' ? meta.version : stripV(release.tag)
    o.onInstalling?.(name, version)

    const { mods } = await getProfile(paths, def.label, profileId)
    const superseded = supersededBy(mods, name, owner, repo, packageId)
    const { sameRepoMods, tsCopy } = superseded
    const previous = mods.find((m) => m.id === packageId) ?? sameRepoMods[0]
    const provides = [
      ...new Set([
        ...(previous?.provides ?? []),
        ...(o.provides ?? []),
        ...(tsCopy?.source.kind === 'thunderstore' ? [tsCopy.source.fullName] : [])
      ])
    ]
    const source = {
      kind: 'github' as const,
      owner,
      repo,
      tag: release.tag,
      asset: chosen.asset.name,
      sha256: chosen.sha256
    }
    const { mod, replaced } = await installZipReporting(
      paths,
      def,
      catalog,
      profileId,
      data,
      source,
      {
        packageId,
        // The BepInEx loader's zip has no manifest; it is named by its build instead of its id.
        name: meta?.name ?? loaderModName(source) ?? undefined,
        version,
        replaces: replacesOf(superseded, packageId),
        github: withInstalled(o.config(previous), release),
        provides
      }
    )
    // What the install actually replaced (a raw loader also replaces the loader package), less
    // this repo's own mod under another id.
    const own = new Set(sameRepoMods.map((m) => m.id))
    return { mod, replaced: replaced.filter((id) => !own.has(id)) }
  }

  /**
   * Downloads and installs `release` over an installed GitHub mod, keeping its config. Returns
   * null, installing nothing, when the mod changed while downloading: it was removed, its tag
   * changed, its pre-release setting no longer matches the one `release` was looked up with, or
   * its update mode no longer passes `allows`.
   */
  async function updateMod(
    def: GameDef,
    catalog: Catalog,
    profileId: string,
    mod: GhMod,
    release: GhRelease,
    token: string | null,
    allows: ModeCheck
  ): Promise<InstalledMod | null> {
    const { owner, repo } = mod.source
    const chosen = await chooseByPattern(token, release, patternOf(mod))
    if ('ask' in chosen) {
      throw new Error(
        configOf(mod).assetPattern
          ? `${owner}/${repo} ${release.tag} has several files and none matches the one you picked before. Reinstall it from its GitHub link to choose again.`
          : `${owner}/${repo} ${release.tag} has several files and HML can't tell which one replaces ${mod.source.asset}. Reinstall it from its GitHub link to choose.`
      )
    }
    return serialize(def.label, profileId, async () => {
      const { mods } = await getProfile(paths, def.label, profileId)
      const current = mods.find((m) => m.id === mod.id)
      if (
        !current ||
        !isGhMod(current) ||
        current.source.tag !== mod.source.tag ||
        followOf(current).prereleases !== followOf(mod).prereleases ||
        !allows(configOf(current).updateMode)
      ) {
        return null
      }
      const keep = configOf(current)
      const { mod: updated } = await installChosen(def, catalog, profileId, {
        owner,
        repo,
        release,
        chosen,
        packageId: mod.id,
        config: () => keep
      })
      return updated
    })
  }

  /**
   * The newest release the mod follows, with the mod as the lookup used it. A mod saved before
   * the pre-release setting existed (no key) on a repo that only publishes pre-releases gets it
   * turned on and is looked up again, since HML then installed pre-releases for such repos.
   */
  async function latestFor(
    game: string,
    profileId: string,
    m: GhMod,
    latestOf: LatestOf
  ): Promise<{ mod: GhMod; latest: GhRelease }> {
    const { owner, repo } = m.source
    try {
      return { mod: m, latest: await latestOf(owner, repo, followOf(m)) }
    } catch (e) {
      const c = configOf(m)
      if (!(e instanceof GhPrereleaseOnlyError) || c.track || c.prereleases !== undefined) throw e
      const migrated = await serialize(game, profileId, async () => {
        const profile = await getProfile(paths, game, profileId)
        const current = profile.mods.find((x) => x.id === m.id)
        if (!current || !isGhMod(current) || configOf(current).prereleases !== undefined) {
          return null
        }
        const updated: GhMod = { ...current, github: { ...configOf(current), prereleases: true } }
        await saveProfile(paths, {
          ...profile,
          mods: profile.mods.map((x) => (x.id === m.id ? updated : x))
        })
        return updated
      })
      if (!migrated) throw e
      return { mod: migrated, latest: await latestOf(owner, repo, followOf(migrated)) }
    }
  }

  const needsUpdate = (m: GhMod, latest: GhRelease): boolean => {
    const c = configOf(m)
    // Loader mods on a release track keep the plain tag comparison.
    if (c.track) return isNewerTag(latest.tag, m.source.tag)
    return isNewerRelease(latest, {
      tag: m.source.tag,
      prerelease: c.installedPrerelease === true,
      publishedAt: c.installedPublishedAt
    })
  }

  async function install(
    game: string,
    profileId: string,
    url: string,
    assetArg?: string,
    opts: GhInstallOptions = {}
  ): ReturnType<HmlApi['ghInstall']> {
    const ref = parseGithubUrl(String(url))
    if (!ref) {
      throw new Error(
        "That isn't a GitHub repository link. Paste one like https://github.com/owner/repo."
      )
    }
    const def = await ctx.requireGame(game)
    if (!def.supported) throw new Error(unsupportedLoaderMessage(def))
    const catalog = await ctx.getCatalog()
    const { owner, repo } = ref
    const total = 3
    const progress = (message: string, done: number): void =>
      deps.emit({ type: 'progress', message, done, total })

    progress(`Checking ${owner}/${repo}`, 0)
    const token = await loadToken(paths, deps.secrets)
    const { mods } = await getProfile(paths, game, profileId)
    const prior = mods
      .filter(isGhMod)
      .find((m) => sameRepo(m.source.owner, owner) && sameRepo(m.source.repo, repo))
    const track = opts.track ?? prior?.github?.track
    const prereleases = !track && (opts.prereleases === true || prior?.github?.prereleases === true)
    let release: GhRelease
    try {
      release = await lookup(token, owner, repo, { tag: ref.tag, track: opts.track, prereleases })
    } catch (e) {
      if (e instanceof GhPrereleaseOnlyError) return { kind: 'prerelease-only', owner, repo }
      throw e
    }

    const named = assetArg ?? ref.asset
    const onDownload = (a: GhReleaseAsset): void => progress(`Downloading ${a.name}`, 1)
    let chosen: Chosen
    if (opts.assetPattern !== undefined) {
      const pattern = opts.assetPattern
      const matching = release.assets.filter((a) => matchesAssetPattern(pattern, a.name))
      if (matching.length !== 1) {
        throw new Error(`${owner}/${repo} ${release.tag} has no file like ${pattern}.`)
      }
      chosen = await download(token, matching[0], onDownload)
    } else if (named !== undefined) {
      const asset = release.assets.find((a) => a.name === named)
      if (!asset) throw new Error(`${release.tag} has no file named ${named}.`)
      chosen = await download(token, asset, onDownload)
    } else {
      const r = await chooseByPattern(token, release, prior ? patternOf(prior) : null, onDownload)
      if ('ask' in r) {
        return {
          kind: 'choose-asset',
          owner,
          repo,
          tag: release.tag,
          assets: r.ask.map((a) => ({ name: a.name, size: a.size }))
        }
      }
      chosen = r
    }

    const packageId = prior?.id ?? `${owner}-${repo}`
    if (
      opts.beforeReplacing &&
      (await replacesInstalled(def, catalog, profileId, chosen, { owner, repo, packageId }))
    ) {
      await opts.beforeReplacing(def)
    }
    return serialize(game, profileId, async () => {
      const { mod, replaced } = await installChosen(def, catalog, profileId, {
        owner,
        repo,
        release,
        chosen,
        packageId,
        onInstalling: (name, version) => progress(`Installing ${name} ${version}`, 2),
        provides: opts.provides,
        config: (previous) =>
          opts.assetPattern !== undefined
            ? { updateMode: 'auto', assetPattern: opts.assetPattern, track: opts.track }
            : {
                updateMode: ref.tag ? 'pinned' : (previous?.github?.updateMode ?? 'auto'),
                assetPattern:
                  named !== undefined
                    ? assetPattern(chosen.asset.name, release.tag)
                    : (previous?.github?.assetPattern ?? null),
                ...((opts.track ?? previous?.github?.track)
                  ? { track: opts.track ?? previous?.github?.track }
                  : { prereleases })
              }
      })
      progress('Done', total)
      return { kind: 'installed', mod, replaced }
    })
  }

  async function checkUpdates(game: string, profileId: string): Promise<GhUpdate[]> {
    await ctx.requireGame(game)
    const { mods } = await getProfile(paths, game, profileId)
    const token = await loadToken(paths, deps.secrets)
    const latestOf = memoLookup(token, GH_RELEASE_MEMO_MS)
    const out: GhUpdate[] = []
    let checked = 0
    let accessError: unknown = null
    for (const m of mods.filter(isGhMod)) {
      const mode = configOf(m).updateMode
      if (mode === 'pinned') continue
      try {
        const { mod: m2, latest } = await latestFor(game, profileId, m, latestOf)
        checked++
        if (needsUpdate(m2, latest)) {
          out.push({
            modId: m.id,
            owner: m.source.owner,
            repo: m.source.repo,
            current: m.source.tag,
            latest: latest.tag,
            mode
          })
        }
      } catch (e) {
        // A failing lookup skips this mod; a rate limit or rejected token is kept to report.
        if (accessError === null && isGhAccessError(errMsg(e))) accessError = e
      }
    }
    // With nothing checked because of a rate limit or a rejected token, say so instead of
    // reporting no updates.
    if (checked === 0 && accessError !== null) throw accessError
    return out
  }

  async function update(
    game: string,
    profileId: string,
    modIds: string[]
  ): Promise<InstalledMod[]> {
    const def = await ctx.requireGame(game)
    if (!def.supported) throw new Error(unsupportedLoaderMessage(def))
    const catalog = await ctx.getCatalog()
    const { mods } = await getProfile(paths, game, profileId)
    const wanted = new Set(modIds)
    const token = await loadToken(paths, deps.secrets)
    const latestOf = memoLookup(token)
    const updated: InstalledMod[] = []
    const failed: string[] = []
    for (const m of mods.filter(isGhMod)) {
      if (!wanted.has(m.id) || !manualAllows(configOf(m).updateMode)) continue
      try {
        const found = await latestFor(game, profileId, m, latestOf)
        if (!needsUpdate(found.mod, found.latest)) continue
        const mod = await updateMod(
          def,
          catalog,
          profileId,
          found.mod,
          found.latest,
          token,
          manualAllows
        )
        if (mod) updated.push(mod)
      } catch (e) {
        failed.push(`${m.source.owner}/${m.source.repo}: ${errMsg(e)}`)
      }
    }
    // One failure doesn't stop the rest; the error names every failed mod and, when some did
    // update, says so (the renderer reloads the profile either way).
    if (failed.length > 0) {
      const done =
        updated.length > 0
          ? `Updated ${updated.length} of ${updated.length + failed.length} GitHub mods. `
          : ''
      throw new Error(done + failed.join(' '))
    }
    return updated
  }

  async function setUpdateMode(
    game: string,
    profileId: string,
    modId: string,
    mode: GhUpdateMode
  ): Promise<void> {
    if (!MODES.includes(mode)) throw new Error(`Unknown update mode: ${String(mode)}`)
    await ctx.requireGame(game)
    return serialize(game, profileId, async () => {
      const profile = await getProfile(paths, game, profileId)
      const target = profile.mods.find((m) => m.id === modId)
      if (!target || !isGhMod(target)) throw new Error(`${modId} isn't a GitHub mod.`)
      await saveProfile(paths, {
        ...profile,
        mods: profile.mods.map((m) =>
          m.id === modId ? { ...m, github: { ...configOf(m), updateMode: mode } } : m
        )
      })
    })
  }

  async function setPrereleases(
    game: string,
    profileId: string,
    modId: string,
    on: boolean
  ): Promise<GhPrereleaseResult> {
    if (typeof on !== 'boolean') throw new Error('Pre-releases must be turned on or off.')
    await ctx.requireGame(game)
    const mod = await serialize(game, profileId, async () => {
      const profile = await getProfile(paths, game, profileId)
      const target = profile.mods.find((m) => m.id === modId)
      if (!target || !isGhMod(target)) throw new Error(`${modId} isn't a GitHub mod.`)
      if (configOf(target).track) {
        throw new Error(`${target.name} follows its loader release track, not pre-releases.`)
      }
      // Saved as false when off, so an older mod that never had the setting can be told apart.
      const updated: GhMod = { ...target, github: { ...configOf(target), prereleases: on } }
      await saveProfile(paths, {
        ...profile,
        mods: profile.mods.map((m) => (m.id === modId ? updated : m))
      })
      return updated
    })
    const mode = configOf(mod).updateMode
    if (mode === 'pinned') return { update: null }
    const { owner, repo } = mod.source
    try {
      const token = await loadToken(paths, deps.secrets)
      const latest = await lookup(token, owner, repo, { prereleases: on })
      // Turning it off never downgrades: the mod waits for a newer stable release.
      if (!on || !needsUpdate(mod, latest)) return { update: null }
      // The caller announces a notify-mode update; the background check doesn't repeat it.
      if (mode === 'notify') announced.add(`${game}/${profileId}/${modId}@${latest.tag}`)
      return { update: { modId, owner, repo, current: mod.source.tag, latest: latest.tag, mode } }
    } catch (e) {
      // Off on a repo with only pre-releases: the mod won't update, and the caller says why.
      if (e instanceof GhPrereleaseOnlyError) return { update: null, prereleaseOnly: true }
      // The setting is saved; the next update check reports what went wrong.
      console.warn(`GitHub update check of ${owner}/${repo} failed: ${errMsg(e)}`)
      return { update: null }
    }
  }

  /** `game/profile/modId@tag` of notify-mode releases already announced this session. */
  const announced = new Set<string>()

  async function autoUpdateProfile(
    def: GameDef,
    catalog: Catalog,
    profileId: string,
    token: string | null,
    latestOf: LatestOf,
    /** False while the game runs: notify-mode lookups still happen, installs don't. */
    installs: boolean
  ): Promise<void> {
    const { mods } = await getProfile(paths, def.label, profileId)
    const done: { name: string; tag: string }[] = []
    const fresh: string[] = []
    for (const m of mods.filter(isGhMod)) {
      if (configOf(m).updateMode === 'notify') {
        try {
          const found = await latestFor(def.label, profileId, m, latestOf)
          const key = `${def.label}/${profileId}/${m.id}@${found.latest.tag}`
          if (needsUpdate(found.mod, found.latest) && !announced.has(key)) fresh.push(key)
        } catch (e) {
          console.warn(
            `GitHub update check of ${m.source.owner}/${m.source.repo} failed: ${errMsg(e)}`
          )
        }
        continue
      }
      if (!installs || !autoAllows(configOf(m).updateMode)) continue
      try {
        const found = await latestFor(def.label, profileId, m, latestOf)
        if (!needsUpdate(found.mod, found.latest)) continue
        const mod = await updateMod(
          def,
          catalog,
          profileId,
          found.mod,
          found.latest,
          token,
          autoAllows
        )
        if (mod) done.push({ name: mod.name, tag: found.latest.tag })
      } catch (e) {
        console.warn(
          `GitHub auto-update of ${m.source.owner}/${m.source.repo} failed: ${errMsg(e)}`
        )
      }
    }
    if (done.length > 0) {
      deps.emit({ type: 'github-updated', game: def.label, profileId, mods: done })
    }
    if (fresh.length > 0) {
      for (const key of fresh) announced.add(key)
      deps.emit({
        type: 'github-updates-available',
        game: def.label,
        profileId,
        count: fresh.length
      })
    }
  }

  async function runAutoUpdate(): Promise<void> {
    try {
      const catalog = await ctx.getCatalog()
      const dirs = await fs.readdir(paths.gamesDir, { withFileTypes: true }).catch(() => [])
      const token = await loadToken(paths, deps.secrets)
      const latestOf = memoLookup(token)
      for (const d of dirs) {
        if (!d.isDirectory()) continue
        const def = catalog.games.find((g) => g.label === d.name)
        if (!def?.supported) continue
        // Replacing files under a running game can leave a mod half-removed (Windows locks DLLs),
        // so only the read-only notify-mode lookups run then.
        const installs = !(await ctx.isGameRunning(def))
        try {
          for (const profile of await listProfiles(paths, def.label)) {
            // A follower's mods come from its sync code; the owner updates them.
            if (profile.sync?.role === 'follower') continue
            try {
              await autoUpdateProfile(def, catalog, profile.id, token, latestOf, installs)
            } catch (e) {
              console.warn(`GitHub auto-update of ${def.label}/${profile.id} failed: ${errMsg(e)}`)
            }
          }
        } catch (e) {
          console.warn(`GitHub auto-update of ${def.label} failed: ${errMsg(e)}`)
        }
      }
    } catch (e) {
      console.warn(`GitHub auto-update failed: ${errMsg(e)}`)
    }
  }

  async function setToken(raw: string | null): Promise<{ login: string | null }> {
    const token = raw?.trim() ?? ''
    if (token === '') {
      await saveToken(paths, deps.secrets, null)
      return { login: null }
    }
    if (!looksLikeToken(token)) throw new Error(BAD_TOKEN)
    // Don't send a token to GitHub that can't be stored afterwards.
    if (!deps.secrets.isAvailable()) throw new Error(NO_SECURE_STORAGE)
    const login = await fetchLogin({ fetch: deps.fetch, token })
    await saveToken(paths, deps.secrets, token)
    return { login }
  }

  async function tokenStatus(): Promise<{ set: boolean; encryptionAvailable: boolean }> {
    return {
      set: (await loadToken(paths, deps.secrets)) !== null,
      encryptionAvailable: deps.secrets.isAvailable()
    }
  }

  async function ghMod(game: string, profileId: string, modId: string): Promise<GhMod> {
    const { mods } = await getProfile(paths, game, profileId)
    const mod = mods.find((m) => m.id === modId)
    if (!mod || !isGhMod(mod)) throw new Error(`${modId} isn't a GitHub mod.`)
    return mod
  }

  async function listReleases(
    game: string,
    profileId: string,
    modId: string
  ): Promise<GhReleaseChoice[]> {
    await ctx.requireGame(game)
    const mod = await ghMod(game, profileId, modId)
    const releases = await fetchReleaseList({
      fetch: deps.fetch,
      token: await loadToken(paths, deps.secrets),
      cacheFile: paths.ghCache,
      now: deps.now,
      owner: mod.source.owner,
      repo: mod.source.repo,
      maxAgeMs: GH_RELEASE_MEMO_MS
    })
    const pattern = patternOf(mod)
    return releases.map((r) => ({
      tag: r.tag,
      name: r.name,
      prerelease: r.prerelease,
      publishedAt: r.publishedAt,
      installed: r.tag === mod.source.tag,
      // A release without the file the mod uses can't be installed over it.
      hasAsset: r.assets.some((a) => matchesAssetPattern(pattern, a.name))
    }))
  }

  /**
   * Installs release `tag` of a GitHub mod. Any release but the newest one the mod follows holds
   * it there (update mode 'pinned'); the newest one lets a held mod update again.
   */
  async function installRelease(
    game: string,
    profileId: string,
    modId: string,
    tag: string
  ): Promise<InstalledMod> {
    const def = await ctx.requireGame(game)
    if (!def.supported) throw new Error(unsupportedLoaderMessage(def))
    const catalog = await ctx.getCatalog()
    const mod = await ghMod(game, profileId, modId)
    const { owner, repo } = mod.source
    const token = await loadToken(paths, deps.secrets)
    const release = await lookup(token, owner, repo, { tag })
    const newest = await latestFor(game, profileId, mod, memoLookup(token)).then(
      (r) => r.latest.tag,
      () => null
    )
    const pin = release.tag !== newest
    const chosen = await chooseByPattern(token, release, patternOf(mod))
    if ('ask' in chosen) {
      throw new Error(
        `${owner}/${repo} ${release.tag} has several files and HML can't tell which one replaces ${mod.source.asset}.`
      )
    }
    return serialize(game, profileId, async () => {
      const current = await ghMod(game, profileId, modId)
      const keep = configOf(current)
      const updateMode: GhUpdateMode = pin
        ? 'pinned'
        : keep.updateMode === 'pinned'
          ? 'auto'
          : keep.updateMode
      const { mod: installed } = await installChosen(def, catalog, profileId, {
        owner,
        repo,
        release,
        chosen,
        packageId: current.id,
        config: () => ({ ...keep, updateMode })
      })
      return installed
    })
  }

  let running: Promise<void> | null = null
  return {
    ghSetToken: setToken,
    ghTokenStatus: tokenStatus,
    ghInstall: (game, profileId, url, asset, opts) =>
      install(game, profileId, url, asset, { prereleases: opts?.prereleases === true }),
    ghInstallWith: install,
    ghCheckUpdates: checkUpdates,
    ghUpdate: update,
    ghSetUpdateMode: setUpdateMode,
    ghSetPrereleases: setPrereleases,
    ghListReleases: listReleases,
    ghInstallRelease: installRelease,
    ghAutoUpdateAll() {
      running ??= runAutoUpdate().finally(() => {
        running = null
      })
      return running
    }
  }
}
