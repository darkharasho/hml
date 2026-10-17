import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import {
  DEV_UPDATE_MESSAGE,
  UPDATE_CHECK_INTERVAL_MS,
  createUpdater,
  type AutoUpdaterLike,
  type Updater
} from '../../src/main/updater'
import type { UpdateState } from '../../src/shared/ipc'
import { UPDATE_METHODS, updateChannel } from '../../src/shared/ipc'

type Listener = (...args: unknown[]) => void

function fakeUpdater(): AutoUpdaterLike & {
  emit(event: string, ...args: unknown[]): void
  checks: number
  installs: number
  nextCheck: () => Promise<unknown>
} {
  const listeners = new Map<string, Listener[]>()
  const u = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checks: 0,
    installs: 0,
    nextCheck: (): Promise<unknown> => Promise.resolve({}),
    on(event: string, l: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), l])
      return u
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners.get(event) ?? []) l(...args)
    },
    checkForUpdates() {
      u.checks++
      return u.nextCheck()
    },
    quitAndInstall() {
      u.installs++
    }
  }
  return u
}

function setup(isPackaged = true): {
  u: ReturnType<typeof fakeUpdater>
  states: UpdateState[]
  load: Mock<() => Promise<AutoUpdaterLike>>
  warn: Mock<(m: string) => void>
  updater: Updater
} {
  const u = fakeUpdater()
  const states: UpdateState[] = []
  const load = vi.fn<() => Promise<AutoUpdaterLike>>(async () => u)
  const warn = vi.fn<(m: string) => void>()
  const updater = createUpdater({
    isPackaged,
    version: '1.0.0',
    load,
    onState: (s) => states.push(s),
    warn
  })
  return { u, states, load, warn, updater }
}

describe('dev build', () => {
  test('never loads electron-updater, and a manual check says why', async () => {
    const { updater, load } = setup(false)
    await updater.start()
    expect(await updater.check()).toEqual({ ok: false, error: DEV_UPDATE_MESSAGE })
    await updater.restart()
    expect(load).not.toHaveBeenCalled()
    expect(await updater.getState()).toEqual({ status: 'idle' })
  })

  test('reports the app version', async () => {
    expect(await setup(false).updater.getVersion()).toBe('1.0.0')
  })
})

describe('packaged build', () => {
  test('a check loads the updater once and turns on auto download and install on quit', async () => {
    const { updater, u, load } = setup()
    expect(await updater.check()).toEqual({ ok: true })
    expect(await updater.check()).toEqual({ ok: true })
    expect(load).toHaveBeenCalledTimes(1)
    expect(u.autoDownload).toBe(true)
    expect(u.autoInstallOnAppQuit).toBe(true)
    expect(u.checks).toBe(2)
  })

  test('forwards updater events as states', async () => {
    const { updater, u, states } = setup()
    await updater.check()
    u.emit('checking-for-update')
    u.emit('update-not-available', { version: '1.0.0' })
    u.emit('checking-for-update')
    u.emit('update-available', { version: '1.1.0' })
    u.emit('download-progress', { percent: 42.4 })
    u.emit('update-downloaded', { version: '1.1.0' })
    expect(states).toEqual([
      { status: 'checking' },
      { status: 'none' },
      { status: 'checking' },
      { status: 'downloading', version: '1.1.0', percent: null },
      { status: 'downloading', version: '1.1.0', percent: 42.4 },
      { status: 'downloaded', version: '1.1.0' }
    ])
    expect(await updater.getState()).toEqual({ status: 'downloaded', version: '1.1.0' })
  })

  test('an error event keeps only its first line', async () => {
    const { updater, u } = setup()
    await updater.check()
    u.emit('error', new Error('Cannot find latest.yml: HttpError: 404\nHeaders: {...}'))
    expect(await updater.getState()).toEqual({
      status: 'error',
      message: 'Cannot find latest.yml: HttpError: 404'
    })
  })

  test('a failed check returns the error and sets the error state', async () => {
    const { updater, u } = setup()
    u.nextCheck = () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(await updater.check()).toEqual({ ok: false, error: 'net::ERR_INTERNET_DISCONNECTED' })
    expect(await updater.getState()).toEqual({
      status: 'error',
      message: 'net::ERR_INTERNET_DISCONNECTED'
    })
  })

  test('an inactive updater (Linux outside an AppImage) answers like a dev build', async () => {
    const { updater, u } = setup()
    u.nextCheck = () => Promise.resolve(null)
    expect(await updater.check()).toEqual({ ok: false, error: DEV_UPDATE_MESSAGE })
  })

  test('a failed load is retried by the next check', async () => {
    const { updater, load, u } = setup()
    load.mockRejectedValueOnce(new Error('boom'))
    expect(await updater.check()).toEqual({ ok: false, error: 'boom' })
    expect(await updater.check()).toEqual({ ok: true })
    expect(u.checks).toBe(1)
  })

  test('no new check while an update downloads or waits for a restart', async () => {
    const { updater, u } = setup()
    await updater.check()
    u.emit('update-available', { version: '1.1.0' })
    expect(await updater.check()).toEqual({ ok: true })
    u.emit('update-downloaded', { version: '1.1.0' })
    expect(await updater.check()).toEqual({ ok: true })
    u.emit('checking-for-update')
    expect(await updater.getState()).toEqual({ status: 'downloaded', version: '1.1.0' })
    expect(u.checks).toBe(1)
  })

  test('restart installs only once an update is downloaded', async () => {
    const { updater, u } = setup()
    await updater.check()
    await updater.restart()
    expect(u.installs).toBe(0)
    u.emit('update-downloaded', { version: '1.1.0' })
    await updater.restart()
    expect(u.installs).toBe(1)
  })
})

describe('scheduling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('checks on launch and then every 6 hours', async () => {
    const { updater, u } = setup()
    await updater.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(u.checks).toBe(1)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1)
    expect(u.checks).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(u.checks).toBe(2)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(u.checks).toBe(3)
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
  })

  test('the scheduled check is skipped once an update is downloaded', async () => {
    const { updater, u } = setup()
    await updater.start()
    await vi.advanceTimersByTimeAsync(0)
    u.emit('update-downloaded', { version: '1.1.0' })
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
    expect(u.checks).toBe(1)
  })

  test('a failed background check only warns', async () => {
    const { updater, u, warn } = setup()
    u.nextCheck = () => Promise.reject(new Error('offline'))
    await updater.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledWith('HML update check failed: offline')
  })

  test('a dev build schedules nothing', async () => {
    const { updater, load } = setup(false)
    await updater.start()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2)
    expect(load).not.toHaveBeenCalled()
  })
})

test('update channels are namespaced apart from the HML API', () => {
  expect(UPDATE_METHODS).toEqual(['getVersion', 'getState', 'check', 'restart'])
  expect(updateChannel('check')).toBe('hml:update:check')
})
