import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyRevision,
  modKey,
  type ApplyContext,
  type SyncApplyResult
} from '../../../src/main/sync/apply'
import { readBases, writeBases } from '../../../src/main/sync/bases'
import type { HmlExport, HmlExportMod, InstalledMod } from '../../../src/shared/types'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const CFG = 'BepInEx/config/a.cfg'

const ts = (name: string, version = '1.0.0', enabled = true): HmlExportMod => ({
  source: { kind: 'thunderstore', fullName: `o-${name}` },
  version,
  enabled
})
const installed = (e: HmlExportMod): InstalledMod => {
  const s = e.source
  return {
    id: modKey(s),
    name: modKey(s),
    version: e.version,
    source: s,
    enabled: e.enabled,
    files: [],
    disableable: [],
    installedAt: ''
  }
}

let dir: string
let mods: InstalledMod[]
let calls: string[]
let failKeys: Set<string>
let nexusManual: Set<string>

function makeCtx(): ApplyContext {
  const boom = (): never => {
    throw new Error('not used')
  }
  return {
    deps: {
      paths: { profileDir: () => dir },
      emit: () => undefined
    } as never,
    serialize: (_g, _p, fn) => fn(),
    installers: {
      uninstallMod: async (_g, _p, id) => {
        calls.push(`uninstall ${id}`)
        mods = mods.filter((m) => m.id !== id)
      },
      setModEnabled: async (_g, _p, id, enabled) => {
        calls.push(`enable ${id} ${enabled}`)
        mods = mods.map((m) => (m.id === id ? { ...m, enabled } : m))
      },
      createProfile: boom,
      addNexusGame: boom,
      addCustomGame: boom
    } as never,
    entries: {
      refresher: () => async () => undefined,
      repinThunderstore: async () => {
        calls.push('repin')
        return []
      },
      tsModAt: async () => false,
      installEntry: async (_g: string, _p: string, entry: HmlExportMod) => {
        const key = modKey(entry.source)
        calls.push(`install ${key}@${entry.version}`)
        if (failKeys.has(key)) {
          return {
            unresolved: {
              name: key,
              version: entry.version,
              kind: entry.source.kind,
              reason: 'HTTP 500'
            }
          }
        }
        if (nexusManual.has(key)) {
          return {
            unresolved: {
              name: key,
              version: entry.version,
              kind: 'nexus',
              reason: 'Premium',
              url: 'https://nexusmods.com/x'
            }
          }
        }
        // Installs land enabled, like a real install.
        mods = [...mods.filter((m) => m.id !== key), installed({ ...entry, enabled: true })]
        return { modId: key, warnings: [] }
      }
    } as never
  }
}

const exp = (list: HmlExportMod[]): HmlExport => ({
  formatVersion: 1,
  game: 'repo',
  profileName: 'P',
  mods: list
})
// getProfile reads the manifest from disk, so keep it written.
async function sync(rev: {
  export: HmlExport
  configs?: Map<string, Uint8Array>
}): Promise<SyncApplyResult> {
  const ctx = makeCtx()
  const origInstall = ctx.entries.installEntry
  const write = async (): Promise<void> =>
    writeFile(
      join(dir, 'hml-profile.json'),
      JSON.stringify({ formatVersion: 1, id: 'p1', name: 'P', game: 'repo', createdAt: '', mods })
    )
  await write()
  ctx.entries.installEntry = async (...a) => {
    const r = await origInstall(...a)
    await write()
    return r
  }
  const un = ctx.installers.uninstallMod
  ctx.installers.uninstallMod = async (...a) => {
    await un(...a)
    await write()
  }
  const se = ctx.installers.setModEnabled
  ctx.installers.setModEnabled = async (...a) => {
    await se(...a)
    await write()
  }
  return applyRevision(ctx, 'repo', 'p1', { export: rev.export, configs: rev.configs ?? new Map() })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hml-apply-'))
  mods = []
  calls = []
  failKeys = new Set()
  nexusManual = new Set()
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('applyRevision', () => {
  it('removes mods the owner removed', async () => {
    mods = [installed(ts('a')), installed(ts('b'))]
    const r = await sync({ export: exp([ts('a')]) })
    expect(r).toMatchObject({ removed: 1, added: 0, updated: 0 })
    expect(calls).toContain('uninstall ts:o-b')
    expect(mods.map((m) => m.id)).toEqual(['ts:o-a'])
  })

  it('installs mods the owner added', async () => {
    const r = await sync({ export: exp([ts('a')]) })
    expect(r).toMatchObject({ added: 1, updated: 0, removed: 0 })
    expect(calls).toEqual(['install ts:o-a@1.0.0', 'repin'])
  })

  it("moves a mod to the owner's version and counts it as updated", async () => {
    mods = [installed(ts('a', '1.0.0'))]
    const r = await sync({ export: exp([ts('a', '2.0.0')]) })
    expect(r).toMatchObject({ updated: 1, added: 0 })
    expect(mods[0].version).toBe('2.0.0')
  })

  it('skips a mod already at the owner version', async () => {
    mods = [installed(ts('a'))]
    const r = await sync({ export: exp([ts('a')]) })
    expect(r).toMatchObject({ added: 0, updated: 0, enabled: 0, disabled: 0 })
    expect(calls).toEqual(['repin'])
  })

  it('matches enabled states', async () => {
    mods = [installed(ts('a', '1.0.0', true)), installed(ts('b', '1.0.0', false))]
    const r = await sync({
      export: exp([ts('a', '1.0.0', false), ts('b', '1.0.0', true), ts('c', '1.0.0', false)])
    })
    expect(r).toMatchObject({ enabled: 1, disabled: 2, added: 1 })
    expect(mods.map((m) => [m.id, m.enabled])).toEqual([
      ['ts:o-a', false],
      ['ts:o-b', true],
      ['ts:o-c', false]
    ])
  })

  it("skips the owner's local mods and does not remove them from the count", async () => {
    const local: HmlExportMod = {
      source: { kind: 'local', fileName: 'x.dll', sha256: 'aa' },
      version: '1.0.0',
      enabled: true
    }
    const r = await sync({ export: exp([local, ts('a')]) })
    expect(r).toMatchObject({ added: 1, removed: 0, failed: [], manual: [] })
    expect(calls.some((c) => c.includes('local:'))).toBe(false)
  })

  it('a nexus open-website result lands in manual with its url', async () => {
    const nx: HmlExportMod = {
      source: { kind: 'nexus', domain: 'repo', modId: 5, fileId: 9 },
      version: '1.0.0',
      enabled: true
    }
    nexusManual.add(modKey(nx.source))
    const r = await sync({ export: exp([nx]) })
    expect(r.manual).toEqual([{ name: 'nx:repo:5', url: 'https://nexusmods.com/x' }])
    expect(r.failed).toEqual([])
    expect(r.added).toBe(0)
  })

  it('a failed download lands in failed and the rest still applies', async () => {
    failKeys.add('ts:o-a')
    const r = await sync({ export: exp([ts('a'), ts('b', '1.0.0', false)]) })
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].reason).toBe('HTTP 500')
    expect(r).toMatchObject({ added: 1, disabled: 1 })
    expect(mods.map((m) => m.id)).toEqual(['ts:o-b'])
  })

  it("merges configs against bases and then stores the owner's files as the new bases", async () => {
    await mkdir(join(dir, 'BepInEx', 'config'), { recursive: true })
    await writeFile(join(dir, CFG), 'a = 1\nb = 1\n')
    await writeBases(dir, new Map([[CFG, enc('a = 1\nb = 1\n')]]))
    // The follower changed nothing; the owner changed b.
    const owner = new Map([
      [CFG, enc('a = 1\nb = 2\n')],
      ['BepInEx/config/new.cfg', enc('n = 1\n')]
    ])
    const r = await sync({ export: exp([]), configs: owner })
    expect(r.configs).toBe(2)
    expect(await readFile(join(dir, CFG), 'utf8')).toBe('a = 1\nb = 2\n')
    expect(await readFile(join(dir, 'BepInEx/config/new.cfg'), 'utf8')).toBe('n = 1\n')
    const bases = await readBases(dir)
    expect(new TextDecoder().decode(bases.get(CFG))).toBe('a = 1\nb = 2\n')
    expect(bases.size).toBe(2)
  })

  it('does not count a config the merge leaves unchanged', async () => {
    await mkdir(join(dir, 'BepInEx', 'config'), { recursive: true })
    await writeFile(join(dir, CFG), 'a = 1\n')
    const r = await sync({ export: exp([]), configs: new Map([[CFG, enc('a = 1\n')]]) })
    expect(r.configs).toBe(0)
  })

  it('leaves a follower-only config file alone', async () => {
    await mkdir(join(dir, 'BepInEx', 'config'), { recursive: true })
    await writeFile(join(dir, 'BepInEx/config/mine.cfg'), 'mine = 1\n')
    await sync({ export: exp([]), configs: new Map([[CFG, enc('a = 1\n')]]) })
    expect(await readFile(join(dir, 'BepInEx/config/mine.cfg'), 'utf8')).toBe('mine = 1\n')
  })

  it('refuses config paths that escape the profile', async () => {
    const r = await sync({
      export: exp([]),
      configs: new Map([['BepInEx/config/../../../evil', enc('x')]])
    })
    expect(r.configs).toBe(0)
  })
})

describe('modKey', () => {
  it('forms keys per source kind', () => {
    expect(
      modKey({ kind: 'github', owner: 'Foo', repo: 'Bar', tag: 't', asset: 'a', sha256: 's' })
    ).toBe('gh:foo/bar')
    expect(modKey({ kind: 'local', fileName: 'x.dll', sha256: 's' })).toBe('local:x.dll')
  })
})
