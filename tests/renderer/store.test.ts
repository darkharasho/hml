// The store reaches the preload API through window; this brings in its typing.
import type {} from '../../src/renderer/src/env.d'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { GameSummary } from '../../src/shared/ipc'
import type { DeploymentStatus } from '../../src/shared/types'

const api = vi.hoisted(() => ({
  getDeployment: vi.fn(),
  removeDeployment: vi.fn(),
  listProfiles: vi.fn(),
  ghCheckUpdates: vi.fn()
}))
vi.mock('../../src/renderer/src/api', () => ({
  api,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))

const { useStore } = await import('../../src/renderer/src/store')

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
