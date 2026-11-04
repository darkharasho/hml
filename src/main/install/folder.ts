import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ZipEntries } from './zipEntries'
import { MAX_EXTRACTED_BYTES, TOO_LARGE } from './zipEntries'

/**
 * A mod folder read as if it were a zip: every regular file under `dir`, named by its path
 * relative to `dir` with `/` separators. Symlinks are skipped so nothing outside the folder is
 * read. `sha256` covers the sorted names and contents, so an unchanged folder hashes the same.
 */
export async function readFolderEntries(
  dir: string,
  opts: { maxBytes?: number } = {}
): Promise<{ entries: ZipEntries; sha256: string }> {
  const maxBytes = opts.maxBytes ?? MAX_EXTRACTED_BYTES
  const files = new Map<string, Uint8Array>()
  let total = 0
  async function walk(rel: string): Promise<void> {
    const dirents = await fs.readdir(path.join(dir, rel), { withFileTypes: true })
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) await walk(childRel)
      else if (d.isFile()) {
        const data = await fs.readFile(path.join(dir, childRel))
        total += data.length
        if (total > maxBytes) throw new Error(TOO_LARGE)
        files.set(childRel, data)
      }
    }
  }
  await walk('')
  if (files.size === 0) throw new Error(`${path.basename(dir)} is an empty folder.`)
  const names = [...files.keys()].sort()
  const hash = createHash('sha256')
  for (const n of names) {
    const data = files.get(n) as Uint8Array
    hash.update(`${n}\0${data.length}\0`)
    hash.update(data)
  }
  return {
    entries: {
      names,
      read(name) {
        const f = files.get(name)
        if (!f) throw new Error(`No such file in folder: ${name}`)
        return f
      }
    },
    sha256: hash.digest('hex')
  }
}
