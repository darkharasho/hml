import { describe, expect, test, vi } from 'vitest'
import { createBackgroundChecks } from '../../../src/main/updates/backgroundChecks'
import type { InstalledMod } from '../../../src/shared/types'

const mod = (id: string, kind: 'thunderstore' | 'github'): InstalledMod =>
  ({ id, name: id, source: { kind } }) as unknown as InstalledMod

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(opts: { focused?: boolean } = {}) {
  let tsLatest = '2.0.0'
  const ts = vi.fn(async () => [{ modId: 'a', latest: tsLatest }])
  const gh = vi.fn(async () => {
    throw new Error('rate limited')
  })
  const publish = vi.fn()
  const notify = vi.fn()
  const checks = createBackgroundChecks({
    games: async () => [
      { label: 'lc', displayName: 'Lethal Company' },
      { label: 'empty', displayName: 'Empty' }
    ],
    profiles: async (game) =>
      game === 'lc'
        ? [
            { id: 'p1', name: 'Main', mods: [mod('a', 'thunderstore'), mod('g', 'github')] },
            { id: 'p2', name: 'GH only', mods: [mod('g', 'github')] }
          ]
        : [],
    checks: { thunderstore: ts, github: gh },
    publish,
    notify,
    shouldNotify: async () => !opts.focused
  })
  return { checks, ts, gh, publish, notify, bump: (v: string) => (tsLatest = v) }
}

describe('background update checks', () => {
  test('counts updates per profile, running only the sources a profile uses', async () => {
    const { checks, ts, gh, publish } = setup()
    expect(await checks.run()).toEqual({ lc: { p1: 1 } })
    expect(ts).toHaveBeenCalledTimes(1)
    expect(gh).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({ lc: { p1: 1 } })
  })

  test('notifies of each update once, and not while HML has focus', async () => {
    const { checks, notify, bump } = setup()
    await checks.run()
    expect(notify).toHaveBeenCalledWith({
      title: '1 mod update for Lethal Company',
      body: 'In profile Main. Click to open it in HML.',
      game: 'lc',
      profileId: 'p1'
    })
    await checks.run()
    expect(notify).toHaveBeenCalledTimes(1)
    bump('3.0.0')
    await checks.run()
    expect(notify).toHaveBeenCalledTimes(2)

    const focused = setup({ focused: true })
    await focused.checks.run()
    expect(focused.notify).not.toHaveBeenCalled()
  })

  test('setCount replaces one profile and drops zeros', async () => {
    const { checks } = setup()
    await checks.run()
    checks.setCount('lc', 'p2', 3)
    expect(checks.summary()).toEqual({ lc: { p1: 1, p2: 3 } })
    checks.setCount('lc', 'p1', 0)
    checks.setCount('lc', 'p2', 0)
    expect(checks.summary()).toEqual({})
  })

  test('overlapping runs share one check', async () => {
    const { checks, ts } = setup()
    await Promise.all([checks.run(), checks.run()])
    expect(ts).toHaveBeenCalledTimes(1)
  })
})
