import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHmlFile, collectHmlParts, readHmlFile } from '../../../src/main/share/hmlFile'
import { revisionDigest } from '../../../src/main/sync/revision'
import type { InstalledMod, ProfileManifest } from '../../../src/shared/types'

function mod(name: string, enabled = true): InstalledMod {
  return {
    id: name,
    name,
    version: '1.0.0',
    source: { kind: 'thunderstore', fullName: `o-${name}` },
    enabled,
    files: [],
    disableable: [],
    installedAt: ''
  }
}

function makeProfile(mods: InstalledMod[]): ProfileManifest {
  return { formatVersion: 1, id: 'p1', name: 'P', game: 'repo', createdAt: '', mods }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hml-rev-'))
  await mkdir(join(dir, 'BepInEx', 'config'), { recursive: true })
  await writeFile(join(dir, 'BepInEx', 'config', 'a.cfg'), 'one')
  await writeFile(join(dir, 'BepInEx', 'config', 'b.cfg'), 'two')
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

const digestOf = async (p: ProfileManifest): Promise<string> =>
  revisionDigest(await collectHmlParts(p, dir))

describe('revisionDigest', () => {
  it('same content gives the same digest even when built at different times', async () => {
    const p = makeProfile([mod('A')])
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))
    const zip1 = await buildHmlFile(p, dir)
    const d1 = await digestOf(p)
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'))
    const zip2 = await buildHmlFile(p, dir)
    const d2 = await digestOf(p)
    expect(Buffer.from(zip1).equals(Buffer.from(zip2))).toBe(false)
    expect(d1).toMatch(/^[0-9a-f]{64}$/)
    expect(d1).toBe(d2)
  })

  it('config order does not matter', async () => {
    const parts = await collectHmlParts(makeProfile([mod('A')]), dir)
    const reversed = { export: parts.export, configs: new Map([...parts.configs].reverse()) }
    expect(revisionDigest(reversed)).toBe(revisionDigest(parts))
  })

  it('a changed config byte changes the digest', async () => {
    const p = makeProfile([mod('A')])
    const before = await digestOf(p)
    await writeFile(join(dir, 'BepInEx', 'config', 'a.cfg'), 'onf')
    expect(await digestOf(p)).not.toBe(before)
  })

  it('toggling a mod changes the digest', async () => {
    expect(await digestOf(makeProfile([mod('A', true)]))).not.toBe(
      await digestOf(makeProfile([mod('A', false)]))
    )
  })

  it('different path/content splits do not collide', () => {
    const exp = { formatVersion: 1 as const, game: 'g', profileName: 'n', mods: [] }
    const enc = new TextEncoder()
    const a = new Map([['x', enc.encode('1y')]])
    const b = new Map([['x1', enc.encode('y')]])
    expect(revisionDigest({ export: exp, configs: a })).not.toBe(
      revisionDigest({ export: exp, configs: b })
    )
  })
})

describe('buildHmlFile', () => {
  it('still produces a readable .hml', async () => {
    const p = makeProfile([mod('A'), mod('B', false)])
    const read = await readHmlFile(await buildHmlFile(p, dir))
    expect(read.export.mods.map((m) => [m.name, m.enabled])).toEqual([
      ['A', true],
      ['B', false]
    ])
    expect([...read.configs.keys()]).toEqual(['BepInEx/config/a.cfg', 'BepInEx/config/b.cfg'])
    expect(new TextDecoder().decode(read.configs.get('BepInEx/config/a.cfg'))).toBe('one')
  })
})
