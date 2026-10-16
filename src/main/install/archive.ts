import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { path7za } from '7zip-bin'
import { MAX_EXTRACTED_BYTES, readZipEntries, TOO_LARGE, type ZipEntries } from './zipEntries'

const execFileAsync = promisify(execFile)

export { MAX_EXTRACTED_BYTES }
const TIMEOUT_MS = 5 * 60 * 1000
const NOT_AN_ARCHIVE = "This download isn't a zip or 7z archive."

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

/**
 * A zip with bytes in front of it (a self-extractor stub) whose offsets weren't adjusted: the
 * archive part, found from the end-of-central-directory record. Otherwise the data unchanged.
 */
function zipBody(data: Uint8Array): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const stop = Math.max(0, data.length - 22 - 0xffff)
  for (let i = data.length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) !== 0x06054b50) continue
    const cdSize = view.getUint32(i + 12, true)
    const cdOffset = view.getUint32(i + 16, true)
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff) return data // zip64: leave as-is
    const prefix = i - cdSize - cdOffset
    return prefix > 0 ? data.subarray(prefix) : data
  }
  return data
}

const defaultSevenZip = (): string => path7za.replace('app.asar', 'app.asar.unpacked')

async function walk(
  root: string,
  dir: string,
  out: string[],
  total: { bytes: number }
): Promise<void> {
  for (const entry of await fs.readdir(dir)) {
    const abs = path.join(dir, entry)
    const st = await fs.lstat(abs)
    if (st.isSymbolicLink()) continue
    const real = await fs.realpath(abs)
    if (real !== root && !real.startsWith(root + path.sep)) continue
    if (st.isDirectory()) await walk(root, abs, out, total)
    else if (st.isFile()) {
      total.bytes += st.size
      if (total.bytes > MAX_EXTRACTED_BYTES) throw new Error(TOO_LARGE)
      out.push(abs)
    }
  }
}

async function run7z(sevenZip: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(sevenZip, args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: TIMEOUT_MS
    })
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string; killed?: boolean }
    if (err.killed) throw new Error("Couldn't open the 7z archive: timed out", { cause: e })
    const text = (err.stderr || err.stdout || err.message || '').trim()
    const line = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? 'unknown error'
    throw new Error(`Couldn't open the 7z archive: ${line.trim()}`, { cause: e })
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
    const listing = await run7z(sevenZip, ['l', '-slt', '-bd', archive])
    let declared = 0
    for (const m of listing.matchAll(/^Size = (\d+)\s*$/gm)) declared += Number(m[1])
    if (declared > MAX_EXTRACTED_BYTES) throw new Error(TOO_LARGE)
    await run7z(sevenZip, ['x', '-y', '-bd', '-bso0', '-bsp0', `-o${outDir}`, archive])
    await fs.mkdir(outDir, { recursive: true })
    const root = await fs.realpath(outDir)
    const abs: string[] = []
    await walk(root, root, abs, { bytes: 0 })
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
  opts: { sevenZip?: string; tmpDir?: string; maxBytes?: number } = {}
): Promise<ZipEntries> {
  const zipOpts = { maxBytes: opts.maxBytes }
  switch (archiveKind(data)) {
    case 'zip':
      return readZipEntries(data, zipOpts)
    case '7z':
      return read7z(data, opts.sevenZip ?? defaultSevenZip(), opts.tmpDir ?? os.tmpdir())
    case 'rar':
      throw new Error(
        "HML can't open .rar archives yet. Download it from Nexus Mods and install the extracted files from a zip."
      )
    default:
      // Self-extracting and stub-prefixed zips don't start with a zip signature.
      try {
        return readZipEntries(zipBody(data), zipOpts)
      } catch (e) {
        if (e instanceof Error && e.message === TOO_LARGE) throw e
        throw new Error(NOT_AN_ARCHIVE, { cause: e })
      }
  }
}
