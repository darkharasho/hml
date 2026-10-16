import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { path7za } from '7zip-bin'
import { readZipEntries, type ZipEntries } from './installer'

const execFileAsync = promisify(execFile)

export type ArchiveKind = 'zip' | '7z' | 'rar' | 'unknown'

const startsWith = (data: Uint8Array, magic: number[]): boolean =>
  data.length >= magic.length && magic.every((b, i) => data[i] === b)

export function archiveKind(data: Uint8Array): ArchiveKind {
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(data, [0x50, 0x4b, 0x05, 0x06])) {
    return 'zip'
  }
  if (startsWith(data, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z'
  if (startsWith(data, [0x52, 0x61, 0x72, 0x21])) return 'rar'
  return 'unknown'
}

const defaultSevenZip = (): string => path7za.replace('app.asar', 'app.asar.unpacked')

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const entry of await fs.readdir(dir)) {
    const abs = path.join(dir, entry)
    const st = await fs.lstat(abs)
    if (st.isSymbolicLink()) continue
    const real = await fs.realpath(abs)
    if (real !== root && !real.startsWith(root + path.sep)) continue
    if (st.isDirectory()) await walk(root, abs, out)
    else if (st.isFile()) out.push(abs)
  }
}

async function read7z(data: Uint8Array, sevenZip: string, tmpDir: string): Promise<ZipEntries> {
  const id = randomUUID()
  const archive = path.join(tmpDir, `${id}.7z`)
  const outDir = path.join(tmpDir, id)
  try {
    // Some installs (npm, unpacked asar) drop the exec bit on the bundled binary.
    if (process.platform !== 'win32') await fs.chmod(sevenZip, 0o755).catch(() => undefined)
    await fs.writeFile(archive, data)
    try {
      await execFileAsync(sevenZip, ['x', '-y', '-bd', `-o${outDir}`, archive], {
        maxBuffer: 16 * 1024 * 1024
      })
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message?: string }
      const text = (err.stderr || err.stdout || err.message || '').trim()
      const line = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? 'unknown error'
      throw new Error(`Couldn't open the 7z archive: ${line.trim()}`, { cause: e })
    }
    await fs.mkdir(outDir, { recursive: true })
    const root = await fs.realpath(outDir)
    const abs: string[] = []
    await walk(root, root, abs)
    const files = new Map<string, Uint8Array>()
    for (const a of abs) {
      const rel = path.relative(root, a).split(path.sep).join('/')
      files.set(rel, new Uint8Array(await fs.readFile(a)))
    }
    return {
      names: [...files.keys()],
      read(name) {
        const f = files.get(name)
        if (!f) throw new Error(`No such archive entry: ${name}`)
        return f
      }
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(archive, { force: true }).catch(() => undefined)
  }
}

export async function readArchive(
  data: Uint8Array,
  opts: { sevenZip?: string; tmpDir?: string } = {}
): Promise<ZipEntries> {
  switch (archiveKind(data)) {
    case 'zip':
      return readZipEntries(data)
    case '7z':
      return read7z(data, opts.sevenZip ?? defaultSevenZip(), opts.tmpDir ?? os.tmpdir())
    case 'rar':
      throw new Error(
        "HML can't open .rar archives yet. Download it from Nexus Mods and install the extracted files from a zip."
      )
    default:
      throw new Error("This download isn't a zip or 7z archive.")
  }
}
