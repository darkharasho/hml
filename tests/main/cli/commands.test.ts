import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { findCliArgs, parseCliArgs, runCli, type CliPort } from '../../../src/main/cli/commands'
import type { InstalledMod, ProfileManifest } from '../../../src/shared/types'

const mod = (id: string, enabled = true): InstalledMod => ({
  id,
  name: id,
  version: '1.0.0',
  source: { kind: 'local', fileName: `${id}.zip`, sha256: 'x' },
  enabled,
  files: [`BepInEx/plugins/${id}/${id}.dll`],
  disableable: [`BepInEx/plugins/${id}/${id}.dll`],
  installedAt: '2026-11-04T00:00:00.000Z'
})

const profile = (id: string, mods: InstalledMod[] = []): ProfileManifest => ({
  formatVersion: 1,
  id,
  name: id.toUpperCase(),
  game: 'repo',
  createdAt: '2026-11-04T00:00:00.000Z',
  mods
})

type FakePort = { [K in keyof CliPort]: CliPort[K] & ReturnType<typeof vi.fn> }

function fakePort(profiles: ProfileManifest[], lastProfile: Record<string, string> = {}): FakePort {
  const port = {
    getGame: vi.fn(async (label: string) =>
      label === 'repo' ? ({ label: 'repo', displayName: 'R.E.P.O.' } as never) : null
    ),
    knownGames: vi.fn(async () => [{ label: 'repo', displayName: 'R.E.P.O.' }]),
    listProfiles: vi.fn(async () => profiles),
    createProfile: vi.fn(async (_g: string, name: string) => profile(name.toLowerCase())),
    installFromPaths: vi.fn(async (_g: string, _p: string, files: string[]) =>
      files.map((f) => mod(path.basename(f)))
    ),
    uninstallMod: vi.fn(async () => undefined),
    setModEnabled: vi.fn(async () => undefined),
    launch: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => ({ lastProfile }) as never),
    emit: vi.fn()
  }
  return port as unknown as FakePort
}

describe('findCliArgs', () => {
  it('returns what follows --cli, or null', () => {
    expect(findCliArgs(['/opt/hml', '--no-sandbox', '--cli', 'mods', 'repo'])).toEqual([
      'mods',
      'repo'
    ])
    expect(findCliArgs(['/opt/hml'])).toBeNull()
  })
})

describe('parseCliArgs', () => {
  it('reads options anywhere and defaults to help', () => {
    expect(parseCliArgs(['mods', '--json', 'repo', '-p', 'dev'])).toMatchObject({
      command: 'mods',
      positional: ['repo'],
      profile: 'dev',
      json: true
    })
    expect(parseCliArgs([]).command).toBe('help')
    expect(parseCliArgs(['install', '--profile=x']).profile).toBe('x')
  })
})

describe('runCli', () => {
  it('prints usage for help', async () => {
    const r = await runCli(fakePort([]), ['help'], '/')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('install <game> <path>...')
  })

  it('installs paths resolved against the caller cwd into the only profile', async () => {
    const port = fakePort([profile('default')])
    const r = await runCli(port, ['install', 'repo', 'build/MyMod', '/abs/Other.zip'], '/work')
    expect(r.code).toBe(0)
    expect(port.installFromPaths).toHaveBeenCalledWith('repo', 'default', [
      path.resolve('/work', 'build/MyMod'),
      path.resolve('/abs/Other.zip')
    ])
    expect(r.stdout).toContain('Installed MyMod 1.0.0')
    expect(port.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cli-changed', game: 'repo', profileId: 'default' })
    )
  })

  it('uses the profile selected in HML when there are several', async () => {
    const port = fakePort([profile('a'), profile('b')], { repo: 'b' })
    await runCli(port, ['install', 'repo', '/m.zip'], '/')
    expect(port.installFromPaths).toHaveBeenCalledWith('repo', 'b', ['/m.zip'])
  })

  it('asks for --profile when several exist and none is selected', async () => {
    const r = await runCli(fakePort([profile('a'), profile('b')]), ['mods', 'repo'], '/')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--profile')
  })

  it('matches profiles by name and games by display name', async () => {
    const port = fakePort([profile('a'), profile('b')])
    const r = await runCli(port, ['mods', 'r.e.p.o.', '--profile', 'B', '--json'], '/')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ game: 'repo', profile: 'b', mods: [] })
  })

  it('rejects an unknown game with a hint', async () => {
    const r = await runCli(fakePort([]), ['mods', 'nope'], '/')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('hml games')
  })

  it('disables, enables and uninstalls by mod id', async () => {
    const port = fakePort([profile('default', [mod('MyMod')])])
    expect((await runCli(port, ['disable', 'repo', 'mymod'], '/')).code).toBe(0)
    expect(port.setModEnabled).toHaveBeenCalledWith('repo', 'default', 'MyMod', false)
    await runCli(port, ['enable', 'repo', 'MyMod'], '/')
    expect(port.setModEnabled).toHaveBeenCalledWith('repo', 'default', 'MyMod', true)
    await runCli(port, ['uninstall', 'repo', 'MyMod'], '/')
    expect(port.uninstallMod).toHaveBeenCalledWith('repo', 'default', 'MyMod')
    const missing = await runCli(port, ['uninstall', 'repo', 'Ghost'], '/')
    expect(missing.code).toBe(2)
  })

  it('launches modded, or vanilla without a profile', async () => {
    const port = fakePort([profile('default')])
    await runCli(port, ['launch', 'repo'], '/')
    expect(port.launch).toHaveBeenCalledWith('repo', 'default', 'modded')
    await runCli(port, ['launch', 'repo', '--vanilla'], '/')
    expect(port.launch).toHaveBeenCalledWith('repo', null, 'vanilla')
  })

  it('reports service errors with exit code 1, as JSON when asked', async () => {
    const port = fakePort([profile('default')])
    port.installFromPaths.mockRejectedValueOnce(new Error('Could not install x.zip: bad zip'))
    const r = await runCli(port, ['install', 'repo', '/x.zip', '--json'], '/')
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stderr)).toEqual({ error: 'Could not install x.zip: bad zip' })
  })
})
