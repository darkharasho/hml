import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { downloadPackage } from '../../../src/main/thunderstore/download'

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hml-dl-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const ok = (b: Uint8Array): Response =>
  ({
    ok: true,
    status: 200,
    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }) as unknown as Response
const base = (f: typeof fetch): Parameters<typeof downloadPackage>[0] => ({
  url: 'https://ts.test/dl',
  fullName: 'A-Alpha',
  version: '1.0.0',
  downloadsDir: path.join(tmp, 'dl'),
  fetch: f
})

describe('downloadPackage', () => {
  it('caches and reuses', async () => {
    const f = vi.fn(async () => ok(ZIP)) as unknown as typeof fetch
    expect(await downloadPackage(base(f))).toEqual(ZIP)
    expect(await downloadPackage(base(f))).toEqual(ZIP)
    expect(f).toHaveBeenCalledTimes(1)
    expect(await fs.readdir(path.join(tmp, 'dl'))).toEqual(['A-Alpha-1.0.0.zip'])
  })

  it('names package and version on 404 and leaves no file', async () => {
    const f = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch
    await expect(downloadPackage(base(f))).rejects.toThrow(/^Download of A-Alpha 1\.0\.0 failed: /)
    expect(await fs.readdir(path.join(tmp, 'dl')).catch(() => [])).toEqual([])
  })

  it('rejects an HTML body served with 200', async () => {
    const f = (async () =>
      ok(new TextEncoder().encode('<html>oops</html>'))) as unknown as typeof fetch
    await expect(downloadPackage(base(f))).rejects.toThrow(/Download of A-Alpha 1\.0\.0 failed/)
    expect(await fs.readdir(path.join(tmp, 'dl')).catch(() => [])).toEqual([])
  })

  it('re-downloads a corrupt cached file', async () => {
    await fs.mkdir(path.join(tmp, 'dl'), { recursive: true })
    await fs.writeFile(path.join(tmp, 'dl', 'A-Alpha-1.0.0.zip'), 'garbage')
    const f = vi.fn(async () => ok(ZIP)) as unknown as typeof fetch
    expect(await downloadPackage(base(f))).toEqual(ZIP)
    expect(f).toHaveBeenCalledTimes(1)
    expect(new Uint8Array(await fs.readFile(path.join(tmp, 'dl', 'A-Alpha-1.0.0.zip')))).toEqual(
      ZIP
    )
  })

  it('wraps network errors', async () => {
    const f = (async () => {
      throw new Error('boom')
    }) as unknown as typeof fetch
    await expect(downloadPackage(base(f))).rejects.toThrow('Download of A-Alpha 1.0.0 failed: boom')
  })

  it('rejects unsafe names before any fetch or file write', async () => {
    const f = vi.fn(async () => ok(ZIP)) as unknown as typeof fetch
    await expect(downloadPackage({ ...base(f), fullName: '../evil' })).rejects.toThrow(
      /^Download of \.\.\/evil 1\.0\.0 failed: invalid package name/
    )
    await expect(downloadPackage({ ...base(f), version: '..' })).rejects.toThrow(
      /invalid package name/
    )
    expect(f).not.toHaveBeenCalled()
    expect(await fs.readdir(tmp)).toEqual([])
  })
})
