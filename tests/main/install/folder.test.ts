import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFolderEntries } from '../../../src/main/install/folder'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('readFolderEntries', () => {
  it('reads files as zip-style entries with a stable hash', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hml-folder-'))
    dirs.push(dir)
    await writeFile(path.join(dir, 'manifest.json'), '{"name":"MyMod"}')
    await mkdir(path.join(dir, 'plugins'))
    await writeFile(path.join(dir, 'plugins', 'MyMod.dll'), 'dll')
    if (process.platform !== 'win32') {
      await symlink('/etc/passwd', path.join(dir, 'outside'))
    }
    const a = await readFolderEntries(dir)
    expect(a.entries.names).toEqual(['manifest.json', 'plugins/MyMod.dll'])
    expect(new TextDecoder().decode(a.entries.read('plugins/MyMod.dll'))).toBe('dll')
    expect((await readFolderEntries(dir)).sha256).toBe(a.sha256)
    await writeFile(path.join(dir, 'plugins', 'MyMod.dll'), 'dll2')
    expect((await readFolderEntries(dir)).sha256).not.toBe(a.sha256)
  })

  it('refuses an empty folder and one over the size limit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hml-folder-'))
    dirs.push(dir)
    await expect(readFolderEntries(dir)).rejects.toThrow('empty folder')
    await writeFile(path.join(dir, 'big.bin'), 'x'.repeat(100))
    await expect(readFolderEntries(dir, { maxBytes: 10 })).rejects.toThrow('too large')
  })
})
