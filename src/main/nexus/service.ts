import type {
  Catalog,
  GameDef,
  InstalledMod,
  NxFile,
  NxInstallResult,
  NxStatus,
  NxUpdate,
  NxUser
} from '../../shared/types'
import type { HmlApi } from '../../shared/ipc'
import { NX_NO_KEY, noSecureStorage } from '../../shared/messages'
import { unsupportedLoaderMessage } from '../github/service'
import type { ServiceDeps } from '../services'
import { detectPackageMeta, installZip } from '../install/installer'
import { readArchive } from '../install/archive'
import { getProfile } from '../profiles/profiles'
import { loadSettings } from '../store/settings'
import { loadSecret, saveSecret } from '../secrets'
import {
  downloadFile,
  downloadLinks,
  getMod,
  modFiles,
  NxPremiumRequiredError,
  NxRejectedKeyError,
  searchMods,
  validateKey,
  type NxClientOpts
} from './api'
import type { NexusGames } from './games'
import type { NxmLink } from './nxm'

export interface NexusContext {
  deps: ServiceDeps
  client: NxClientOpts
  games: NexusGames
  getCatalog(): Promise<Catalog>
  requireGame(label: string): Promise<GameDef>
  serialize<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T>
}

const NX_FILES_MEMO_MS = 600_000
const BAD_KEY = "That doesn't look like a Nexus Mods API key."
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type NxMod = InstalledMod & { source: Extract<InstalledMod['source'], { kind: 'nexus' }> }
const isNxMod = (m: InstalledMod): m is NxMod => m.source.kind === 'nexus'

function looksLikeKey(k: string): boolean {
  if (k.length > 512) return false
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i)
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) return false
  }
  return true
}

/** The newest MAIN file by date, regardless of the unreliable `primary` flag. */
const newestMain = (files: NxFile[]): NxFile | undefined =>
  files.filter((f) => f.category === 'MAIN').sort((a, b) => b.date - a.date)[0]

const filePageUrl = (domain: string, modId: number, fileId: number): string =>
  `https://www.nexusmods.com/${domain}/mods/${modId}?tab=files&file_id=${fileId}`

export function createNexusServices(ctx: NexusContext): Pick<
  HmlApi,
  'nxSetKey' | 'nxStatus' | 'nxSearch' | 'nxGetMod' | 'nxInstall' | 'nxCheckUpdates' | 'nxUpdate'
> & {
  installFromNxm(link: NxmLink): Promise<{ game: string; profileId: string; mod: InstalledMod }>
  /** The logged-in Nexus user's id (validating the key if needed); null without a key. */
  loggedInUserId(): Promise<number | null>
} {
  const { deps, client, games, serialize } = ctx
  const { paths } = deps
  const now = deps.now ?? Date.now

  // The validated account, kept in memory for the session. Never the email.
  let user: (NxUser & { userId: number }) | null = null
  let validated = false

  const loadKey = (): Promise<string | null> => loadSecret(paths.nxKey, deps.secrets)

  async function setKey(raw: string | null): Promise<NxUser | null> {
    const key = raw?.trim() ?? ''
    if (key === '') {
      await saveSecret(paths.nxKey, deps.secrets, null, 'a Nexus Mods API key')
      user = null
      validated = false
      return null
    }
    if (!looksLikeKey(key)) throw new Error(BAD_KEY)
    // Don't send a key to Nexus Mods that can't be stored afterwards.
    if (!deps.secrets.isAvailable()) {
      throw new Error(noSecureStorage('a Nexus Mods API key'))
    }
    const who = await validateKey(client, key)
    await saveSecret(paths.nxKey, deps.secrets, key, 'a Nexus Mods API key')
    user = who
    validated = true
    return { name: who.name, isPremium: who.isPremium }
  }

  async function status(): Promise<NxStatus> {
    const key = await loadKey()
    if (key && !validated) {
      try {
        user = await validateKey(client, key)
        validated = true
      } catch (e) {
        user = null
        // A rejected key is final for this session; a network failure is retried next time.
        if (e instanceof NxRejectedKeyError) validated = true
      }
    }
    return {
      set: key !== null,
      encryptionAvailable: deps.secrets.isAvailable(),
      user: key && user ? { name: user.name, isPremium: user.isPremium } : null,
      handler: await deps.nxmHandler.status()
    }
  }

  async function currentUser(key: string): Promise<NxUser & { userId: number }> {
    if (!user) {
      user = await validateKey(client, key)
      validated = true
    }
    return user
  }

  async function requireDomain(
    def: GameDef,
    settings: Awaited<ReturnType<typeof loadSettings>>
  ): Promise<{ domain: string; gameId: number }> {
    const found = await games.domainFor(def, settings)
    if (!found) {
      throw new Error(
        `${def.displayName} isn't on Nexus Mods. Set its Nexus domain in the game's menu.`
      )
    }
    return found
  }

  /** Installs follow the Thunderstore and GitHub rule: no installs for unsupported loaders. */
  function requireSupported(def: GameDef): void {
    if (!def.supported) throw new Error(unsupportedLoaderMessage(def))
  }

  const domainOf = async (
    game: string
  ): Promise<{ def: GameDef; domain: string; gameId: number }> => {
    const def = await ctx.requireGame(game)
    return { def, ...(await requireDomain(def, await loadSettings(paths))) }
  }

  /** Downloads one file, installs it under `nexus-<modId>` and returns the installed mod. */
  async function downloadAndInstall(
    def: GameDef,
    profileId: string,
    o: {
      domain: string
      modId: number
      file: { fileId: number; version: string }
      key: string
      nxm?: { key: string; expires: number }
    }
  ): Promise<{ mod: InstalledMod; replaced: string[] }> {
    const { domain, modId, file, key } = o
    const links = await downloadLinks(client, key, domain, modId, file.fileId, o.nxm)
    if (links.length === 0) throw new Error('Nexus Mods returned no download link for that file.')
    const info = await getMod(client, domain, modId)
    const bytes = await downloadFile(client, links[0])
    const entries = await readArchive(bytes)
    const catalog = await ctx.getCatalog()
    const packageId = `nexus-${modId}`
    const name = info.name || packageId
    const version = file.version || info.version || '0.0.0'
    return serialize(def.label, profileId, async () => {
      const { mods } = await getProfile(paths, def.label, profileId)
      const manifestName = detectPackageMeta(entries, packageId)?.name
      const local = mods.filter(
        (m) => m.source.kind === 'local' && m.id === manifestName && m.id !== packageId
      )
      const mod = await installZip(
        paths,
        def,
        catalog,
        profileId,
        entries,
        { kind: 'nexus', domain, modId, fileId: file.fileId },
        { packageId, name, version, replaces: local.map((m) => m.id) }
      )
      return { mod, replaced: local.map((m) => m.id) }
    })
  }

  async function install(
    game: string,
    profileId: string,
    modId: number,
    fileId?: number
  ): Promise<NxInstallResult> {
    const { def, domain, gameId } = await domainOf(game)
    requireSupported(def)
    const key = await loadKey()
    if (!key) throw new Error(NX_NO_KEY)
    const files = await modFiles(client, gameId, modId)
    const file = fileId === undefined ? newestMain(files) : files.find((f) => f.fileId === fileId)
    if (!file) {
      throw new Error(
        fileId === undefined
          ? 'This mod has no main file to install.'
          : 'That file is no longer on Nexus Mods.'
      )
    }
    return installFile(def, profileId, domain, modId, file, key)
  }

  /** Premium accounts install directly; free ones are sent to the file page. */
  async function installFile(
    def: GameDef,
    profileId: string,
    domain: string,
    modId: number,
    file: NxFile,
    key: string
  ): Promise<NxInstallResult> {
    const openWebsite: NxInstallResult = {
      kind: 'open-website',
      url: filePageUrl(domain, modId, file.fileId)
    }
    if (!(await currentUser(key)).isPremium) return openWebsite
    try {
      const { mod, replaced } = await downloadAndInstall(def, profileId, {
        domain,
        modId,
        file,
        key
      })
      return { kind: 'installed', mod, replaced }
    } catch (e) {
      if (e instanceof NxPremiumRequiredError) return openWebsite
      throw e
    }
  }

  // Per mod file lists, shared across update checks for 10 minutes.
  const filesMemo = new Map<string, { at: number; promise: Promise<NxFile[]> }>()
  function memoFiles(domain: string, gameId: number, modId: number): Promise<NxFile[]> {
    const k = `${domain}/${modId}`
    const hit = filesMemo.get(k)
    if (hit && now() - hit.at < NX_FILES_MEMO_MS) return hit.promise
    const promise = modFiles(client, gameId, modId)
    filesMemo.set(k, { at: now(), promise })
    promise.catch(() => {
      if (filesMemo.get(k)?.promise === promise) filesMemo.delete(k)
    })
    return promise
  }

  /** The newer MAIN file when `m` was installed from a MAIN file and a later one exists. */
  function newerFile(m: NxMod, files: NxFile[]): NxFile | null {
    const installed = files.find((f) => f.fileId === m.source.fileId)
    if (installed?.category !== 'MAIN') return null
    const latest = newestMain(files)
    return latest && latest.fileId !== installed.fileId && latest.date > installed.date
      ? latest
      : null
  }

  async function checkUpdates(game: string, profileId: string): Promise<NxUpdate[]> {
    const { domain, gameId } = await domainOf(game)
    const { mods } = await getProfile(paths, game, profileId)
    const out: NxUpdate[] = []
    for (const m of mods.filter(isNxMod)) {
      try {
        const latest = newerFile(m, await memoFiles(domain, gameId, m.source.modId))
        if (latest) {
          out.push({
            modId: m.id,
            domain: m.source.domain,
            nexusModId: m.source.modId,
            current: m.version,
            latest: latest.version,
            latestFileId: latest.fileId
          })
        }
      } catch (e) {
        console.warn(`Nexus update check of ${m.name} failed: ${errMsg(e)}`)
      }
    }
    return out
  }

  async function update(
    game: string,
    profileId: string,
    modIds: string[]
  ): Promise<NxInstallResult[]> {
    const { def, domain, gameId } = await domainOf(game)
    requireSupported(def)
    const key = await loadKey()
    if (!key) throw new Error(NX_NO_KEY)
    const { mods } = await getProfile(paths, game, profileId)
    const wanted = new Set(modIds)
    const results: NxInstallResult[] = []
    const failed: string[] = []
    for (const m of mods.filter(isNxMod)) {
      if (!wanted.has(m.id)) continue
      try {
        const latest = newerFile(m, await modFiles(client, gameId, m.source.modId))
        if (!latest) continue
        results.push(await installFile(def, profileId, domain, m.source.modId, latest, key))
      } catch (e) {
        failed.push(`${m.name}: ${errMsg(e)}`)
      }
    }
    if (failed.length > 0) {
      const done =
        results.length > 0
          ? `Updated ${results.length} of ${results.length + failed.length} Nexus mods. `
          : ''
      throw new Error(done + failed.join(' '))
    }
    return results
  }

  async function installFromNxm(
    link: NxmLink
  ): Promise<{ game: string; profileId: string; mod: InstalledMod }> {
    const catalog = await ctx.getCatalog()
    const settings = await loadSettings(paths)
    let def: GameDef | undefined
    for (const g of catalog.games) {
      if ((await games.cachedDomain(g, settings)) === link.domain) {
        def = g
        break
      }
    }
    if (!def) throw new Error(`Open ${link.domain} in HML before downloading its mods.`)
    requireSupported(def)
    const profileId = settings.lastProfile[def.label]
    if (!profileId) throw new Error(`Pick a profile for ${def.displayName} in HML first.`)
    const key = await loadKey()
    if (!key) throw new Error(NX_NO_KEY)
    const { gameId } = await requireDomain(def, settings)
    const files = await modFiles(client, gameId, link.modId)
    const file = files.find((f) => f.fileId === link.fileId) ?? {
      fileId: link.fileId,
      version: ''
    }
    const { mod } = await downloadAndInstall(def, profileId, {
      domain: link.domain,
      modId: link.modId,
      file,
      key,
      nxm: { key: link.key, expires: link.expires }
    })
    return { game: def.label, profileId, mod }
  }

  return {
    nxSetKey: setKey,
    nxStatus: status,
    async nxSearch(game, q) {
      const { domain } = await domainOf(game)
      return searchMods(client, domain, q)
    },
    async nxGetMod(game, modId) {
      const { domain, gameId } = await domainOf(game)
      const [mod, files] = await Promise.all([
        getMod(client, domain, modId),
        modFiles(client, gameId, modId)
      ])
      const shown = new Set(['MAIN', 'UPDATE', 'OPTIONAL', 'MISCELLANEOUS'])
      return { domain, mod, files: files.filter((f) => shown.has(f.category)) }
    },
    nxInstall: install,
    nxCheckUpdates: checkUpdates,
    nxUpdate: update,
    installFromNxm,
    async loggedInUserId() {
      const key = await loadKey()
      return key ? (await currentUser(key)).userId : null
    }
  }
}
