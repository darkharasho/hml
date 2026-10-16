import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findProtonVersions, wineAvailable, defaultRunner } from '../../../src/main/launch/runners'

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-runners-'))
})
afterEach(() => fs.rm(tmp, { recursive: true, force: true }))

async function proton(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'proton'), '')
}

describe('runners', () => {
  test('finds Proton builds in libraries and compatibilitytools.d, newest first', async () => {
    const root = path.join(tmp, 'steam')
    const lib = path.join(tmp, 'lib')
    const common = path.join(lib, 'steamapps', 'common')
    await proton(path.join(common, 'Proton 8.0'))
    await proton(path.join(common, 'Proton 9.0'))
    await proton(path.join(common, 'Proton - Experimental'))
    await fs.mkdir(path.join(common, 'Proton 7.0'), { recursive: true })
    await proton(path.join(root, 'compatibilitytools.d', 'GE-Proton9-20'))
    const found = await findProtonVersions(root, [lib])
    expect(found.map((r) => r.name)).toEqual([
      'GE-Proton9-20',
      'Proton 9.0',
      'Proton 8.0',
      'Proton - Experimental'
    ])
    expect(found[1]).toEqual({
      kind: 'proton',
      name: 'Proton 9.0',
      path: path.join(common, 'Proton 9.0')
    })
  })

  test('defaultRunner prefers Proton, then Wine, then null', () => {
    const p = { kind: 'proton' as const, name: 'P', path: '/p' }
    expect(defaultRunner([p], true)).toBe(p)
    expect(defaultRunner([], true)).toEqual({ kind: 'wine' })
    expect(defaultRunner([], false)).toBeNull()
  })

  test('wineAvailable reflects execFile', async () => {
    expect(await wineAvailable(async () => ({ stdout: 'wine-9' }))).toBe(true)
    expect(
      await wineAvailable(async () => {
        throw new Error('ENOENT')
      })
    ).toBe(false)
  })
})
