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
import { revisionDigest } from './revision'

export const SYNC_DEBOUNCE_MS = 10_000
export const SYNC_POLL_MS = 300_000
export const SYNC_HOLD_RETRY_MS = 30_000
export const SYNC_LAUNCH_CHECK_MS = 10_000

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
}

const DEPLOY_KEY = '__deploy__'
const WHAT = 'sync codes'
const FOLLOWER_CREATE = 'Detach this profile from its sync before creating a sync code.'
const FOLLOWER_STOP = 'This profile follows a sync code. Detach it instead.'
const NOT_FOLLOWER = "This profile isn't following a sync code."
const NO_SUCH_SYNC = 'No synced profile has that code. It may have ended.'

/** The Nexus mod id in a mod page URL (`…/mods/<id>`), or null. */
const nexusModIdOf = (url: string): number | null => {
  const m = /\/mods\/(\d+)/.exec(url)
  return m ? Number(m[1]) : null
}

const hasChanges = (r: SyncApplyResult): boolean =>
  r.added + r.removed + r.updated + r.enabled + r.disabled + r.configs > 0 ||
  r.manual.length > 0 ||
  r.failed.length > 0

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
  /** Follower: fetch and apply a newer revision. Never throws. */
  checkFollower(game: string, profileId: string): Promise<void>
  /** Follower: a check that gives up after SYNC_LAUNCH_CHECK_MS unless it is mid-apply. */
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
    /** `behind`: some mods didn't install, so the next check re-applies this revision. */
    opts?: { behind?: boolean }
  ): Promise<void>
  /** The profile that owns or follows this code. */
  findByCode(code: string): Promise<{ game: string; profileId: string } | null>
  /** Import: the newest revision of a code. */
  fetchLatest(code: string): Promise<{ revision: number; data: Uint8Array }>
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
    if ('existing' in snap) return { code: snap.existing, localMods: snap.localMods }

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
      void checkFollower(game, profileId, true)
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

  /**
   * One check. `fromHold`: a retry of a held revision, which only re-tests whether it may apply
   * the revision it already downloaded.
   */
  async function checkOnce(game: string, profileId: string, fromHold: boolean): Promise<void> {
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
      // A revision this HML can't read, or one already held, isn't downloaded again.
      const since = Math.max(
        sync.behind ? 0 : sync.revision,
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
    const launching = (st.launchHoldUntil ?? 0) > Date.now()
    if (launching || (await ctx.isGameRunning(def))) {
      st.held = { code, revision, rev }
      scheduleHold(game, profileId)
      return
    }
    st.held = undefined
    cancelHold(game, profileId)
    // A detach since the manifest was read wins: its apply would merge against cleared bases.
    if (st.detaching || !(await stillFollowing(game, profileId, code))) return
    let result: SyncApplyResult
    st.applying = true
    try {
      result = await ctx.apply(game, profileId, rev)
    } finally {
      st.applying = false
    }
    const saved = await updateFollower(game, profileId, code, () => ({
      role: 'follower',
      code,
      revision,
      ...(result.failed.length > 0 ? { behind: true as const } : {}),
      ...(result.manual.length > 0 ? { manual: result.manual } : {})
    }))
    if (!saved) return
    if (hasChanges(result)) {
      const { added, removed, updated, enabled, disabled, configs, manual } = result
      const changes = { added, removed, updated, enabled, disabled, configs }
      deps.emit({ type: 'sync-applied', game, profileId, profileName: saved.name, changes, manual })
    }
    emitState(game, profileId)
  }

  /** Single-flight per profile; logs and swallows every failure. */
  function checkFollower(game: string, profileId: string, fromHold = false): Promise<void> {
    const st = stateOf(game, profileId)
    if (st.checking) return st.checking
    const run = checkOnce(game, profileId, fromHold)
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

  /** Drops manual entries whose Nexus mod is now installed. */
  async function pruneManual(game: string, profileId: string): Promise<void> {
    const changed = await lock(game, profileId, async () => {
      const profile = await getProfile(deps.paths, game, profileId)
      const sync = profile.sync
      if (sync?.role !== 'follower' || !sync.manual?.length) return false
      const installed = new Set(
        profile.mods.flatMap((m) => (m.source.kind === 'nexus' ? [m.source.modId] : []))
      )
      const manual = sync.manual.filter((e) => {
        const id = nexusModIdOf(e.url)
        return id === null || !installed.has(id)
      })
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
    for await (const { game, profile } of allProfiles()) {
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
      if (!sync) return
      if (sync.role !== 'owner') throw new Error(FOLLOWER_STOP)
      cancelTimer(label, profileId)
      const file = keyFile(sync.code)
      if (file && !deps.secrets.isAvailable()) throw new Error(noSecureStorage(WHAT))
      const key = file ? await loadSecret(file, deps.secrets) : null
      // Without a key the code can't be ended on the server; it expires on its own.
      if (key) await endSync(client(), sync.code, key)
      const changed = await lock(label, profileId, async () => {
        const profile = await getProfile(deps.paths, label, profileId)
        if (profile.sync?.role !== 'owner' || profile.sync.code !== sync.code) return false
        const next: ProfileManifest = { ...profile }
        delete next.sync
        await saveProfile(deps.paths, next)
        return true
      })
      if (file) await saveSecret(file, deps.secrets, null, WHAT)
      if (changed) emitState(label, profileId)
    },

    touched(game, profileId) {
      if (profileId === DEPLOY_KEY) return
      const st = stateOf(game, profileId)
      if (st.timer !== undefined) timers.clearTimeout(st.timer)
      st.timer = timers.setTimeout(() => {
        st.timer = undefined
        // Network failures are recorded as pending; anything else (disk, collect) is logged.
        publishNow(game, profileId).catch((e: unknown) => {
          console.warn(`Sync publish failed for ${game}/${profileId}:`, e)
        })
      }, SYNC_DEBOUNCE_MS)
    },

    async publishNow(game, profileId) {
      const label = (await ctx.requireGame(game)).label
      return publishNow(label, profileId)
    },

    async forgetOwnerKey(code) {
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
      const check = checkFollower(label, profileId).then(() => 'done' as const)
      let timer: unknown
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = timers.setTimeout(() => resolve('timeout'), SYNC_LAUNCH_CHECK_MS)
      })
      const won = await Promise.race([check, timeout])
      const st = stateOf(label, profileId)
      if (won === 'done') timers.clearTimeout(timer)
      // Launching halfway through an apply would start the game on a half-updated profile.
      else if (st.applying) await check
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

    isApplying(game, profileId) {
      return !!states.get(`${game}\0${profileId}`)?.applying
    },

    async isFollower(game, profileId) {
      return (await readProfile(game, profileId))?.sync?.role === 'follower'
    }
  }
}
