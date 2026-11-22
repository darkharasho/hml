import { describe, expect, it } from 'vitest'
import {
  buildStatus,
  listRepo,
  MAX_ASSET_MATCHES_PER_REPO,
  matchUnits,
  newMatchBudget,
  type CrawledRelease,
  type CrawledRepo
} from '../../worker/src/catalog/listing'

const known = (g: string): boolean => g === 'repo'
const NOW = '2026-11-22T00:00:00Z'
const mod = (o: object = {}): object => ({
  id: 'm',
  name: 'M',
  description: 'd',
  games: ['repo'],
  ...o
})
const man = (...mods: object[]): string => JSON.stringify({ schema: 1, mods })
const rel = (tag: string, at: string, o: Partial<CrawledRelease> = {}): CrawledRelease => ({
  tag,
  draft: false,
  prerelease: false,
  publishedAt: at,
  assets: [{ name: 'x.zip', size: 10, downloads: 5 }],
  ...o
})
const repo = (o: Partial<CrawledRepo> = {}): CrawledRepo => ({
  id: 'R1',
  ownerId: 'O1',
  owner: 'o',
  repo: 'r',
  stars: 3,
  createdAt: '2026-01-01T00:00:00Z',
  ownerAvatar: 'https://avatars/o',
  defaultBranch: 'main',
  manifest: man(mod()),
  releases: [rel('v1.0.0', '2026-02-01T00:00:00Z')],
  archived: false,
  ...o
})

describe('buildStatus', () => {
  it('rejects without a manifest', () => {
    expect(buildStatus(repo({ manifest: null }), known, NOW).rejected).toBe('no-manifest')
  })
  it('rejects an oversized manifest', () => {
    expect(buildStatus(repo({ manifest: null, manifestTooLarge: true }), known, NOW).rejected).toBe(
      'invalid-manifest: (root): too large'
    )
  })
  it('rejects only draft releases', () => {
    const s = buildStatus(
      repo({ releases: [rel('v1', '2026-02-01T00:00:00Z', { draft: true })] }),
      known,
      NOW
    )
    expect(s.rejected).toBe('no-releases')
    expect(s.listed).toEqual([])
  })
  it('rejects releases without a zip', () => {
    const r = rel('v1', '2026-02-01T00:00:00Z', {
      assets: [{ name: 'a.txt', size: 1, downloads: 0 }]
    })
    expect(buildStatus(repo({ releases: [r] }), known, NOW).rejected).toBe('no-matching-asset')
  })
  it('honours assetPattern', () => {
    const r = rel('v1', '2026-02-01T00:00:00Z', {
      assets: [
        { name: 'other.zip', size: 1, downloads: 1 },
        { name: 'pkg-1.0.zip', size: 2, downloads: 7 }
      ]
    })
    const s = buildStatus(
      repo({ manifest: man(mod({ assetPattern: 'pkg-{version}.zip' })), releases: [r] }),
      known,
      NOW
    )
    expect(s.listed[0].latest.assetName).toBe('pkg-1.0.zip')
    expect(s.listed[0].latest.size).toBe(2)
    expect(s.listed[0].downloads).toBe(7)
  })
  it('picks the newest release per prefix in a monorepo', () => {
    const releases = [
      rel('a-v1.0.0', '2026-01-01T00:00:00Z'),
      rel('a-v1.1.0', '2026-03-01T00:00:00Z'),
      rel('b-v2.0.0', '2026-02-01T00:00:00Z'),
      rel('b-v1.0.0', '2026-01-01T00:00:00Z')
    ]
    const s = buildStatus(
      repo({
        manifest: man(mod({ id: 'a', tagPrefix: 'a-v' }), mod({ id: 'b', tagPrefix: 'b' })),
        releases
      }),
      known,
      NOW
    )
    const by = Object.fromEntries(s.listed.map((e) => [e.id, e]))
    expect(by.a.latest.tag).toBe('a-v1.1.0')
    expect(by.a.latest.version).toBe('1.1.0')
    expect(by.b.latest.tag).toBe('b-v2.0.0')
    expect(by.a.key).toBe('o/r/a')
    expect(by.a.downloads).toBe(10)
  })
  it('prefers stable over a newer prerelease, lists prerelease-only', () => {
    const both = [
      rel('v1.0.0', '2026-01-01T00:00:00Z'),
      rel('v2.0.0-beta', '2026-05-01T00:00:00Z', { prerelease: true })
    ]
    expect(buildStatus(repo({ releases: both }), known, NOW).listed[0].latest.tag).toBe('v1.0.0')
    const pre = [both[1]]
    expect(buildStatus(repo({ releases: pre }), known, NOW).listed[0].latest.prerelease).toBe(true)
  })
  it('sums downloads of matching assets across releases', () => {
    const releases = [
      rel('v1', '2026-01-01T00:00:00Z', {
        assets: [
          { name: 'a.zip', size: 1, downloads: 3 },
          { name: 'a.txt', size: 1, downloads: 100 }
        ]
      }),
      rel('v2', '2026-02-01T00:00:00Z', { assets: [{ name: 'b.ZIP', size: 1, downloads: 4 }] })
    ]
    expect(buildStatus(repo({ releases }), known, NOW).listed[0].downloads).toBe(7)
  })
  it('resolves icon and readme URLs', () => {
    const base = 'https://raw.githubusercontent.com/o/r/main/'
    const a = buildStatus(
      repo({ manifest: man(mod({ icon: 'img/my icon.png', readme: 'docs/R.md' })) }),
      known,
      NOW
    )
    expect(a.listed[0].icon).toBe(base + 'img/my%20icon.png')
    expect(a.listed[0].readme).toBe(base + 'docs/R.md')
    const b = buildStatus(repo(), known, NOW)
    expect(b.listed[0].icon).toBe('https://avatars/o')
    expect(b.listed[0].readme).toBe(base + 'README.md')
    const c = buildStatus(repo({ manifest: man(mod({ icon: 'https://x.io/i.png' })) }), known, NOW)
    expect(c.listed[0].icon).toBe('https://x.io/i.png')
  })
  it('lists one mod when the other has no releases and warns', () => {
    const s = buildStatus(
      repo({
        manifest: man(mod({ id: 'a', tagPrefix: 'a' }), mod({ id: 'b', tagPrefix: 'b' })),
        releases: [rel('a-v1.0.0', '2026-01-01T00:00:00Z')]
      }),
      known,
      NOW
    )
    expect(s.rejected).toBeUndefined()
    expect(s.listed.map((e) => e.id)).toEqual(['a'])
    expect(s.warnings.some((w) => w.includes('b'))).toBe(true)
  })
  it('keeps the unknown labels as warnings when rejected with unknown-games', () => {
    const s = buildStatus(repo({ manifest: man(mod({ games: ['zzz', 'yyy'] })) }), known, NOW)
    expect(s.rejected).toBe('unknown-games')
    expect(s.warnings).toEqual(['m: unknown game "zzz" ignored', 'm: unknown game "yyy" ignored'])
  })
  it("keeps each mod's reason when no mod of a monorepo is listed", () => {
    const s = buildStatus(
      repo({
        manifest: man(mod({ id: 'a', tagPrefix: 'a' }), mod({ id: 'b', tagPrefix: 'b' })),
        releases: [
          rel('a-v1.0.0', '2026-01-01T00:00:00Z', {
            assets: [{ name: 'a.txt', size: 1, downloads: 0 }]
          })
        ]
      }),
      known,
      NOW
    )
    expect(s.rejected).toBe('no-matching-asset')
    expect(s.warnings).toEqual(['a: not listed (no-matching-asset)', 'b: not listed (no-releases)'])
  })
  it('passes manifest warnings through', () => {
    const s = buildStatus(repo({ manifest: man(mod({ games: ['repo', 'zzz'] })) }), known, NOW)
    expect(s.warnings.some((w) => w.includes('zzz'))).toBe(true)
    expect(s.listed[0].games).toEqual(['repo'])
  })
})

describe('listRepo', () => {
  it('asks for more releases when a prefixed mod has none in the crawled ones', () => {
    const r = repo({
      manifest: man(mod({ id: 'a', tagPrefix: 'a' }), mod({ id: 'b', tagPrefix: 'b' })),
      releases: [rel('a-v1.0.0', '2026-01-01T00:00:00Z')]
    })
    expect(listRepo(r, known, NOW).moreReleases).toBe(true)
  })
  it("doesn't when every prefixed mod has releases, or a plain mod has none", () => {
    const both = repo({
      manifest: man(mod({ id: 'a', tagPrefix: 'a' }), mod({ id: 'b', tagPrefix: 'b' })),
      releases: [rel('a-v1.0.0', '2026-01-01T00:00:00Z'), rel('b-v1.0.0', '2026-01-01T00:00:00Z')]
    })
    expect(listRepo(both, known, NOW).moreReleases).toBe(false)
    const plain = repo({ releases: [rel('v1', '2026-02-01T00:00:00Z', { draft: true })] })
    expect(listRepo(plain, known, NOW).moreReleases).toBe(false)
  })
})

describe('asset matching cost', () => {
  const HOSTILE = '1{version}{version}1'
  /** 20 releases of 15 distinct asset names each: a full first page of releases. */
  const releases = (name: (i: number) => string): CrawledRelease[] =>
    Array.from({ length: 20 }, (_, r) =>
      rel(`v1.0.${r}`, `2026-02-${String(r + 1).padStart(2, '0')}T00:00:00Z`, {
        assets: Array.from({ length: 15 }, (_, a) => ({
          name: name(r * 15 + a),
          size: 1,
          downloads: 1
        }))
      })
    )
  const hostileRepo = (len: number): CrawledRepo =>
    repo({
      manifest: man(mod({ assetPattern: HOSTILE })),
      releases: releases((i) => `${'1'.repeat(len - 4)}${String(i).padStart(3, '0')}x`)
    })

  it.each([250, 100])('a hostile pattern over %i-character names stays fast', (len) => {
    const r = hostileRepo(len)
    expect(r.releases[0].assets[0].name).toHaveLength(len)
    const started = performance.now()
    const { status } = listRepo(r, known, NOW)
    expect(performance.now() - started).toBeLessThan(50)
    expect(status.listed).toEqual([])
    // Adjacent tokens are now refused by the schema, before any asset is matched.
    expect(status.rejected).toMatch(/^invalid-manifest: mods\.0\.assetPattern: must have text/)
  })

  it('a separated pattern over 100-character names stays fast', () => {
    const r = repo({
      manifest: man(mod({ assetPattern: 'a{version}.{version}b' })),
      releases: releases((i) => `a${'1.'.repeat(47)}1${String(i).padStart(3, '0')}!`)
    })
    expect(r.releases[0].assets[0].name).toHaveLength(100)
    const started = performance.now()
    expect(listRepo(r, known, NOW).status.rejected).toBe('no-matching-asset')
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('charges a match one unit per 25 characters of the name', () => {
    expect([1, 25, 26, 50, 51, 100].map(matchUnits)).toEqual([1, 1, 2, 2, 3, 4])
    const long = (i: number): string => `Mod-${String(i).padStart(92, '0')}.zip`
    expect(long(0)).toHaveLength(100)
    const r = repo({
      manifest: man(mod({ assetPattern: 'Mod-{version}.zip' })),
      releases: releases(long)
    })
    const budget = newMatchBudget()
    const s = listRepo(r, known, NOW, budget).status
    expect(budget.seen.size).toBe(MAX_ASSET_MATCHES_PER_REPO / 4)
    expect(s.rejected).toBe('no-matching-asset')
    expect(s.warnings[0]).toBe(
      `asset matching stopped after ${MAX_ASSET_MATCHES_PER_REPO} units (25 name characters each)`
    )
  })

  it('lists a mod whose first page of releases is all distinct matching assets', () => {
    expect(MAX_ASSET_MATCHES_PER_REPO).toBe(300)
    const r = repo({
      manifest: man(mod({ assetPattern: 'Mod-{version}.zip' })),
      releases: releases((i) => `Mod-${i}.zip`)
    })
    const s = listRepo(r, known, NOW).status
    expect(s.listed).toHaveLength(1)
    expect(s.listed[0].downloads).toBe(300)
    expect(s.warnings).toEqual([])
  })

  it('rejects the remaining mods with a warning once the budget is spent', () => {
    const r = repo({
      manifest: man(
        mod({ id: 'a', tagPrefix: 'a', assetPattern: 'A-{version}.zip' }),
        mod({ id: 'b', tagPrefix: 'b', assetPattern: 'B-{version}.zip' })
      ),
      releases: [
        ...releases((i) => `A-${i}.zip`).map((x) => ({ ...x, tag: `a-${x.tag}` })),
        rel('b-v1.0.0', '2026-03-01T00:00:00Z', {
          assets: [
            { name: 'x.txt', size: 1, downloads: 0 },
            { name: 'B-1.0.zip', size: 1, downloads: 0 }
          ]
        })
      ]
    })
    const s = listRepo(r, known, NOW).status
    expect(s.listed.map((m) => m.id)).toEqual(['a'])
    expect(s.warnings).toEqual([
      `asset matching stopped after ${MAX_ASSET_MATCHES_PER_REPO} units (25 name characters each)`,
      'b: not listed (no-matching-asset)'
    ])
  })

  it('shares one budget across listings of a repo, re-matching known names for free', () => {
    const r = repo({
      manifest: man(mod({ assetPattern: 'Mod-{version}.zip' })),
      releases: releases((i) => `Mod-${i}.zip`)
    })
    const budget = newMatchBudget()
    expect(listRepo(r, known, NOW, budget).status.listed).toHaveLength(1)
    expect(budget.left).toBe(0)
    expect(listRepo(r, known, NOW, budget).status.listed).toHaveLength(1)
    const more = {
      ...r,
      releases: [
        ...r.releases,
        rel('v0.0.1', '2026-01-01T00:00:00Z', {
          assets: [{ name: 'Mod-0.0.1.zip', size: 1, downloads: 1 }]
        })
      ]
    }
    const s = listRepo(more, known, NOW, budget).status
    expect(s.rejected).toBe('no-matching-asset')
    expect(s.warnings[0]).toBe(
      `asset matching stopped after ${MAX_ASSET_MATCHES_PER_REPO} units (25 name characters each)`
    )
  })
})
