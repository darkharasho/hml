import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
    catStatus: vi.fn(async () => null),
    knownGameLabel: vi.fn(async (l: string) => l === 'repo' || /^nexus-[a-z0-9-]+$/.test(l)),
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

describe('validate', () => {
  const manifest = (games: string[] = ['repo']): string =>
    JSON.stringify({
      schema: 1,
      mods: [{ id: 'my-mod', name: 'My Mod', description: 'Does things', games }]
    })
  const dirWith = (text?: string): string => {
    const d = mkdtempSync(path.join(tmpdir(), 'hml-validate-'))
    if (text !== undefined) writeFileSync(path.join(d, 'hml.json'), text)
    return d
  }
  const status = (over: object = {}): never =>
    ({
      owner: 'a',
      repo: 'b',
      crawledAt: '2026-11-22T10:00:00.000Z',
      listed: [],
      warnings: [],
      ...over
    }) as never

  it('lists mod ids and games for a valid file in cwd', async () => {
    const r = await runCli(fakePort([]), ['validate'], dirWith(manifest()))
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('my-mod')
    expect(r.stdout).toContain('repo')
  })

  it('accepts a file path and a directory path', async () => {
    const d = dirWith(manifest())
    expect((await runCli(fakePort([]), ['validate', path.join(d, 'hml.json')], '/')).code).toBe(0)
    expect((await runCli(fakePort([]), ['validate', d], '/')).code).toBe(0)
  })

  it('prints warnings to stderr and still exits 0', async () => {
    const r = await runCli(fakePort([]), ['validate'], dirWith(manifest(['repo', 'nope'])))
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('unknown game "nope" ignored')
  })

  it('names the unknown labels of an unknown-games rejection', async () => {
    const r = await runCli(fakePort([]), ['validate'], dirWith(manifest(['nope'])))
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('hml: unknown-games')
    expect(r.stderr).toContain('unknown game "nope" ignored')
  })

  it('exits 1 with the exact reason for an invalid file', async () => {
    const r = await runCli(fakePort([]), ['validate'], dirWith('{"schema":2}'))
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('invalid-manifest: schema')
  })

  it('exits 1 with the parse problem for broken JSON', async () => {
    const r = await runCli(fakePort([]), ['validate'], dirWith('{nope'))
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('invalid-manifest')
  })

  it('exits 1 when there is no hml.json', async () => {
    const d = dirWith()
    const r = await runCli(fakePort([]), ['validate', d], '/')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`No hml.json in ${d}`)
  })

  it('prefers an existing path over owner/repo', async () => {
    const d = dirWith()
    mkdirSync(path.join(d, 'a'))
    writeFileSync(path.join(d, 'a', 'b'), '')
    const port = fakePort([])
    const r = await runCli(port, ['validate', 'a/b'], d)
    expect(port.catStatus).not.toHaveBeenCalled()
    expect(r.code).toBe(1)
  })

  it('reports a listed repo with the crawl time', async () => {
    const port = fakePort([])
    port.catStatus.mockResolvedValue(
      status({ listed: [{ id: 'my-mod', name: 'My Mod', games: ['repo'] }] })
    )
    const r = await runCli(port, ['validate', 'a/b'], '/nonexistent-dir')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('2026-11-22T10:00:00.000Z')
    expect(port.catStatus).toHaveBeenCalledWith('a/b')
  })

  it('reports a rejected repo with the reason', async () => {
    const port = fakePort([])
    port.catStatus.mockResolvedValue(status({ rejected: 'invalid-manifest: schema: bad' }))
    const r = await runCli(port, ['validate', 'a/b'], '/nonexistent-dir')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('invalid-manifest: schema: bad')
  })

  it('says when a repo is not crawled yet', async () => {
    const r = await runCli(fakePort([]), ['validate', 'a/b'], '/nonexistent-dir')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(
      'Not in the catalog yet. Add the hml-mod topic; the catalog updates every 30 minutes.'
    )
  })

  it('does not call an unreachable catalog "not in the catalog yet"', async () => {
    const port = fakePort([])
    port.catStatus.mockRejectedValue(new Error('fetch failed'))
    const r = await runCli(port, ['validate', 'a/b'], '/nonexistent-dir')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('fetch failed')
    expect(r.stderr).not.toContain('Not in the catalog yet')
  })

  it('exits 2 for two arguments', async () => {
    const r = await runCli(fakePort([]), ['validate', 'a', 'b'], '/')
    expect(r.code).toBe(2)
  })

  it('prints the ManifestResult or RepoStatus with --json', async () => {
    const r = await runCli(fakePort([]), ['validate', '--json'], dirWith(manifest()))
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, mods: [{ id: 'my-mod' }] })
    const port = fakePort([])
    port.catStatus.mockResolvedValue(status())
    const s = await runCli(port, ['validate', 'a/b', '--json'], '/nonexistent-dir')
    expect(JSON.parse(s.stdout)).toMatchObject({ owner: 'a', repo: 'b' })
  })

  it('exits 1 with --json for an invalid file, printing the result', async () => {
    const r = await runCli(fakePort([]), ['validate', '--json'], dirWith('{"schema":2}'))
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false })
  })
})
