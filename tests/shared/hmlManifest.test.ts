import { describe, it, expect } from 'vitest'
import {
  validateManifest,
  isKnownGameLabel,
  manifestJsonSchema,
  MANIFEST_MAX_BYTES
} from '../../src/shared/hmlManifest'
import { parseDependency } from '../../src/shared/ghCatalog'

const KNOWN = (l: string): boolean => isKnownGameLabel(l, new Set(['repo', 'stonewards']))
const mod = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'a',
  name: 'A',
  description: 'd',
  games: ['repo'],
  ...o
})
const man = (mods: Record<string, unknown>[]): string => JSON.stringify({ schema: 1, mods })
const one = (o: Record<string, unknown> = {}): ReturnType<typeof validateManifest> =>
  validateManifest(man([mod(o)]), KNOWN)

describe('validateManifest', () => {
  it('null is no-manifest', () => {
    expect(validateManifest(null, KNOWN)).toEqual({ ok: false, error: 'no-manifest' })
  })
  it('bad JSON is invalid-manifest', () => {
    const r = validateManifest('{', KNOWN)
    expect(!r.ok && r.error.startsWith('invalid-manifest: ')).toBe(true)
  })
  it('rejects oversized text by bytes', () => {
    const r = validateManifest('é'.repeat(MANIFEST_MAX_BYTES / 2 + 1), KNOWN)
    expect(r).toEqual({ ok: false, error: 'invalid-manifest: (root): too large' })
  })
  it('rejects schema 2', () => {
    const r = validateManifest(JSON.stringify({ schema: 2, mods: [mod()] }), KNOWN)
    expect(!r.ok && r.error.startsWith('invalid-manifest: schema')).toBe(true)
  })
  it('requires tagPrefix with several mods', () => {
    const r = validateManifest(man([mod(), mod({ id: 'b' })]), KNOWN)
    expect(!r.ok && r.error).toContain('tagPrefix')
  })
  it('rejects duplicate ids', () => {
    const r = validateManifest(man([mod({ tagPrefix: 'a-' }), mod({ tagPrefix: 'b-' })]), KNOWN)
    expect(!r.ok && r.error).toContain('mods.1.id')
  })
  it('warns on unknown games when another is known', () => {
    const r = one({ games: ['repo', 'bogus'] })
    expect(r.ok && r.warnings.join()).toContain('bogus')
    expect(r.ok && r.mods[0].games).toEqual(['repo'])
  })
  it('rejects when no game is known, with the unknown labels as warnings', () => {
    expect(one({ games: ['bogus'] })).toEqual({
      ok: false,
      error: 'unknown-games',
      warnings: ['a: unknown game "bogus" ignored']
    })
  })
  it('accepts nexus labels', () => {
    expect(one({ games: ['nexus-skyrimspecialedition'] }).ok).toBe(true)
  })
  it('icon must be https URL or repo path', () => {
    for (const icon of ['javascript:alert(1)', 'http://x/y.png']) {
      const r = one({ icon })
      expect(!r.ok && r.error.startsWith('invalid-manifest')).toBe(true)
    }
    expect(one({ icon: 'https://x/y.png' }).ok).toBe(true)
    expect(one({ icon: 'icons/a.png' }).ok).toBe(true)
  })
  it('rejects absolute and .. paths', () => {
    for (const o of [
      { icon: '/a.png' },
      { icon: '../a.png' },
      { readme: '/R.md' },
      { readme: 'a/../../R.md' }
    ]) {
      const r = one(o)
      expect(!r.ok && r.error.startsWith('invalid-manifest')).toBe(true)
    }
  })
  it('caps assetPattern at 200 characters', () => {
    expect(one({ assetPattern: `${'a'.repeat(196)}.zip` }).ok).toBe(true)
    const r = one({ assetPattern: `${'a'.repeat(197)}.zip` })
    expect(!r.ok && r.error).toMatch(/^invalid-manifest: mods\.0\.assetPattern: /)
  })
  it('allows at most 2 {version} tokens in assetPattern', () => {
    expect(one({ assetPattern: 'a-{version}-{version}.zip' }).ok).toBe(true)
    const r = one({ assetPattern: 'a-{version}-{version}-{version}.zip' })
    expect(!r.ok && r.error).toBe(
      'invalid-manifest: mods.0.assetPattern: must contain at most 2 {version} tokens'
    )
  })
  it('rejects {version} tokens with nothing between them', () => {
    expect(one({ assetPattern: 'a{version}.{version}b.zip' }).ok).toBe(true)
    for (const assetPattern of ['1{version}{version}1', '{version}{version}.zip']) {
      const r = one({ assetPattern })
      expect(!r.ok && r.error).toBe(
        'invalid-manifest: mods.0.assetPattern: must have text between {version} tokens, like {version}-{version}'
      )
    }
  })
  it('caps games, dependencies and tagPrefix', () => {
    const games = (n: number, len = 4): string[] =>
      Array.from({ length: n }, (_, i) => `nexus-${String(i).padStart(len, 'x')}`)
    expect(one({ games: games(20) }).ok).toBe(true)
    expect(one({ games: games(21) })).toMatchObject({ ok: false })
    expect(one({ games: ['nexus-' + 'a'.repeat(58)] }).ok).toBe(true)
    const long = one({ games: ['nexus-' + 'a'.repeat(59)] })
    expect(!long.ok && long.error).toMatch(/^invalid-manifest: mods\.0\.games\.0: /)
    const deps = (n: number): string[] => Array.from({ length: n }, (_, i) => `github:a/b${i}`)
    expect(one({ dependencies: deps(50) }).ok).toBe(true)
    const many = one({ dependencies: deps(51) })
    expect(!many.ok && many.error).toMatch(/^invalid-manifest: mods\.0\.dependencies: /)
    expect(one({ dependencies: [`github:a/${'b'.repeat(191)}`] }).ok).toBe(true)
    expect(one({ dependencies: [`github:a/${'b'.repeat(192)}`] })).toMatchObject({ ok: false })
    expect(one({ tagPrefix: 'p'.repeat(64) }).ok).toBe(true)
    const pre = one({ tagPrefix: 'p'.repeat(65) })
    expect(!pre.ok && pre.error).toMatch(/^invalid-manifest: mods\.0\.tagPrefix: /)
  })
  it('readme path errors name a repo path only; icon errors allow a URL', () => {
    expect(one({ readme: 'https://x/R.md' })).toEqual({
      ok: false,
      error: 'invalid-manifest: mods.0.readme: must be a relative repo path'
    })
    const r = one({ icon: 'javascript:alert(1)' })
    expect(!r.ok && r.error).toBe(
      'invalid-manifest: mods.0.icon: must be an https URL or repo path'
    )
  })
  it('applies defaults', () => {
    const r = one()
    expect(r.ok && r.mods[0]).toMatchObject({ categories: [], dependencies: [], nsfw: false })
  })
})

describe('parseDependency', () => {
  it('thunderstore', () => {
    expect(parseDependency('BepInEx-BepInExPack-5.4.2100')).toEqual({
      kind: 'thunderstore',
      fullName: 'BepInEx-BepInExPack-5.4.2100'
    })
  })
  it('github owner/repo', () => {
    expect(parseDependency('github:a/b')).toEqual({ kind: 'github', owner: 'a', repo: 'b' })
  })
  it('github with id', () => {
    expect(parseDependency('github:a/b/c')).toEqual({
      kind: 'github',
      owner: 'a',
      repo: 'b',
      id: 'c'
    })
  })
  it('invalid gives null', () => {
    expect(parseDependency('github:')).toBeNull()
    expect(parseDependency('nope')).toBeNull()
  })
})

describe('manifestJsonSchema', () => {
  it('has properties.mods', () => {
    expect(
      (manifestJsonSchema() as { properties: Record<string, unknown> }).properties.mods
    ).toBeDefined()
  })
})
