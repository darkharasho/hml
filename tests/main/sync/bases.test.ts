import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearBases, readBases, writeBases } from '../../../src/main/sync/bases'

const b = (s: string): Uint8Array => new TextEncoder().encode(s)
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hml-bases-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('bases', () => {
  it('reads an empty map when none are stored', async () => {
    expect((await readBases(dir)).size).toBe(0)
  })

  it('write replaces the set; clear removes the dir', async () => {
    await writeBases(dir, new Map([['BepInEx/config/a.cfg', b('one')]]))
    await writeBases(dir, new Map([['BepInEx/config/b.cfg', b('two')]]))
    const got = await readBases(dir)
    expect([...got.keys()]).toEqual(['BepInEx/config/b.cfg'])
    expect(new TextDecoder().decode(got.get('BepInEx/config/b.cfg'))).toBe('two')
    expect(await readFile(join(dir, '.hml-sync', 'base', 'BepInEx/config/b.cfg'), 'utf8')).toBe(
      'two'
    )
    await clearBases(dir)
    await expect(stat(join(dir, '.hml-sync', 'base'))).rejects.toThrow()
    expect((await readBases(dir)).size).toBe(0)
  })

  it('ignores unsafe paths', async () => {
    await writeBases(dir, new Map([['../evil', b('x')]]))
    expect((await readBases(dir)).size).toBe(0)
  })
})
