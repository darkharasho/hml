// The store reaches the preload API through window; this brings in its typing.
import type {} from '../../src/renderer/src/env.d'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { GameSummary } from '../../src/shared/ipc'
import type { DeploymentStatus, GhUpdate, ProfileManifest } from '../../src/shared/types'

const api = vi.hoisted(() => ({
  getDeployment: vi.fn(),
  removeDeployment: vi.fn(),
  listProfiles: vi.fn(),
  ghCheckUpdates: vi.fn(),
  nxInstall: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  getGame: vi.fn(),
  getLaunchWarnings: vi.fn(),
  getManualLoader: vi.fn(),
  keepManualLoader: vi.fn(),
  removeManualLoader: vi.fn(),
  addCustomGame: vi.fn()
}))
vi.mock('../../src/renderer/src/api', () => ({
  api,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))

const { useStore } = await import('../../src/renderer/src/store')
const { NX_NO_KEY } = await import('../../src/renderer/src/nxView')

const status: DeploymentStatus = {
  profileId: 'p',
  profileName: 'P',
  files: 3,
  deployedAt: '2026-10-16T00:00:00.000Z'
}
const game = { label: 'nexus-x', displayName: 'X', loader: 'deploy', installDir: null }

describe('store deployment refresh', () => {
  beforeEach(() => {
    api.getDeployment.mockReset()
    api.removeDeployment.mockReset().mockResolvedValue(undefined)
    api.listProfiles.mockReset().mockResolvedValue([])
    useStore.setState({
      currentGame: game as unknown as GameSummary,
      deployment: null,
      toasts: []
    })
  })

  test('a deploy game without a folder still reads its deployment', async () => {
    api.getDeployment.mockResolvedValue(status)
    await useStore.getState().removeDeployment()
    expect(api.getDeployment).toHaveBeenCalledWith('nexus-x')
    expect(useStore.getState().deployment).toEqual(status)
  })

  test('a failing deployment read counts as nothing deployed', async () => {
    useStore.setState({ deployment: status })
    api.getDeployment.mockRejectedValue(new Error('nope'))
    await useStore.getState().removeDeployment()
    expect(useStore.getState().deployment).toBeNull()
    expect(useStore.getState().toasts.some((t) => t.message.includes('nope'))).toBe(false)
  })
})

describe('store GitHub update check errors', () => {
  const repo = { label: 'repo', displayName: 'R.E.P.O.', loader: 'bepinex', packageIndex: null }
  const RATE =
    "GitHub's rate limit was reached. Try again after 10:00, or add a GitHub token in Settings."
  const TOKEN = 'GitHub rejected the saved token. Update or remove it in Settings.'
  const infos = (): string[] =>
    useStore
      .getState()
      .toasts.filter((t) => t.kind === 'info')
      .map((t) => t.message)

  beforeEach(() => {
    api.ghCheckUpdates.mockReset()
    useStore.setState({
      currentGame: repo as unknown as GameSummary,
      currentProfile: 'p',
      profiles: [],
      toasts: []
    })
  })

  test('a rate limit or rejected token is shown once as info; other errors stay quiet', async () => {
    api.ghCheckUpdates.mockRejectedValue(new Error(RATE))
    await useStore.getState().checkUpdates()
    await useStore.getState().checkUpdates()
    expect(infos()).toEqual([RATE])
    api.ghCheckUpdates.mockRejectedValue(new Error(TOKEN))
    await useStore.getState().checkUpdates()
    expect(infos()).toEqual([RATE, TOKEN])
    api.ghCheckUpdates.mockRejectedValue(new Error('GitHub returned HTTP 500 for o/r.'))
    await useStore.getState().checkUpdates()
    expect(infos()).toEqual([RATE, TOKEN])
    expect(useStore.getState().toasts.some((t) => t.kind === 'error')).toBe(false)
  })
})

describe('store notify-mode GitHub updates', () => {
  const repo = { label: 'repo', displayName: 'R.E.P.O.', loader: 'bepinex', packageIndex: null }
  const update = {
    modId: 'a-ra',
    owner: 'a',
    repo: 'ra',
    current: 'v1.0.0',
    latest: 'v2.0.0',
    mode: 'notify'
  }
  beforeEach(() => {
    api.ghCheckUpdates.mockReset().mockResolvedValue([update])
    useStore.setState({
      currentGame: repo as unknown as GameSummary,
      currentProfile: 'p',
      profiles: [],
      ghUpdates: [],
      toasts: []
    })
  })
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  test('for the current profile, refreshes updates and shows one info toast', async () => {
    useStore
      .getState()
      .handleEvent({ type: 'github-updates-available', game: 'repo', profileId: 'p', count: 1 })
    await settle()
    expect(api.ghCheckUpdates).toHaveBeenCalledWith('repo', 'p')
    expect(useStore.getState().ghUpdates).toEqual([update])
    expect(useStore.getState().toasts.map((t) => [t.kind, t.message])).toEqual([
      ['info', '1 GitHub mod has an update. Use Update to install it.']
    ])
    useStore.setState({ toasts: [] })
    useStore
      .getState()
      .handleEvent({ type: 'github-updates-available', game: 'repo', profileId: 'p', count: 3 })
    await settle()
    expect(useStore.getState().toasts.map((t) => t.message)).toEqual([
      '3 GitHub mods have an update. Use Update to install it.'
    ])
  })

  test('for another profile, does nothing', async () => {
    useStore
      .getState()
      .handleEvent({ type: 'github-updates-available', game: 'repo', profileId: 'q', count: 1 })
    await settle()
    expect(api.ghCheckUpdates).not.toHaveBeenCalled()
    expect(useStore.getState().toasts).toEqual([])
  })
})

describe('store update lists after a failed check', () => {
  const repo = { label: 'repo', displayName: 'R.E.P.O.', loader: 'bepinex', packageIndex: null }
  const gh = (modId: string): GhUpdate => ({
    modId,
    owner: 'o',
    repo: modId,
    current: 'v1',
    latest: 'v2',
    mode: 'notify'
  })
  const profile = { id: 'p', name: 'P', mods: [{ id: 'kept', source: { kind: 'github' } }] }

  beforeEach(() => {
    api.ghCheckUpdates.mockReset()
    useStore.setState({
      currentGame: repo as unknown as GameSummary,
      currentProfile: 'p',
      profiles: [profile] as unknown as ProfileManifest[],
      ghUpdates: [gh('kept'), gh('gone')],
      toasts: []
    })
  })

  test('a rejected check drops uninstalled mods and keeps the rest', async () => {
    api.ghCheckUpdates.mockRejectedValue(new Error('GitHub returned HTTP 500 for o/r.'))
    await useStore.getState().checkUpdates()
    expect(useStore.getState().ghUpdates.map((u) => u.modId)).toEqual(['kept'])
  })

  test('a rate-limit failure prunes too and still shows its info toast', async () => {
    api.ghCheckUpdates.mockRejectedValue(
      new Error(
        "GitHub's rate limit was reached. Try again after 11:00, or add a GitHub token in Settings."
      )
    )
    await useStore.getState().checkUpdates()
    expect(useStore.getState().ghUpdates.map((u) => u.modId)).toEqual(['kept'])
    expect(useStore.getState().toasts.filter((t) => t.kind === 'info')).toHaveLength(1)
  })
})

describe('store nxInstall without an API key', () => {
  const NO_KEY = NX_NO_KEY
  const mod = { modId: 7, name: 'M' }
  beforeEach(() => {
    api.nxInstall.mockReset().mockRejectedValue(new Error(NO_KEY))
    api.listProfiles.mockReset().mockResolvedValue([])
    useStore.setState({
      currentGame: { label: 'repo', displayName: 'R', loader: 'bepinex' } as unknown as GameSummary,
      currentProfile: 'p',
      nxInstalling: [],
      toasts: []
    })
  })

  test('toasts with a Settings action by default', async () => {
    expect(await useStore.getState().nxInstall(mod)).toBe('needs-key')
    expect(useStore.getState().toasts.map((t) => t.message)).toEqual([NO_KEY])
  })

  test('skips the toast when the caller shows the notice inline', async () => {
    expect(await useStore.getState().nxInstall(mod, 1, { inlineNoKey: true })).toBe('needs-key')
    expect(useStore.getState().toasts).toEqual([])
  })

  test('still toasts other errors when inline', async () => {
    api.nxInstall.mockRejectedValue(new Error('boom'))
    expect(await useStore.getState().nxInstall(mod, 1, { inlineNoKey: true })).toBe('done')
    expect(useStore.getState().toasts.map((t) => t.message)).toEqual(['boom'])
  })
})

describe('store openImportedProfile', () => {
  const gameOf = (label: string): GameSummary =>
    ({ label, displayName: label, loader: 'deploy', installDir: null }) as unknown as GameSummary
  const prof = (id: string): ProfileManifest =>
    ({ id, name: id, mods: [] }) as unknown as ProfileManifest

  beforeEach(() => {
    api.getDeployment.mockReset().mockResolvedValue(null)
    api.listProfiles.mockReset()
    api.ghCheckUpdates.mockReset().mockResolvedValue([])
    api.getSettings.mockReset().mockResolvedValue({ lastProfile: {}, lastGame: null })
    api.saveSettings.mockReset().mockResolvedValue(undefined)
    api.getGame.mockReset()
    api.getLaunchWarnings.mockReset().mockResolvedValue([])
    useStore.setState({
      currentGame: gameOf('nexus-x'),
      currentProfile: 'a',
      profiles: [prof('a')],
      settings: null,
      toasts: []
    })
  })

  test('for the current game it reloads profiles and selects the id', async () => {
    api.listProfiles.mockResolvedValue([prof('a'), prof('b')])
    await useStore.getState().openImportedProfile('nexus-x', 'b')
    expect(api.listProfiles).toHaveBeenCalledWith('nexus-x')
    expect(api.getGame).not.toHaveBeenCalled()
    const s = useStore.getState()
    expect(s.profiles.map((p) => p.id)).toEqual(['a', 'b'])
    expect(s.currentProfile).toBe('b')
    expect(s.currentGame?.label).toBe('nexus-x')
  })

  test('for another game it looks the game up with getGame and selects it', async () => {
    const other = gameOf('nexus-y')
    api.getGame.mockResolvedValue(other)
    api.listProfiles.mockResolvedValue([prof('q1'), prof('q2')])
    await useStore.getState().openImportedProfile('nexus-y', 'q2')
    expect(api.getGame).toHaveBeenCalledWith('nexus-y')
    const s = useStore.getState()
    expect(s.currentGame?.label).toBe('nexus-y')
    expect(s.currentProfile).toBe('q2')
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ lastGame: 'nexus-y' }))
  })

  test('an unknown game is reported and leaves the current game alone', async () => {
    api.getGame.mockResolvedValue(null)
    await useStore.getState().openImportedProfile('nexus-z', 'p')
    const s = useStore.getState()
    expect(s.currentGame?.label).toBe('nexus-x')
    expect(s.toasts.some((t) => t.message.includes("HML couldn't find the game nexus-z."))).toBe(
      true
    )
  })
})

describe('store manual BepInEx prompt', () => {
  const gameOf = (label: string, loader: string): GameSummary =>
    ({ label, displayName: label, loader, installDir: null }) as unknown as GameSummary
  const prof = { id: 'a', name: 'a', mods: [] } as unknown as ProfileManifest

  beforeEach(() => {
    api.getDeployment.mockReset().mockResolvedValue(null)
    api.listProfiles.mockReset().mockResolvedValue([prof])
    api.ghCheckUpdates.mockReset().mockResolvedValue([])
    api.getSettings.mockReset().mockResolvedValue({ lastProfile: {}, lastGame: null })
    api.saveSettings.mockReset().mockResolvedValue(undefined)
    api.getLaunchWarnings.mockReset().mockResolvedValue([])
    api.getManualLoader.mockReset()
    api.keepManualLoader.mockReset().mockResolvedValue(undefined)
    api.removeManualLoader.mockReset().mockResolvedValue('/backup/bepinex')
    useStore.setState({ currentGame: null, settings: null, manualLoader: null, toasts: [] })
  })

  test('selecting a BepInEx game with a hand install opens the prompt', async () => {
    api.getManualLoader.mockResolvedValue({ entries: ['BepInEx', 'winhttp.dll'], kept: false })
    await useStore.getState().selectGame(gameOf('repo', 'bepinex'))
    expect(api.getManualLoader).toHaveBeenCalledWith('repo')
    expect(useStore.getState().manualLoader).toEqual({
      game: 'repo',
      entries: ['BepInEx', 'winhttp.dll']
    })
  })

  test('a kept install, no install, or a non-BepInEx game leaves the prompt closed', async () => {
    api.getManualLoader.mockResolvedValue({ entries: ['BepInEx'], kept: true })
    await useStore.getState().selectGame(gameOf('repo', 'bepinex'))
    expect(useStore.getState().manualLoader).toBeNull()
    api.getManualLoader.mockResolvedValue(null)
    await useStore.getState().selectGame(gameOf('repo', 'bepinex'))
    expect(useStore.getState().manualLoader).toBeNull()
    api.getManualLoader.mockClear()
    await useStore.getState().selectGame(gameOf('other', 'none'))
    expect(api.getManualLoader).not.toHaveBeenCalled()
  })

  test("resolveManualLoader('keep') calls keepManualLoader and clears the prompt", async () => {
    useStore.setState({ manualLoader: { game: 'repo', entries: ['BepInEx'] } })
    await useStore.getState().resolveManualLoader('keep')
    expect(api.keepManualLoader).toHaveBeenCalledWith('repo')
    expect(useStore.getState().manualLoader).toBeNull()
  })

  test("resolveManualLoader('remove') moves it aside and says where", async () => {
    useStore.setState({ manualLoader: { game: 'repo', entries: ['BepInEx'] } })
    await useStore.getState().resolveManualLoader('remove')
    expect(api.removeManualLoader).toHaveBeenCalledWith('repo')
    expect(useStore.getState().manualLoader).toBeNull()
    expect(useStore.getState().toasts.map((t) => t.message)).toContain(
      'Moved the manual BepInEx install to /backup/bepinex'
    )
  })

  test('addCustomGame adds then selects the game', async () => {
    const added = gameOf('steam-1', 'none')
    api.addCustomGame.mockResolvedValue(added)
    api.getManualLoader.mockResolvedValue(null)
    await useStore
      .getState()
      .addCustomGame({ source: 'steam', steamAppId: '1', loaderChoice: 'none' })
    expect(useStore.getState().currentGame?.label).toBe('steam-1')
  })
})
