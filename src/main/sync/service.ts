import { promises as fs } from 'node:fs'
import type {
  GameDef,
  HmlCustomGame,
  HmlExport,
  ProfileManifest,
  ProfileSync
} from '../../shared/types'
import { noSecureStorage } from '../../shared/messages'
import { normalizeSyncCode } from '../../shared/shareCode'
import { getProfile, listProfiles, saveProfile } from '../profiles/profiles'
import { loadSecret, saveSecret } from '../secrets'
import type { ServiceDeps } from '../services'
import { collectHmlParts, readHmlFile, zipHmlParts } from '../share/hmlFile'
import type { SyncApplyResult } from './apply'
import { clearBases, writeBases } from './bases'
import {
  createSync,
  endSync,
  fetchSync,
  publishSync,
  SyncGoneError,
  type SyncClientOptions
} from './client'
import { matchesManualEntry } from './lock'
import { revisionDigest } from './revision'

export const SYNC_DEBOUNCE_MS = 10_000
export const SYNC_POLL_MS = 300_000
export const SYNC_HOLD_RETRY_MS = 30_000
export const SYNC_LAUNCH_CHECK_MS = 10_000
/** A behind follower re-applies its revision at most this often (startup and launch excepted). */
export const SYNC_BEHIND_RETRY_MS = 3_600_000

export interface SyncTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}

export interface SyncContext {
  deps: ServiceDeps
  /** The raw profile lock: must NOT notify `touched`, or publishing would re-trigger itself. */
  lock<T>(game: string, profileId: string, fn: () => Promise<T>): Promise<T>
  requireGame(label: string): Promise<GameDef>
  getCustomGame(label: string): Promise<HmlCustomGame | null>
  /** isGameProcessRunning === true for the game's exes. */
  isGameRunning(def: GameDef): Promise<boolean>
  apply(
    game: string,
    profileId: string,
    rev: { export: HmlExport; configs: Map<string, Uint8Array> }
  ): Promise<SyncApplyResult>
  timers?: SyncTimers
}

type OwnerSync = Extract<ProfileSync, { role: 'owner' }>
type FollowerSync = Extract<ProfileSync, { role: 'follower' }>
type Parts = { export: HmlExport; configs: Map<string, Uint8Array> }

/** In-memory state of one profile: its debounce timer and the publish under way. */
interface ProfileState {
  timer?: unknown
  publishing?: Promise<void>
  /** A publish was asked for while one ran: run once more when it ends. */
  dirty?: boolean
  /** Follower: the check under way. */
  checking?: Promise<void>
  /** Follower: true while a revision is being applied. */
  applying?: boolean
  /** Follower: the retry scheduled while the game runs. */
  holdTimer?: unknown
  /** Follower: the revision this HML couldn't read, already reported. */
  lastErrorRevision?: number
  /** Follower: a revision fetched but held while the game runs, so a retry needn't download it. */
  held?: { code: string; revision: number; rev: Parts }
  /** Follower: launched before a check finished; hold applies until then (ms since epoch). */
  launchHoldUntil?: number
  /** Follower: a detach is waiting for the check under way; that check must not apply. */
  detaching?: boolean
  /**
   * Follower: from the running-game test until the apply ends, so a launch whose check timed out
   * waits for it instead of starting the game on a half-updated profile.
   */
  committed?: boolean
  /** Follower: when a behind profile last re-fetched its revision to retry (ms since epoch). */
  behindRetryAt?: number
  /** Follower: the revision and failed mods last reported, so a retry doesn't repeat it. */
  failedNotice?: string
}

const DEPLOY_KEY = '__deploy__'
const WHAT = 'sync codes'
const FOLLOWER_CREATE = 'Detach this profile from its sync before creating a sync code.'
const FOLLOWER_STOP = 'This profile follows a sync code. Detach it instead.'
const NOT_FOLLOWER = "This profile isn't following a sync code."
const NO_SUCH_SYNC = 'No synced profile has that code. It may have ended.'

/** Counted changes only: failed mods are reported on their own, once (see failedNotice). */
const hasChanges = (r: SyncApplyResult): boolean =>
  r.added + r.removed + r.updated + r.enabled + r.disabled + r.configs > 0

const sameManual = (
  a: readonly { name: string; url: string }[] | undefined,
  b: readonly { name: string; url: string }[]
): boolean => {
  const key = (l: readonly { url: string }[]): string =>
    l
      .map((e) => e.url)
      .sort()
      .join('\n')
  return key(a ?? []) === key(b)
}

/** Identifies one report of failed mods: the revision and the mods' names. */
const failedKeyOf = (revision: number, names: readonly string[]): string =>
  [revision, ...[...names].sort()].join('\0')

const failedMessage = (profileName: string, n: number): string =>
  `${profileName}: ${n === 1 ? "1 mod couldn't" : `${n} mods couldn't`} be installed`

const localModCount = (p: ProfileManifest): number =>
  p.mods.filter((m) => m.source.kind === 'local').length

const sameOwner = (a: OwnerSync, b: OwnerSync): boolean =>
  a.code === b.code &&
  a.revision === b.revision &&
  a.digest === b.digest &&
  !!a.pending === !!b.pending &&
  !!a.orphaned === !!b.orphaned

const withFlags = (s: OwnerSync, flags: { pending?: boolean; orphaned?: boolean }): OwnerSync => {
  const { pending, orphaned, ...rest } = s
  const p = flags.pending ?? !!pending
  const o = flags.orphaned ?? !!orphaned
  return { ...rest, ...(p ? { pending: true } : {}), ...(o ? { orphaned: true } : {}) }
}

export function createSyncServices(ctx: SyncContext): {
  createSyncCode(game: string, profileId: string): Promise<{ code: string; localMods: number }>
  stopSync(game: string, profileId: string): Promise<void>
  touched(game: string, profileId: string): void
  publishNow(game: string, profileId: string): Promise<void>
  /** Owner: forget the key file (used by deleteProfile). */
  forgetOwnerKey(code: string): Promise<void>
  /** Follower: stop following; the profile keeps its mods and configs. */
  detachSync(game: string, profileId: string): Promise<void>
  /**
   * Follower: fetch and apply a newer revision. Never throws. A behind profile re-applies its
   * revision at most once per SYNC_BEHIND_RETRY_MS; beforeLaunch always retries.
   */
  checkFollower(game: string, profileId: string): Promise<void>
  /**
   * Follower: a check that gives up after SYNC_LAUNCH_CHECK_MS, unless it has already committed
   * to holding or applying a revision.
   */
  beforeLaunch(game: string, profileId: string): Promise<void>
  /** Startup and every SYNC_POLL_MS: check followers, publishNow owners, prune manual lists. */
  tick(): Promise<void>
  /** Import: make a fresh profile follow `code` at `revision`, with `configs` as its bases. */
  attachFollower(
    game: string,
    profileId: string,
    code: string,
    revision: number,
    configs: Map<string, Uint8Array>,
    /**
     * `behind`: some mods didn't install, so the next check re-applies this revision.
     * `failed`: the names of those the import already reported, so that retry doesn't repeat them.
     */
    opts?: { behind?: boolean; failed?: string[] }
  ): Promise<void>
  /** The profile that owns or follows this code. */
  findByCode(code: string): Promise<{ game: string; profileId: string } | null>
  /** Import: the newest revision of a code. */
  fetchLatest(code: string): Promise<{ revision: number; data: Uint8Array }>
  /** Follower: drops manual entries whose Nexus file is now installed. */
  pruneManual(game: string, profileId: string): Promise<void>
  /** True while applyRevision runs for this profile (lets the follower lock pass). */
  isApplying(game: string, profileId: string): boolean
  isFollower(game: string, profileId: string): Promise<boolean>
} {
  const { deps, lock } = ctx
  const timers = ctx.timers ?? {
    setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clearTimeout: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>)
  }
  const client = (): SyncClientOptions => ({ fetch: deps.fetch, base: deps.shareBaseUrl })

  const states = new Map<string, ProfileState>()
  const stateOf = (game: string, profileId: string): ProfileState => {
    const key = `${game}\0${profileId}`
    let st = states.get(key)
    if (!st) {
      st = {}
      states.set(key, st)
    }
    return st
  }
  /**
   * Profiles known to own a sync code (state key -> code), so `touched` costs nothing for any
   * other profile. Filled by createSyncCode and every publish (tick publishes each owner, so an
   * edit made before the first tick is still published); emptied by stopSync and forgetOwnerKey.
   */
  const owners = new Map<string, string>()
  // createSyncCode calls under way, so a double click doesn't make two codes.
  const creating = new Map<string, Promise<{ code: string; localMods: number }>>()

  const emitState = (game: string, profileId: string): void =>
    deps.emit({ type: 'sync-state', game, profileId })

  /** The key file for a stored code; a code that isn't valid never names a path. */
  const keyFile = (code: string): string | null => {
    const normalized = normalizeSyncCode(code)
    return normalized ? deps.paths.syncKey(normalized) : null
  }

  const collect = async (
    game: string,
    profileId: string,
    profile: ProfileManifest
  ): Promise<Parts> =>
    collectHmlParts(profile, deps.paths.profileDir(game, profileId), {
      customGame: (await ctx.getCustomGame(game)) ?? undefined
    })

  /**
   * Re-reads the manifest under the lock and changes its owner state, only while it is still the
   * owner of `code` (syncing may have stopped meanwhile). Emits `sync-state` when it changed.
   */
  async function updateOwner(
    game: string,
    profileId: string,
    code: string,
    change: (s: OwnerSync) => OwnerSync
  ): Promise<void> {
    const changed = await lock(game, profileId, async () => {
      const profile = await getProfile(deps.paths, game, profileId)
      const s = profile.sync
      if (s?.role !== 'owner' || s.code !== code) return false
      const next = change(s)
      if (sameOwner(s, next)) return false
      await saveProfile(deps.paths, { ...profile, sync: next })
      return true
    })
    if (changed) emitState(game, profileId)
  }

  /** One publish: collects under the lock, uploads outside it, saves the result under it again. */
  async function publishOnce(game: string, profileId: string): Promise<void> {
    const snap = await lock(game, profileId, async () => {
      const profile = await getProfile(deps.paths, game, profileId)
      const sync = profile.sync
      if (sync?.role === 'owner') owners.set(`${game}\0${profileId}`, sync.code)
      else owners.delete(`${game}\0${profileId}`)
      // An orphaned code can never publish again, so nothing is collected or sent.
      if (sync?.role !== 'owner' || sync.orphaned) return null
      const parts = await collect(game, profileId, profile)
      return { sync, parts, digest: revisionDigest(parts) }
    })
    if (!snap) return
    const { sync, parts, digest } = snap
    const code = sync.code
    if (digest === sync.digest) {
      if (sync.pending)
        await updateOwner(game, profileId, code, (s) => withFlags(s, { pending: false }))
      return
    }
    // Storage that is unavailable may come back; only a key that can't be read is lost.
    if (!deps.secrets.isAvailable()) {
      await updateOwner(game, profileId, code, (s) => withFlags(s, { pending: true }))
      return
    }
    const file = keyFile(code)
    const key = file ? await loadSecret(file, deps.secrets) : null
    if (!key) {
      await updateOwner(game, profileId, code, (s) =>
        withFlags(s, { pending: true, orphaned: true })
      )
      return
    }
    let revision: number
    try {
      revision = (await publishSync(client(), code, key, zipHmlParts(parts))).revision
    } catch (e) {
      const gone = e instanceof SyncGoneError
      await updateOwner(game, profileId, code, (s) =>
        withFlags(s, gone ? { orphaned: true } : { pending: true })
      )
      return
    }
    await updateOwner(game, profileId, code, (s) =>
      withFlags({ ...s, revision, digest }, { pending: false, orphaned: false })
    )
  }

  /** Single-flight per profile: a call during a publish runs one more publish after it. */
  function publishNow(game: string, profileId: string): Promise<void> {
    const st = stateOf(game, profileId)
    if (st.publishing) {
      st.dirty = true
      return st.publishing
    }
    const run = (async (): Promise<void> => {
      try {
        for (;;) {
          st.dirty = false
          try {
            await publishOnce(game, profileId)
          } catch (e) {
            if (!st.dirty) throw e
          }
          if (!st.dirty) return
        }
      } finally {
        st.publishing = undefined
      }
    })()
    st.publishing = run
    return run
  }

  /** (Re)starts the debounce before an owner's publish. */
  function schedulePublish(game: string, profileId: string): void {
    const st = stateOf(game, profileId)
    if (st.timer !== undefined) timers.clearTimeout(st.timer)
    st.timer = timers.setTimeout(() => {
      st.timer = undefined
      // Network failures are recorded as pending; anything else (disk, collect) is logged.
      publishNow(game, profileId).catch((e: unknown) => {
        console.warn(`Sync publish failed for ${game}/${profileId}:`, e)
      })
    }, SYNC_DEBOUNCE_MS)
  }

  function cancelTimer(game: string, profileId: string): void {
    const st = stateOf(game, profileId)
    if (st.timer !== undefined) timers.clearTimeout(st.timer)
    st.timer = undefined
  }

  async function createSyncCodeOnce(
    game: string,
    profileId: string
  ): Promise<{ code: string; localMods: number }> {
    type Snap = { existing: string; localMods: number } | { parts: Parts; localMods: number }
    const snap = await lock(game, profileId, async (): Promise<Snap> => {
      const profile = await getProfile(deps.paths, game, profileId)
      const localMods = localModCount(profile)
      if (profile.sync?.role === 'owner') return { existing: profile.sync.code, localMods }
      if (profile.sync?.role === 'follower') throw new Error(FOLLOWER_CREATE)
      if (!deps.secrets.isAvailable()) throw new Error(noSecureStorage(WHAT))
      return { parts: await collect(game, profileId, profile), localMods }
    })
    if ('existing' in snap) {
      owners.set(`${game}\0${profileId}`, snap.existing)
      return { code: snap.existing, localMods: snap.localMods }
    }

    const digest = revisionDigest(snap.parts)
    const created = await createSync(client(), zipHmlParts(snap.parts))
    const file = deps.paths.syncKey(created.code)
    const undo = async (): Promise<void> => {
      await endSync(client(), created.code, created.ownerKey).catch(() => undefined)
      await saveSecret(file, deps.secrets, null, WHAT).catch(() => undefined)
    }
    try {
      await saveSecret(file, deps.secrets, created.ownerKey, WHAT)
      await lock(game, profileId, async () => {
        const profile = await getProfile(deps.paths, game, profileId)
        if (profile.sync) throw new Error("This profile's sync changed. Try again.")
        const sync: OwnerSync = {
          role: 'owner',
          code: created.code,
          revision: created.revision,
          digest
        }
        await saveProfile(deps.paths, { ...profile, sync })
      })
    } catch (e) {
      await undo()
      throw e
    }
    owners.set(`${game}\0${profileId}`, created.code)
    emitState(game, profileId)
    return { code: created.code, localMods: snap.localMods }
  }

  /** The manifest, or null when the profile is gone. */
  const readProfile = (game: string, profileId: string): Promise<ProfileManifest | null> =>
    getProfile(deps.paths, game, profileId).catch(() => null)

  /**
   * Re-reads the manifest under the lock and changes its follower state, only while it still
   * follows `code` (a detach meanwhile wins). Returns the manifest as saved, or null.
   */
  async function updateFollower(
    game: string,
    profileId: string,
    code: string,
    change: (s: FollowerSync) => FollowerSync | undefined
  ): Promise<ProfileManifest | null> {
    return lock(game, profileId, async () => {
      const profile = await getProfile(deps.paths, game, profileId)
      const s = profile.sync
      if (s?.role !== 'follower' || s.code !== code) return null
      const next: ProfileManifest = { ...profile }
      const sync = change(s)
      if (sync) next.sync = sync
      else delete next.sync
      await saveProfile(deps.paths, next)
      return next
    })
  }

  function scheduleHold(game: string, profileId: string): void {
    const st = stateOf(game, profileId)
    if (st.holdTimer !== undefined) return
    st.holdTimer = timers.setTimeout(() => {
      st.holdTimer = undefined
      void checkFollower(game, profileId, { fromHold: true })
    }, SYNC_HOLD_RETRY_MS)
  }

  function cancelHold(game: string, profileId: string): void {
    const st = stateOf(game, profileId)
    if (st.holdTimer !== undefined) timers.clearTimeout(st.holdTimer)
    st.holdTimer = undefined
  }

  /** Whether the profile still follows `code`. */
  const stillFollowing = async (
    game: string,
    profileId: string,
    code: string
  ): Promise<boolean> => {
    const s = (await readProfile(game, profileId))?.sync
    return s?.role === 'follower' && s.code === code
  }

  interface CheckOptions {
    /** A retry of a held revision, which only re-tests whether it may apply what it downloaded. */
    fromHold?: boolean
    /** A behind profile re-applies its revision even within SYNC_BEHIND_RETRY_MS. */
    retryBehind?: boolean
  }

  /** One check. */
  async function checkOnce(game: string, profileId: string, opts: CheckOptions): Promise<void> {
    const { fromHold = false } = opts
    const st = stateOf(game, profileId)
    const profile = await readProfile(game, profileId)
    const sync = profile?.sync
    if (!profile || sync?.role !== 'follower') return
    const { code } = sync
    if (st.held && st.held.code !== code) st.held = undefined

    let revision: number
    let rev: Parts
    if (fromHold && st.held) {
      ;({ revision, rev } = st.held)
    } else {
      // A behind profile re-fetches its own revision to retry the mods that failed, but not on
      // every poll: a mod that can never install would re-apply (and re-index) every few minutes.
      // Between retries it asks only for newer revisions, like any follower.
      const now = Date.now()
      const retry =
        !!sync.behind &&
        (opts.retryBehind ||
          st.behindRetryAt === undefined ||
          now - st.behindRetryAt >= SYNC_BEHIND_RETRY_MS)
      if (retry) st.behindRetryAt = now
      // A revision this HML can't read, or one already held, isn't downloaded again.
      const since = Math.max(
        retry ? 0 : sync.revision,
        st.lastErrorRevision ?? 0,
        st.held?.revision ?? 0
      )
      const res = await fetchSync(client(), code, since)
      if (res.kind === 'ended' || res.kind === 'missing') {
        st.held = undefined
        const saved = await updateFollower(game, profileId, code, () => undefined)
        if (!saved) return
        cancelHold(game, profileId)
        await clearBases(deps.paths.profileDir(game, profileId))
        deps.emit({ type: 'sync-ended', game, profileId, profileName: saved.name })
        emitState(game, profileId)
        return
      }
      if (res.kind === 'unchanged') {
        if (!st.held || st.held.revision !== res.revision) return
        ;({ revision, rev } = st.held)
      } else {
        revision = res.revision
        if (st.lastErrorRevision === revision) return
        try {
          rev = await readHmlFile(res.data, { forImport: true })
        } catch {
          st.lastErrorRevision = revision
          deps.emit({
            type: 'sync-error',
            game,
            profileId,
            message: `Update HML to keep following ${profile.name}.`
          })
          return
        }
        if (rev.export.game !== game) {
          console.warn(`Sync ${code} is for ${rev.export.game}, not ${game}; ignored.`)
          return
        }
      }
    }

    const def = await ctx.requireGame(game)
    // Committed from here (no await before this line since the launch test): a launch whose
    // check times out now waits for this one, which either holds or applies.
    st.committed = true
    let result: SyncApplyResult
    try {
      if ((st.launchHoldUntil ?? 0) > Date.now() || (await ctx.isGameRunning(def))) {
        st.held = { code, revision, rev }
        scheduleHold(game, profileId)
        return
      }
      st.held = undefined
      cancelHold(game, profileId)
      // A detach since the manifest was read wins: its apply would merge against cleared bases.
      if (st.detaching || !(await stillFollowing(game, profileId, code))) return
      st.applying = true
      try {
        result = await ctx.apply(game, profileId, rev)
      } finally {
        st.applying = false
      }
    } finally {
      st.committed = false
    }
    const saved = await updateFollower(game, profileId, code, () => ({
      role: 'follower',
      code,
      revision,
      ...(result.failed.length > 0 ? { behind: true as const } : {}),
      ...(result.manual.length > 0 ? { manual: result.manual } : {})
    }))
    if (!saved) return
    // Manual downloads are news on a new revision, or when the list changed; not on a retry.
    const manual =
      revision !== sync.revision || !sameManual(sync.manual, result.manual) ? result.manual : []
    if (hasChanges(result) || manual.length > 0) {
      const { added, removed, updated, enabled, disabled, configs } = result
      const changes = { added, removed, updated, enabled, disabled, configs }
      deps.emit({ type: 'sync-applied', game, profileId, profileName: saved.name, changes, manual })
    }
    // Failures are told once per revision and failed set, not on every retry.
    const failedKey =
      result.failed.length > 0
        ? failedKeyOf(
            revision,
            result.failed.map((f) => f.name)
          )
        : undefined
    if (failedKey !== undefined && failedKey !== st.failedNotice) {
      deps.emit({
        type: 'sync-error',
        game,
        profileId,
        message: failedMessage(saved.name, result.failed.length)
      })
    }
    st.failedNotice = failedKey
    emitState(game, profileId)
  }

  /** Single-flight per profile; logs and swallows every failure. */
  function checkFollower(game: string, profileId: string, opts: CheckOptions = {}): Promise<void> {
    const st = stateOf(game, profileId)
    if (st.checking) return st.checking
    const run = checkOnce(game, profileId, opts)
      .catch((e: unknown) => {
        console.warn(`Sync check failed for ${game}/${profileId}:`, e)
      })
      .finally(() => {
        st.checking = undefined
      })
    st.checking = run
    return run
  }

  /** The game label, or null (logged) when the game is no longer known. */
  async function labelOf(game: string): Promise<string | null> {
    try {
      return (await ctx.requireGame(game)).label
    } catch (e) {
      console.warn(`Sync skipped for unknown game ${game}:`, e)
      return null
    }
  }

  async function* allProfiles(): AsyncGenerator<{ game: string; profile: ProfileManifest }> {
    let games: string[]
    try {
      const dirents = await fs.readdir(deps.paths.gamesDir, { withFileTypes: true })
      games = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return
    }
    for (const game of games) {
      let profiles: ProfileManifest[]
      try {
        profiles = await listProfiles(deps.paths, game)
      } catch {
        continue
      }
      for (const profile of profiles) yield { game, profile }
    }
  }

  /** Drops manual entries whose Nexus file (same mod and file id) is now installed. */
  async function pruneManual(game: string, profileId: string): Promise<void> {
    const changed = await lock(game, profileId, async () => {
      const profile = await getProfile(deps.paths, game, profileId)
      const sync = profile.sync
      if (sync?.role !== 'follower' || !sync.manual?.length) return false
      const installed = profile.mods.flatMap((m) => (m.source.kind === 'nexus' ? [m.source] : []))
      // The same file the entry names, not just the mod: an owner's newer file is still due.
      const manual = sync.manual.filter((e) => !installed.some((s) => matchesManualEntry([e], s)))
      if (manual.length === sync.manual.length) return false
      const next: FollowerSync = { ...sync, manual }
      if (manual.length === 0) delete next.manual
      await saveProfile(deps.paths, { ...profile, sync: next })
      return true
    })
    if (changed) emitState(game, profileId)
  }

  let ticking: Promise<void> | null = null
  async function tickOnce(): Promise<void> {
    const all: { game: string; profile: ProfileManifest }[] = []
    for await (const entry of allProfiles()) all.push(entry)
    // Every owner is known before any follower check (which can be slow), so edits to owners
    // made meanwhile are published after the debounce instead of waiting for the tick.
    for (const { game, profile } of all) {
      if (profile.sync?.role !== 'owner') continue
      const label = await labelOf(game)
      if (label) owners.set(`${label}\0${profile.id}`, profile.sync.code)
    }
    for (const { game, profile } of all) {
      try {
        const role = profile.sync?.role
        if (role === 'follower') {
          await pruneManual(game, profile.id)
          const label = await labelOf(game)
          if (label) await checkFollower(label, profile.id)
        } else if (role === 'owner') {
          const label = await labelOf(game)
          if (label) await publishNow(label, profile.id)
        }
      } catch (e) {
        console.warn(`Sync tick failed for ${game}/${profile.id}:`, e)
      }
    }
  }

  return {
    async createSyncCode(game, profileId) {
      const label = (await ctx.requireGame(game)).label
      const key = `${label}\0${profileId}`
      const held = creating.get(key)
      if (held) return held
      const p = createSyncCodeOnce(label, profileId).finally(() => creating.delete(key))
      creating.set(key, p)
      return p
    },

    async stopSync(game, profileId) {
      const label = (await ctx.requireGame(game)).label
      const sync = (await lock(label, profileId, () => getProfile(deps.paths, label, profileId)))
        .sync
      if (sync?.role !== 'owner') owners.delete(`${label}\0${profileId}`)
      if (!sync) return
      if (sync.role !== 'owner') throw new Error(FOLLOWER_STOP)
      // No publish while the code is being ended; a stop that fails keeps the one that was due.
      const due = stateOf(label, profileId).timer !== undefined
      cancelTimer(label, profileId)
      const file = keyFile(sync.code)
      try {
        if (file && !deps.secrets.isAvailable()) throw new Error(noSecureStorage(WHAT))
        const key = file ? await loadSecret(file, deps.secrets) : null
        // Without a key the code can't be ended on the server; it expires on its own.
        if (key) await endSync(client(), sync.code, key)
      } catch (e) {
        if (due) schedulePublish(label, profileId)
        throw e
      }
      const changed = await lock(label, profileId, async () => {
        const profile = await getProfile(deps.paths, label, profileId)
        if (profile.sync?.role !== 'owner' || profile.sync.code !== sync.code) return false
        const next: ProfileManifest = { ...profile }
        delete next.sync
        await saveProfile(deps.paths, next)
        return true
      })
      if (file) await saveSecret(file, deps.secrets, null, WHAT)
      owners.delete(`${label}\0${profileId}`)
      cancelTimer(label, profileId)
      if (changed) emitState(label, profileId)
    },

    // Runs after every serialized operation, so it is synchronous, never throws, and does nothing
    // for profiles that don't own a code (followers re-enter it while a revision is applied).
    touched(game, profileId) {
      if (profileId === DEPLOY_KEY || !owners.has(`${game}\0${profileId}`)) return
      schedulePublish(game, profileId)
    },

    async publishNow(game, profileId) {
      const label = (await ctx.requireGame(game)).label
      return publishNow(label, profileId)
    },

    async forgetOwnerKey(code) {
      // The profile is gone: drop it, and the publish its deletion scheduled.
      for (const [key, owned] of [...owners]) {
        if (owned !== code) continue
        owners.delete(key)
        const st = states.get(key)
        if (st?.timer !== undefined) timers.clearTimeout(st.timer)
        if (st) st.timer = undefined
      }
      const file = keyFile(code)
      if (file) await saveSecret(file, deps.secrets, null, WHAT)
    },

    async detachSync(game, profileId) {
      const label = (await ctx.requireGame(game)).label
      const st = stateOf(label, profileId)
      // A check under way finishes first (it never throws) and, seeing this flag, doesn't apply.
      st.detaching = true
      try {
        await st.checking
        await lock(label, profileId, async () => {
          const profile = await getProfile(deps.paths, label, profileId)
          if (profile.sync?.role !== 'follower') throw new Error(NOT_FOLLOWER)
          const next: ProfileManifest = { ...profile }
          delete next.sync
          await saveProfile(deps.paths, next)
        })
      } finally {
        st.detaching = false
      }
      cancelHold(label, profileId)
      st.lastErrorRevision = undefined
      st.held = undefined
      st.launchHoldUntil = undefined
      st.behindRetryAt = undefined
      st.failedNotice = undefined
      await clearBases(deps.paths.profileDir(label, profileId))
      emitState(label, profileId)
    },

    async checkFollower(game, profileId) {
      const label = await labelOf(game)
      if (label) await checkFollower(label, profileId)
    },

    async beforeLaunch(game, profileId) {
      const label = await labelOf(game)
      if (!label) return
      const check = checkFollower(label, profileId, { retryBehind: true }).then(
        () => 'done' as const
      )
      let timer: unknown
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = timers.setTimeout(() => resolve('timeout'), SYNC_LAUNCH_CHECK_MS)
      })
      const won = await Promise.race([check, timeout])
      const st = stateOf(label, profileId)
      if (won === 'done') timers.clearTimeout(timer)
      // Launching halfway through an apply would start the game on a half-updated profile.
      else if (st.committed) await check
      // The game may not show as running yet: hold any apply this late check would start.
      else st.launchHoldUntil = Date.now() + SYNC_HOLD_RETRY_MS
    },

    tick() {
      ticking ??= tickOnce().finally(() => {
        ticking = null
      })
      return ticking
    },

    async attachFollower(game, profileId, code, revision, configs, opts) {
      const normalized = normalizeSyncCode(code)
      if (!normalized) throw new Error("That isn't a valid sync code.")
      await lock(game, profileId, async () => {
        const profile = await getProfile(deps.paths, game, profileId)
        const sync: FollowerSync = {
          role: 'follower',
          code: normalized,
          revision,
          ...(opts?.behind ? { behind: true as const } : {})
        }
        // Bases first: a follower without bases would merge as if every owner value were new.
        await writeBases(deps.paths.profileDir(game, profileId), configs)
        await saveProfile(deps.paths, { ...profile, sync })
      })
      // The import already reported its failures; the retry it leads to shouldn't repeat them.
      const st = stateOf(game, profileId)
      st.behindRetryAt = undefined
      st.failedNotice = opts?.failed?.length ? failedKeyOf(revision, opts.failed) : undefined
      emitState(game, profileId)
    },

    async findByCode(code) {
      const normalized = normalizeSyncCode(code)
      if (!normalized) return null
      for await (const { game, profile } of allProfiles()) {
        if (profile.sync?.code === normalized) return { game, profileId: profile.id }
      }
      return null
    },

    async fetchLatest(code) {
      const res = await fetchSync(client(), code, 0)
      if (res.kind !== 'updated') throw new Error(NO_SUCH_SYNC)
      return { revision: res.revision, data: res.data }
    },

    async pruneManual(game, profileId) {
      const label = await labelOf(game)
      if (label) await pruneManual(label, profileId)
    },

    isApplying(game, profileId) {
      return !!states.get(`${game}\0${profileId}`)?.applying
    },

    async isFollower(game, profileId) {
      return (await readProfile(game, profileId))?.sync?.role === 'follower'
    }
  }
}
