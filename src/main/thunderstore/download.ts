import { promises as fs } from 'node:fs'
import path from 'node:path'

const isZip = (b: Uint8Array): boolean =>
  b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function downloadPackage(opts: {
  url: string
  fullName: string
  version: string
  downloadsDir: string
  fetch: typeof fetch
}): Promise<Uint8Array> {
  const { url, fullName, version, downloadsDir } = opts
  const file = path.join(downloadsDir, `${fullName}-${version}.zip`)
  try {
    const cached = await fs.readFile(file).catch(() => null)
    if (cached) {
      const bytes = new Uint8Array(cached.buffer, cached.byteOffset, cached.byteLength)
      if (isZip(bytes)) return bytes
      await fs.rm(file, { force: true })
    }
    const res = await opts.fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = new Uint8Array(await res.arrayBuffer())
    if (!isZip(data)) throw new Error('the response was not a zip file')
    await fs.mkdir(downloadsDir, { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.writeFile(tmp, data)
      await fs.rename(tmp, file)
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw e
    }
    return data
  } catch (e) {
    throw new Error(`Download of ${fullName} ${version} failed: ${msg(e)}`, { cause: e })
  }
}
