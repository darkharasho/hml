import { promises as fs } from 'node:fs'
import { zipSync } from 'fflate'
import type {
  Catalog,
  GameDef,
  GhModConfig,
  GhUpdate,
  GhUpdateMode,
  InstalledMod
} from '../../shared/types'
import type { HmlApi } from '../../shared/ipc'
import type { ServiceDeps } from '../services'
import { detectPackageMeta, installZip, readZipEntries } from '../install/installer'
import { getProfile, listProfiles, saveProfile } from '../profiles/profiles'
import { parseGithubUrl } from './url'
import { assetPattern, chooseAsset, type GhReleaseAsset } from './assets'
import {
  downloadAsset,
  fetchLogin,
  fetchRelease,
  GH_RELEASE_MEMO_MS,
  isNewerTag,
  type GhRelease
} from './api'
import { loadToken, saveToken } from './token'

export const GH_CHECK_INTERVAL_MS = 21_600_000

export interface GhContext {
  deps: ServiceDeps
  getCatalog(): Promise<Catalog>
  requireGame(label: string): Promise<GameDef>
  serialize<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T>
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

interface Chosen {
  asset: GhReleaseAsset
  data: Uint8Array
  sha256: string
}

const BAD_TOKEN = "That doesn't look like a GitHub token."

/** True for an empty-free token without whitespace or control characters, at most 255 long. */
function looksLikeToken(t: string): boolean {
  if (t.length > 255) return false
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) return false
  }
  return true
}

export function createGithubServices(ctx: GhContext): Pick<
  HmlApi,
  'ghInstall' | 'ghCheckUpdates' | 'ghUpdate' | 'ghSetUpdateMode' | 'ghSetToken' | 'ghTokenStatus'
> & {
  ghAutoUpdateAll(): Promise<void>
} {
  const { deps, serialize } = ctx
  const { paths } = deps

  const lookup = (
    token: string | null,
    owner: string,
    repo: string,
    opts: { tag?: string; maxAgeMs?: number } = {}
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

  /** One release lookup per owner/repo (case-insensitive) for the life of the returned function. */
  function memoLookup(
    token: string | null,
    maxAgeMs?: number
  ): (owner: string, repo: string) => Promise<GhRelease> {
    const seen = new Map<string, Promise<GhRelease>>()
    return (owner, repo) => {
      const key = `${owner}/${repo}`.toLowerCase()
      let p = seen.get(key)
      if (!p) {
        p = lookup(token, owner, repo, { maxAgeMs })
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
    }
  ): Promise<{ mod: InstalledMod; replaced: string[] }> {
    const { owner, repo, release, chosen, packageId } = o
    const data = /\.dll$/i.test(chosen.asset.name)
      ? zipSync({ [chosen.asset.name]: chosen.data })
      : chosen.data
    const meta = detectPackageMeta(readZipEntries(data), packageId)
    const name = meta?.name ?? packageId
    const version = meta && meta.version !== '0.0.0' ? meta.version : stripV(release.tag)
    o.onInstalling?.(name, version)

    const { mods } = await getProfile(paths, def.label, profileId)
    const local = mods.filter((m) => m.source.kind === 'local' && m.id === name)
    const sameRepoMods = mods.filter(
      (m) =>
        isGhMod(m) &&
        sameRepo(m.source.owner, owner) &&
        sameRepo(m.source.repo, repo) &&
        m.id !== packageId
    )
    const previous = mods.find((m) => m.id === packageId) ?? sameRepoMods[0]
    const mod = await installZip(
      paths,
      def,
      catalog,
      profileId,
      data,
      {
        kind: 'github',
        owner,
        repo,
        tag: release.tag,
        asset: chosen.asset.name,
        sha256: chosen.sha256
      },
      {
        packageId,
        version,
        replaces: [...local, ...sameRepoMods].map((m) => m.id).filter((id) => id !== packageId),
        github: o.config(previous)
      }
    )
    return { mod, replaced: local.map((m) => m.id) }
  }

  /** Downloads and installs `release` over an installed GitHub mod, keeping its config. */
  async function updateMod(
    def: GameDef,
    catalog: Catalog,
    profileId: string,
    mod: GhMod,
    release: GhRelease,
    token: string | null
  ): Promise<InstalledMod | null> {
    const { owner, repo } = mod.source
    const chosen = await chooseByPattern(token, release, configOf(mod).assetPattern)
    if ('ask' in chosen) {
      throw new Error(
        `${owner}/${repo} ${release.tag} has several files and none matches the one you picked before. Reinstall it from its GitHub link to choose again.`
      )
    }
    return serialize(def.label, profileId, async () => {
      const { mods } = await getProfile(paths, def.label, profileId)
      const current = mods.find((m) => m.id === mod.id)
      if (!current || !isGhMod(current)) return null
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

  const needsUpdate = (m: GhMod, latest: GhRelease): boolean => isNewerTag(latest.tag, m.source.tag)

  async function install(
    game: string,
    profileId: string,
    url: string,
    assetArg?: string
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
    const release = await lookup(token, owner, repo, { tag: ref.tag })
    const { mods } = await getProfile(paths, game, profileId)
    const prior = mods.find(
      (m) => isGhMod(m) && sameRepo(m.source.owner, owner) && sameRepo(m.source.repo, repo)
    )

    const named = assetArg ?? ref.asset
    const onDownload = (a: GhReleaseAsset): void => progress(`Downloading ${a.name}`, 1)
    let chosen: Chosen
    if (named !== undefined) {
      const asset = release.assets.find((a) => a.name === named)
      if (!asset) throw new Error(`${release.tag} has no file named ${named}.`)
      chosen = await download(token, asset, onDownload)
    } else {
      const r = await chooseByPattern(
        token,
        release,
        prior ? configOf(prior).assetPattern : null,
        onDownload
      )
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

    return serialize(game, profileId, async () => {
      const { mod, replaced } = await installChosen(def, catalog, profileId, {
        owner,
        repo,
        release,
        chosen,
        packageId: prior?.id ?? `${owner}-${repo}`,
        onInstalling: (name, version) => progress(`Installing ${name} ${version}`, 2),
        config: (previous) => ({
          updateMode: ref.tag ? 'pinned' : (previous?.github?.updateMode ?? 'auto'),
          assetPattern:
            named !== undefined
              ? assetPattern(chosen.asset.name, release.tag)
              : (previous?.github?.assetPattern ?? null)
        })
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
    for (const m of mods.filter(isGhMod)) {
      const mode = configOf(m).updateMode
      if (mode === 'pinned') continue
      try {
        const latest = await latestOf(m.source.owner, m.source.repo)
        if (needsUpdate(m, latest)) {
          out.push({
            modId: m.id,
            owner: m.source.owner,
            repo: m.source.repo,
            current: m.source.tag,
            latest: latest.tag,
            mode
          })
        }
      } catch {
        // a failing lookup skips this mod
      }
    }
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
    for (const m of mods.filter(isGhMod)) {
      if (!wanted.has(m.id) || configOf(m).updateMode === 'pinned') continue
      const slug = `${m.source.owner}/${m.source.repo}`
      try {
        const latest = await latestOf(m.source.owner, m.source.repo)
        if (!needsUpdate(m, latest)) continue
        const mod = await updateMod(def, catalog, profileId, m, latest, token)
        if (mod) updated.push(mod)
      } catch (e) {
        throw new Error(`${slug}: ${errMsg(e)}`, { cause: e })
      }
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

  async function autoUpdateProfile(
    def: GameDef,
    catalog: Catalog,
    profileId: string,
    token: string | null,
    latestOf: (owner: string, repo: string) => Promise<GhRelease>
  ): Promise<void> {
    const { mods } = await getProfile(paths, def.label, profileId)
    const done: { name: string; tag: string }[] = []
    for (const m of mods.filter(isGhMod)) {
      if (configOf(m).updateMode !== 'auto') continue
      try {
        const latest = await latestOf(m.source.owner, m.source.repo)
        if (!needsUpdate(m, latest)) continue
        const mod = await updateMod(def, catalog, profileId, m, latest, token)
        if (mod) done.push({ name: mod.name, tag: latest.tag })
      } catch (e) {
        console.warn(
          `GitHub auto-update of ${m.source.owner}/${m.source.repo} failed: ${errMsg(e)}`
        )
      }
    }
    if (done.length > 0) {
      deps.emit({ type: 'github-updated', game: def.label, profileId, mods: done })
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
        try {
          for (const profile of await listProfiles(paths, def.label)) {
            try {
              await autoUpdateProfile(def, catalog, profile.id, token, latestOf)
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

  let running: Promise<void> | null = null
  return {
    ghSetToken: setToken,
    ghTokenStatus: tokenStatus,
    ghInstall: install,
    ghCheckUpdates: checkUpdates,
    ghUpdate: update,
    ghSetUpdateMode: setUpdateMode,
    ghAutoUpdateAll() {
      running ??= runAutoUpdate().finally(() => {
        running = null
      })
      return running
    }
  }
}
