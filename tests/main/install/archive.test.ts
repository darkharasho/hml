import { describe, test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { path7za } from '7zip-bin'
import { strToU8, zipSync } from 'fflate'
import { archiveKind, readArchive } from '../../../src/main/install/archive'

const have7z = existsSync(path7za)
const text = (u: Uint8Array): string => new TextDecoder().decode(u)

function make7z(setup: (src: string) => void): { data: Uint8Array; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'hml-7z-'))
  const src = path.join(dir, 'src')
  mkdirSync(src)
  setup(src)
  const out = path.join(dir, 'out.7z')
  chmodSync(path7za, 0o755)
  execFileSync(path7za, ['a', '-bd', '-snl', out, '.'], { cwd: src, stdio: 'ignore' })
  return {
    data: new Uint8Array(readFileSync(out)),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

describe('archiveKind', () => {
  test('detects by magic bytes', () => {
    expect(archiveKind(zipSync({ 'a.txt': strToU8('a') }))).toBe('zip')
    expect(archiveKind(Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0]))).toBe('7z')
    expect(archiveKind(Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]))).toBe('rar')
    expect(archiveKind(strToU8('hello'))).toBe('unknown')
    expect(archiveKind(new Uint8Array())).toBe('unknown')
  })
})

describe('readArchive', () => {
  test('reads a zip', async () => {
    const a = await readArchive(zipSync({ 'x/a.txt': strToU8('hi') }))
    expect(a.names).toEqual(['x/a.txt'])
    expect(text(a.read('x/a.txt'))).toBe('hi')
  })

  test.skipIf(!have7z)('reads a 7z and cleans up its temp files', async () => {
    const { data, cleanup } = make7z((src) => {
      mkdirSync(path.join(src, 'plugins/A'), { recursive: true })
      writeFileSync(path.join(src, 'plugins/A/A.dll'), 'dll')
      writeFileSync(path.join(src, 'readme.txt'), 'read')
    })
    const tmp = mkdtempSync(path.join(tmpdir(), 'hml-7zt-'))
    try {
      const a = await readArchive(data, { tmpDir: tmp })
      expect([...a.names].sort()).toEqual(['plugins/A/A.dll', 'readme.txt'])
      expect(text(a.read('plugins/A/A.dll'))).toBe('dll')
      expect(readdirSync(tmp)).toEqual([])
    } finally {
      cleanup()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test.skipIf(!have7z || process.platform !== 'linux')('skips symlinks in a 7z', async () => {
    const { data, cleanup } = make7z((src) => {
      writeFileSync(path.join(src, 'real.txt'), 'real')
      symlinkSync('/etc/hostname', path.join(src, 'link.txt'))
    })
    try {
      const a = await readArchive(data)
      expect(a.names).toEqual(['real.txt'])
    } finally {
      cleanup()
    }
  })

  test.skipIf(!have7z)('reports a corrupt 7z and cleans up', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'hml-7zt-'))
    const bad = Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 1, 2, 3, 4, 5, 6, 7, 8])
    try {
      await expect(readArchive(bad, { tmpDir: tmp })).rejects.toThrow(
        /^Couldn't open the 7z archive: .+/
      )
      expect(readdirSync(tmp)).toEqual([])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('refuses rar', async () => {
    await expect(
      readArchive(Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0]))
    ).rejects.toThrow(
      "HML can't open .rar archives yet. Download it from Nexus Mods and install the extracted files from a zip."
    )
  })

  test('refuses junk', async () => {
    await expect(readArchive(strToU8('junk'))).rejects.toThrow(
      "This download isn't a zip or 7z archive."
    )
  })
})
