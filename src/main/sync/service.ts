import type {
  GameDef,
  HmlCustomGame,
  HmlExport,
  ProfileManifest,
  ProfileSync
} from '../../shared/types'
import { noSecureStorage } from '../../shared/messages'
import { normalizeSyncCode } from '../../shared/shareCode'
import { getProfile, saveProfile } from '../profiles/profiles'
import { loadSecret, saveSecret } from '../secrets'
import type { ServiceDeps } from '../services'
import { collectHmlParts, zipHmlParts } from '../share/hmlFile'
import type { SyncApplyResult } from './apply'
import { createSync, endSync, publishSync, SyncGoneError, type SyncClientOptions } from './client'
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
type Parts = { export: HmlExport; configs: Map<string, Uint8Array> }

/** In-memory state of one profile: its debounce timer and the publish under way. */
interface ProfileState {
  timer?: unknown
  publishing?: Promise<void>
  /** A publish was asked for while one ran: run once more when it ends. */
  dirty?: boolean
}

const DEPLOY_KEY = '__deploy__'
const WHAT = 'sync codes'
const FOLLOWER_CREATE = 'Detach this profile from its sync before creating a sync code.'
const FOLLOWER_STOP = 'This profile follows a sync code. Detach it instead.'

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
      if (sync?.role !== 'owner') return null
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
        // Failures are already recorded as pending; nothing is left to report here.
        publishNow(game, profileId).catch(() => undefined)
      }, SYNC_DEBOUNCE_MS)
    },

    async publishNow(game, profileId) {
      const label = (await ctx.requireGame(game)).label
      return publishNow(label, profileId)
    },

    async forgetOwnerKey(code) {
      const file = keyFile(code)
      if (file) await saveSecret(file, deps.secrets, null, WHAT)
    }
  }
}
