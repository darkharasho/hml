import { describe, expect, it, vi } from 'vitest'
import {
  createCatalogInstaller,
  type CatalogInstallDeps
} from '../../../src/main/ghcatalog/install'
import type { CatalogEntry } from '../../../src/shared/ghCatalog'
import type { InstalledMod } from '../../../src/shared/types'

const entry = (
  owner: string,
  repo: string,
  id: string,
  extra: Partial<CatalogEntry> = {}
): CatalogEntry =>
  ({
    key: `${owner}/${repo}/${id}`,
    owner,
    repo,
    id,
    name: id,
    dependencies: [],
    ...extra
  }) as CatalogEntry

const ghMod = (owner: string, repo: string, tag: string): InstalledMod => ({
  id: `${owner}-${repo}`,
  name: repo,
  version: '1.0.0',
  source: { kind: 'github', owner, repo, tag, asset: 'a.zip', sha256: 'x' },
  enabled: true,
  files: [],
  disableable: [],
  installedAt: 'x'
})

interface Harness {
  deps: CatalogInstallDeps
  trusted: string[]
  installed: InstalledMod[]
  blocked: Record<string, string>
  ghInstallWith: ReturnType<typeof vi.fn>
  tsInstall: ReturnType<typeof vi.fn>
}

function harness(index: CatalogEntry[]): Harness {
  const h = {
    trusted: [] as string[],
    installed: [] as InstalledMod[],
    blocked: {} as Record<string, string>
  } as Harness
  h.ghInstallWith = vi.fn(async (_g: string, _p: string, url: string) => {
    const [owner, repo] = url.replace('https://github.com/', '').split('/')
    const mod = ghMod(owner, repo, 'v1.0.0')
    h.installed.push(mod)
    return { kind: 'installed', mod, replaced: [] }
  })
  h.tsInstall = vi.fn(async (_g: string, _p: string, fullName: string) => ({
    installed: [{ ...ghMod('ts', fullName, 'v1'), source: { kind: 'thunderstore', fullName } }],
    skipped: [],
    missing: []
  }))
  h.deps = {
    catList: async () => ({ mods: index, fetchedAt: 'x', offline: false }),
    blockedReason: async (owner, repo) =>
      h.blocked[`${owner}/${repo}`.toLowerCase()] ?? h.blocked[owner.toLowerCase()] ?? null,
    installedMods: async () => h.installed,
    trustedOwners: async () => h.trusted,
    trustOwners: async (owners) => {
      h.trusted = [...new Set([...h.trusted, ...owners])]
    },
    ghInstallWith: h.ghInstallWith as unknown as CatalogInstallDeps['ghInstallWith'],
    tsInstall: h.tsInstall as unknown as CatalogInstallDeps['tsInstall']
  }
  return h
}

describe('catPlanInstall', () => {
  it('puts GitHub deps before the target and lists Thunderstore deps', async () => {
    const a = entry('o', 'a', 'a', {
      dependencies: ['github:o/b', 'BepInEx-BepInExPack-5.4.2100']
    })
    const b = entry('o', 'b', 'b')
    const h = harness([a, b])
    const plan = await createCatalogInstaller(h.deps).catPlanInstall('repo', 'p', 'o/a/a')
    expect(plan.mods.map((m) => m.key)).toEqual(['o/b/b', 'o/a/a'])
    expect(plan.thunderstore).toEqual(['BepInEx-BepInExPack-5.4.2100'])
    expect(plan.unavailable).toEqual([])
  })

  it('orders a shared dependency before every mod that needs it', async () => {
    // A needs B and C; C needs B. Plain reverse BFS order would put C before B.
    const a = entry('o', 'a', 'a', { dependencies: ['github:o/b', 'github:o/c'] })
    const b = entry('o', 'b', 'b')
    const c = entry('o', 'c', 'c', { dependencies: ['github:o/b'] })
    const plan = await createCatalogInstaller(harness([a, b, c]).deps).catPlanInstall(
      'repo',
      'p',
      'o/a/a'
    )
    expect(plan.mods.map((m) => m.id)).toEqual(['b', 'c', 'a'])
  })

  it('terminates on a cycle, listing each mod once', async () => {
    const a = entry('o', 'a', 'a', { dependencies: ['github:o/b'] })
    const b = entry('o', 'b', 'b', { dependencies: ['github:O/A/a'] })
    const plan = await createCatalogInstaller(harness([a, b]).deps).catPlanInstall(
      'repo',
      'p',
      'o/a/a'
    )
    expect(plan.mods.map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('ignores a self-dependency', async () => {
    const a = entry('o', 'a', 'a', { dependencies: ['github:o/a', 'github:O/a/a'] })
    const plan = await createCatalogInstaller(harness([a]).deps).catPlanInstall(
      'repo',
      'p',
      'o/a/a'
    )
    expect(plan.mods.map((m) => m.id)).toEqual(['a'])
    expect(plan.unavailable).toEqual([])
  })

  it('lists unlisted, ambiguous, unparseable and blocked deps as unavailable', async () => {
    const a = entry('o', 'a', 'a', {
      dependencies: [
        'github:o/missing',
        'github:o/mono',
        'not a dep',
        'github:bad/x',
        'github:o/mono/two'
      ]
    })
    const m1 = entry('o', 'mono', 'one', { tagPrefix: 'one' })
    const m2 = entry('o', 'mono', 'two', { tagPrefix: 'two' })
    const x = entry('bad', 'x', 'x')
    const h = harness([a, m1, m2, x])
    h.blocked['bad/x'] = 'malware'
    const plan = await createCatalogInstaller(h.deps).catPlanInstall('repo', 'p', 'o/a/a')
    expect(plan.unavailable).toEqual([
      'github:o/missing',
      'github:o/mono',
      'not a dep',
      'github:bad/x'
    ])
    expect(plan.mods.map((m) => m.key)).toEqual(['o/mono/two', 'o/a/a'])
  })

  it('tolerates a non-array dependencies field', async () => {
    const a = entry('o', 'a', 'a', { dependencies: 'github:o/b' as unknown as string[] })
    const plan = await createCatalogInstaller(harness([a]).deps).catPlanInstall(
      'repo',
      'p',
      'o/a/a'
    )
    expect(plan.mods.map((m) => m.id)).toEqual(['a'])
  })

  it('lists untrusted owners of the target and its deps', async () => {
    const a = entry('Alice', 'a', 'a', { dependencies: ['github:bob/b', 'github:carol/c'] })
    const h = harness([a, entry('bob', 'b', 'b'), entry('carol', 'c', 'c')])
    h.trusted = ['carol']
    const plan = await createCatalogInstaller(h.deps).catPlanInstall('repo', 'p', 'Alice/a/a')
    expect(plan.untrustedOwners).toEqual(['bob', 'Alice'])
  })

  it('omits mods already installed at the same owner/repo/prefix', async () => {
    const a = entry('o', 'a', 'a', { dependencies: ['github:o/b', 'github:o/mono/e'] })
    const e = entry('o', 'mono', 'e', { tagPrefix: 'energy-v' })
    const h = harness([a, entry('o', 'b', 'b'), e])
    h.installed = [ghMod('O', 'B', 'v1.0.0'), ghMod('o', 'mono', 'energy-v1.0.0')]
    const plan = await createCatalogInstaller(h.deps).catPlanInstall('repo', 'p', 'o/a/a')
    expect(plan.mods.map((m) => m.id)).toEqual(['a'])
  })

  it('throws for a key not in the catalog', async () => {
    await expect(
      createCatalogInstaller(harness([]).deps).catPlanInstall('repo', 'p', 'o/a/a')
    ).rejects.toThrow("isn't in the GitHub catalog")
  })
})

describe('catInstall', () => {
  const setup = (): Harness => {
    const a = entry('alice', 'a', 'a', {
      tagPrefix: 'a-v',
      assetPattern: 'A-{version}.zip',
      dependencies: ['github:bob/b', 'BepInEx-BepInExPack-5.4.2100']
    })
    return harness([a, entry('bob', 'b', 'b')])
  }

  it('asks for confirmation of untrusted owners and installs nothing', async () => {
    const h = setup()
    const r = await createCatalogInstaller(h.deps).catInstall('repo', 'p', 'alice/a/a', ['alice'])
    expect(r).toEqual({ kind: 'needs-confirm', owners: ['bob'] })
    expect(h.ghInstallWith).not.toHaveBeenCalled()
    expect(h.tsInstall).not.toHaveBeenCalled()
    expect(h.trusted).toEqual([])
  })

  it('installs deps first with the catalog options, saves the owners lowercase', async () => {
    const h = setup()
    const r = await createCatalogInstaller(h.deps).catInstall('repo', 'p', 'alice/a/a', [
      'Alice',
      'BOB'
    ])
    expect(r.kind).toBe('installed')
    expect(h.ghInstallWith.mock.calls).toEqual([
      [
        'repo',
        'p',
        'https://github.com/bob/b',
        undefined,
        {
          tagPrefix: undefined,
          assetPattern: undefined,
          prereleases: false,
          followNewestTag: true,
          catalog: true
        }
      ],
      [
        'repo',
        'p',
        'https://github.com/alice/a',
        undefined,
        {
          tagPrefix: 'a',
          assetPattern: 'A-{version}.zip',
          prereleases: false,
          followNewestTag: true,
          catalog: true
        }
      ]
    ])
    expect(h.tsInstall.mock.calls).toEqual([['repo', 'p', 'BepInEx-BepInExPack']])
    expect(h.trusted.sort()).toEqual(['alice', 'bob'])
    if (r.kind !== 'installed') throw new Error('expected install')
    expect(r.installed.map((m) => m.source)).toEqual([
      expect.objectContaining({ repo: 'b' }),
      expect.objectContaining({ repo: 'a' }),
      { kind: 'thunderstore', fullName: 'BepInEx-BepInExPack' }
    ])
  })

  it('follows pre-releases for a mod the catalog lists from a pre-release', async () => {
    const latest = { tag: 'v0.1.0-beta', prerelease: true, assetName: 'a.zip' }
    const h = harness([entry('o', 'a', 'a', { latest } as Partial<CatalogEntry>)])
    h.trusted = ['o']
    await createCatalogInstaller(h.deps).catInstall('repo', 'p', 'o/a/a', [])
    expect(h.ghInstallWith.mock.calls[0][4]).toMatchObject({ prereleases: true })
  })

  it("asks for the catalog's asset by name when the mod has no assetPattern", async () => {
    const latest = { tag: 'v1.0.0', prerelease: false, assetName: 'Mod-Lite-1.0.0.zip' }
    const h = harness([
      entry('o', 'a', 'a', { latest } as Partial<CatalogEntry>),
      entry('o', 'b', 'b', { latest, assetPattern: 'B-{version}.zip' } as Partial<CatalogEntry>)
    ])
    h.trusted = ['o']
    const inst = createCatalogInstaller(h.deps)
    await inst.catInstall('repo', 'p', 'o/a/a', [])
    await inst.catInstall('repo', 'p', 'o/b/b', [])
    expect(h.ghInstallWith.mock.calls.map((c) => c[3])).toEqual(['Mod-Lite-1.0.0.zip', undefined])
  })

  it('skips a Thunderstore dep the profile already has', async () => {
    const h = setup()
    h.trusted = ['alice', 'bob']
    h.installed = [
      {
        ...ghMod('x', 'y', 'v1'),
        source: { kind: 'thunderstore', fullName: 'BepInEx-BepInExPack' }
      }
    ]
    await createCatalogInstaller(h.deps).catInstall('repo', 'p', 'alice/a/a', [])
    expect(h.tsInstall).not.toHaveBeenCalled()
  })

  it('returns blocked before installing anything', async () => {
    const h = setup()
    h.blocked['alice'] = 'stolen mods'
    const r = await createCatalogInstaller(h.deps).catInstall('repo', 'p', 'alice/a/a', [
      'alice',
      'bob'
    ])
    expect(r).toEqual({ kind: 'blocked', reason: 'stolen mods' })
    expect(h.ghInstallWith).not.toHaveBeenCalled()
    expect(h.tsInstall).not.toHaveBeenCalled()
    expect(h.trusted).toEqual([])
  })

  it('throws when a GitHub install needs a choice', async () => {
    const h = setup()
    h.trusted = ['alice', 'bob']
    h.ghInstallWith.mockResolvedValueOnce({ kind: 'prerelease-only', owner: 'bob', repo: 'b' })
    await expect(
      createCatalogInstaller(h.deps).catInstall('repo', 'p', 'alice/a/a', [])
    ).rejects.toThrow('bob/b')
    expect(h.ghInstallWith).toHaveBeenCalledTimes(1)
  })
})
