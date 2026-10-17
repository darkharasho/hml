import type { UpdateApi, UpdateCheckResult, UpdateState } from '../shared/ipc'

// HML's own auto-update (electron-updater), the same behavior as AxiRoster's: download in the
// background, install on quit or on "Restart to update", check on launch and every 6 hours.
// electron-builder publishes to the GitHub release, which is where electron-updater looks.
// Nothing here imports Electron, so tests drive it with a fake updater.

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export const DEV_UPDATE_MESSAGE = 'Updates only run in the installed app.'

/** The subset of electron-updater's autoUpdater HML uses. */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown
  /** Resolves null when the updater isn't active (e.g. Linux outside an AppImage). */
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

export interface UpdaterDeps {
  isPackaged: boolean
  version: string
  /**
   * Loads electron-updater's autoUpdater. Called lazily, and only in a packaged build: the module
   * touches Electron internals when it loads.
   */
  load(): Promise<AutoUpdaterLike>
  /** Gets every new state (main forwards it to the renderer). */
  onState(state: UpdateState): void
  setInterval?: (fn: () => void, ms: number) => unknown
  warn?: (message: string) => void
}

export interface Updater extends UpdateApi {
  /** The launch check plus the 6-hourly one; does nothing in a dev build. */
  start(): Promise<void>
}

/** electron-updater errors can carry response headers on later lines; the first says what failed. */
function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.split('\n')[0].trim() || 'Update check failed.'
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const warn = deps.warn ?? ((m) => console.warn(m))
  let state: UpdateState = { status: 'idle' }
  let loading: Promise<AutoUpdaterLike> | null = null

  const set = (next: UpdateState): void => {
    state = next
    deps.onState(next)
  }
  const busy = (): boolean => state.status === 'downloading' || state.status === 'downloaded'

  function ensure(): Promise<AutoUpdaterLike> {
    loading ??= deps.load().then((u) => {
      u.autoDownload = true
      u.autoInstallOnAppQuit = true
      u.on('checking-for-update', () => {
        if (!busy()) set({ status: 'checking' })
      })
      u.on('update-available', (info: { version: string }) =>
        set({ status: 'downloading', version: info.version, percent: null })
      )
      u.on('update-not-available', () => set({ status: 'none' }))
      u.on('download-progress', (p: { percent: number }) =>
        set({
          status: 'downloading',
          version: state.status === 'downloading' ? state.version : '',
          percent: p.percent
        })
      )
      u.on('update-downloaded', (info: { version: string }) =>
        set({ status: 'downloaded', version: info.version })
      )
      u.on('error', (e: unknown) => set({ status: 'error', message: firstLine(e) }))
      return u
    })
    // A failed load can be retried by the next check.
    loading.catch(() => (loading = null))
    return loading
  }

  async function check(): Promise<UpdateCheckResult> {
    if (!deps.isPackaged) return { ok: false, error: DEV_UPDATE_MESSAGE }
    if (busy()) return { ok: true }
    try {
      const u = await ensure()
      const result = await u.checkForUpdates()
      if (result === null) return { ok: false, error: DEV_UPDATE_MESSAGE }
      return { ok: true }
    } catch (e) {
      const message = firstLine(e)
      set({ status: 'error', message })
      return { ok: false, error: message }
    }
  }

  function background(): void {
    if (busy()) return
    void check().then((r) => {
      if (!r.ok) warn(`HML update check failed: ${r.error}`)
    })
  }

  return {
    async start() {
      if (!deps.isPackaged) return
      background()
      every(background, UPDATE_CHECK_INTERVAL_MS)
    },
    check,
    async restart() {
      if (state.status !== 'downloaded') return
      ;(await ensure()).quitAndInstall()
    },
    async getState() {
      return state
    },
    async getVersion() {
      return deps.version
    }
  }
}
