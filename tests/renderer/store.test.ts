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
  ghSetPrereleases: vi.fn(),
  ghUpdate: vi.fn(),
  nxInstall: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  getGame: vi.fn(),
  getLaunchWarnings: vi.fn(),
  getManualLoader: vi.fn(),
  keepManualLoader: vi.fn(),
  removeManualLoader: vi.fn(),
  addCustomGame: vi.fn(),
  launch: vi.fn(),
  waitForGame: vi.fn(),
  cancelWaitForGame: vi.fn(),
  setModEnabled: vi.fn(),
  uninstallMod: vi.fn(),
  getModDeps: vi.fn(),
  reportUpdateCount: vi.fn(async () => undefined),
  getUpdateSummary: vi.fn(async () => ({})),
  openExternal: vi.fn(async () => undefined),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  createSyncCode: vi.fn(),
  stopSync: vi.fn(),
  detachSync: vi.fn()
}))
vi.mock('../../src/renderer/src/api', () => ({
  api,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))

const { useStore } = await import('../../src/renderer/src/store')
const { NX_MAX_UPDATE_TABS, NX_NO_KEY } = await import('../../src/renderer/src/nxView')

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

describe('store ghSetPrereleases', () => {
  const repo = { label: 'repo', displayName: 'R.E.P.O.', loader: 'bepinex', packageIndex: null }
  const update = (mode: GhUpdate['mode']): GhUpdate => ({
    modId: 'o-r',
    owner: 'o',
    repo: 'r',
    current: 'v1.0.0',
    latest: 'v1.1.0-beta.1',
    mode
  })
  beforeEach(() => {
    api.ghSetPrereleases.mockReset()
    api.ghUpdate.mockReset().mockResolvedValue([])
    api.ghCheckUpdates.mockReset().mockResolvedValue([])
    api.listProfiles.mockReset().mockResolvedValue([])
    api.getLaunchWarnings.mockReset().mockResolvedValue([])
    useStore.setState({
      currentGame: repo as unknown as GameSummary,
      currentProfile: 'p',
      profiles: [],
      ghUpdates: [],
      ghUpdating: [],
      toasts: []
    })
  })

  test('turning on installs an auto-mode update right away', async () => {
    api.ghSetPrereleases.mockResolvedValue({ update: update('auto') })
    await useStore.getState().ghSetPrereleases('o-r', true)
    expect(api.ghSetPrereleases).toHaveBeenCalledWith('repo', 'p', 'o-r', true)
    expect(api.ghUpdate).toHaveBeenCalledWith('repo', 'p', ['o-r'])
  })

  test('turning on announces a notify-mode update without installing it', async () => {
    api.ghSetPrereleases.mockResolvedValue({ update: update('notify') })
    await useStore.getState().ghSetPrereleases('o-r', true)
    expect(api.ghUpdate).not.toHaveBeenCalled()
    expect(api.ghCheckUpdates).toHaveBeenCalledWith('repo', 'p')
    expect(useStore.getState().toasts.map((t) => [t.kind, t.message])).toEqual([
      ['info', 'o/r has an update to v1.1.0-beta.1. Use Update to install it.']
    ])
  })

  test('turning off only saves and refreshes the update list', async () => {
    api.ghSetPrereleases.mockResolvedValue({ update: null })
    await useStore.getState().ghSetPrereleases('o-r', false)
    expect(api.ghUpdate).not.toHaveBeenCalled()
    expect(api.ghCheckUpdates).toHaveBeenCalledWith('repo', 'p')
    expect(useStore.getState().toasts).toEqual([])
  })

  test('turning off on a prerelease-only repo says the mod waits for a stable release', async () => {
    const profile = {
      id: 'p',
      name: 'P',
      mods: [{ id: 'o-r', source: { kind: 'github', owner: 'o', repo: 'r' } }]
    }
    api.listProfiles.mockResolvedValue([profile])
    api.ghSetPrereleases.mockResolvedValue({ update: null, prereleaseOnly: true })
    await useStore.getState().ghSetPrereleases('o-r', false)
    expect(useStore.getState().toasts.map((t) => [t.kind, t.message])).toEqual([
      [
        'info',
        "o/r only publishes pre-releases, so it won't update until it publishes a stable release."
      ]
    ])
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

describe('store dependency-aware toggles', () => {
  const repo = { label: 'repo', displayName: 'R.E.P.O.', loader: 'bepinex', packageIndex: null }
  const mod = (id: string, enabled: boolean): unknown => ({
    id,
    name: `${id}_mod`,
    enabled,
    source: { kind: 'thunderstore', fullName: id }
  })
  const mods = [mod('app', false), mod('lib', false), mod('other', true)]

  beforeEach(() => {
    api.setModEnabled.mockReset().mockResolvedValue(undefined)
    api.uninstallMod.mockReset().mockResolvedValue(undefined)
    api.getModDeps.mockReset().mockResolvedValue({ deps: { app: ['lib'] }, loaders: [] })
    api.listProfiles.mockReset().mockResolvedValue([{ id: 'p', name: 'P', mods }])
    api.getLaunchWarnings.mockReset().mockResolvedValue([])
    api.ghCheckUpdates.mockReset().mockResolvedValue([])
    useStore.setState({
      currentGame: repo as unknown as GameSummary,
      currentProfile: 'p',
      profiles: [{ id: 'p', name: 'P', mods }] as unknown as ProfileManifest[],
      toasts: []
    })
  })

  test('turning a mod on turns on the disabled mods it needs', async () => {
    await useStore.getState().setModEnabled('app', true)
    expect(api.setModEnabled.mock.calls.map((c) => c[2])).toEqual(['app', 'lib'])
    expect(useStore.getState().toasts.map((t) => t.message)).toEqual([
      'Also turned on lib mod, which it needs.'
    ])
  })

  test('turning a mod off touches only it and the mods passed along', async () => {
    await useStore.getState().setModEnabled('other', false, ['app'])
    expect(api.getModDeps).not.toHaveBeenCalled()
    expect(api.setModEnabled.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      ['other', false],
      ['app', false]
    ])
  })

  test('an unreadable graph still turns the mod on', async () => {
    api.getModDeps.mockRejectedValue(new Error('offline'))
    await useStore.getState().setModEnabled('app', true)
    expect(api.setModEnabled.mock.calls.map((c) => c[2])).toEqual(['app'])
    expect(useStore.getState().toasts).toEqual([])
  })

  test('uninstall removes the chosen dependencies after the mod', async () => {
    const [app, lib] = mods as ProfileManifest['mods']
    await useStore.getState().uninstallMod(app, [lib])
    expect(api.uninstallMod.mock.calls.map((c) => c[2])).toEqual(['app', 'lib'])
    expect(useStore.getState().toasts.map((t) => t.message)).toEqual([
      'Uninstalled app_mod and 1 dependency'
    ])
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

describe('store launch', () => {
  const repo = { label: 'repo', displayName: 'R.E.P.O.', loader: 'bepinex' }
  const messages = (): string[] => useStore.getState().toasts.map((t) => t.message)

  beforeEach(() => {
    api.launch.mockReset().mockResolvedValue(undefined)
    api.waitForGame.mockReset()
    api.cancelWaitForGame.mockReset().mockResolvedValue(undefined)
    useStore.setState({
      currentGame: repo as unknown as GameSummary,
      currentProfile: 'p1',
      launching: {},
      toasts: []
    })
  })

  test('marks the game launching until it is seen running', async () => {
    let seen!: (r: 'running') => void
    api.waitForGame.mockReturnValue(new Promise((r) => (seen = r)))
    const run = useStore.getState().launch('modded')
    await vi.waitFor(() => expect(api.waitForGame).toHaveBeenCalledWith('repo'))
    expect(useStore.getState().launching).toEqual({ repo: 'modded' })
    expect(useStore.getState().busy).toBe(false)
    seen('running')
    await run
    expect(useStore.getState().launching).toEqual({})
    expect(messages()).toEqual([])
    expect(api.launch).toHaveBeenCalledWith('repo', 'p1', 'modded')
  })

  test('a second press while launching does nothing', async () => {
    let seen!: (r: 'running') => void
    api.waitForGame.mockReturnValue(new Promise((r) => (seen = r)))
    const first = useStore.getState().launch('modded')
    await useStore.getState().launch('vanilla')
    expect(api.launch).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(api.waitForGame).toHaveBeenCalled())
    seen('running')
    await first
  })

  test('a timeout clears the state with an info toast', async () => {
    api.waitForGame.mockResolvedValue('timeout')
    await useStore.getState().launch('vanilla')
    expect(useStore.getState().launching).toEqual({})
    expect(useStore.getState().toasts).toEqual([
      expect.objectContaining({
        kind: 'info',
        message: "Couldn't confirm R.E.P.O. started — it may still be loading"
      })
    ])
  })

  test('a failed launch clears the state, shows the error and does not wait', async () => {
    api.launch.mockRejectedValue(new Error('Steam was not found.'))
    await useStore.getState().launch('modded')
    expect(useStore.getState().launching).toEqual({})
    expect(api.waitForGame).not.toHaveBeenCalled()
    expect(messages()).toEqual(['Steam was not found.'])
  })

  test('switching games while launching clears only the launched game', async () => {
    let seen!: (r: 'running') => void
    api.waitForGame.mockReturnValue(new Promise((r) => (seen = r)))
    const run = useStore.getState().launch('modded')
    await vi.waitFor(() => expect(api.waitForGame).toHaveBeenCalled())
    useStore.setState({ currentGame: { ...repo, label: 'other' } as unknown as GameSummary })
    expect(useStore.getState().launching).toEqual({ repo: 'modded' })
    seen('running')
    await run
    expect(useStore.getState().launching).toEqual({})
  })

  test('cancelLaunch clears the state at once and stops the wait in main', async () => {
    let settle!: (r: 'cancelled') => void
    api.waitForGame.mockReturnValue(new Promise((r) => (settle = r)))
    const run = useStore.getState().launch('modded')
    await vi.waitFor(() => expect(api.waitForGame).toHaveBeenCalled())
    useStore.getState().cancelLaunch('repo')
    expect(useStore.getState().launching).toEqual({})
    expect(api.cancelWaitForGame).toHaveBeenCalledWith('repo')
    settle('cancelled')
    await run
    expect(messages()).toEqual([])
  })

  test('a launch pressed again after cancelling keeps its state when the old one ends', async () => {
    const settles: ((r: 'cancelled' | 'running') => void)[] = []
    api.waitForGame.mockImplementation(() => new Promise((r) => settles.push(r)))
    const first = useStore.getState().launch('modded')
    await vi.waitFor(() => expect(settles).toHaveLength(1))
    useStore.getState().cancelLaunch('repo')
    const second = useStore.getState().launch('vanilla')
    await vi.waitFor(() => expect(settles).toHaveLength(2))
    settles[0]('cancelled')
    await first
    expect(useStore.getState().launching).toEqual({ repo: 'vanilla' })
    settles[1]('running')
    await second
    expect(useStore.getState().launching).toEqual({})
  })

  test('cancelling before the launch call returns skips the wait', async () => {
    let started!: () => void
    api.launch.mockReturnValue(new Promise<void>((r) => (started = r)))
    const run = useStore.getState().launch('modded')
    useStore.getState().cancelLaunch('repo')
    started()
    await run
    expect(api.waitForGame).not.toHaveBeenCalled()
    expect(useStore.getState().launching).toEqual({})
  })

  test('a game that exits before it is seen ends with an error toast', async () => {
    api.waitForGame.mockResolvedValue('exited')
    await useStore.getState().launch('modded')
    expect(useStore.getState().launching).toEqual({})
    expect(useStore.getState().toasts).toEqual([
      expect.objectContaining({
        kind: 'error',
        message: 'R.E.P.O. closed before it finished starting.'
      })
    ])
  })
})

describe('store init', () => {
  test('opens on the game picker even when a game was open last time', async () => {
    api.getSettings.mockReset().mockResolvedValue({ lastProfile: {}, lastGame: 'nexus-x' })
    api.getGame.mockReset().mockResolvedValue(game)
    useStore.setState({ currentGame: null, ready: false })
    await useStore.getState().init()
    expect(useStore.getState().ready).toBe(true)
    expect(useStore.getState().currentGame).toBeNull()
    // The last game stays known, so the picker can offer a way back to it.
    expect(useStore.getState().settings?.lastGame).toBe('nexus-x')
  })
})

describe('store sync events', () => {
  const repo = { label: 'repo', displayName: 'R.E.P.O.', loader: 'bepinex', packageIndex: null }
  const changes = { added: 2, removed: 0, updated: 1, enabled: 0, disabled: 0, configs: 1 }
  const reloaded = [{ id: 'p', name: 'Friends', mods: [] }] as unknown as ProfileManifest[]
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const shown = (): [string, string][] => useStore.getState().toasts.map((t) => [t.kind, t.message])

  beforeEach(() => {
    api.listProfiles.mockReset().mockResolvedValue(reloaded)
    api.openExternal.mockReset().mockResolvedValue(undefined)
    useStore.setState({
      currentGame: repo as unknown as GameSummary,
      currentProfile: 'p',
      profiles: [],
      toasts: [],
      progress: null
    })
  })

  test("sync-applied toasts and reloads the current game's profiles", async () => {
    useStore.getState().handleEvent({
      type: 'sync-applied',
      game: 'repo',
      profileId: 'p',
      profileName: 'Friends',
      changes,
      manual: []
    })
    await settle()
    expect(shown()).toEqual([['success', 'Friends updated: +2 mods, 1 updated, configs changed']])
    expect(api.listProfiles).toHaveBeenCalledWith('repo')
    expect(useStore.getState().profiles).toEqual(reloaded)
  })

  test("sync-applied for another game toasts without reloading this game's profiles", async () => {
    useStore.getState().handleEvent({
      type: 'sync-applied',
      game: 'other',
      profileId: 'q',
      profileName: 'Elsewhere',
      changes,
      manual: []
    })
    await settle()
    expect(shown()).toEqual([['success', 'Elsewhere updated: +2 mods, 1 updated, configs changed']])
    expect(api.listProfiles).not.toHaveBeenCalled()
  })

  test('sync-applied with manual adds an Open action', async () => {
    const manual = Array.from({ length: 7 }, (_, i) => ({
      name: `M${i}`,
      url: `https://www.nexusmods.com/repo/mods/${i}`
    }))
    useStore.getState().handleEvent({
      type: 'sync-applied',
      game: 'repo',
      profileId: 'p',
      profileName: 'Friends',
      changes,
      manual
    })
    await settle()
    const info = useStore.getState().toasts.find((t) => t.kind === 'info')
    expect(info?.message).toBe('7 mods need a manual download')
    expect(info?.action?.label).toBe('Open')
    info?.action?.run()
    await settle()
    expect(api.openExternal.mock.calls.map((c) => (c as unknown[])[0])).toEqual(
      manual.slice(0, NX_MAX_UPDATE_TABS).map((m) => m.url)
    )
  })

  test('sync-ended toasts and reloads', async () => {
    useStore
      .getState()
      .handleEvent({ type: 'sync-ended', game: 'repo', profileId: 'p', profileName: 'Friends' })
    await settle()
    expect(shown()).toEqual([['info', 'Friends is no longer synced']])
    expect(api.listProfiles).toHaveBeenCalledWith('repo')
  })

  test('sync-state reloads only for the current game and shows nothing', async () => {
    useStore.getState().handleEvent({ type: 'sync-state', game: 'other', profileId: 'q' })
    await settle()
    expect(api.listProfiles).not.toHaveBeenCalled()
    useStore.getState().handleEvent({ type: 'sync-state', game: 'repo', profileId: 'p' })
    await settle()
    expect(api.listProfiles).toHaveBeenCalledWith('repo')
    expect(shown()).toEqual([])
    expect(useStore.getState().progress).toBeNull()
  })

  test('sync-error toasts its message', async () => {
    useStore.getState().handleEvent({
      type: 'sync-error',
      game: 'repo',
      profileId: 'p',
      message: 'Update HML to keep following Friends.'
    })
    await settle()
    expect(shown()).toEqual([['error', 'Update HML to keep following Friends.']])
  })
})

describe('store deleting a synced owner profile', () => {
  const repo = { label: 'repo', displayName: 'R.E.P.O.', loader: 'bepinex', packageIndex: null }
  const owner = {
    id: 'o',
    name: 'Mine',
    mods: [],
    sync: { role: 'owner', code: 'ABCDEFGHJKMN', revision: 1, digest: 'd' }
  } as unknown as ProfileManifest
  const other = { id: 'x', name: 'Other', mods: [] } as unknown as ProfileManifest

  beforeEach(() => {
    api.stopSync.mockReset().mockResolvedValue(undefined)
    api.deleteProfile.mockReset().mockResolvedValue(undefined)
    api.listProfiles.mockReset().mockResolvedValue([other])
    api.getSettings.mockReset().mockResolvedValue({ lastProfile: {} })
    api.saveSettings.mockReset().mockImplementation(async (s: unknown) => s)
    api.getLaunchWarnings.mockReset().mockResolvedValue([])
    api.ghCheckUpdates.mockReset().mockResolvedValue([])
    useStore.setState({
      currentGame: repo as unknown as GameSummary,
      currentProfile: 'x',
      profiles: [owner, other],
      toasts: []
    })
  })

  test('stops syncing before deleting when asked', async () => {
    const order: string[] = []
    api.stopSync.mockImplementation(async () => void order.push('stop'))
    api.deleteProfile.mockImplementation(async () => void order.push('delete'))
    expect(await useStore.getState().deleteProfile('o', { stopSync: true })).toBe(true)
    expect(api.stopSync).toHaveBeenCalledWith('repo', 'o')
    expect(order).toEqual(['stop', 'delete'])
    expect(useStore.getState().profiles).toEqual([other])
  })

  test('a failed stop keeps the profile and shows the error', async () => {
    api.stopSync.mockRejectedValue(new Error('HML is offline.'))
    expect(await useStore.getState().deleteProfile('o', { stopSync: true })).toBe(false)
    expect(api.deleteProfile).not.toHaveBeenCalled()
    expect(useStore.getState().profiles).toEqual([owner, other])
    expect(useStore.getState().toasts.map((t) => [t.kind, t.message])).toEqual([
      ['error', 'HML is offline.']
    ])
  })

  test('without the option it deletes without stopping', async () => {
    expect(await useStore.getState().deleteProfile('o')).toBe(true)
    expect(api.stopSync).not.toHaveBeenCalled()
    expect(api.deleteProfile).toHaveBeenCalledWith('repo', 'o')
  })
})
