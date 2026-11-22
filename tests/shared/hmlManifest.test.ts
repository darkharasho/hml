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
  it('rejects when no game is known', () => {
    expect(one({ games: ['bogus'] })).toEqual({ ok: false, error: 'unknown-games' })
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
